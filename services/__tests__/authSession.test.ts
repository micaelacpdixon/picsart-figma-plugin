import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    API_KEY_NAME,
    OAUTH_RECORD_NAME,
    SESSION_ENDED_ERR,
    SESSION_SCOPE_ERR,
    SIGNED_OUT_MSG,
    SIGNED_OUT_USING_KEY_MSG,
    SIGN_IN_BLOCKED_ERR,
    SIGN_IN_CODE_UNREADABLE_ERR,
    SIGN_IN_NOT_REMEMBERED_ERR,
    SIGN_IN_NO_SESSION_ERR,
    SIGN_IN_STATE_MISMATCH_ERR,
    SIGN_IN_UNREACHABLE_ERR,
    ENTROPY_TIMEOUT_MS,
    OAUTH_REDIRECT_URI,
    TYPE_AUTH_STATE,
    TYPE_CREDENTIAL,
} from "../../constants/index";
import type { AuthState } from "../../src/types/auth";
import {
    acknowledgeTerminalAuthState,
    activeCredential,
    armSignIn,
    authState,
    cancelSignIn,
    hasPendingSignIn,
    postAuthState,
    refreshCredentialNow,
    resetAuthSession,
    signOut,
    startSignIn,
    submitAuthResponse,
} from "../authSession";
import type { SandboxFetchFn } from "../sandboxFetch";
import { beginUiSession, resetUiBridge } from "../UiBridge";
import { makeFigmaStub, type FigmaStub } from "./figmaStub";

const jwt = (claims: Record<string, unknown>): string => {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value))
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    return `${encode({ alg: "RS256" })}.${encode(claims)}.sig`;
};

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;
const TOKEN = jwt({ scope: ["openid", "profile", "workflows.execute"], exp: FUTURE_EXP });
const DESCOPED = jwt({ scope: ["openid"], exp: FUTURE_EXP });
const KEY = "an-api-key";

const reply = (over: Partial<FetchResponse> = {}): FetchResponse =>
    ({
        ok: true,
        status: 200,
        headersObject: {},
        json: async () => ({}),
        text: async () => "",
        ...over,
    }) as FetchResponse;

const fetchStub = (...responses: FetchResponse[]) => {
    let call = 0;
    return vi.fn<SandboxFetchFn>(async () => responses[Math.min(call++, responses.length - 1)]);
};

const tokenReply = (over: Record<string, unknown> = {}) =>
    reply({ json: async () => ({ access_token: TOKEN, refresh_token: "rt:new", ...over }) });

const record = (over: Record<string, unknown> = {}) => ({
    accessToken: TOKEN,
    refreshToken: "rt:stored",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["openid", "profile", "workflows.execute"],
    clientId: "dcr-test",
    writtenAt: 1000,
    ...over,
});


const WRITE_KEY = "w".repeat(43);
const READ_KEY = "r".repeat(43);

const relay = (
    poll: () => FetchResponse = () => reply({ json: async () => ({ status: "pending" }) }),
    ...rest: FetchResponse[]
) => {
    let call = 0;
    return vi.fn<SandboxFetchFn>(async (url: string) => {
        if (url.indexOf("/auth/handoff/result") !== -1) return poll();
        if (url.indexOf("/auth/handoff") !== -1) {
            return reply({
                json: async () => ({
                    write_key: WRITE_KEY,
                    read_key: READ_KEY,
                    expires_in: 600,
                }),
            });
        }
        return rest[Math.min(call++, rest.length - 1)] ?? reply();
    });
};

const exchanged = (over: Record<string, unknown> = {}) => ({
    ok: true as const,
    body: { access_token: TOKEN, refresh_token: "rt:new", ...over },
});

const ready = (stub: FigmaStub) => {
    beginUiSession(stub.api);
    (stub.api.ui.onmessage as (m: { type: string }) => unknown)({ type: "ui-ready" });
};

const states = (stub: FigmaStub): AuthState[] =>
    stub.posted.filter((m) => m.type === TYPE_AUTH_STATE).map((m) => m.payload as AuthState);

const lastState = (stub: FigmaStub): AuthState | undefined => states(stub).at(-1);

const stateFromUrl = (url: string): string =>
    decodeURIComponent(/[?&]state=([^&]*)/.exec(url)?.[1] ?? "");

beforeEach(() => {
    resetUiBridge();
    resetAuthSession();

    // Nothing here may reach the network. Most calls take an injected fetch, but
    // `cancelSignIn` and `signOut` re-arm through `armSignIn(pluginApi)` with none —
    // correct in production, where the global is the seam — so the tests that exercise
    // them POSTed to the live relay and failed on a 5s socket timeout whenever it was
    // slow or rate-limited. An injected stub still wins over this one.
    vi.stubGlobal("fetch", relay());

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    resetUiBridge();
    resetAuthSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("armSignIn", () => {
    it("arms an authorize URL before anything is pressed", async () => {
        const stub = makeFigmaStub();
        ready(stub);

        await armSignIn(stub.api, relay());

        const state = lastState(stub);
        expect(state?.status).toBe("armed");
        if (state?.status === "armed") {
            expect(state.authorizeUrl).toContain("code_challenge_method=S256");
            expect(state.authorizeUrl).toContain("response_type=code");
        }
    });

    it("does not overwrite a sign-in that is already under way", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await startSignIn(stub.api, relay());

        await armSignIn(stub.api, relay());

        expect(lastState(stub)?.status).toBe("awaiting");
        expect(hasPendingSignIn()).toBe(true);
    });

    it("hands the armed URL to startSignIn rather than building a second one", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await armSignIn(stub.api, relay());
        const armed = lastState(stub);

        await startSignIn(stub.api, relay());

        const awaiting = lastState(stub);
        expect(awaiting?.status).toBe("awaiting");
        if (armed?.status === "armed" && awaiting?.status === "awaiting") {
            expect(awaiting.authorizeUrl).toBe(armed.authorizeUrl);
        }
    });

    it("borrows randomness from the panel when this realm has none", async () => {
        vi.stubGlobal("crypto", undefined);
        const stub = makeFigmaStub();
        ready(stub);
        try {
            await armSignIn(stub.api, relay());

            const state = lastState(stub);
            expect(state?.status).toBe("armed");
            if (state?.status === "armed") {
                expect(state.authorizeUrl).toContain("code_challenge_method=S256");
            }
            expect(stub.posted.some((m) => m.type === "request-random")).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("says so, terminally, when NEITHER realm can produce a safe verifier", async () => {
        vi.stubGlobal("crypto", undefined);
        const stub = makeFigmaStub({ entropy: "no-crypto" });
        ready(stub);
        try {
            await armSignIn(stub.api, relay());

            const state = lastState(stub);
            expect(state?.status).toBe("failed");
            if (state?.status === "failed") {
                expect(state.reason).toContain("Sign-in isn't available");
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("leaves the button alone when the panel merely fails to answer", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("crypto", undefined);
        const stub = makeFigmaStub({ entropy: "silent" });
        ready(stub);
        try {
            const arming = armSignIn(stub.api, relay());
            await vi.advanceTimersByTimeAsync(ENTROPY_TIMEOUT_MS + 1);
            await arming;

            expect(states(stub).some((s) => s.status === "failed")).toBe(false);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });
});

describe("startSignIn", () => {
    it("moves through starting to awaiting, carrying the authorize URL", async () => {
        const stub = makeFigmaStub();
        ready(stub);

        await startSignIn(stub.api, relay());

        expect(states(stub).map((s) => s.status)).toEqual(["starting", "awaiting"]);
        const awaiting = lastState(stub);
        expect(awaiting).toMatchObject({ status: "awaiting", mode: "relay" });
        expect((awaiting as { authorizeUrl: string }).authorizeUrl).toContain(
            "code_challenge_method=S256"
        );
    });

    it("starts a sign-in in a realm with no crypto, which is the one that was failing", async () => {
        vi.stubGlobal("crypto", undefined);
        const stub = makeFigmaStub();
        ready(stub);
        try {
            await startSignIn(stub.api, relay());

            const state = lastState(stub);
            expect(state?.status).toBe("awaiting");
            expect(states(stub).some((s) => s.status === "failed")).toBe(false);
            expect(hasPendingSignIn()).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("re-posts the SAME pending flow rather than doing nothing on a second press", async () => {
        const stub = makeFigmaStub();
        ready(stub);

        await startSignIn(stub.api, relay());
        const first = (lastState(stub) as { authorizeUrl: string }).authorizeUrl;

        await startSignIn(stub.api, relay());
        const second = lastState(stub);

        expect(second).toMatchObject({ status: "awaiting" });
        expect((second as { authorizeUrl: string }).authorizeUrl).toBe(first);
        expect(states(stub).filter((s) => s.status === "starting")).toHaveLength(1);
    });
});

describe("the relay rendezvous", () => {
    it("collects the code and completes the sign-in with nothing pasted", async () => {
        const stub = makeFigmaStub({ exchange: exchanged() });
        ready(stub);

        await startSignIn(
            stub.api,
            relay(() => reply({ json: async () => ({ status: "ready", code: "ac:relayed", age_ms: 40 }) }))
        );

        await vi.waitFor(() => expect(lastState(stub)).toMatchObject({ status: "signedIn" }));
        expect(stub.clientStorage.get(OAUTH_RECORD_NAME)).toMatchObject({ accessToken: TOKEN });
    });

    it("sends the relay's write key as the OAuth state, because that is what routes the code", async () => {
        const stub = makeFigmaStub();
        ready(stub);

        await startSignIn(stub.api, relay());

        const url = (lastState(stub) as { authorizeUrl: string }).authorizeUrl;
        expect(stateFromUrl(url)).toBe(WRITE_KEY);
        expect(url).toContain(encodeURIComponent(OAUTH_REDIRECT_URI));
        expect(url).toContain("code_challenge_method=S256");
    });

    it("abandons a code the relay held too long instead of spending a corpse", async () => {
        const stub = makeFigmaStub({ exchange: exchanged() });
        ready(stub);

        await startSignIn(
            stub.api,
            relay(() =>
                reply({
                    json: async () => ({ status: "ready", code: "ac:stale", age_ms: 120000 }),
                })
            )
        );

        await vi.waitFor(() => expect(lastState(stub)?.status).toBe("failed"));
        expect(stub.posted.some((m) => m.type === "exchange-request")).toBe(false);
    });

    it("routes a refusal from the relay into the denied screen, not a generic failure", async () => {
        const stub = makeFigmaStub();
        ready(stub);

        await startSignIn(
            stub.api,
            relay(() =>
                reply({ json: async () => ({ status: "error", error: "access_denied" }) })
            )
        );

        await vi.waitFor(() => expect(lastState(stub)).toEqual({ status: "denied" }));
    });

    it("stops polling when the user cancels, so a late code cannot sign them in anyway", async () => {
        const stub = makeFigmaStub({ exchange: exchanged() });
        ready(stub);

        let deliver = false;
        await startSignIn(
            stub.api,
            relay(() =>
                reply({
                    json: async () =>
                        deliver
                            ? { status: "ready", code: "ac:late", age_ms: 10 }
                            : { status: "pending" },
                })
            )
        );

        await cancelSignIn(stub.api);
        deliver = true;

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(lastState(stub)?.status).not.toBe("signedIn");
        expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
    });
});

describe("submitAuthResponse", () => {
    it("refuses when there is no pending flow, and says so accurately", async () => {
        const stub = makeFigmaStub();
        ready(stub);

        await submitAuthResponse(stub.api, "ac:whatever12345");

        expect(lastState(stub)).toEqual({ status: "failed", reason: SIGN_IN_NO_SESSION_ERR });
    });

    it("KEEPS the pending flow when the paste is unreadable", async () => {
        const stub = makeFigmaStub({ exchange: exchanged() });
        ready(stub);
        await startSignIn(stub.api, relay());

        await submitAuthResponse(stub.api, "Sign-in complete!");

        expect(lastState(stub)).toEqual({
            status: "failed",
            reason: SIGN_IN_CODE_UNREADABLE_ERR,
        });
        expect(hasPendingSignIn()).toBe(true);

        await submitAuthResponse(stub.api, "ac:good1234567890");
        expect(lastState(stub)).toMatchObject({ status: "signedIn" });
    });

    it("reports access_denied as its own state, naming the actor", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await startSignIn(stub.api, relay());

        await submitAuthResponse(
            stub.api,
            "http://localhost:8080/callback.html?error=access_denied"
        );

        expect(lastState(stub)).toEqual({ status: "denied" });
        expect(hasPendingSignIn()).toBe(false);
    });

    it("refuses a response whose state is not the one it sent", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await startSignIn(stub.api, relay());
        const fetchFn = fetchStub(tokenReply());

        await submitAuthResponse(stub.api, "?code=abc12345&state=not-the-one");

        expect(lastState(stub)).toEqual({
            status: "failed",
            reason: SIGN_IN_STATE_MISMATCH_ERR,
        });
        expect(fetchFn).not.toHaveBeenCalled();
        expect(hasPendingSignIn()).toBe(false);
    });

    it("accepts a response carrying the matching state", async () => {
        const stub = makeFigmaStub({ exchange: exchanged() });
        ready(stub);
        await startSignIn(stub.api, relay());
        const sent = stateFromUrl((lastState(stub) as { authorizeUrl: string }).authorizeUrl);

        await submitAuthResponse(
            stub.api,
            `?code=abc12345&state=${encodeURIComponent(sent)}`
        );

        expect(lastState(stub)).toMatchObject({ status: "signedIn" });
    });

    it("stores the record, posts the credential, and reports the granted scopes", async () => {
        const stub = makeFigmaStub({
            clientStorage: { [API_KEY_NAME]: KEY },
            exchange: exchanged({ id_token: jwt({ name: "Ada" }) }),
        });
        ready(stub);
        await startSignIn(stub.api, relay());

        await submitAuthResponse(stub.api, "ac:good1234567890");

        expect(lastState(stub)).toMatchObject({
            status: "signedIn",
            name: "Ada",
            scopes: ["openid", "profile", "workflows.execute"],
        });

        const stored = stub.clientStorage.get(OAUTH_RECORD_NAME) as Record<string, unknown>;
        expect(stored).toMatchObject({ accessToken: TOKEN, refreshToken: "rt:new" });
        expect(stub.clientStorage.get(API_KEY_NAME)).toBe(KEY);

        const credential = stub.posted.filter((m) => m.type === TYPE_CREDENTIAL).at(-1);
        expect(credential?.payload).toMatchObject({
            credential: { kind: "oauth", token: TOKEN },
            apiKey: KEY,
        });
    });

    it("clears the pending flow BEFORE the exchange, so an impatient second press cannot re-send", async () => {
        const stub = makeFigmaStub({ exchange: "silent" });
        ready(stub);
        await startSignIn(stub.api, relay());

        const inFlight = submitAuthResponse(stub.api, "ac:good1234567890");
        expect(hasPendingSignIn()).toBe(false);

        await submitAuthResponse(stub.api, "ac:good1234567890");
        expect(lastState(stub)).toEqual({ status: "failed", reason: SIGN_IN_NO_SESSION_ERR });

        expect(
            stub.posted.filter((m) => m.type === "exchange-request")
        ).toHaveLength(1);
        void inFlight;
    });

    it("reports a descoped token as a scope failure, and stores nothing", async () => {
        const stub = makeFigmaStub({ exchange: { ok: true, body: { access_token: DESCOPED } } });
        ready(stub);
        await startSignIn(stub.api, relay());

        await submitAuthResponse(stub.api, "ac:good1234567890");

        expect(lastState(stub)).toEqual({ status: "failed", reason: SESSION_SCOPE_ERR });
        expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
    });

    it("says the plugin was refused, not that the connection is bad, on a CORS block", async () => {
        const stub = makeFigmaStub({
            exchange: { ok: false, error: "not readable from this origin", throttled: true },
        });
        ready(stub);
        await startSignIn(stub.api, relay());

        await submitAuthResponse(stub.api, "ac:good1234567890");

        expect(lastState(stub)).toEqual({ status: "failed", reason: SIGN_IN_BLOCKED_ERR });
    });

    it("does not claim to be reachable when it is not", async () => {
        const stub = makeFigmaStub({
            exchange: { ok: false, error: "could not reach the token endpoint at all" },
        });
        ready(stub);
        await startSignIn(stub.api, relay());

        await submitAuthResponse(stub.api, "ac:good1234567890");

        expect(lastState(stub)).toEqual({ status: "failed", reason: SIGN_IN_UNREACHABLE_ERR });
    });

    it("keeps the current session usable but warns it will not survive a relaunch when storage fails", async () => {
        const stub = makeFigmaStub({ storageFails: { set: true }, exchange: exchanged() });
        ready(stub);
        await startSignIn(stub.api, relay());

        await submitAuthResponse(stub.api, "ac:good1234567890");

        expect(lastState(stub)).toMatchObject({ status: "signedIn" });
        expect(stub.notified).toEqual([{ msg: SIGN_IN_NOT_REMEMBERED_ERR, error: true }]);
        await expect(activeCredential(stub.api)).resolves.toMatchObject({ credential: { kind: "oauth", token: TOKEN } });
        expect(
            stub.posted.filter((m) => m.type === TYPE_CREDENTIAL).at(-1)?.payload
        ).toMatchObject({ credential: { kind: "oauth", token: TOKEN } });
    });
});

describe("cancelSignIn", () => {
    it("is the exit from the case nothing else can end", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await startSignIn(stub.api, relay());

        await cancelSignIn(stub.api);

        expect(lastState(stub)).toMatchObject({ status: "armed" });
        expect(hasPendingSignIn()).toBe(false);
        expect(stub.notified).toHaveLength(1);
    });

    it("says nothing when there was nothing to cancel", async () => {
        const stub = makeFigmaStub();
        ready(stub);

        await cancelSignIn(stub.api);

        expect(stub.notified).toEqual([]);
        expect(lastState(stub)).toMatchObject({ status: "armed" });
    });
});

describe("activeCredential", () => {
    it("returns the API key when that is all there is", async () => {
        const stub = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });

        expect(await activeCredential(stub.api)).toEqual({
            credential: { kind: "apikey", token: KEY },
            apiKey: KEY,
        });
    });

    it("returns nothing at all when there is neither", async () => {
        const stub = makeFigmaStub({ clientStorage: {} });
        expect(await activeCredential(stub.api)).toEqual({ credential: null, apiKey: "" });
    });

    it("prefers OAuth over a retained key (decision D4)", async () => {
        const stub = makeFigmaStub({
            clientStorage: { [API_KEY_NAME]: KEY, [OAUTH_RECORD_NAME]: record() },
        });

        const active = await activeCredential(stub.api);

        expect(active.credential).toMatchObject({ kind: "oauth", token: TOKEN });
        expect(active.apiKey).toBe(KEY);
    });

    it("resolves a rejected storage read to no credential rather than throwing", async () => {
        const stub = makeFigmaStub({ storageFails: { get: true } });
        expect(await activeCredential(stub.api)).toEqual({ credential: null, apiKey: "" });
    });

    describe("when the access token has expired", () => {
        const expired = { [OAUTH_RECORD_NAME]: record({ expiresAt: Date.now() - 1000 }) };

        it("refreshes and adopts the new token", async () => {
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: exchanged(),
            });
            ready(stub);

            const active = await activeCredential(stub.api);

            expect(active.credential).toMatchObject({ kind: "oauth", token: TOKEN });
            expect(stub.clientStorage.get(OAUTH_RECORD_NAME)).toMatchObject({
                refreshToken: "rt:new",
            });
            expect(authState()).toMatchObject({ status: "signedIn" });
        });

        it("keeps the stored refresh token when the server issues no new one", async () => {
            // RFC 6749 section 6: a new refresh token is optional on a refresh. Taking
            // the response literally drops the one that still works, and the session
            // then dies at the NEXT expiry with "your session has ended".
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: exchanged({ refresh_token: undefined }),
            });
            ready(stub);

            const active = await activeCredential(stub.api);

            expect(active.credential).toMatchObject({ kind: "oauth", token: TOKEN });
            expect(stub.clientStorage.get(OAUTH_RECORD_NAME)).toMatchObject({
                refreshToken: "rt:stored",
            });
        });

        it("refreshes SILENTLY, so a background refresh cannot hijack the panel", async () => {
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: exchanged(),
            });
            ready(stub);

            await activeCredential(stub.api);

            expect(states(stub)).toEqual([]);
            expect(authState()).toMatchObject({ status: "signedIn" });
        });

        it("still says a terminal failure out loud", async () => {
            const stub = makeFigmaStub({
                clientStorage: {
                    [OAUTH_RECORD_NAME]: record({
                        expiresAt: Date.now() - 1000,
                        refreshToken: undefined,
                    }),
                },
            });
            ready(stub);

            await activeCredential(stub.api);

            expect(lastState(stub)).toEqual({ status: "failed", reason: SESSION_ENDED_ERR });
        });

        it("does not overwrite a sign-in the user has on screen", async () => {
            const stub = makeFigmaStub({
                clientStorage: { [OAUTH_RECORD_NAME]: record() },
                exchange: exchanged(),
            });
            ready(stub);
            await startSignIn(stub.api, relay());

            await activeCredential(stub.api);

            expect(authState().status).toBe("awaiting");
        });

        it("collapses two concurrent callers into ONE refresh", async () => {
            let requests = 0;
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: () => {
                    requests++;
                    return exchanged();
                },
            });
            ready(stub);

            const [a, b] = await Promise.all([
                activeCredential(stub.api),
                activeCredential(stub.api),
            ]);

            expect(requests).toBe(1);
            expect(a.credential).toMatchObject({ kind: "oauth" });
            expect(b.credential).toMatchObject({ kind: "oauth" });
        });

        it("adopts another document's rotation instead of signing the user out", async () => {
            const rotated = record({ writtenAt: 9999, accessToken: TOKEN });
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: () => {
                    stub.clientStorage.set(OAUTH_RECORD_NAME, rotated);
                    return {
                        ok: false as const,
                        status: 400,
                        error: 'token exchange failed: HTTP 400 {"error":"invalid_grant"}',
                    };
                },
            });
            ready(stub);

            const active = await activeCredential(stub.api);

            expect(active.credential).toMatchObject({ kind: "oauth", token: TOKEN });
            expect(authState()).toMatchObject({ status: "signedIn" });
            expect(stub.clientStorage.get(OAUTH_RECORD_NAME)).toBe(rotated);
        });

        it("ends the session on an invalid_grant that storage still agrees with", async () => {
            const stub = makeFigmaStub({
                clientStorage: { ...expired, [API_KEY_NAME]: KEY },
                exchange: {
                    ok: false,
                    status: 400,
                    error: 'token exchange failed: HTTP 400 {"error":"invalid_grant"}',
                },
            });
            ready(stub);

            const active = await activeCredential(stub.api);

            expect(lastState(stub)).toEqual({ status: "failed", reason: SESSION_ENDED_ERR });
            expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
            expect(active.credential).toEqual({ kind: "apikey", token: KEY });
        });

        it("KEEPS the record when the refresh is blocked, and says which it was", async () => {
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: { ok: false, error: "the reply was not readable", throttled: true },
            });
            ready(stub);

            const active = await activeCredential(stub.api);

            expect(lastState(stub)).toEqual({ status: "failed", reason: SIGN_IN_BLOCKED_ERR });
            expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(true);
            expect(active.credential).toBeNull();
        });

        it("KEEPS the record when the refresh could not reach a server", async () => {
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: { ok: false, error: "could not reach the token endpoint at all" },
            });
            ready(stub);

            const active = await activeCredential(stub.api);

            expect(lastState(stub)).toEqual({
                status: "failed",
                reason: SIGN_IN_UNREACHABLE_ERR,
            });
            expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(true);
            expect(active.credential).toBeNull();
        });

        it("ends the session, out loud, when there is no refresh token behind it", async () => {
            const stub = makeFigmaStub({
                clientStorage: {
                    [OAUTH_RECORD_NAME]: record({
                        expiresAt: Date.now() - 1000,
                        refreshToken: undefined,
                    }),
                },
            });
            ready(stub);

            await activeCredential(stub.api);

            expect(lastState(stub)).toEqual({ status: "failed", reason: SESSION_ENDED_ERR });
            expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
        });

        it("clears a session whose refresh came back missing a scope", async () => {
            const stub = makeFigmaStub({
                clientStorage: { ...expired },
                exchange: { ok: true, body: { access_token: DESCOPED } },
            });
            ready(stub);

            await activeCredential(stub.api);

            expect(lastState(stub)).toEqual({ status: "failed", reason: SESSION_SCOPE_ERR });
            expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
        });
    });
});

describe("refreshCredentialNow", () => {
    it("refreshes even when the local clock thinks the token is fine", async () => {
        let requests = 0;
        const stub = makeFigmaStub({
            clientStorage: { [OAUTH_RECORD_NAME]: record() },
            exchange: () => {
                requests++;
                return exchanged();
            },
        });
        ready(stub);

        const active = await refreshCredentialNow(stub.api);

        expect(requests).toBe(1);
        expect(active.credential).toMatchObject({ kind: "oauth" });
        expect(states(stub)).toEqual([]);
    });

    it("answers with the API key when there is no session to refresh", async () => {
        let requests = 0;
        const stub = makeFigmaStub({
            clientStorage: { [API_KEY_NAME]: KEY },
            exchange: () => {
                requests++;
                return exchanged();
            },
        });

        expect(await refreshCredentialNow(stub.api)).toEqual({
            credential: { kind: "apikey", token: KEY },
            apiKey: KEY,
        });
        expect(requests).toBe(0);
    });
});

describe("signOut", () => {
    it("clears locally first, then tells the user which pool is spending now", async () => {
        const stub = makeFigmaStub({
            clientStorage: { [API_KEY_NAME]: KEY, [OAUTH_RECORD_NAME]: record() },
        });
        ready(stub);

        const active = await signOut(stub.api, fetchStub(reply()));

        expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
        expect(stub.clientStorage.get(API_KEY_NAME)).toBe(KEY);
        expect(active.credential).toEqual({ kind: "apikey", token: KEY });
        expect(stub.notified).toEqual([{ msg: SIGNED_OUT_USING_KEY_MSG, error: false }]);
        expect(lastState(stub)).toEqual({ status: "idle" });
    });

    it("says something different when there is no key to fall back to", async () => {
        const stub = makeFigmaStub({ clientStorage: { [OAUTH_RECORD_NAME]: record() } });
        ready(stub);

        const active = await signOut(stub.api, fetchStub(reply()));

        expect(active.credential).toBeNull();
        expect(stub.notified).toEqual([{ msg: SIGNED_OUT_MSG, error: false }]);
    });

    it("signs the user out locally even when the server refuses", async () => {
        const stub = makeFigmaStub({ clientStorage: { [OAUTH_RECORD_NAME]: record() } });
        ready(stub);

        await signOut(stub.api, fetchStub(reply({ ok: false, status: 401 })));

        expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
        expect(lastState(stub)).toEqual({ status: "idle" });
    });
});

describe("postAuthState", () => {
    it("replays a pending sign-in into a new session (task A13)", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await startSignIn(stub.api, relay());

        const fresh = makeFigmaStub();
        resetUiBridge();
        ready(fresh);
        postAuthState(fresh.api);

        expect(lastState(fresh)).toMatchObject({ status: "awaiting" });
        expect(authState().status).toBe("awaiting");
    });

    it("replays a terminal failure faithfully until it is acknowledged", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await submitAuthResponse(stub.api, "ac:no-pending-flow");
        expect(authState().status).toBe("failed");

        const fresh = makeFigmaStub();
        resetUiBridge();
        ready(fresh);
        postAuthState(fresh.api);

        expect(lastState(fresh)).toMatchObject({ status: "failed" });
    });

    it("stops replaying once the user has navigated away", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await submitAuthResponse(stub.api, "ac:no-pending-flow");

        acknowledgeTerminalAuthState();

        expect(authState()).toEqual({ status: "idle" });
    });

    it("does NOT acknowledge a pending sign-in away, which is what A13 protects", async () => {
        const stub = makeFigmaStub();
        ready(stub);
        await startSignIn(stub.api, relay());

        acknowledgeTerminalAuthState();

        expect(authState().status).toBe("awaiting");
        expect(hasPendingSignIn()).toBe(true);
    });

    it("does not downgrade a signed-in state", async () => {
        const stub = makeFigmaStub({ exchange: exchanged() });
        ready(stub);
        await startSignIn(stub.api, relay());
        await submitAuthResponse(stub.api, "ac:good1234567890");

        postAuthState(stub.api);
        expect(authState().status).toBe("signedIn");
    });
});
