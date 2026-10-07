// @vitest-environment jsdom
//
// The UI half of the token exchange, which had no test at all — and was where a
// signed-in session quietly died overnight.
//
// Two things are asserted here and nothing else in the repo asserts either:
//
// 1. **Every field the sandbox sends reaches the page.** `refreshViaPage` posts
//    `{ grant: "refresh", refresh_token }`; the UI used to destructure exactly
//    `{ nonce, code, verifier }` and forward those three, so a refresh arrived at
//    api.picsart.io as an authorization_code exchange with no code. The sandbox
//    side is covered (services/__tests__/exchangePage.test.ts asserts the fields
//    go out); nothing covered whether they arrive.
//
// 2. **A request is held until the page says it is ready.** `loadExchangePage`
//    and the first `TYPE_EXCHANGE_REQUEST` are drained from the UiBridge queue
//    back to back in one flush, so the iframe is still on about:blank when the
//    request is forwarded — and `postMessage` to a targetOrigin the target does
//    not have is discarded with no error. Sign-in never noticed (the user spends
//    a minute in a browser first); the startup refresh always hit it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXCHANGE_PAGE_READY_TIMEOUT_MS, TYPE_EXCHANGE_RESULT } from "@constants/index";

const mocks = vi.hoisted(() => ({ sendMessageToSandBox: vi.fn() }));

vi.mock("@api/index", () => ({ sendMessageToSandBox: mocks.sendMessageToSandBox }));

import {
    forwardFromExchangePage,
    loadExchangePage,
    requestExchange,
    resetExchangeFrame,
} from "../exchangeFrame";

const PAGE_URL = "https://api.picsart.io/v1/figma/auth.html";
const PAGE_ORIGIN = "https://api.picsart.io";

const readyEvent = () =>
    ({
        origin: PAGE_ORIGIN,
        source: document.querySelector("iframe")?.contentWindow,
        data: {
            type: "picsart-auth-ready",
            clientId: "client",
            redirectUri: "https://api.picsart.io/v1/auth/handoff/callback",
            origin: PAGE_ORIGIN,
            secureContext: true,
            tokenEndpoint: "https://auth.picsart.com/api/oauth2/token",
        },
    }) as unknown as MessageEvent;

/** The frame the module just appended, with its postMessage spied on. */
const spyOnFrame = () => {
    const frame = document.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("no exchange iframe was created");
    return vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(() => undefined);
};

const resultsToSandbox = () =>
    mocks.sendMessageToSandBox.mock.calls.filter((call) => call[2] === TYPE_EXCHANGE_RESULT);

beforeEach(() => {
    vi.useFakeTimers();
    mocks.sendMessageToSandBox.mockClear();
    document.body.innerHTML = "";
    resetExchangeFrame();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the exchange frame", () => {
    it("ignores another frame on the same origin and forwards the actual helper's token endpoint", () => {
        loadExchangePage(PAGE_URL);
        spyOnFrame();
        forwardFromExchangePage({ ...readyEvent(), source: window } as MessageEvent);
        expect(mocks.sendMessageToSandBox).not.toHaveBeenCalled();
        forwardFromExchangePage(readyEvent());
        expect(mocks.sendMessageToSandBox.mock.calls[0][4]).toHaveProperty("tokenEndpoint", "https://auth.picsart.com/api/oauth2/token");
    });
    it("forwards the refresh grant, not just the authorization-code fields", () => {
        loadExchangePage(PAGE_URL);
        const posted = spyOnFrame();
        forwardFromExchangePage(readyEvent());

        requestExchange(7, { grant: "refresh", refresh_token: "rt:stored" });

        expect(posted).toHaveBeenCalledTimes(1);
        expect(posted.mock.calls[0][0]).toMatchObject({
            type: "picsart-auth-exchange",
            nonce: 7,
            grant: "refresh",
            refresh_token: "rt:stored",
        });
        expect(posted.mock.calls[0][1]).toBe(PAGE_ORIGIN);
    });

    it("still forwards a code exchange", () => {
        loadExchangePage(PAGE_URL);
        const posted = spyOnFrame();
        forwardFromExchangePage(readyEvent());

        requestExchange(1, { code: "abc", verifier: "xyz" });

        expect(posted.mock.calls[0][0]).toMatchObject({
            type: "picsart-auth-exchange",
            nonce: 1,
            code: "abc",
            verifier: "xyz",
        });
    });

    it("holds a request that arrives before the page is ready, then sends it", () => {
        loadExchangePage(PAGE_URL);
        const posted = spyOnFrame();

        requestExchange(3, { grant: "refresh", refresh_token: "rt:stored" });

        // The iframe is still on about:blank. Sending now is the same as not sending.
        expect(posted).not.toHaveBeenCalled();
        expect(resultsToSandbox()).toHaveLength(0);

        forwardFromExchangePage(readyEvent());

        expect(posted).toHaveBeenCalledTimes(1);
        expect(posted.mock.calls[0][0]).toMatchObject({
            nonce: 3,
            grant: "refresh",
            refresh_token: "rt:stored",
        });
    });

    it("keeps held requests in order and sends each exactly once", () => {
        loadExchangePage(PAGE_URL);
        const posted = spyOnFrame();

        requestExchange(1, { code: "a", verifier: "v" });
        requestExchange(2, { grant: "refresh", refresh_token: "rt" });
        forwardFromExchangePage(readyEvent());
        forwardFromExchangePage(readyEvent());

        expect(posted).toHaveBeenCalledTimes(2);
        expect(posted.mock.calls.map((call) => (call[0] as { nonce: number }).nonce)).toEqual([
            1, 2,
        ]);
    });

    it("fails a held request when the page never answers, rather than leaving it to hang", () => {
        loadExchangePage(PAGE_URL);
        spyOnFrame();

        requestExchange(5, { grant: "refresh", refresh_token: "rt:stored" });
        expect(resultsToSandbox()).toHaveLength(0);

        vi.advanceTimersByTime(EXCHANGE_PAGE_READY_TIMEOUT_MS + 1);

        const results = resultsToSandbox();
        expect(results).toHaveLength(1);
        expect(results[0][4]).toMatchObject({ nonce: 5, ok: false });
        expect(String((results[0][4] as { error?: string }).error)).toContain(PAGE_URL);
    });

    it("reports a request made with no frame at all", () => {
        requestExchange(9, { grant: "refresh", refresh_token: "rt" });

        const results = resultsToSandbox();
        expect(results).toHaveLength(1);
        expect(results[0][4]).toMatchObject({ nonce: 9, ok: false });
    });
});
