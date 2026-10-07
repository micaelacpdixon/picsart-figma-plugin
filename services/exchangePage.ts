import {
    EXCHANGE_PAGE_URL,
    EXCHANGE_PAGE_READY_TIMEOUT_MS,
    EXCHANGE_TIMEOUT_MS,
    AUTH_TOKEN,
    OAUTH_CLIENT_ID,
    OAUTH_REDIRECT_URI,
    TYPE_EXCHANGE_PAGE_READY,
    TYPE_EXCHANGE_REQUEST,
    TYPE_EXCHANGE_RESULT,
    TYPE_LOAD_EXCHANGE_PAGE,
} from "@constants/index";
import { authLog } from "./authLog";
import type { TokenFailureReason } from "./oauthClient";
import { addUiMessageHandler, postToUi } from "./UiBridge";
import { AGENTS_BETA } from "@constants/agents";

export interface ExchangePageInfo {
    clientId?: string;
    redirectUri?: string;
    pageOrigin?: string;
    secureContext?: boolean;
    tokenEndpoint?: string;
}

let page: ExchangePageInfo | undefined;
let requested = false;
let nextNonce = 0;
const waiters = new Map<number, (result: ExchangeReply) => void>();
const readyWaiters = new Set<() => void>();

export type ExchangeReply =
    | {
          ok: true;
          access_token?: unknown;
          id_token?: unknown;
          refresh_token?: unknown;
          expires_in?: unknown;
          scope?: unknown;
      }
    | {
          ok: false;
          reason: TokenFailureReason;
          error?: string;
          status?: number;
          throttled?: boolean;
      };

interface IncomingExchangeMessage {
    type?: string;
    nonce?: number;
    ok?: boolean;
    error?: string;
    status?: number;
    throttled?: boolean;
    clientId?: string;
    redirectUri?: string;
    pageOrigin?: string;
    secureContext?: boolean;
    tokenEndpoint?: string;
    [key: string]: unknown;
}

const classify = (message: IncomingExchangeMessage): TokenFailureReason => {
    if (typeof message.status === "number" && message.status > 0) {
        return /invalid_grant/i.test(String(message.error ?? "")) ? "invalid_grant" : "http";
    }
    if (message.throttled) return "blocked";
    return "unreachable";
};

const handleMessage = (message: IncomingExchangeMessage) => {
    if (!message) return;

    if (message.type === TYPE_EXCHANGE_PAGE_READY) {
        page = {
            clientId: message.clientId,
            redirectUri: message.redirectUri,
            pageOrigin: message.pageOrigin,
            secureContext: message.secureContext,
            tokenEndpoint: message.tokenEndpoint,
        };

        if (page.clientId && page.clientId !== OAUTH_CLIENT_ID) {
            authLog("the exchange page is pinned to a different client than this build", {
                page: page.clientId,
                plugin: OAUTH_CLIENT_ID,
            });
        }
        if (page.redirectUri && page.redirectUri !== OAUTH_REDIRECT_URI) {
            authLog("the exchange page is pinned to a different redirect_uri", {
                page: page.redirectUri,
                plugin: OAUTH_REDIRECT_URI,
            });
        }
        if (!page.pageOrigin || page.pageOrigin === "null") {
            authLog("the exchange page reported an opaque origin; the exchange cannot work");
        }
        readyWaiters.forEach(resolve => resolve());
        return;
    }

    if (message.type === TYPE_EXCHANGE_RESULT) {
        const waiter = typeof message.nonce === "number" ? waiters.get(message.nonce) : undefined;
        if (!waiter) return;
        waiters.delete(message.nonce as number);
        waiter(
            message.ok
                ? {
                      ok: true,
                      access_token: message.access_token,
                      id_token: message.id_token,
                      refresh_token: message.refresh_token,
                      expires_in: message.expires_in,
                      scope: message.scope,
                  }
                : {
                      ok: false,
                      reason: classify(message),
                      error: message.error,
                      status: message.status,
                      throttled: message.throttled,
                  }
        );
    }
};

export const loadExchangePage = (pluginApi: PluginAPI) => {
    addUiMessageHandler(pluginApi, handleMessage);
    requested = true;
    postToUi(pluginApi, { type: TYPE_LOAD_EXCHANGE_PAGE, url: EXCHANGE_PAGE_URL });
};

export const exchangePageInfo = (): ExchangePageInfo | undefined => page;

export const BETA_SIGN_IN_UNAVAILABLE = "Staff beta sign-in isn't ready yet. Please try again once the beta is enabled.";

const matchesBeta = (): boolean => !!page && page.clientId === OAUTH_CLIENT_ID
    && page.redirectUri === OAUTH_REDIRECT_URI && page.tokenEndpoint === AUTH_TOKEN
    && page.pageOrigin === "https://api-staging.picsart.io" && page.secureContext === true;

// Older staging helpers exchange with production. Never send a staging code or
// refresh token to that helper, or open a login that cannot return successfully.
export const betaExchangeReady = async (pluginApi: PluginAPI): Promise<boolean> => {
    if (!AGENTS_BETA) return true;
    if (page) return matchesBeta();
    if (!requested) loadExchangePage(pluginApi);
    await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); readyWaiters.delete(finish); resolve(); };
        const timer = setTimeout(finish, EXCHANGE_PAGE_READY_TIMEOUT_MS);
        readyWaiters.add(finish);
    });
    return matchesBeta();
};

export const resetExchangePage = () => {
    readyWaiters.forEach(resolve => resolve());
    readyWaiters.clear();
    page = undefined;
    requested = false;
    nextNonce = 0;
    waiters.clear();
};

const requestFromPage = async (
    pluginApi: PluginAPI,
    fields: Record<string, unknown>
): Promise<ExchangeReply> => {
    if (AGENTS_BETA && !await betaExchangeReady(pluginApi)) {
        return { ok: false, reason: "blocked", error: BETA_SIGN_IN_UNAVAILABLE };
    }
    return new Promise<ExchangeReply>((resolve) => {
        addUiMessageHandler(pluginApi, handleMessage);
        if (!requested) {
            loadExchangePage(pluginApi);
        }

        const nonce = ++nextNonce;
        const timer = setTimeout(() => {
            waiters.delete(nonce);
            authLog("the exchange page did not answer", { ms: EXCHANGE_TIMEOUT_MS });
            resolve({
                ok: false,
                reason: page ? "unreachable" : "blocked",
                error:
                    `the exchange page at ${EXCHANGE_PAGE_URL} did not answer` +
                    (page ? "" : " and never loaded") +
                    `. A plugin realm cannot perform the exchange itself, so there is ` +
                    `nowhere else to do it.`,
            });
        }, EXCHANGE_TIMEOUT_MS);

        waiters.set(nonce, (reply) => {
            clearTimeout(timer);
            resolve(reply);
        });

        postToUi(pluginApi, { type: TYPE_EXCHANGE_REQUEST, nonce, ...fields });
    });
};

export const exchangeViaPage = (
    pluginApi: PluginAPI,
    code: string,
    verifier: string
): Promise<ExchangeReply> => requestFromPage(pluginApi, { code, verifier });

export const refreshViaPage = (
    pluginApi: PluginAPI,
    refreshToken: string
): Promise<ExchangeReply> =>
    requestFromPage(pluginApi, { grant: "refresh", refresh_token: refreshToken });
