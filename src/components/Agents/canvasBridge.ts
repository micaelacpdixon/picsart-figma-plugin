import { AGENTS_REQUEST, AGENTS_RESPONSE } from "@constants/agents";
import { sendMessageToSandBox } from "@api/index";

export function requestCanvas(action: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener("message", listener); reject(new Error("Figma did not confirm the action. Check the canvas before trying again.")); }, 30000);
    const listener = (event: MessageEvent) => {
      if (event.source !== parent) return;
      const message = event.data?.pluginMessage;
      if (message?.type !== AGENTS_RESPONSE || message.requestId !== requestId) return;
      clearTimeout(timer); window.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error)); else resolve(message.result);
    };
    window.addEventListener("message", listener);
    sendMessageToSandBox(true, "", AGENTS_REQUEST, undefined, { action, requestId, ...data });
  });
}
