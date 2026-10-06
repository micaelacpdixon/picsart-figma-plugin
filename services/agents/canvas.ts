import { AGENTS_HOST, AGENTS_REQUEST, AGENTS_RESPONSE } from "@constants/agents";
import { addUiMessageHandler, postToUi } from "../UiBridge";

const MAX_IMAGE = 15 * 1024 * 1024;
const handlers = new WeakMap<PluginAPI, (message: { type?: string; [key: string]: unknown }) => Promise<void>>();

function position(api: PluginAPI, node: SceneNode) {
  const bounds = api.currentPage.selection[0]?.absoluteBoundingBox;
  node.x = bounds ? bounds.x + bounds.width + 48 : api.viewport.center.x - node.width / 2;
  node.y = bounds ? bounds.y : api.viewport.center.y - node.height / 2;
  api.currentPage.selection = [node];
  api.viewport.scrollAndZoomIntoView([node]);
}

export async function canvasAction(api: PluginAPI, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (message.action === "host") return { editor: api.editorType };
  if (message.action === "capture") {
    const selected = api.currentPage.selection;
    if (selected.length !== 1 || !("exportAsync" in selected[0])) throw new Error("Select one layer, frame or board object to attach.");
    const node = selected[0];
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: Math.min(1, 1600 / Math.max(node.width, node.height, 1)) } });
    if (bytes.length > 6 * 1024 * 1024) throw new Error("The selection is larger than 6 MB. Select a smaller object.");
    return { bytes: Array.from(bytes), name: node.name };
  }
  if (message.action === "note") {
    if (api.editorType !== "figjam") throw new Error("Notes are available in FigJam.");
    if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 5000) throw new Error("A note must contain 1–5,000 characters.");
    const note = api.createSticky();
    try {
      const font = note.text.fontName;
      if (font === api.mixed) throw new Error("Could not load the note font.");
      await api.loadFontAsync(font);
      note.text.characters = message.text;
      position(api, note);
    } catch (error) { note.remove(); throw error; }
    return { placed: true };
  }
  if (message.action === "image") {
    if (!Array.isArray(message.bytes) || !message.bytes.length || message.bytes.length > MAX_IMAGE ||
      !message.bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error("Invalid image bytes.");
    const image = api.createImage(new Uint8Array(message.bytes));
    const size = await image.getSizeAsync();
    const node = api.createRectangle();
    try {
      const scale = Math.min(1, 1200 / Math.max(size.width, size.height));
      node.resize(Math.max(1, size.width * scale), Math.max(1, size.height * scale));
      node.name = typeof message.name === "string" ? message.name.slice(0, 160) : "Picsart image";
      node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
      position(api, node);
    } catch (error) { node.remove(); throw error; }
    return { placed: true };
  }
  throw new Error("Unknown canvas action.");
}

export function installAgentsCanvas(api: PluginAPI) {
  let handler = handlers.get(api);
  if (!handler) {
    let busy = false;
    handler = async message => {
      if (message.type !== AGENTS_REQUEST || typeof message.requestId !== "string") return;
      const reply = (data: Record<string, unknown>) => postToUi(api, { type: AGENTS_RESPONSE, requestId: message.requestId, ...data });
      if (busy) { reply({ error: "Another canvas action is in progress." }); return; }
      busy = true;
      try { reply({ result: await canvasAction(api, message) }); }
      catch (error) { reply({ error: error instanceof Error ? error.message : "The canvas action failed." }); }
      finally { busy = false; }
    };
    handlers.set(api, handler);
  }
  addUiMessageHandler(api, handler);
}

export function postAgentsHost(api: PluginAPI) {
  postToUi(api, { type: AGENTS_HOST, editor: api.editorType });
}
