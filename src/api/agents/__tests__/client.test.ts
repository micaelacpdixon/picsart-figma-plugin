import { describe, expect, it, vi } from "vitest";
import { createAgentsClient, downloadImage, normalizeResult, approvedAsset } from "../client";
import { AGENTS_BASE } from "@constants/agents";
const credential = { kind: "oauth" as const, token: "test-user-token", expiresAt: Date.now() + 600000 };

describe("Agents account and network boundaries", () => {
  it("rejects API keys without sending them anywhere", async () => {
    const fetcher = vi.fn();
    const client = createAgentsClient(() => "private-key", vi.fn(), fetcher);
    await expect(client.catalog()).rejects.toThrow("Sign in");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refreshes an expiring session before submitting to the fixed staging origin", async () => {
    let current = { ...credential, expiresAt: 1 };
    const refresh = vi.fn(async () => { current = { ...credential, token: "new-token" }; return true; });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ task: "ticket" })));
    await createAgentsClient(() => current, refresh, fetcher).submit("conversation", "Hello", []);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${AGENTS_BASE}/chat`);
    expect(init.headers).toHaveProperty("Authorization", "Bearer new-token");
    expect(init.redirect).toBe("error");
  });
  it("never retries a potentially charged submission after a network failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Network timeout"));
    await expect(createAgentsClient(() => credential, vi.fn(), fetcher).submit("conversation", "Make something", [])).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("polls the same signed task without resubmitting a prompt", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ response: { status: "IN_PROGRESS" } })));
    const client = createAgentsClient(() => credential, vi.fn(), fetcher);
    expect(await client.result("same-task")).toBeNull();
    expect(await client.result("same-task")).toBeNull();
    for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[0]).toBe(`${AGENTS_BASE}/result`);
      expect(JSON.parse(String(call[1].body))).toEqual({ conversation: "same-task" });
    }
  });
  it("does not attach account credentials to CDN downloads", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } }));
    await downloadImage("https://aicdn.picsart.com/image.png", fetcher);
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe("omit");
  });
  it("rejects forged media origins and non-images", async () => {
    for (const url of ["http://picsart.com/x", "https://picsart.com.evil.com/x", "https://user@picsart.com/x", "https://picsart.com:444/x", "javascript:alert(1)"]) expect(approvedAsset(url)).toBe(false);
    await expect(downloadImage("https://picsart.com/image", vi.fn(async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } })))).rejects.toThrow("format");
  });
  it("normalizes real workflow plans and nested images without rendering upstream markup", () => {
    const result = normalizeResult({ responses: ["<script>untrusted</script>"], active_plans: [{ title: "Concept", estimatedCredits: 12 }],
      tool_calls: [{ toolName: "execute_plan", result: { items: [{ pipelineResults: [{ status: "completed", resultUrl: "https://aicdn.picsart.com/a.png", resultType: "image" }, { status: "completed", resultUrl: "https://evil.com/x", resultType: "image" }] }] } }] });
    expect(result.messages).toEqual(["<script>untrusted</script>"]);
    expect(result.assets).toHaveLength(1);
    expect(result.plans[0].credits).toBe(12);
  });
});
