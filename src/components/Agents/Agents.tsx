import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCredential } from "../../context/CredentialContext";
import { createAgentsClient, downloadImage, AgentsError, type Agent, type AgentResult } from "@api/agents/client";
import { sendMessageToSandBox } from "@api/index";
import { TYPE_SWITCH_TAB } from "@constants/types";
import { TabType } from "@app-types/enums";
import { requestCanvas } from "./canvasBridge";
import logo from "@assets/agents/picsart-logo.svg";
import aura from "@assets/agents/aura.png";
import mila from "@assets/agents/style-remix.png";
import "./styles.scss";

type ChatMessage = { role: "user" | "agent"; text: string; result?: AgentResult };
type Attachment = { name: string; data: string; preview: string };
type Chat = { messages: ChatMessage[]; draft: string; conversation?: string; task?: string; uncertain?: boolean; attachment?: Attachment; error?: string };
const emptyChat = (): Chat => ({ messages: [], draft: "" });
const avatars: Record<string, string> = { aura, "style-remix": mila };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
const wait = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new Error("Stopped waiting.")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1800);
  signal.addEventListener("abort", abort, { once: true });
});

export function accountKey(token: string): string {
  try {
    const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const value = JSON.parse(atob(encoded));
    // For local UI isolation only. The gateway authenticates the token and owns authorization.
    if (typeof value.sub === "string") return `${String(value.iss || "")}:${value.sub}`;
  } catch { /* Opaque token: clearing on refresh is safer than sharing another user's chat. */ }
  return token;
}

export default function Agents({ onSignIn }: { onSignIn: () => void }) {
  const { credential, getCredential, refreshCredential } = useCredential();
  const identity = credential?.kind === "oauth" ? accountKey(credential.token) : "signed-out";
  return <AgentsSession key={identity} onSignIn={onSignIn} oauth={credential?.kind === "oauth"}
    client={createAgentsClient(getCredential, refreshCredential)} />;
}

function AgentsSession({ onSignIn, oauth, client: incomingClient }: { onSignIn: () => void; oauth: boolean; client: ReturnType<typeof createAgentsClient> }) {
  // Keep one client and one set of conversations for the current account.
  const client = useRef(incomingClient).current;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState("aura");
  const [chats, setChats] = useState<Record<string, Chat>>({});
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState<"auto" | "light" | "dark">("auto");
  const [editor, setEditor] = useState("figma");
  const [notice, setNotice] = useState("");
  const abortRef = useRef(new AbortController());
  const bottomRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const agent = agents.find(a => a.id === selected);
  const chat = chats[selected] || emptyChat();
  const blocked = busy || !!chat.task || !!chat.uncertain;
  const filtered = useMemo(() => agents.filter(a => `${a.name} ${a.role}`.toLowerCase().includes(search.toLowerCase())), [agents, search]);
  const update = (id: string, patch: Partial<Chat>) => setChats(previous => ({ ...previous, [id]: { ...(previous[id] || emptyChat()), ...patch } }));

  const loadCatalog = async () => {
    setLoading(true); setCatalogError("");
    try {
      const list = await client.catalog(abortRef.current.signal);
      setAgents(list); setSelected(list.some(a => a.id === "aura") ? "aura" : list[0].id);
    } catch (error) { if (!abortRef.current.signal.aborted) setCatalogError(errorText(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (oauth) void loadCatalog();
    void requestCanvas("host").then(data => setEditor(String(data.editor))).catch(() => {});
    return () => abortRef.current.abort();
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ block: "end" }); }, [chat.messages.length, busy]);

  async function poll(id: string, task: string, messages: ChatMessage[]) {
    for (let attempt = 0; attempt < 65; attempt++) {
      const result = await client.result(task, abortRef.current.signal);
      if (result) {
        update(id, { task: undefined, error: undefined, messages: [...messages, { role: "agent", text: result.messages.join("\n\n"), result }] });
        return;
      }
      await wait(abortRef.current.signal);
    }
    update(id, { error: "Still working. Use Check result to continue waiting; it won't send another request." });
  }

  const send = async () => {
    if (busyRef.current || !agent || blocked || !chat.draft.trim()) return;
    busyRef.current = true; setBusy(true); update(selected, { error: undefined });
    const id = selected; let submitted = false; let task: string | undefined;
    try {
      const conversation = chat.conversation || await client.conversation(id, abortRef.current.signal);
      update(id, { conversation });
      const imageUrls = chat.attachment ? [await client.upload(conversation, chat.attachment.data, abortRef.current.signal)] : [];
      submitted = true;
      task = await client.submit(conversation, chat.draft.trim(), imageUrls, abortRef.current.signal);
      const messages: ChatMessage[] = [...chat.messages, { role: "user", text: chat.draft.trim() + (chat.attachment ? `\n[Attached: ${chat.attachment.name}]` : "") }];
      update(id, { task, messages, draft: "", attachment: undefined });
      await poll(id, task, messages);
    } catch (error) {
      if (!abortRef.current.signal.aborted) {
        const definitive = error instanceof AgentsError && [401, 403, 404, 422, 429].includes(error.status);
        const uncertain = submitted && !task && !definitive;
        update(id, { uncertain, ...(error instanceof AgentsError && error.status === 422 ? { task: undefined } : {}), error: uncertain
          ? "Submission not confirmed. It may still be running in Picsart. Check there before starting another chat."
          : errorText(error) });
      }
    } finally { busyRef.current = false; setBusy(false); }
  };

  const resume = async () => {
    if (busyRef.current || !chat.task) return;
    busyRef.current = true; setBusy(true); update(selected, { error: undefined });
    try { await poll(selected, chat.task, chat.messages); }
    catch (error) { if (!abortRef.current.signal.aborted) update(selected, { error: errorText(error), ...(error instanceof AgentsError && error.status === 422 ? { task: undefined } : {}) }); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const canvas = async (action: () => Promise<unknown>, success: string) => {
    if (canvasBusy) return;
    setCanvasBusy(true); setNotice("");
    try { await action(); setNotice(success); }
    catch (error) { setNotice(errorText(error)); }
    finally { setCanvasBusy(false); }
  };
  const capture = () => canvas(async () => {
    const result = await requestCanvas("capture");
    const bytes = new Uint8Array(result.bytes as number[]);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192)));
    const data = btoa(binary);
    update(selected, { attachment: { name: String(result.name), data, preview: `data:image/png;base64,${data}` } });
  }, "Selection attached. It will be uploaded when you send.");

  return <section className="agents" data-theme={theme} aria-label="Picsart AI Agents">
    <header className="agents-brand"><img src={logo} alt="Picsart" /><span>AI Agents</span><small>STAFF BETA</small>
      <button className="agents-icon" aria-label={`Theme: ${theme}. Change theme`} onClick={() => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")}>{theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</button>
    </header>
    <div className="agents-toolbar">
      <button className="agent-current" onClick={() => setPicker(!picker)} disabled={!agents.length || busy || canvasBusy} aria-expanded={picker} aria-label="Change agent">
        {avatars[selected] && <img src={avatars[selected]} alt="" />}<span><strong>{agent?.name || "Choose an agent"}</strong><small>{agent?.role || "Your creative team, in Figma"}</small></span><span>⌄</span>
      </button>
      <button className="agents-icon" title="New chat" aria-label="New chat" disabled={blocked || canvasBusy || !chat.messages.length} onClick={() => setChats(previous => ({ ...previous, [selected]: emptyChat() }))}>＋</button>
    </div>
    {picker ? <div className="agents-picker"><label>Find your creative partner<input autoFocus type="search" placeholder="Search agents or skills" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="agents-options">{filtered.map(a => <button key={a.id} aria-pressed={selected === a.id} onClick={() => { setSelected(a.id); setPicker(false); setNotice(""); }}>
        {avatars[a.id] ? <img src={avatars[a.id]} alt="" /> : <span className="agent-initial">{a.name.slice(0, 1)}</span>}<span><strong>{a.name}</strong><small>{a.role}</small></span>{selected === a.id && <span>✓</span>}
      </button>)}{!filtered.length && <p>No matching agents.</p>}</div></div>
      : <div className="agents-transcript" role="log" aria-label="Conversation" aria-live="polite">
        {!oauth ? <div className="agents-welcome"><img src={aura} alt="Aura, Picsart's creative agent" /><h1>Your next idea starts here.</h1><p>Bring your Picsart creative team into Figma and FigJam.</p><button className="agents-primary" onClick={onSignIn}>Sign in with Picsart</button><small>Use your own account for the PA staff beta.</small></div>
          : loading ? <p className="agents-loading" role="status">Finding your creative team…</p>
          : catalogError ? <div className="agents-welcome"><h2>Let's get connected.</h2><p role="alert">{catalogError}</p><button onClick={loadCatalog}>Try again</button><button onClick={onSignIn}>Sign in again</button></div>
          : !chat.messages.length && <div className="agents-welcome">{avatars[selected] && <img src={avatars[selected]} alt="" />}<span className="agents-eyebrow">MEET {agent?.name?.toUpperCase() || "YOUR TEAM"}</span><h1>What are we<br />creating today?</h1><p>{agent?.description || "An idea, a frame, a fresh direction. Let's make it happen."}</p>
            <div className="agents-starters">{["Help me explore a creative direction", "Give me feedback on my selection", "Turn an idea into a visual concept"].map(prompt => <button key={prompt} onClick={() => update(selected, { draft: prompt })} disabled={blocked}>{prompt}<span>↗</span></button>)}</div></div>}
        {chat.messages.map((message, index) => <article key={index} className={`agent-message ${message.role}`}><small>{message.role === "user" ? "You" : agent?.name}</small><p>{message.text}</p>
          {message.result?.plans.map((plan, i) => <div className="agent-plan" key={i}><strong>{plan.title}</strong><small>{plan.status}{plan.credits !== null ? ` · Estimated ${plan.credits} credits` : ""}</small></div>)}
          {message.result?.assets.map(asset => <div className="agent-image" key={asset.url}><img src={asset.url} alt={asset.label} referrerPolicy="no-referrer" /><button disabled={canvasBusy} onClick={() => canvas(async () => { const bytes = await downloadImage(asset.url); await requestCanvas("image", { bytes: Array.from(bytes), name: `${agent?.name} — ${asset.label}` }); }, "Image added to the canvas.")}>Add to {editor === "figjam" ? "board" : "canvas"} ↗</button></div>)}
          {editor === "figjam" && message.role === "agent" && message.text && <button className="agents-text-button" disabled={canvasBusy || message.text.length + (agent?.name.length || 0) + 2 > 5000} onClick={() => canvas(() => requestCanvas("note", { text: `${agent?.name}\n\n${message.text}` }), "Note added to the board.")}>Add note to board ↗</button>}
          {message.result?.questions.map(question => <button className="agent-question" key={question} disabled={blocked} onClick={() => update(selected, { draft: question })}>{question}</button>)}
        </article>)}
        {busy && <p className="agent-thinking" role="status">{agent?.name || "Your agent"} is working…</p>}
        {chat.error && <div className="agents-error" role="alert"><p>{chat.error}</p>{chat.task && !busy && <button onClick={resume}>Check result</button>}{chat.uncertain && <button onClick={() => setChats(previous => ({ ...previous, [selected]: emptyChat() }))}>I've checked Picsart — start a new chat</button>}</div>}
        <div ref={bottomRef} />
      </div>}
    {oauth && agents.length > 0 && !picker && <div className="agents-composer"><label className="sr-only" htmlFor="agent-prompt">Message {agent?.name}</label>
      {chat.attachment && <div className="agents-attachment"><img src={chat.attachment.preview} alt="Selected canvas content" /><span>{chat.attachment.name}</span><button aria-label="Remove attachment" disabled={blocked} onClick={() => update(selected, { attachment: undefined })}>×</button></div>}
      <textarea id="agent-prompt" rows={2} maxLength={8000} placeholder={`Ask ${agent?.name || "your agent"} anything…`} value={chat.draft} disabled={blocked} onChange={e => update(selected, { draft: e.target.value })} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="agents-compose-actions"><button disabled={blocked || canvasBusy} onClick={capture}>＋ Attach selection</button><button className="agents-send" aria-label="Send message" disabled={blocked || !chat.draft.trim() || canvasBusy} onClick={send}>↑</button></div>
    </div>}
    {notice && <p className="agents-notice" role="status">{notice}</p>}
    <footer className="agents-footer"><span>Staging · {editor === "figjam" ? "FigJam" : "Figma"}</span><button disabled={busy || canvasBusy || Object.values(chats).some(value => !!value.task || !!value.uncertain)} onClick={() => sendMessageToSandBox(true, "", TYPE_SWITCH_TAB, undefined, { tab: TabType.GENERATE_IMAGE })}>Other Picsart tools ↗</button></footer>
  </section>;
}
