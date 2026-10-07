import { AGENTS_BASE } from "@constants/agents";
import type { CredentialInput } from "@app-types/credential";

export interface Agent { id: string; name: string; role: string; description: string }
export interface AgentResult {
  messages: string[];
  assets: { url: string; label: string }[];
  plans: { title: string; status: string; credits: number | null }[];
  questions: string[];
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);

export function approvedAsset(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["picsart.com", "picsart.io"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function normalizeResult(value: unknown): AgentResult {
  const result = record(value);
  const messages = typeof result.response === "string" ? [result.response] : array(result.responses).filter((v): v is string => typeof v === "string");
  const assets: AgentResult["assets"] = [];
  const seen = new Set<string>();
  const collect = (items: unknown, depth = 0) => {
    if (depth > 3) return;
    for (const value of array(items).slice(0, 50)) {
      const item = record(value);
      if (item.status === "completed" && approvedAsset(item.resultUrl) && !seen.has(item.resultUrl)) {
        seen.add(item.resultUrl);
        const kind = item.resultType || (/\.(mp4|webm|mp3|wav)(\?|$)/i.test(item.resultUrl) ? "media" : "image");
        if (kind === "image") assets.push({ url: item.resultUrl, label: String(item.label || "Generated image").slice(0, 160) });
      }
      collect(item.pipelineResults, depth + 1);
    }
  };
  for (const call of array(result.tool_calls).map(record)) {
    if (call.toolName === "execute_plan") collect(record(call.result).items);
  }
  const plans = array(result.active_plans).map(record).map(p => ({
    title: String(p.title || "Creative plan"), status: String(p.status || ""),
    credits: typeof p.estimatedCredits === "number" && Number.isFinite(p.estimatedCredits) ? p.estimatedCredits : null,
  }));
  const questions = array(result.proposed_questions).map(record).map(q => typeof q.question === "string" ? q.question : "").filter(Boolean);
  return { messages, assets, plans, questions };
}

export class AgentsError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    // ES5 output needs the prototype restored for status-based retry guards.
    Object.setPrototypeOf(this, AgentsError.prototype);
    this.name = "AgentsError";
  }
}

export function createAgentsClient(getCredential: () => CredentialInput | undefined, refresh: () => Promise<boolean>, fetcher: typeof fetch = fetch) {
  async function request(operation: string, body?: unknown, signal?: AbortSignal) {
    let credential = getCredential();
    if (typeof credential !== "object" || credential.kind !== "oauth") throw new AgentsError("Sign in with your Picsart account to use Agents.", 401);
    if (credential.expiresAt && credential.expiresAt < Date.now() + 60000) {
      if (!await refresh()) throw new AgentsError("Your session expired. Sign in again.", 401);
      credential = getCredential();
      if (typeof credential !== "object" || credential.kind !== "oauth") throw new AgentsError("Sign in again.", 401);
    }
    // Fixed company origin. Never attach OAuth credentials to generated images or arbitrary URLs.
    const response = await fetcher(`${AGENTS_BASE}/${operation}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json", "X-Picsart-Plugin": "Figma" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new AgentsError(response.status === 403 ? "This account does not have access to the staff beta yet."
      : response.status === 401 ? "The Agents service couldn't verify this sign-in. Try signing in again. If this continues, the staff beta connection needs attention."
      : response.status === 404 ? "The hosted Agents beta is not deployed yet."
      : `Picsart could not complete this request (${response.status}).`, response.status);
    return record(await response.json());
  }
  return {
    async catalog(signal?: AbortSignal): Promise<Agent[]> {
      const data = await request("catalog", undefined, signal);
      const agents = array(data.agents).map(record).filter(a => validId(a.id)).map(a => ({
        id: String(a.id), name: String(a.name), role: String(a.role), description: String(a.description || ""),
      }));
      if (!agents.length) throw new AgentsError("No agents are available in staging.");
      return agents;
    },
    async conversation(agentId: string, signal?: AbortSignal): Promise<string> {
      const data = await request("conversation", { agentId }, signal);
      if (typeof data.conversation !== "string") throw new AgentsError("Could not start this conversation.");
      return data.conversation;
    },
    async upload(conversation: string, data: string, signal?: AbortSignal): Promise<string> {
      const result = await request("upload", { conversation, data }, signal);
      if (!approvedAsset(result.url)) throw new AgentsError("The upload returned an unsupported image URL.");
      return result.url;
    },
    async submit(conversation: string, message: string, imageUrls: string[], signal?: AbortSignal): Promise<string> {
      const data = await request("chat", { conversation, message, imageUrls, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, signal);
      if (typeof data.task !== "string") throw new AgentsError("The submission could not be confirmed.");
      return data.task;
    },
    async result(task: string, signal?: AbortSignal): Promise<AgentResult | null> {
      const data = await request("result", { conversation: task }, signal);
      const response = record(data.response);
      if (typeof response.status !== "string") throw new AgentsError("Unrecognized task response.");
      if (response.status.startsWith("FAILED") || typeof record(response.result).statusCode === "number") throw new AgentsError("The agent could not complete this turn. Check Picsart for details.", 422);
      if (response.status !== "COMPLETED") return null;
      const result = normalizeResult(response.result);
      if (!result.messages.length && !result.assets.length && !result.plans.length && !result.questions.length) {
        result.messages.push("This result cannot be displayed here yet. Open Picsart to view it.");
      }
      return result;
    },
  };
}

export async function downloadImage(url: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  if (!approvedAsset(url)) throw new AgentsError("Unsupported image host.");
  const response = await fetcher(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000) });
  const mime = (response.headers.get("content-type") || "").split(";")[0];
  if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new AgentsError("This image format is not supported.");
  const reader = response.body?.getReader();
  if (!reader) throw new AgentsError("Could not download this image.");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 15 * 1024 * 1024) throw new AgentsError("Choose an image smaller than 15 MB.");
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
