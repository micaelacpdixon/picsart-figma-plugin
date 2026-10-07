import {
    SESSION_ENDED_ERR,
    SESSION_SCOPE_ERR,
    SIGNED_OUT_MSG,
    SIGNED_OUT_USING_KEY_MSG,
    SIGN_IN_CANCELLED_MSG,
    SIGN_IN_BLOCKED_ERR,
    SIGN_IN_CODE_UNREADABLE_ERR,
    SIGN_IN_DECLINED_ERR,
    SIGN_IN_FAILED_ERR,
    SIGN_IN_NO_RANDOM_ERR,
    SIGN_IN_NOT_REMEMBERED_ERR,
    SIGN_IN_NO_SESSION_ERR,
    SIGN_IN_STATE_MISMATCH_ERR,
    SIGN_IN_TIMED_OUT_ERR,
    SIGN_IN_UNREACHABLE_ERR,
    SIGN_IN_TIMEOUT_MS,
    TOKEN_EXPIRY_SKEW_MS,
    ASSUMED_CODE_LIFETIME_MS,
    RELAY_INSTANT_POLL_MS,
    RELAY_OFFLINE_TOLERANCE,
    RELAY_PACE_MS,
    RELAY_SPARE_MAX_AGE_MS,
    TYPE_AUTH_STATE,
    TYPE_CREDENTIAL,
} from "@constants/index";
import type { AuthState } from "@app-types/auth";
import type { CredentialDescriptor } from "@app-types/credential";
import { readApiKey } from "./apiKeyStorage";
import { authLog } from "./authLog";
import {
    buildAuthorizeUrl,
    endSession,
    tokenFromBody,
    type TokenResult,
} from "./oauthClient";
import { betaExchangeReady, BETA_SIGN_IN_UNAVAILABLE, exchangeViaPage, refreshViaPage } from "./exchangePage";
import { mintHandoff, pollHandoffOnce, type HandoffKeys } from "./relay";
import {
    classifyInvalidGrant,
    clearOAuthRecord,
    credentialFromRecord,
    isAccessTokenExpired,
    readOAuthRecord,
    resetSessionOAuthRecords,
    writeOAuthRecord,
    type OAuthRecord,
} from "./oauthStorage";
import { NoSecureRandomError, randomSourceFor } from "./entropy";
import { createPkcePair, createState } from "./pkce";
import { parseAuthorizationResponse, rendezvousMode } from "./rendezvous";
import type { SandboxFetchFn } from "./sandboxFetch";
import { postToUi } from "./UiBridge";

interface PendingSignIn {
    verifier: string;
    state: string;
    startedAt: number;
    authorizeUrl: string;
    keys?: HandoffKeys;
}

class BetaSignInUnavailableError extends Error {
    constructor() { super(BETA_SIGN_IN_UNAVAILABLE); Object.setPrototypeOf(this, BetaSignInUnavailableError.prototype); }
}

let pending: PendingSignIn | undefined;

let armedFlow:
    | { verifier: string; state: string; authorizeUrl: string; keys?: HandoffKeys }
    | undefined;
let arming = false;
let signInGeneration = 0;
let pollGeneration = 0;
let state: AuthState = { status: "idle" };
let displayName: string | undefined;

let refreshInFlight: Promise<CredentialDescriptor | undefined> | undefined;

export const authState = (): AuthState => state;

const setState = (pluginApi: PluginAPI, next: AuthState) => {
    state = next;
    postToUi(pluginApi, { type: TYPE_AUTH_STATE, payload: next });
};

const setStateQuietly = (next: AuthState) => {
    state = next;
};

const isLiveFlow = (): boolean =>
    state.status === "starting" || state.status === "awaiting" || state.status === "working";

export const postAuthState = (pluginApi: PluginAPI) => {
    postToUi(pluginApi, { type: TYPE_AUTH_STATE, payload: state });
};

export const acknowledgeTerminalAuthState = () => {
    if (state.status === "denied" || state.status === "failed") state = { status: "idle" };
};

const signedInState = (record: OAuthRecord): AuthState => ({
    status: "signedIn",
    name: displayName,
    scopes: record.scopes ?? [],
    expiresAt: record.expiresAt,
});

export interface ActiveCredential {
    credential: CredentialDescriptor | null;
    apiKey: string;
}

export const postCredential = (
    pluginApi: PluginAPI,
    active: ActiveCredential,
    requestId?: string
) => {
    postToUi(pluginApi, {
        type: TYPE_CREDENTIAL,
        payload: { credential: active.credential, apiKey: active.apiKey },
        ...(requestId ? { requestId } : {}),
    });
};

const endOAuthSession = async (pluginApi: PluginAPI, reason: string) => {
    await clearOAuthRecord(pluginApi);
    displayName = undefined;
    setState(pluginApi, { status: "failed", reason });
};

const refreshThroughPage = async (
    pluginApi: PluginAPI,
    refreshToken: string
): Promise<TokenResult> => {
    const reply = await refreshViaPage(pluginApi, refreshToken);

    if (!reply.ok) {
        authLog("the exchange page could not spend the refresh token", {
            error: reply.error,
            status: reply.status,
            throttled: reply.throttled,
        });
        return { ok: false, reason: reply.reason, detail: reply.error };
    }

    return tokenFromBody(reply, "figma/auth.html (refresh_token)");
};

const refreshRecord = async (
    pluginApi: PluginAPI,
    record: OAuthRecord
): Promise<CredentialDescriptor | undefined> => {
    if (!record.refreshToken) {
        authLog("the stored session has no refresh token, so it ends at expiry");
        await endOAuthSession(pluginApi, SESSION_ENDED_ERR);
        return undefined;
    }

    setStateQuietly({ status: "working" });
    const result = await refreshThroughPage(pluginApi, record.refreshToken);

    if (result.ok) {
        const refreshed = {
            ...result.record,
            refreshToken: result.record.refreshToken ?? record.refreshToken,
        };
        const stored = await writeOAuthRecord(pluginApi, refreshed);
        if (result.name) displayName = result.name;
        const effective = stored ?? { ...refreshed, writtenAt: record.writtenAt };
        setStateQuietly(signedInState(effective));
        return credentialFromRecord(effective);
    }

    if (result.reason === "unreachable" || result.reason === "blocked") {
        setState(pluginApi, {
            status: "failed",
            reason:
                result.reason === "blocked" ? SIGN_IN_BLOCKED_ERR : SIGN_IN_UNREACHABLE_ERR,
        });
        return undefined;
    }

    if (result.reason === "scope") {
        authLog("the refreshed token was missing a required scope", {
            missing: result.missing,
        });
        await endOAuthSession(pluginApi, SESSION_SCOPE_ERR);
        return undefined;
    }

    if (result.reason === "invalid_grant") {
        const verdict = await classifyInvalidGrant(pluginApi, record);

        if (verdict.outcome === "rotated") {
            authLog("another document rotated the session; adopting the stored record");
            setStateQuietly(signedInState(verdict.record));
            return isAccessTokenExpired(verdict.record, TOKEN_EXPIRY_SKEW_MS)
                ? undefined
                : credentialFromRecord(verdict.record);
        }

        if (verdict.outcome === "gone") {
            displayName = undefined;
            setState(pluginApi, { status: "idle" });
            return undefined;
        }

        await endOAuthSession(pluginApi, SESSION_ENDED_ERR);
        return undefined;
    }

    await endOAuthSession(pluginApi, result.detail ? SESSION_ENDED_ERR : SIGN_IN_FAILED_ERR);
    return undefined;
};

export const activeCredential = async (
    pluginApi: PluginAPI
): Promise<ActiveCredential> => {
    const apiKey = (await readApiKey(pluginApi)) ?? "";
    const record = await readOAuthRecord(pluginApi);

    if (!record) {
        if (state.status === "signedIn") {
            displayName = undefined;
            setStateQuietly({ status: "idle" });
        }
        return {
            credential: apiKey ? { kind: "apikey", token: apiKey } : null,
            apiKey,
        };
    }

    if (!isAccessTokenExpired(record, TOKEN_EXPIRY_SKEW_MS)) {
        if (!isLiveFlow()) setStateQuietly(signedInState(record));
        return { credential: credentialFromRecord(record), apiKey };
    }

    if (!refreshInFlight) {
        refreshInFlight = refreshRecord(pluginApi, record).then((credential) => {
            refreshInFlight = undefined;
            return credential;
        });
    }
    const refreshed = await refreshInFlight;

    return {
        credential: refreshed ?? (apiKey ? { kind: "apikey", token: apiKey } : null),
        apiKey,
    };
};

const buildFlow = async (
    pluginApi: PluginAPI,
    fetchFn?: SandboxFetchFn
): Promise<{ verifier: string; state: string; authorizeUrl: string; keys?: HandoffKeys }> => {
    if (!await betaExchangeReady(pluginApi)) throw new BetaSignInUnavailableError();
    const random = randomSourceFor(pluginApi);
    const { verifier, challenge } = await createPkcePair(random);

    if (rendezvousMode() === "relay") {
        const keys = await mintHandoff(fetchFn);
        return {
            verifier,
            state: keys.writeKey,
            authorizeUrl: buildAuthorizeUrl({ state: keys.writeKey, challenge }),
            keys,
        };
    }

    const csrfState = await createState(random);
    return {
        verifier,
        state: csrfState,
        authorizeUrl: buildAuthorizeUrl({ state: csrfState, challenge }),
    };
};

export const armSignIn = async (
    pluginApi: PluginAPI,
    fetchFn?: SandboxFetchFn
): Promise<void> => {
    if (pending || armedFlow || arming) return;
    if (state.status !== "idle") return;

    arming = true;
    const generation = signInGeneration;
    try {
        const flow = await buildFlow(pluginApi, fetchFn);
        if (generation !== signInGeneration) return;
        if (pending || armedFlow) return;
        armedFlow = flow;
        setState(pluginApi, { status: "armed", authorizeUrl: flow.authorizeUrl });
    } catch (error) {
        if (generation !== signInGeneration) return;
        armedFlow = undefined;
        const noRandom = error instanceof NoSecureRandomError;
        authLog("could not arm the sign-in", { error: String(error) });
        if (noRandom) setState(pluginApi, { status: "failed", reason: SIGN_IN_NO_RANDOM_ERR });
    } finally {
        arming = false;
    }
};

export const startSignIn = async (
    pluginApi: PluginAPI,
    fetchFn?: SandboxFetchFn
): Promise<void> => {
    if (pending && Date.now() - pending.startedAt < SIGN_IN_TIMEOUT_MS) {
        setState(pluginApi, {
            status: "awaiting",
            mode: rendezvousMode(),
            authorizeUrl: pending.authorizeUrl,
        });
        return;
    }

    if (!armedFlow) setState(pluginApi, { status: "starting" });
    const generation = ++signInGeneration;

    try {
        const armedIsStale =
            !!armedFlow?.keys && Date.now() - armedFlow.keys.mintedAt > RELAY_SPARE_MAX_AGE_MS;
        if (armedIsStale) authLog("the armed relay key pair went stale; minting another");
        const ready =
            armedFlow && !armedIsStale ? armedFlow : await buildFlow(pluginApi, fetchFn);
        if (generation !== signInGeneration) return;
        armedFlow = undefined;

        pending = {
            verifier: ready.verifier,
            state: ready.state,
            startedAt: Date.now(),
            authorizeUrl: ready.authorizeUrl,
            keys: ready.keys,
        };

        setState(pluginApi, {
            status: "awaiting",
            mode: rendezvousMode(),
            authorizeUrl: ready.authorizeUrl,
        });

        if (ready.keys) void runRelayPoll(pluginApi, ready.keys, ++pollGeneration, fetchFn);
    } catch (error) {
        if (generation !== signInGeneration) return;
        const noRandom = error instanceof NoSecureRandomError;
        authLog("could not start the sign-in", { error: String(error) });
        pending = undefined;
        setState(pluginApi, {
            status: "failed",
            reason: noRandom ? SIGN_IN_NO_RANDOM_ERR : error instanceof BetaSignInUnavailableError ? BETA_SIGN_IN_UNAVAILABLE : SIGN_IN_FAILED_ERR,
        });
    }
};

const runRelayPoll = async (
    pluginApi: PluginAPI,
    keys: HandoffKeys,
    generation: number,
    fetchFn?: SandboxFetchFn
): Promise<void> => {
    const deadline = keys.mintedAt + keys.expiresIn * 1000;
    let offlineStreak = 0;

    while (generation === pollGeneration) {
        if (Date.now() > deadline) {
            pending = undefined;
            setState(pluginApi, { status: "failed", reason: SIGN_IN_TIMED_OUT_ERR });
            void armSignIn(pluginApi);
            return;
        }

        const startedAt = Date.now();
        const outcome = await pollHandoffOnce(keys.readKey, fetchFn);
        if (generation !== pollGeneration) return;

        if (outcome.kind === "pending") {
            offlineStreak = 0;
            if (Date.now() - startedAt < RELAY_INSTANT_POLL_MS) {
                await new Promise((resolve) => setTimeout(resolve, RELAY_PACE_MS));
            }
            continue;
        }

        if (outcome.kind === "offline") {
            if (++offlineStreak >= RELAY_OFFLINE_TOLERANCE) {
                pending = undefined;
                authLog("gave up polling the relay", { reason: outcome.reason });
                setState(pluginApi, { status: "failed", reason: SIGN_IN_UNREACHABLE_ERR });
                void armSignIn(pluginApi);
                return;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, Math.min(1000 * offlineStreak, 4000))
            );
            continue;
        }

        if (outcome.kind === "gone") {
            pending = undefined;
            authLog("the relay key is gone — expired, evicted or already used");
            setState(pluginApi, { status: "failed", reason: SIGN_IN_NO_SESSION_ERR });
            void armSignIn(pluginApi);
            return;
        }

        if (outcome.kind === "refused") {
            await submitAuthResponse(
                pluginApi,
                `error=${encodeURIComponent(outcome.error)}`
            );
            return;
        }

        if (outcome.ageMs !== undefined && outcome.ageMs > ASSUMED_CODE_LIFETIME_MS) {
            pending = undefined;
            authLog("the relay held the code too long to spend", { ageMs: outcome.ageMs });
            setState(pluginApi, { status: "failed", reason: SIGN_IN_TIMED_OUT_ERR });
            void armSignIn(pluginApi);
            return;
        }

        await submitAuthResponse(
            pluginApi,
            `code=${encodeURIComponent(outcome.code)}&state=${encodeURIComponent(keys.writeKey)}`
        );
        return;
    }
};

export const submitAuthResponse = async (
    pluginApi: PluginAPI,
    raw: string
): Promise<void> => {
    if (!pending) {
        setState(pluginApi, { status: "failed", reason: SIGN_IN_NO_SESSION_ERR });
        return;
    }

    if (Date.now() - pending.startedAt >= SIGN_IN_TIMEOUT_MS) {
        pending = undefined;
        setState(pluginApi, { status: "failed", reason: SIGN_IN_TIMED_OUT_ERR });
        return;
    }

    const response = parseAuthorizationResponse(raw);

    if (response.kind === "unreadable") {
        setState(pluginApi, { status: "failed", reason: SIGN_IN_CODE_UNREADABLE_ERR });
        return;
    }

    if (response.kind === "error") {
        pending = undefined;
        authLog("the authorization server refused the sign-in", {
            error: response.error,
            description: response.description,
        });
        setState(
            pluginApi,
            response.error === "access_denied"
                ? { status: "denied" }
                : { status: "failed", reason: SIGN_IN_DECLINED_ERR }
        );
        return;
    }

    if (response.state !== undefined && response.state !== pending.state) {
        pending = undefined;
        authLog("the authorization response carried a state that was not the one sent");
        setState(pluginApi, { status: "failed", reason: SIGN_IN_STATE_MISMATCH_ERR });
        return;
    }

    const verifier = pending.verifier;
    pending = undefined;
    setState(pluginApi, { status: "working" });

    const reply = await exchangeViaPage(pluginApi, response.code, verifier);
    const result: TokenResult = reply.ok
        ? tokenFromBody(reply, "figma/auth.html (authorization_code)")
        : {
              ok: false,
              reason: reply.reason,
              detail: reply.error,
          };
    if (!reply.ok) {
        authLog("the exchange page could not spend the code", {
            error: reply.error,
            status: reply.status,
            throttled: reply.throttled,
        });
    }

    if (!result.ok) {
        setState(pluginApi, {
            status: "failed",
            reason:
                result.reason === "blocked"
                    ? SIGN_IN_BLOCKED_ERR
                    : result.reason === "unreachable"
                      ? SIGN_IN_UNREACHABLE_ERR
                      : result.reason === "scope"
                        ? SESSION_SCOPE_ERR
                        : SIGN_IN_FAILED_ERR,
        });
        return;
    }

    displayName = result.name;
    const stored = await writeOAuthRecord(pluginApi, result.record);

    if (!stored) {
        const effective = { ...result.record, writtenAt: 0 };
        setState(pluginApi, signedInState(effective));
        pluginApi.notify(SIGN_IN_NOT_REMEMBERED_ERR, { error: true });
        postCredential(pluginApi, {
            credential: credentialFromRecord(effective),
            apiKey: (await readApiKey(pluginApi)) ?? "",
        });
        return;
    }

    setState(pluginApi, signedInState(stored));
    postCredential(pluginApi, await activeCredential(pluginApi));
};

export const cancelSignIn = async (pluginApi: PluginAPI): Promise<void> => {
    signInGeneration += 1;
    const wasPending = hasPendingSignIn();
    pending = undefined;
    armedFlow = undefined;
    pollGeneration += 1;
    setState(pluginApi, { status: "idle" });
    if (wasPending) pluginApi.notify(SIGN_IN_CANCELLED_MSG);
    await armSignIn(pluginApi);
};

export const signOut = async (
    pluginApi: PluginAPI,
    fetchFn?: SandboxFetchFn
): Promise<ActiveCredential> => {
    signInGeneration += 1;
    pending = undefined;
    displayName = undefined;

    await clearOAuthRecord(pluginApi);
    const active = await activeCredential(pluginApi);
    setState(pluginApi, { status: "idle" });

    pluginApi.notify(active.apiKey ? SIGNED_OUT_USING_KEY_MSG : SIGNED_OUT_MSG);

    void endSession({}, fetchFn);

    return active;
};

export const refreshCredentialNow = async (
    pluginApi: PluginAPI
): Promise<ActiveCredential> => {
    const record = await readOAuthRecord(pluginApi);
    const apiKey = (await readApiKey(pluginApi)) ?? "";

    if (!record) {
        return { credential: apiKey ? { kind: "apikey", token: apiKey } : null, apiKey };
    }

    if (!refreshInFlight) {
        refreshInFlight = refreshRecord(pluginApi, record).then((credential) => {
            refreshInFlight = undefined;
            return credential;
        });
    }
    const refreshed = await refreshInFlight;

    return {
        credential: refreshed ?? (apiKey ? { kind: "apikey", token: apiKey } : null),
        apiKey,
    };
};

export const resetAuthSession = () => {
    signInGeneration += 1;
    resetSessionOAuthRecords();
    pending = undefined;
    state = { status: "idle" };
    displayName = undefined;
    refreshInFlight = undefined;
    pollGeneration += 1;
    armedFlow = undefined;
    arming = false;
};

export const hasPendingSignIn = (): boolean =>
    !!pending && Date.now() - pending.startedAt < SIGN_IN_TIMEOUT_MS;
