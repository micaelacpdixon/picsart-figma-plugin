import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMessageListeners } from "../MessageListeners";
import { authState, resetAuthSession } from "../authSession";
import { beginUiSession, resetUiBridge } from "../UiBridge";
import CustomSessionStorage from "../CustomSessionStorage";
import { NO_CREDENTIAL_IDENTITY, apiKeyIdentity } from "../credentialIdentity";
import {
  API_KEY_NAME,
  KEY_REMOVED,
  KEY_REMOVE_FAILED,
  KEY_SAVE_FAILED,
  KEY_SET,
  NODE_CANNOT_HOLD_IMAGE_ERR,
  SOURCE_LAYER_GONE_ERR,
  TYPE_APPLY_IMAGE,
  TYPE_CLOSE_PLUGIN,
  TYPE_GET_BALANCE,
  TYPE_IMAGE_BYTES_RESULT,
  TYPE_CREDENTIAL,
  TYPE_NOTIFY,
  TYPE_RESIZE,
  WIDGET_WIDTH,
  TYPE_PLACEMENT_DONE,
  TYPE_PLACE_EDITED_IMAGES,
  TYPE_REMOVE_KEY,
  TYPE_REQUEST_IMAGE_BYTES,
  TYPE_SET_BALANCE,
  TYPE_SET_KEY,
  TYPE_AUTH_RESPONSE,
  TYPE_CANCEL_SIGN_IN,
  TYPE_REFRESH_CREDENTIAL,
  TYPE_SIGN_IN,
  TYPE_SIGN_OUT,
  TYPE_SWITCH_TAB,
  TAB_UPSCALE,
  OAUTH_RECORD_NAME,
  SIGNED_OUT_USING_KEY_MSG,
  WIDGET_HEIGHT_WITHOUT_KEY,
} from "../../constants/index";
const balanceApi = vi.hoisted(() => ({ getBalance: vi.fn() }));
vi.mock("@api/getBalance", () => ({ getBalance: balanceApi.getBalance }));

import { resetBalanceReads } from "../balance";
import { imagePaint, makeFigmaStub, makeNode, solidPaint } from "./figmaStub";

/**
 * Every message from the UI goes through one dispatcher, and it had no tests at all —
 * the largest coverage gap in the repo. Both of the money-path defects that present as
 * "I clicked the button, I got charged, nothing happened" live in here or one call
 * away, and neither needs an API key to exercise.
 */

const BYTES = new Uint8Array([7, 7, 7]);
const KEY = "test-api-key";

// Drives a message through the real bridge rather than calling the handler directly,
// so the registration path and the queue are part of what is under test.
const send = async (api: PluginAPI, message: Record<string, unknown>) => {
  await (api.ui.onmessage as (m: unknown) => Promise<void>)(message);
};

const ready = (api: PluginAPI) => {
  beginUiSession(api);
  // The bridge holds everything until the UI announces itself.
  (api.ui.onmessage as (m: { type: string }) => unknown)({ type: "ui-ready" });
  setMessageListeners(api);
};

describe("handleUiMessage", () => {
  beforeEach(() => {
    resetUiBridge();
    resetAuthSession();
  });
  afterEach(() => {
    resetUiBridge();
    resetAuthSession();
    vi.restoreAllMocks();
  });

  describe("panel resize", () => {
    it.each([[420, 420], [undefined, WIDGET_WIDTH], [9000, WIDGET_WIDTH], ["bad", WIDGET_WIDTH]])("keeps the Agents auth width within bounds (%s)", async (width, expected) => {
      const { api } = makeFigmaStub(); ready(api);
      vi.spyOn(api.ui, "resize");
      await send(api, { type: TYPE_RESIZE, success: true, height: 720, width });
      expect(api.ui.resize).toHaveBeenCalledWith(expected, 720);
    });
  });

  describe("notifications", () => {
    it("reports a failure as an error rather than dropping it", async () => {
      // TYPE_NOTIFY sits ahead of the `response.success` gate deliberately. Behind it,
      // every error the UI tried to report was discarded in silence.
      const { api, notified } = makeFigmaStub();
      ready(api);

      await send(api, { type: TYPE_NOTIFY, success: false, msg: "it went wrong" });

      expect(notified).toEqual([{ msg: "it went wrong", error: true }]);
    });

    it("passes a success notification through without the error flag", async () => {
      const { api, notified } = makeFigmaStub();
      ready(api);

      await send(api, { type: TYPE_NOTIFY, success: true, msg: "working on it" });

      expect(notified).toEqual([{ msg: "working on it", error: false }]);
    });
  });

  describe("byte reads", () => {
    it("answers with the bytes of the node it was asked about", async () => {
      const node = makeNode({ id: "1:2", fills: [imagePaint("h1")] });
      const { api, posted } = makeFigmaStub({ selection: [node], images: { h1: BYTES } });
      ready(api);

      await send(api, {
        type: TYPE_REQUEST_IMAGE_BYTES,
        nodeId: "1:2",
        requestId: "req-1",
      });

      const reply = posted.find((msg) => msg.type === TYPE_IMAGE_BYTES_RESULT);
      expect(reply).toMatchObject({ requestId: "req-1", nodeId: "1:2", bytes: BYTES });
    });

    it("says why it could not read, rather than answering a bare null", async () => {
      const node = makeNode({ id: "1:2", fills: [solidPaint()] });
      const { api, posted } = makeFigmaStub({ selection: [node] });
      ready(api);

      await send(api, {
        type: TYPE_REQUEST_IMAGE_BYTES,
        nodeId: "1:2",
        requestId: "req-2",
      });

      const reply = posted.find((msg) => msg.type === TYPE_IMAGE_BYTES_RESULT);
      expect(reply).toMatchObject({ bytes: null, reason: "no-image" });
    });

    it("always answers, even when the request is malformed", async () => {
      // A UI left waiting on a reply that never comes just spins forever.
      const { api, posted } = makeFigmaStub();
      ready(api);

      await send(api, { type: TYPE_REQUEST_IMAGE_BYTES, requestId: "req-3" });

      const reply = posted.find((msg) => msg.type === TYPE_IMAGE_BYTES_RESULT);
      expect(reply).toBeDefined();
      expect(reply).toMatchObject({ bytes: null, reason: "read-failed" });
    });
  });

  describe("placement acknowledgement", () => {
    it("acknowledges a successful apply with the id the UI sent", async () => {
      const node = makeNode({ id: "1:2", fills: [imagePaint("h1")] });
      const { api, posted } = makeFigmaStub({ selection: [node] });
      ready(api);

      await send(api, {
        type: TYPE_APPLY_IMAGE,
        success: true,
        nodeId: "1:2",
        msg: BYTES,
        placementId: "place-1",
      });

      const ack = posted.find((msg) => msg.type === TYPE_PLACEMENT_DONE);
      expect(ack).toMatchObject({ placementId: "place-1", success: true });
    });

    it("acknowledges a FAILED apply, so the UI is never left waiting", async () => {
      // Without an ack on the failure path the panel keeps its loading overlay up
      // forever on exactly the runs that went wrong.
      const { api, posted, notified } = makeFigmaStub({ selection: [] });
      ready(api);

      await send(api, {
        type: TYPE_APPLY_IMAGE,
        success: true,
        nodeId: "deleted",
        msg: BYTES,
        placementId: "place-2",
      });

      const ack = posted.find((msg) => msg.type === TYPE_PLACEMENT_DONE);
      expect(ack).toMatchObject({ placementId: "place-2", success: false });
      expect(ack?.msg).toBe(SOURCE_LAYER_GONE_ERR);
      expect(notified).toEqual([{ msg: SOURCE_LAYER_GONE_ERR, error: true }]);
    });

    it("acknowledges a malformed apply instead of writing bytes to nowhere", async () => {
      const { api, posted } = makeFigmaStub();
      ready(api);

      await send(api, { type: TYPE_APPLY_IMAGE, success: true, placementId: "place-3" });

      const ack = posted.find((msg) => msg.type === TYPE_PLACEMENT_DONE);
      expect(ack).toMatchObject({ placementId: "place-3", success: false });
      expect(ack?.msg).toBe(NODE_CANNOT_HOLD_IMAGE_ERR);
    });

    it("routes edit-mode candidates to placeBesideSource and acknowledges them", async () => {
      const source = makeNode({ id: "1:src", x: 0, y: 0, width: 200, height: 200 });
      const parent = makeNode({ id: "1:frame", type: "FRAME", children: [source], layoutMode: "NONE" });
      const { api, posted } = makeFigmaStub({ selection: [source], pageNodes: [parent] });
      ready(api);

      await send(api, {
        type: TYPE_PLACE_EDITED_IMAGES,
        success: true,
        images: [BYTES],
        prompt: "make it night",
        sourceNodeId: "1:src",
        placementId: "place-4",
      });

      const ack = posted.find((msg) => msg.type === TYPE_PLACEMENT_DONE);
      expect(ack).toMatchObject({ placementId: "place-4", success: true });
      expect(parent.children?.some((child) => child.name.startsWith("Edit:"))).toBe(true);
    });
  });

  describe("the balance guard", () => {
    beforeEach(() => {
      // The cache is a module-level singleton, so each case starts from a known value.
      CustomSessionStorage.getInstance().reset();
      CustomSessionStorage.getInstance().setBalance(0, NO_CREDENTIAL_IDENTITY);
      balanceApi.getBalance.mockReset();
      resetBalanceReads();
    });

    it("accepts a real number", async () => {
      const { api, posted } = makeFigmaStub();
      ready(api);

      await send(api, { type: TYPE_SET_BALANCE, success: true, msg: "42" });

      const reply = posted.find((msg) => msg.type === TYPE_GET_BALANCE);
      expect(reply?.payload).toBe(42);
    });

    it.each(["", "undefined", "API key is wrong", "NaN"])(
      "refuses %o and echoes the last known good value back",
      async (poison) => {
        const { api, posted } = makeFigmaStub();
        ready(api);
        CustomSessionStorage.getInstance().setBalance(17, NO_CREDENTIAL_IDENTITY);

        await send(api, { type: TYPE_SET_BALANCE, success: true, msg: poison });

        // Caching one of these poisons the balance for the whole plugin session,
        // because nothing re-fetches it — and `"..." <= 0` is false, so every button
        // stays enabled and every paid call goes ahead against a balance nobody read.
        const reply = posted.find((msg) => msg.type === TYPE_GET_BALANCE);
        expect(reply?.payload).toBe(17);
      }
    );

    it("answers a plain balance request from the cache", async () => {
      const { api, posted } = makeFigmaStub();
      ready(api);
      CustomSessionStorage.getInstance().setBalance(9, NO_CREDENTIAL_IDENTITY);

      await send(api, { type: TYPE_GET_BALANCE, success: true });

      expect(posted.find((msg) => msg.type === TYPE_GET_BALANCE)?.payload).toBe(9);
    });

    it("READS the balance when this session has never read one for this credential", async () => {
      balanceApi.getBalance.mockResolvedValue({ success: true, msg: 250 });
      const { api, posted } = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });
      ready(api);

      await send(api, { type: TYPE_GET_BALANCE, success: true });

      await vi.waitFor(() =>
        expect(posted.find((msg) => msg.type === TYPE_GET_BALANCE)?.payload).toBe(250)
      );
      expect(balanceApi.getBalance).toHaveBeenCalledTimes(1);
    });

    it("reads once when two requests arrive together, rather than racing two replies", async () => {
      balanceApi.getBalance.mockResolvedValue({ success: true, msg: 250 });
      const { api, posted } = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });
      ready(api);

      await Promise.all([
        send(api, { type: TYPE_GET_BALANCE, success: true }),
        send(api, { type: TYPE_GET_BALANCE, success: true }),
      ]);

      await vi.waitFor(() =>
        expect(posted.filter((msg) => msg.type === TYPE_GET_BALANCE).length).toBeGreaterThan(0)
      );
      expect(balanceApi.getBalance).toHaveBeenCalledTimes(1);
    });

    it("does not read it again once this session has", async () => {
      balanceApi.getBalance.mockResolvedValue({ success: true, msg: 250 });
      const { api } = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });
      ready(api);

      await send(api, { type: TYPE_GET_BALANCE, success: true });
      await vi.waitFor(() => expect(balanceApi.getBalance).toHaveBeenCalledTimes(1));
      await send(api, { type: TYPE_GET_BALANCE, success: true });

      expect(balanceApi.getBalance).toHaveBeenCalledTimes(1);
    });

    it("does not read it after the UI supplied one, because that number was read too", async () => {
      balanceApi.getBalance.mockResolvedValue({ success: true, msg: 1 });
      const { api, posted } = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });
      ready(api);

      await send(api, { type: TYPE_SET_BALANCE, success: true, msg: "77" });

      await vi.waitFor(() =>
        expect(posted.find((msg) => msg.type === TYPE_GET_BALANCE)?.payload).toBe(77)
      );
      expect(balanceApi.getBalance).not.toHaveBeenCalled();
    });

    it("still answers, and does not cache, when the read fails", async () => {
      balanceApi.getBalance.mockResolvedValue({ success: false, msg: "API key is wrong" });
      const { api, posted } = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });
      ready(api);

      await send(api, { type: TYPE_GET_BALANCE, success: true });

      await vi.waitFor(() =>
        expect(posted.find((msg) => msg.type === TYPE_GET_BALANCE)).toBeDefined()
      );
      await send(api, { type: TYPE_GET_BALANCE, success: true });
      await vi.waitFor(() => expect(balanceApi.getBalance).toHaveBeenCalledTimes(2));
    });
  });

  describe("everything goes through the bridge", () => {
    it("queues replies posted before the UI has announced itself", async () => {
      // Three sites in this file used to call figma.ui.postMessage directly, in the
      // very file that owns the dispatcher. A direct post before the iframe is
      // listening is simply lost, and the balance reply is exactly the class of
      // message the bridge exists to protect.
      const node = makeNode({ id: "1:2", fills: [imagePaint("h1")] });
      const { api, posted } = makeFigmaStub({ selection: [node], images: { h1: BYTES } });

      beginUiSession(api);
      setMessageListeners(api);

      await send(api, {
        type: TYPE_REQUEST_IMAGE_BYTES,
        nodeId: "1:2",
        requestId: "req-queued",
      });
      expect(posted).toHaveLength(0);

      (api.ui.onmessage as (m: { type: string }) => unknown)({ type: "ui-ready" });
      expect(posted.find((msg) => msg.type === TYPE_IMAGE_BYTES_RESULT)).toBeDefined();
    });
  });

  describe("close", () => {
    it("closes the plugin on request", async () => {
      const stub = makeFigmaStub();
      ready(stub.api);

      await send(stub.api, { type: TYPE_CLOSE_PLUGIN, success: true });

      expect(stub.closed).toBe(true);
    });
  });

  describe("storing the key", () => {
    it("stores it and confirms it", async () => {
      const { api, clientStorage, notified } = makeFigmaStub();
      ready(api);

      await send(api, { type: TYPE_SET_KEY, success: true, msg: KEY });

      expect(clientStorage.get(API_KEY_NAME)).toBe(KEY);
      expect(notified).toEqual([{ msg: KEY_SET, error: false }]);
    });

    it("reports a failed write instead of confirming one that did not happen", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { api, notified } = makeFigmaStub({ storageFails: { set: true } });
      ready(api);

      await send(api, { type: TYPE_SET_KEY, success: true, msg: KEY });

      expect(notified).toEqual([{ msg: KEY_SAVE_FAILED, error: true }]);
      expect(notified.some((n) => n.msg === KEY_SET)).toBe(false);
    });
  });

  describe("removing the key", () => {
    const withGlobals = (api: PluginAPI) => {
      vi.stubGlobal("figma", api);
      vi.stubGlobal("__html__", "<html>");
    };

    afterEach(() => vi.unstubAllGlobals());

    it("deletes it, clears the cached balance, and returns to the keyless panel", async () => {
      const stub = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });
      withGlobals(stub.api);
      CustomSessionStorage.getInstance().setBalance(25, apiKeyIdentity(KEY));
      CustomSessionStorage.getInstance().markWarm(apiKeyIdentity(KEY));
      ready(stub.api);

      await send(stub.api, { type: TYPE_REMOVE_KEY, success: true });

      expect(stub.clientStorage.has(API_KEY_NAME)).toBe(false);
      expect(stub.notified).toEqual([{ msg: KEY_REMOVED, error: false }]);
      expect(CustomSessionStorage.getInstance().balanceFor(apiKeyIdentity(KEY))).toBeUndefined();
      expect(CustomSessionStorage.getInstance().isWarmFor(apiKeyIdentity(KEY))).toBe(false);

      const [, options] = stub.showUiCalls.at(-1) as [string, { height: number }];
      expect(options.height).toBe(WIDGET_HEIGHT_WITHOUT_KEY);

      (stub.api.ui.onmessage as (m: { type: string }) => unknown)({ type: "ui-ready" });
      expect(stub.posted.find((msg) => msg.type === TYPE_CREDENTIAL)?.payload).toEqual({
        credential: null,
        apiKey: "",
      });
    });

    it("keeps the panel on the key when the delete fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const stub = makeFigmaStub({
        clientStorage: { [API_KEY_NAME]: KEY },
        storageFails: { delete: true },
      });
      withGlobals(stub.api);
      ready(stub.api);

      await send(stub.api, { type: TYPE_REMOVE_KEY, success: true });

      expect(stub.clientStorage.get(API_KEY_NAME)).toBe(KEY);
      expect(stub.notified).toEqual([{ msg: KEY_REMOVE_FAILED, error: true }]);
      expect(stub.showUiCalls).toHaveLength(0);
    });
  });

  describe("the auth commands", () => {
    const relayFetch = () => {
      const key = "A".repeat(43);
      const reply = (body: unknown) => ({
        ok: true,
        status: 200,
        headersObject: {},
        json: async () => body,
        text: async () => JSON.stringify(body),
      });

      return vi.fn(async (url: string) =>
        String(url).indexOf("/result") === -1
          ? reply({ write_key: key, read_key: key.replace("A", "B"), expires_in: 600 })
          : reply({ status: "pending" })
      );
    };

    beforeEach(() => {
      vi.stubGlobal("fetch", relayFetch());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const jwt = (claims: Record<string, unknown>): string => {
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value))
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      return `${encode({ alg: "RS256" })}.${encode(claims)}.sig`;
    };
    const TOKEN = jwt({
      scope: ["openid", "profile", "workflows.execute"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const oauthRecord = {
      accessToken: TOKEN,
      refreshToken: "rt:stored",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["openid", "profile", "workflows.execute"],
      writtenAt: 1,
    };

    it("starts a sign-in even when the message is not flagged successful", async () => {
      const { api } = makeFigmaStub();
      ready(api);

      await send(api, { type: TYPE_SIGN_IN });

      expect(authState().status).toBe("awaiting");
    });

    it("hands a pasted response over as raw text", async () => {
      const { api } = makeFigmaStub();
      ready(api);
      await send(api, { type: TYPE_SIGN_IN });

      await send(api, { type: TYPE_AUTH_RESPONSE, msg: "not a code" });

      expect(authState().status).toBe("failed");
    });

    it("acknowledges a terminal auth message when a tab switch is serviced", async () => {
      const stub = makeFigmaStub();
      vi.stubGlobal("figma", stub.api);
      vi.stubGlobal("__html__", "<html>");
      ready(stub.api);
      await send(stub.api, { type: TYPE_AUTH_RESPONSE, msg: "ac:no-pending-flow" });
      expect(authState().status).toBe("failed");

      await send(stub.api, { type: TYPE_SWITCH_TAB, success: true, tab: TAB_UPSCALE });

      await vi.waitFor(() => expect(authState().status).toBe("armed"));
      vi.unstubAllGlobals();
    });

    it("cancels a pending sign-in", async () => {
      const { api } = makeFigmaStub();
      ready(api);
      await send(api, { type: TYPE_SIGN_IN });

      await send(api, { type: TYPE_CANCEL_SIGN_IN });

      expect(authState().status).toBe("armed");
    });

    it("signs out, keeps the API key, and says the credit pool changed", async () => {
      const stub = makeFigmaStub({
        clientStorage: { [API_KEY_NAME]: KEY, [OAUTH_RECORD_NAME]: oauthRecord },
      });
      ready(stub.api);

      await send(stub.api, { type: TYPE_SIGN_OUT });

      expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
      expect(stub.clientStorage.get(API_KEY_NAME)).toBe(KEY);
      expect(stub.notified.some((n) => n.msg === SIGNED_OUT_USING_KEY_MSG)).toBe(true);
      expect(stub.posted.filter((m) => m.type === TYPE_CREDENTIAL).at(-1)?.payload).toEqual({
        credential: { kind: "apikey", token: KEY },
        apiKey: KEY,
      });
    });

    it("answers a refresh request with the SAME requestId it was given", async () => {
      const stub = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: KEY } });
      ready(stub.api);

      await send(stub.api, { type: TYPE_REFRESH_CREDENTIAL, requestId: "cred-7" });

      const reply = stub.posted.filter((m) => m.type === TYPE_CREDENTIAL).at(-1);
      expect(reply?.requestId).toBe("cred-7");
    });

    it("re-posts the authoritative credential after a key is stored", async () => {
      const stub = makeFigmaStub({ clientStorage: { [OAUTH_RECORD_NAME]: oauthRecord } });
      ready(stub.api);

      await send(stub.api, { type: TYPE_SET_KEY, success: true, msg: KEY });

      expect(stub.posted.filter((m) => m.type === TYPE_CREDENTIAL).at(-1)?.payload).toEqual({
        credential: { kind: "oauth", token: TOKEN, scopes: oauthRecord.scopes, expiresAt: oauthRecord.expiresAt },
        apiKey: KEY,
      });
    });

    it("does NOT send a signed-in user to the intro page when they remove their key", async () => {
      const stub = makeFigmaStub({
        clientStorage: { [API_KEY_NAME]: KEY, [OAUTH_RECORD_NAME]: oauthRecord },
      });
      vi.stubGlobal("figma", stub.api);
      vi.stubGlobal("__html__", "<html>");
      ready(stub.api);
      const showUiCallsBefore = stub.showUiCalls.length;

      await send(stub.api, { type: TYPE_REMOVE_KEY, success: true });

      expect(stub.clientStorage.has(API_KEY_NAME)).toBe(false);
      expect(stub.clientStorage.has(OAUTH_RECORD_NAME)).toBe(true);
      expect(stub.showUiCalls).toHaveLength(showUiCallsBefore);
      expect(stub.posted.filter((m) => m.type === TYPE_CREDENTIAL).at(-1)?.payload).toMatchObject({
        credential: { kind: "oauth" },
        apiKey: "",
      });
      vi.unstubAllGlobals();
    });
  });
});
