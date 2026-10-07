import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFigmaStub } from "./figmaStub";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function beta() {
    vi.resetModules();
    vi.stubGlobal("__AGENTS_BETA__", true);
    const constants = await import("../../constants/index");
    const bridge = await import("../UiBridge");
    const exchange = await import("../exchangePage");
    const session = await import("../authSession");
    const stub = makeFigmaStub();
    bridge.beginUiSession(stub.api);
    const receive = (message: Record<string, unknown>) => stub.api.ui.onmessage?.(message, { origin: "null" });
    receive({ type: "ui-ready" });
    exchange.loadExchangePage(stub.api);
    const announce = (tokenEndpoint = constants.AUTH_TOKEN) => receive({
        type: constants.TYPE_EXCHANGE_PAGE_READY, clientId: constants.OAUTH_CLIENT_ID,
        redirectUri: constants.OAUTH_REDIRECT_URI, pageOrigin: "https://api-staging.picsart.io",
        secureContext: true, tokenEndpoint,
    });
    return { constants, exchange, session, stub, announce };
}

describe("staff beta authentication environment", () => {
    it("keeps public builds on production and their existing storage", async () => {
        vi.resetModules(); vi.stubGlobal("__AGENTS_BETA__", false);
        const c = await import("../../constants/index");
        expect(c.AUTH_BASE).toBe("https://auth.picsart.com/api");
        expect(c.PICSARTURL).toBe("https://api.picsart.io/v1/");
        expect(c.EXCHANGE_PAGE_URL).toBe("https://api.picsart.io/v1/figma/auth.html");
        expect(c.OAUTH_RECORD_NAME).toBe("picsart_oauth");
    });

    it("pairs beta authorization, exchange, API requests and storage with staging", async () => {
        const { constants: c } = await beta();
        expect(c.AUTH_BASE).toBe("https://auth-stage.picsartstage2.com/api");
        expect(c.EXCHANGE_PAGE_URL).toBe("https://api-staging.picsart.io/v1/figma/auth.html");
        expect(c.PICSARTURL).toBe("https://api-staging.picsart.io/v1/");
        expect(c.GENAIURL).toBe("https://genai-api-staging.picsart.io/v1/");
        expect(c.CREDENTIAL_HOST_ALLOWLIST).not.toContain("https://api.picsart.io");
        expect(c.OAUTH_RECORD_NAME).toBe("picsart_oauth_stage");
        expect(c.API_KEY_NAME).toBe("picsart_api_key_stage");
        expect(c.OAUTH_REDIRECT_URI).toBe("https://api.picsart.io/v1/auth/handoff/callback");
    });

    it("rejects a production-issued credential even when its scopes and expiry look valid", async () => {
        const { constants: c } = await beta();
        const { tokenFromBody } = await import("../oauthClient");
        const token = (iss: string) => `e30.${Buffer.from(JSON.stringify({ iss, exp: Date.now() / 1000 + 3600, scope: "openid profile workflows.execute" })).toString("base64url")}.sig`;
        expect(tokenFromBody({ access_token: token("https://auth.picsart.com/api") }, "test").ok).toBe(false);
        expect(tokenFromBody({ access_token: token(c.AUTH_BASE) }, "test").ok).toBe(true);
    });

    it("does not open sign-in or mint a callback when the helper still uses production", async () => {
        const { constants: c, session, stub, announce } = await beta();
        announce("https://auth.picsart.com/api/oauth2/token");
        const fetcher = vi.fn();
        await session.startSignIn(stub.api, fetcher);
        expect(session.authState()).toMatchObject({ status: "failed", reason: expect.stringContaining("isn't ready") });
        expect(stub.posted.some(m => m.type === c.TYPE_AUTH_STATE && ["armed", "awaiting"].includes((m.payload as { status: string }).status))).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("times out an unavailable helper before starting OAuth", async () => {
        vi.useFakeTimers();
        const { session, stub, constants: c } = await beta();
        const fetcher = vi.fn();
        const pending = session.startSignIn(stub.api, fetcher);
        await vi.advanceTimersByTimeAsync(c.EXCHANGE_PAGE_READY_TIMEOUT_MS + 1);
        await pending;
        expect(session.authState().status).toBe("failed");
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("recognizes a matching deployed helper", async () => {
        const { exchange, stub, announce } = await beta();
        const pending = exchange.betaExchangeReady(stub.api);
        announce();
        await expect(pending).resolves.toBe(true);
    });

    it("does not reopen a sign-in canceled while checking the helper", async () => {
        vi.useFakeTimers();
        const { session, stub, constants: c } = await beta();
        const fetcher = vi.fn();
        const pending = session.startSignIn(stub.api, fetcher);
        const canceled = session.cancelSignIn(stub.api);
        await vi.advanceTimersByTimeAsync(c.EXCHANGE_PAGE_READY_TIMEOUT_MS + 1);
        await Promise.all([pending, canceled]);
        expect(session.authState().status).toBe("idle");
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("never sends a stage refresh token to an old production helper", async () => {
        const { constants: c, exchange, stub, announce } = await beta();
        announce("https://auth.picsart.com/api/oauth2/token");
        await expect(exchange.refreshViaPage(stub.api, "stage-refresh-fixture")).resolves.toMatchObject({ ok: false, reason: "blocked" });
        expect(stub.posted.some(m => m.type === c.TYPE_EXCHANGE_REQUEST)).toBe(false);
    });
});
