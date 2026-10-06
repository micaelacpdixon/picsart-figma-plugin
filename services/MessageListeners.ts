import AgentsController from "../controllers/AgentsController";
import { TAB_AGENTS } from "@constants/tabs";
import ImageProcessor from "@services/ImageProcessor";
import type { BytesFailureReason } from "@app-types/messages";
import AccountController from "../controllers/AccountController";
import IntroController from "../controllers/IntroController";
import SupportController from "../controllers/SupportController";
import GenerateImageController from "../controllers/GenerateImageController";
import openPanel from "../controllers/openPanel";
import CustomSessionStorage from "./CustomSessionStorage";
import { addUiMessageHandler, postToUi } from "./UiBridge";
import {
  acknowledgeTerminalAuthState,
  activeCredential,
  cancelSignIn,
  postCredential,
  refreshCredentialNow,
  signOut,
  startSignIn,
  submitAuthResponse,
} from "./authSession";
import { credentialIdentity } from "./credentialIdentity";
import { deliverBalance, rememberBalance } from "./balance";
import {
  TYPE_APPLY_IMAGE,
  TYPE_AUTH_RESPONSE,
  TYPE_CANCEL_SIGN_IN,
  TYPE_REFRESH_CREDENTIAL,
  TYPE_SIGN_IN,
  TYPE_SIGN_OUT,
  TYPE_REQUEST_IMAGE_BYTES,
  TYPE_IMAGE_BYTES_RESULT,
  TYPE_PLACEMENT_DONE,
  TYPE_NOTIFY,
  API_KEY_NAME,
  KEY_SET,
  KEY_SAVE_FAILED,
  KEY_REMOVED,
  KEY_REMOVE_FAILED,
  TYPE_SET_KEY,
  TYPE_REMOVE_KEY,
  TYPE_CLOSE_PLUGIN,
  TYPE_GENERATED_IMAGES,
  TYPE_PLACE_EDITED_IMAGES,
  TYPE_SWITCH_TAB,
  NODE_CANNOT_HOLD_IMAGE_ERR,
  TAB_REMOVE_BACKGROUND,
  TAB_UPSCALE,
  TAB_ACCOUNT,
  TAB_SUPPORT,
  TAB_GENERATE_IMAGE,
  WIDGET_HEIGHT_WITH_KEY,
  WIDGET_HEIGHT_WITHOUT_KEY,
  WIDGET_HEIGHT_UPSCALE_WITH_KEY,
  WIDGET_HEIGHT_UPSCALE_WITHOUT_KEY,
  TYPE_SET_BALANCE,
  TYPE_GET_BALANCE,
  TYPE_RESIZE,
  WIDGET_WIDTH,
} from "@constants/index";

/**
 * What can arrive from the UI.
 *
 * `figma.ui.onmessage` hands over an untyped value, so before this every field was
 * `any`: a renamed field read as `undefined` with no complaint from the compiler, and
 * the seam grew three new fields plus a renamed channel in this change alone. Every
 * field is optional because no single message carries all of them — that is what
 * forces the narrowing at each use site.
 */
interface IncomingMessage {
  type?: string;
  success?: boolean;
  /** A notification string, or finished image bytes on TYPE_APPLY_IMAGE. */
  msg?: string | Uint8Array;
  nodeId?: string;
  requestId?: string;
  scaleFactor?: number;
  images?: Uint8Array[];
  prompt?: string;
  tab?: string;
  height?: number | string;
  /** Correlates a TYPE_PLACEMENT_DONE reply with the request that asked for it. */
  placementId?: string;
  /** Edit-mode placement: where the candidates go, and what to call them. */
  sourceNodeId?: string;
}

// figma.notify only takes a string, and `msg` is a union. Narrowing here rather than
// casting at four call sites.
const asText = (value: string | Uint8Array | undefined): string =>
  typeof value === "string" ? value : "";

/**
 * Notify, then acknowledge.
 *
 * Every canvas write goes through here so the UI is never left guessing whether one
 * finished. `figma.ui.onmessage` is a plain callback — Figma does not await what a
 * handler returns — so a UI that posted an apply and then a close raced them, and
 * the close won: the user was charged and the layer never changed.
 */
const finishPlacement = (
  figma: PluginAPI,
  placementId: string | undefined,
  result: { ok: boolean; message: string }
) => {
  figma.notify(result.message, { error: !result.ok });
  postToUi(figma, {
    type: TYPE_PLACEMENT_DONE,
    placementId,
    success: result.ok,
    msg: result.message,
  });
};


// showUIForTab used to live here, duplicating the boot sequence with its own
// setTimeout(..., 400). It covered three of the five controller shapes, which is why
// the other two hand-rolled their own. controllers/openPanel.ts is the one sequence
// now, and it queues on the UI's ready signal instead of guessing at a delay.
//
// getTabUIValue() also used to sit here, mapping each TAB_* constant to a hardcoded
// string literal of the matching TabType value — "Remove BG", "Generate image" and
// so on, written out by hand rather than referenced. Navbar.tsx carried the
// hand-written inverse. Now that constants/tabs.ts derives TAB_* from TabType, both
// mappers are the identity function and the literals they disagreed over are gone.

/**
 * Registered through UiBridge rather than assigned to `figma.ui.onmessage`.
 *
 * That slot holds exactly one function, so whoever assigned last won — and this
 * assignment used to silently destroy the key-validation handler that
 * RemoveBackgroundController was still waiting on.
 *
 * Declared once at module level rather than built as a fresh closure per call, so
 * UiBridge's identity-based dedup actually works. A new closure each time would stack
 * a duplicate handler on every controller invocation, and a tab switch would then
 * apply each result twice — two notifications, two canvas writes.
 */
const handleUiMessage = async (figma: PluginAPI, response: IncomingMessage) => {
    if (response.type === TYPE_SIGN_IN) {
      await startSignIn(figma);
      return;
    }

    if (response.type === TYPE_AUTH_RESPONSE) {
      await submitAuthResponse(figma, asText(response.msg));
      return;
    }

    if (response.type === TYPE_CANCEL_SIGN_IN) {
      await cancelSignIn(figma);
      return;
    }

    if (response.type === TYPE_SIGN_OUT) {
      const active = await signOut(figma);
      postCredential(figma, active);
      if (!active.credential) await IntroController();
      return;
    }

    if (response.type === TYPE_REFRESH_CREDENTIAL) {
      const active = await refreshCredentialNow(figma);
      postCredential(figma, active, response.requestId);
      return;
    }

    // Notifications carry failures as well as progress, so they must be handled
    // before the success gate below. Behind it, every error the UI tried to
    // report was dropped in silence.
    if (response.type === TYPE_NOTIFY) {
      figma.notify(asText(response.msg), { error: !response.success });
      return;
    }

    // Only the sandbox can change the window size, so the UI asks for one when
    // an advanced-settings panel opens or closes. Resizing a hidden UI throws,
    // hence the guard.
    if (response.type === TYPE_RESIZE) {
      const height = Number(response.height);
      if (Number.isFinite(height) && height > 0) {
        try {
          figma.ui.resize(WIDGET_WIDTH, Math.round(height));
        } catch (error) {
          console.error("Failed to resize plugin window:", error);
        }
      }
      return;
    }

    // Reading bytes is not a "success" report, so it sits ahead of the gate
    // below. It answers with its own message either way, because a UI left
    // waiting on a reply that never comes just spins forever.
    if (response.type === TYPE_REQUEST_IMAGE_BYTES) {
      let bytes: Uint8Array | null = null;
      let reason: BytesFailureReason | undefined;
      let error: string | undefined;
      try {
        if (!response.nodeId) throw new Error("request-image-bytes with no nodeId");
        const read = await ImageProcessor.getBytesForNode(figma, response.nodeId);
        if (read.ok) {
          bytes = read.bytes;
        } else {
          // Carried through rather than collapsed to a null. "Deleted", "holds no
          // image" and "the read threw" are three different sentences for the user.
          reason = read.reason;
        }
      } catch (caught) {
        reason = "read-failed";
        error = String(caught);
        console.error("Failed to read image bytes:", caught);
      }
      postToUi(figma, {
        type: TYPE_IMAGE_BYTES_RESULT,
        requestId: response.requestId,
        nodeId: response.nodeId,
        bytes,
        reason,
        error,
      });
      return;
    }

    if (response.success) {
      if (response.type === TYPE_CLOSE_PLUGIN) figma.closePlugin();
      if (response.type === TYPE_APPLY_IMAGE) {
        // Both are required for this message, and a missing one means the UI sent a
        // malformed apply — worth reporting rather than writing bytes to nowhere,
        // because the result has already been paid for by this point.
        if (!response.nodeId || !(response.msg instanceof Uint8Array)) {
          console.error("apply-image without a nodeId and byte payload", response);
          finishPlacement(figma, response.placementId, {
            ok: false,
            message: NODE_CANNOT_HOLD_IMAGE_ERR,
          });
          return;
        }
        const res = await ImageProcessor.applyImageToNode(
          figma,
          response.nodeId,
          response.msg,
          response.scaleFactor
        );
        finishPlacement(figma, response.placementId, res);
      }

      if (response.type === TYPE_GENERATED_IMAGES) {
        const res = await ImageProcessor.addGeneratedImages(
          figma,
          response.images ?? [],
          response.prompt ?? ""
        );
        finishPlacement(figma, response.placementId, res);
      }

      if (response.type === TYPE_PLACE_EDITED_IMAGES) {
        const res = await ImageProcessor.placeBesideSource(figma, {
          images: response.images ?? [],
          prompt: response.prompt ?? "",
          sourceNodeId: response.sourceNodeId ?? "",
        });
        finishPlacement(figma, response.placementId, res);
      }

      if (response.type === TYPE_SWITCH_TAB) {
        // The setTimeout(..., 100) that used to wrap this was one more timing guess,
        // there to "ensure any pending operations complete". openPanel starts a fresh
        // UI session and queues until the new iframe reports ready, so there is
        // nothing left to wait out.
        try {
          acknowledgeTerminalAuthState();

          const hasCredential = !!(await activeCredential(figma)).credential;

          switch (response.tab) {
            case TAB_AGENTS:
              await AgentsController();
              break;
            case TAB_UPSCALE:
              await openPanel({
                tab: TAB_UPSCALE,
                height: hasCredential
                  ? WIDGET_HEIGHT_UPSCALE_WITH_KEY
                  : WIDGET_HEIGHT_UPSCALE_WITHOUT_KEY,
              });
              break;

            case TAB_ACCOUNT:
              await AccountController();
              break;

            case TAB_SUPPORT:
              await SupportController();
              break;

            case TAB_GENERATE_IMAGE:
              await GenerateImageController();
              break;

            // Remove BG lands here rather than in RemoveBackgroundController,
            // deliberately: that controller runs the key check and may divert into
            // the instant-removal flow, which is launch behaviour. Clicking the tab
            // should show the tab.
            case TAB_REMOVE_BACKGROUND:
            default:
              await openPanel({
                tab: TAB_REMOVE_BACKGROUND,
                height: hasCredential ? WIDGET_HEIGHT_WITH_KEY : WIDGET_HEIGHT_WITHOUT_KEY,
              });
          }
        } catch (error) {
          console.error("Error during tab switch:", error);
          figma.notify("Failed to switch tab");
        }

        return; // Exit early to avoid other processing
      }

      if (response.type === TYPE_SET_KEY) {
        try {
          await figma.clientStorage.setAsync(API_KEY_NAME, response.msg);
          figma.notify(KEY_SET);
        } catch (error) {
          console.error("Failed to store the API key:", error);
          figma.notify(KEY_SAVE_FAILED, { error: true });
        }
        postCredential(figma, await activeCredential(figma));
      }

      if (response.type === TYPE_REMOVE_KEY) {
        try {
          await figma.clientStorage.deleteAsync(API_KEY_NAME);
          CustomSessionStorage.getInstance().reset();
          figma.notify(KEY_REMOVED);

          const active = await activeCredential(figma);
          postCredential(figma, active);
          if (!active.credential) await IntroController();
        } catch (error) {
          console.error("Failed to remove the API key:", error);
          figma.notify(KEY_REMOVE_FAILED, { error: true });
        }
      }
      if (response.type === TYPE_SET_BALANCE || response.type === TYPE_GET_BALANCE) {
        const credential = (await activeCredential(figma)).credential;
        const identity = credentialIdentity(credential ?? undefined);

        if (response.type === TYPE_SET_BALANCE) {
          if (rememberBalance(response.msg, identity)) {
            CustomSessionStorage.getInstance().markWarm(identity);
          }
        }

        void deliverBalance(figma, credential);
      }
    }
};

// Bound per PluginAPI so the registered function keeps a stable identity, which is
// what lets UiBridge dedupe repeat registrations instead of stacking them.
const boundHandlers = new WeakMap<
  PluginAPI,
  (response: { type?: string; [key: string]: unknown }) => Promise<void>
>();

export const setMessageListeners = (figma: PluginAPI) => {
  let handler = boundHandlers.get(figma);
  if (!handler) {
    handler = (response) => handleUiMessage(figma, response);
    boundHandlers.set(figma, handler);
  }
  addUiMessageHandler(figma, handler);
};
