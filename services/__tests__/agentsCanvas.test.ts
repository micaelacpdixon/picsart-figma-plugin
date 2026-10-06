import { describe, expect, it, vi } from "vitest";
import { canvasAction } from "../agents/canvas";

function stub(editorType = "figjam") {
  const node = { text: { fontName: { family: "Inter", style: "Regular" }, characters: "" }, remove: vi.fn(), resize: vi.fn(), width: 200, height: 100, x: 0, y: 0 };
  const api = { editorType, mixed: Symbol(), currentPage: { selection: [] as unknown[] }, createSticky: vi.fn(() => node), loadFontAsync: vi.fn(async () => {}),
    viewport: { center: { x: 100, y: 100 }, scrollAndZoomIntoView: vi.fn() }, createRectangle: vi.fn(() => node), createImage: vi.fn(() => ({ hash: "image", getSizeAsync: async () => ({ width: 200, height: 100 }) })) };
  return { api: api as unknown as PluginAPI, node, raw: api };
}
describe("Agents canvas operations", () => {
  it("creates editable FigJam text only after its native font loads", async () => {
    const { api, node, raw } = stub();
    await canvasAction(api, { action: "note", text: "Aura\nA useful idea" });
    expect(raw.loadFontAsync).toHaveBeenCalledWith(node.text.fontName);
    expect(node.text.characters).toBe("Aura\nA useful idea");
    expect(api.currentPage.selection).toEqual([node]);
  });
  it("removes a partially created note if the font fails", async () => {
    const { api, node, raw } = stub();
    raw.loadFontAsync.mockRejectedValueOnce(new Error("font unavailable"));
    await expect(canvasAction(api, { action: "note", text: "Idea" })).rejects.toThrow("font unavailable");
    expect(node.remove).toHaveBeenCalledOnce();
  });
  it("does not attempt FigJam APIs in Design", async () => {
    const { api, raw } = stub("figma");
    await expect(canvasAction(api, { action: "note", text: "Idea" })).rejects.toThrow("FigJam");
    expect(raw.createSticky).not.toHaveBeenCalled();
  });
  it("rejects empty, invalid and oversized image arrays before writing", async () => {
    const { api, raw } = stub();
    for (const bytes of [[], [256], [-1], ["png"]]) await expect(canvasAction(api, { action: "image", bytes })).rejects.toThrow("Invalid");
    expect(raw.createImage).not.toHaveBeenCalled();
  });
  it("captures only an explicit single selection and bounds export scale", async () => {
    const { api, raw } = stub();
    await expect(canvasAction(api, { action: "capture" })).rejects.toThrow("Select one");
    const exportAsync = vi.fn(async () => new Uint8Array([1, 2]));
    raw.currentPage.selection = [{ width: 3200, height: 2000, name: "Frame", exportAsync }];
    expect(await canvasAction(api, { action: "capture" })).toEqual({ name: "Frame", bytes: [1, 2] });
    expect(exportAsync).toHaveBeenCalledWith({ format: "PNG", constraint: { type: "SCALE", value: .5 } });
  });
});
