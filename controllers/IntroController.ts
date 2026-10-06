import { AGENTS_BETA } from "@constants/agents";
import AgentsController from "./AgentsController";
import commands from "@constants/commands";
import {
  API_KEY_NAME,
  WIDGET_WIDTH,
  WIDGET_HEIGHT_WITHOUT_KEY,
  TAB_REMOVE_BACKGROUND,
  TAB_UPSCALE,
  TAB_GENERATE_IMAGE,
  TAB_ACCOUNT,
  TYPE_SET_KEY,
  TYPE_SET_BALANCE,
  KEY_SAVE_FAILED,
} from "@constants/index";
import routeCommand from "@routes/CommandRouter";
import { readApiKey } from "@services/apiKeyStorage";
import { apiKeyIdentity } from "@services/credentialIdentity";
import { rememberBalance } from "@services/balance";
import { setMessageListeners } from "@services/MessageListeners";
import { addUiMessageHandler } from "@services/UiBridge";
import openPanel from "./openPanel";

/**
 * Which tab a keyless user lands on, by the menu item they picked.
 *
 * This used to be a two-way ternary: Remove Background got its own tab and
 * *everything else* got Upscale. So a first-time user who chose "Generate Image"
 * from the menu, entered their API key, and was then shown the Upscale panel — with
 * no explanation and nothing they asked for on screen.
 */
const TAB_FOR_COMMAND: Record<string, string> = {
  [commands.COMMAND_REMOVEBACKGROUND]: TAB_REMOVE_BACKGROUND,
  [commands.COMMAND_UPSCALE]: TAB_UPSCALE,
  [commands.COMMAND_GENERATE_IMAGE]: TAB_GENERATE_IMAGE,
  [commands.COMMAND_ACCOUNT]: TAB_ACCOUNT,
};

const handleIntroMessage = async (response: {
  type?: string;
  success?: boolean;
  msg?: unknown;
}) => {
  if (!response.success) return;

  if (response.type === TYPE_SET_KEY) {
    try {
      await figma.clientStorage.setAsync(API_KEY_NAME, response.msg);
    } catch (error) {
      console.error("Failed to store the API key:", error);
      figma.notify(KEY_SAVE_FAILED, { error: true });
    }
    routeCommand(true);
  } else if (response.type === TYPE_SET_BALANCE) {
    rememberBalance(response.msg, apiKeyIdentity(await readApiKey(figma)));
  }
};

const IntroController = async () => {
  if (AGENTS_BETA && (figma.command === commands.COMMAND_AGENTS || figma.editorType === "figjam")) {
    await AgentsController();
    return;
  }
  if (figma.command === commands.COMMAND_SUPPORT) {
    routeCommand();
    return;
  }

  // The standard listeners, which this controller never installed. It assigned its
  // own figma.ui.onmessage instead, so every TYPE_NOTIFY the intro page tried to
  // send — including its own key-validation errors — went nowhere.
  setMessageListeners(figma);

  // Registered before the panel opens, so a key submitted the instant the intro page
  // renders cannot arrive before anyone is listening. Added rather than assigned, so
  // it coexists with the handler above instead of replacing it.
  addUiMessageHandler(figma, handleIntroMessage);

  await openPanel({
    // Generate Image is the default for an unrecognised command, matching the menu
    // order and the navbar.
    tab: TAB_FOR_COMMAND[figma.command] ?? TAB_GENERATE_IMAGE,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT_WITHOUT_KEY,
    // There is no key yet, so there is no balance to fetch.
    includeBalance: false,
  });
};

export default IntroController;
