import { AGENTS_BETA } from "@constants/agents";
import { TAB_AGENTS } from "@constants/tabs";
import { setMessageListeners } from "@services/MessageListeners";
import { installAgentsCanvas, postAgentsHost } from "@services/agents/canvas";
import openPanel from "./openPanel";

export default async function AgentsController() {
  if (!AGENTS_BETA) { figma.notify("Agents is available in the separate staff beta."); return; }
  setMessageListeners(figma);
  installAgentsCanvas(figma);
  await openPanel({ tab: TAB_AGENTS, width: 420, height: 720, includeBalance: false, includeImageSelection: false });
  postAgentsHost(figma);
}
