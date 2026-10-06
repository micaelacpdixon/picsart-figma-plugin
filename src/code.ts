import { AGENTS_BETA } from "@constants/agents";
import AgentsController from "@controllers/AgentsController";
/// <reference types="@figma/plugin-typings" />
import IntroController from "@controllers/IntroController";
import routeCommand from "@routes/CommandRouter";
import { activeCredential } from "@services/authSession";
import { sendImageSelectionStatus } from "@services/ImageProcessor";
import { beginUiSession } from "@services/UiBridge";

figma.showUI(__html__, { visible: false });
// Immediately after showUI, which is the rule for every showUI in this plugin and was
// being broken by the very first one. Without it this iframe is outside the bridge's
// session tracking entirely: it mounts, posts TYPE_UI_READY, and that signal arrives
// during whichever session a controller has since started — draining that session's
// queue into an iframe still loading. The result is a blank panel with nothing logged.
//
// The bridge now also re-delivers the boot burst to a later ready signal, so this is
// belt and braces rather than the whole fix. Both are wanted: this one makes the first
// iframe's lifecycle visible to the bridge instead of invisible to it.
beginUiSession(figma);

setTimeout(async () => {
  figma.on("selectionchange", () => {
    sendImageSelectionStatus();
  });

  if (AGENTS_BETA && (figma.editorType === "figjam" || !figma.command || figma.command === "AI-AGENTS")) {
    await AgentsController();
    return;
  }

  const { credential } = await activeCredential(figma);

  if (!credential) {
    IntroController();
  } else {
    routeCommand();
  }
}, 0);
