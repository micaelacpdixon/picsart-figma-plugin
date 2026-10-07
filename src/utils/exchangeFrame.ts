import {
    EXCHANGE_PAGE_READY_TIMEOUT_MS,
    TYPE_EXCHANGE_PAGE_READY,
    TYPE_EXCHANGE_RESULT,
} from "@constants/index";
import { sendMessageToSandBox } from "@api/index";

export type ExchangeFields = Record<string, unknown>;

const PAGE_PREFIX = "picsart-auth-";
const PAGE_READY = "picsart-auth-ready";
const PAGE_RESULT = "picsart-auth-result";
const PAGE_REQUEST = "picsart-auth-exchange";

let frame: HTMLIFrameElement | undefined;
let frameOrigin: string | undefined;
let announced = false;

let held: { nonce: number; fields: ExchangeFields }[] = [];

export const isExchangePageMessage = (data: unknown): boolean =>
    !!data &&
    typeof data === "object" &&
    !("pluginMessage" in (data as Record<string, unknown>)) &&
    typeof (data as { type?: unknown }).type === "string" &&
    (data as { type: string }).type.indexOf(PAGE_PREFIX) === 0;

const failRequest = (nonce: number, error: string): void => {
    sendMessageToSandBox(true, "", TYPE_EXCHANGE_RESULT, undefined, {
        nonce,
        ok: false,
        error,
    });
};

const deliver = (nonce: number, fields: ExchangeFields): void => {
    // Spread first, so the page's own envelope wins over anything carried in the
    // payload — the sandbox message arrives with `type: "exchange-request"` on it.
    frame?.contentWindow?.postMessage(
        { ...fields, type: PAGE_REQUEST, nonce },
        frameOrigin ?? "*"
    );
};

export const loadExchangePage = (url: string): void => {
    if (frame) return;
    try {
        frameOrigin = new URL(url).origin;
    } catch {
        frameOrigin = undefined;
    }

    const element = document.createElement("iframe");
    element.setAttribute("title", "Picsart sign-in");
    element.setAttribute("aria-hidden", "true");
    element.style.display = "none";
    element.src = url;
    document.body.appendChild(element);
    frame = element;

    setTimeout(() => {
        if (announced) return;
        console.error(
            `The Picsart sign-in page at ${url} did not answer within ` +
                `${EXCHANGE_PAGE_READY_TIMEOUT_MS}ms. Signing in cannot complete: a plugin ` +
                `cannot perform the token exchange itself.`
        );

        const stranded = held;
        held = [];
        stranded.forEach(({ nonce }) =>
            failRequest(
                nonce,
                `the Picsart sign-in page at ${url} never loaded, so the request could not be sent`
            )
        );
    }, EXCHANGE_PAGE_READY_TIMEOUT_MS);
};

export const forwardFromExchangePage = (event: MessageEvent): void => {
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
    if (frameOrigin && event.origin !== frameOrigin) return;
    const message = event.data as Record<string, unknown>;

    if (message.type === PAGE_READY) {
        const first = !announced;
        announced = true;
        sendMessageToSandBox(true, "", TYPE_EXCHANGE_PAGE_READY, undefined, {
            clientId: message.clientId,
            redirectUri: message.redirectUri,
            pageOrigin: message.origin,
            secureContext: message.secureContext,
            tokenEndpoint: message.tokenEndpoint,
        });

        if (first) {
            const waiting = held;
            held = [];
            waiting.forEach(({ nonce, fields }) => deliver(nonce, fields));
        }
        return;
    }

    if (message.type === PAGE_RESULT) {
        sendMessageToSandBox(true, "", TYPE_EXCHANGE_RESULT, undefined, {
            nonce: message.nonce,
            ok: !!message.ok,
            error: message.error,
            status: message.status,
            throttled: message.throttled,
            access_token: message.access_token,
            id_token: message.id_token,
            refresh_token: message.refresh_token,
            expires_in: message.expires_in,
            scope: message.scope,
        });
    }
};

export const requestExchange = (nonce: number, fields: ExchangeFields): void => {
    if (!frame) {
        failRequest(
            nonce,
            "the Picsart sign-in page is not loaded, so the request cannot be exchanged"
        );
        return;
    }

    if (!announced) {
        held.push({ nonce, fields });
        return;
    }

    if (!frame.contentWindow) {
        failRequest(
            nonce,
            "the Picsart sign-in page has no window, so the request cannot be exchanged"
        );
        return;
    }

    deliver(nonce, fields);
};

export const resetExchangeFrame = (): void => {
    frame = undefined;
    frameOrigin = undefined;
    announced = false;
    held = [];
};
