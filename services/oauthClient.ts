import {
    AUTH_AUTHORIZE,
    AUTH_BASE,
    AUTH_END_SESSION,
    AUTH_TOKEN,
    BALANACE,
    OAUTH_CLIENT_ID,
    OAUTH_REDIRECT_URI,
    OAUTH_SCOPES,
    PICSARTURL,
} from "@constants/index";
import { authLog } from "./authLog";
import { accessTokenExpiry, checkGrantedScopes, decodeAccessToken, grantedScopes } from "./grantedScope";
import type { OAuthRecord } from "./oauthStorage";
import { sandboxFetch, type SandboxFetchFn } from "./sandboxFetch";
import { AGENTS_BETA } from "@constants/agents";

export const isNetworkReachable = async (fetchFn?: SandboxFetchFn): Promise<boolean> => {
    const probe = await sandboxFetch(
        PICSARTURL + BALANACE,
        { method: "GET", omitAttribution: true },
        fetchFn
    );
    return probe.status !== 0;
};

const form = (fields: Record<string, string>): string =>
    Object.keys(fields)
        .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(fields[name])}`)
        .join("&");

export const buildAuthorizeUrl = (params: {
    state: string;
    challenge: string;
    redirectUri?: string;
    clientId?: string;
}): string =>
    `${AUTH_AUTHORIZE}?${form({
        response_type: "code",
        client_id: params.clientId ?? OAUTH_CLIENT_ID,
        redirect_uri: params.redirectUri ?? OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPES.join(" "),
        state: params.state,
        code_challenge: params.challenge,
        code_challenge_method: "S256",
    })}`;

export type TokenFailureReason =
    | "unreachable"
    | "blocked"
    | "invalid_grant"
    | "http"
    | "malformed"
    | "scope";

export type TokenResult =
    | {
          ok: true;
          record: Omit<OAuthRecord, "writtenAt">;
          name?: string;
      }
    | {
          ok: false;
          reason: TokenFailureReason;
          detail?: string;
          missing?: string[];
      };

interface TokenResponseBody {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
    error?: unknown;
    error_description?: unknown;
}

const asText = (value: unknown): string | undefined =>
    typeof value === "string" && value ? value : undefined;

export const tokenFromBody = (body: unknown, endpoint: string): TokenResult => {
    const parsed = (body ?? null) as TokenResponseBody | null;

    const accessToken = asText(parsed?.access_token);
    if (!accessToken) {
        authLog(`${endpoint} answered 200 with no access_token`, { body: parsed });
        return { ok: false, reason: "malformed" };
    }

    if (AGENTS_BETA && decodeAccessToken(accessToken)?.iss !== AUTH_BASE) {
        return { ok: false, reason: "malformed", detail: "The sign-in returned an account from a different environment." };
    }

    const scopeCheck = checkGrantedScopes(accessToken);
    if (!scopeCheck.ok) {
        return { ok: false, reason: "scope", missing: scopeCheck.missing };
    }

    const expiresIn =
        typeof parsed?.expires_in === "number" && isFinite(parsed.expires_in)
            ? Date.now() + parsed.expires_in * 1000
            : undefined;
    const expiresAt = accessTokenExpiry(accessToken) ?? expiresIn ?? Date.now();

    const idToken = asText(parsed?.id_token);
    const name = idToken ? asText(decodeAccessToken(idToken)?.name) : undefined;

    return {
        ok: true,
        record: {
            accessToken,
            refreshToken: asText(parsed?.refresh_token),
            expiresAt,
            scopes: grantedScopes(accessToken),
            clientId: OAUTH_CLIENT_ID,
        },
        name,
    };
};

const readTokenResponse = async (
    response: Awaited<ReturnType<typeof sandboxFetch>>,
    endpoint: string,
    fetchFn?: SandboxFetchFn
): Promise<TokenResult> => {
    if (response.status === 0) {
        const reachable = await isNetworkReachable(fetchFn);
        const reason: TokenFailureReason = reachable ? "blocked" : "unreachable";
        authLog(`${endpoint} returned no answer; classified as ${reason}`, {
            error: String(response.error),
        });
        return { ok: false, reason };
    }

    const body = (await response.json()) as TokenResponseBody | null;

    if (!response.ok) {
        const error = asText(body?.error) ?? `http_${response.status}`;
        const reason: TokenFailureReason = error === "invalid_grant" ? "invalid_grant" : "http";
        authLog(`${endpoint} refused the request`, {
            status: response.status,
            error,
            error_description: asText(body?.error_description),
        });
        return { ok: false, reason, detail: asText(body?.error_description) ?? error };
    }

    return tokenFromBody(body, endpoint);
};

const postForm = (
    fields: Record<string, string>,
    fetchFn?: SandboxFetchFn
): Promise<Awaited<ReturnType<typeof sandboxFetch>>> =>
    sandboxFetch(
        AUTH_TOKEN,
        {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            omitAttribution: true,
            body: form(fields),
        },
        fetchFn
    );

export const exchangeAuthorizationCode = async (
    params: { code: string; verifier: string; redirectUri?: string },
    fetchFn?: SandboxFetchFn
): Promise<TokenResult> => {
    const response = await postForm(
        {
            grant_type: "authorization_code",
            client_id: OAUTH_CLIENT_ID,
            code: params.code,
            redirect_uri: params.redirectUri ?? OAUTH_REDIRECT_URI,
            code_verifier: params.verifier,
        },
        fetchFn
    );
    return readTokenResponse(response, "oauth2/token (authorization_code)", fetchFn);
};

export const refreshAccessToken = async (
    params: { refreshToken: string },
    fetchFn?: SandboxFetchFn
): Promise<TokenResult> => {
    const response = await postForm(
        {
            grant_type: "refresh_token",
            client_id: OAUTH_CLIENT_ID,
            refresh_token: params.refreshToken,
        },
        fetchFn
    );
    return readTokenResponse(response, "oauth2/token (refresh_token)", fetchFn);
};

export const endSession = async (
    params: { idToken?: string } = {},
    fetchFn?: SandboxFetchFn
): Promise<boolean> => {
    const query = form({
        client_id: OAUTH_CLIENT_ID,
        ...(params.idToken ? { id_token_hint: params.idToken } : {}),
    });

    const response = await sandboxFetch(
        `${AUTH_END_SESSION}?${query}`,
        { method: "GET", omitAttribution: true },
        fetchFn
    );

    if (!response.ok) {
        authLog("end_session_endpoint did not acknowledge the sign-out", {
            status: response.status,
        });
    }
    return response.ok;
};

export default exchangeAuthorizationCode;
