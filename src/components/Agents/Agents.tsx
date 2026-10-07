import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCredential } from "../../context/CredentialContext";
import { createAgentsClient, downloadImage, AgentsError, type Agent, type AgentResult } from "@api/agents/client";
import { sendMessageToSandBox } from "@api/index";
import { TYPE_SWITCH_TAB } from "@constants/types";
import { TabType } from "@app-types/enums";
import { requestCanvas } from "./canvasBridge";
import { AgentsShell, Button, Text, TextField, IconArrowUp, IconArrowUpRight, IconChevronDown, IconAddPhotoOutline, IconRefresh, IconArrowLeft, IconPlus, IconClose, IconSearch } from "./cascade";
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
  const [catalogStatus, setCatalogStatus] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState("");
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
    setLoading(true); setCatalogError(""); setCatalogStatus(0);
    try {
      const list = await client.catalog(abortRef.current.signal);
      setAgents(list); setSelected(list.some(a => a.id === "aura") ? "aura" : list[0].id);
    } catch (error) { if (!abortRef.current.signal.aborted) { setCatalogError(errorText(error)); setCatalogStatus(error instanceof AgentsError ? error.status : 0); } }
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

  return <AgentsShell>
    {oauth && agents.length > 0 && <div className="agents-toolbar">
      <button className="agent-current" onClick={() => setPicker(!picker)} disabled={busy || canvasBusy} aria-expanded={picker} aria-label="Change agent">
        {avatars[selected] ? <img src={avatars[selected]} alt="" /> : <span className="agent-initial">{agent?.name.slice(0, 1)}</span>}
        <span><strong>{agent?.name || "Choose an agent"}</strong><small>{agent?.role || "Your creative partner"}</small></span><IconChevronDown />
      </button>
      <Button dataTestId="agent-new-chat" skin="negative" variant="text" size="small" centerIcon={IconPlus}
        title="New chat" aria-label="New chat" isDisabled={blocked || canvasBusy || !chat.messages.length}
        onClick={() => setChats(previous => ({ ...previous, [selected]: emptyChat() }))} />
    </div>}
    {picker ? <div className="agents-picker">
      <div className="agents-picker-heading"><div><h2>Your creative team</h2><p>A different perspective for every idea.</p></div>
        <Button dataTestId="agent-picker-back" skin="negative" variant="text" size="small" centerIcon={IconArrowLeft} aria-label="Back to conversation" onClick={() => setPicker(false)} />
      </div>
      <TextField autoFocus type="search" aria-label="Search agents" placeholder="Search by name or skill" startIcon={IconSearch}
        value={search} onChange={event => setSearch(event.target.value)} dataTestId="agent-search" />
      <div className="agents-options">{filtered.map(a => <button className="agent-option" key={a.id} aria-pressed={selected === a.id}
        onClick={() => { setSelected(a.id); setPicker(false); setNotice(""); }}>
        {avatars[a.id] ? <img src={avatars[a.id]} alt="" /> : <span className="agent-initial">{a.name.slice(0, 1)}</span>}
        <span><strong>{a.name}</strong><small>{a.role}</small></span><span className="agent-option-mark">{selected === a.id ? "Selected" : <IconArrowUpRight />}</span>
      </button>)}{!filtered.length && <p className="agents-empty-search">No agents match “{search}”. Try another name or skill.</p>}</div>
    </div> : <div className="agents-transcript" role="log" aria-label="Conversation" aria-live="polite">
      {!oauth ? <div className="agents-welcome agents-onboarding">
        <div className="agents-portrait-pair"><img src={aura} alt="Aura, your creative director" /><img src={mila} alt="Mila, your art director" /></div>
        <span className="agents-eyebrow">A LITTLE CREATIVE COMPANY</span>
        <h1>Big ideas.<br />Meet your team.</h1>
        <p>Find a direction, explore a new look, and bring it straight to your canvas.</p>
        <div className="agents-onboarding-actions"><Button dataTestId="agent-signin" isFullWidth onClick={onSignIn} endIcon={IconArrowUpRight}>Sign in with Picsart</Button><small>Opens Picsart's account sign-in in your browser.</small></div>
        <div className="agents-feature-list"><span><IconAddPhotoOutline /> Start with your selection</span><span><IconArrowUpRight /> Bring ideas onto the canvas</span></div>
      </div> : loading ? <div className="agents-loading" role="status"><div className="agents-loading-avatars"><img src={aura} alt="" /><img src={mila} alt="" /></div><h2>Getting the team together…</h2><p>Connecting to your Picsart agents.</p></div>
        : catalogError ? <div className="agents-connection">
          <div className="agents-account-status"><span className="agents-status-dot" />{catalogStatus === 401 ? "Agents connection not verified" : "Picsart account connected"}</div>
          <img className="agents-connection-avatar" src={aura} alt="" />
          <h1>{catalogStatus === 404 ? <>Your team is<br />almost here.</> : "Let's get you connected."}</h1>
          <p className="agents-connection-error" role="alert">{catalogError}</p>
          {catalogStatus !== 401 && <p className="agents-connection-note">Your Agents balance hasn't been checked. Adding credits won't resolve this connection issue.</p>}
          <div className="agents-connection-actions"><Button dataTestId="agent-retry" startIcon={IconRefresh} onClick={loadCatalog} isFullWidth>Check connection</Button>
            <Button dataTestId="agent-open-picsart" variant="outlined" skin="negative" isFullWidth endIcon={IconArrowUpRight} onClick={() => window.open("https://picsartstage2.com/ai-agent/", "_blank", "noopener,noreferrer")}>Open Picsart Agents</Button>
            <Button dataTestId="agent-reconnect" variant="text" skin="negative" size="small" onClick={onSignIn}>Sign in again</Button></div>
        </div> : !chat.messages.length && <div className="agents-welcome">
          <div className="agents-hello"><Text size="t4" color="tint-1">A fresh perspective, with {agent?.name}.</Text></div>
          <h1>What are we<br />creating today?</h1>
          <p>{agent?.description || "An idea, a frame, a fresh direction. Let's make it happen."}</p>
          <div className="agents-starters"><span className="agents-starters-label">A FEW PLACES TO START</span>{[
            ["Explore a creative direction", "Help me explore a creative direction"],
            ["Get feedback on my selection", "Give me feedback on my selection"],
            ["Turn an idea into a visual", "Turn an idea into a visual concept"],
          ].map(([label, prompt], index) => <Button key={label} dataTestId={`agent-starter-${index}`} skin="neutral" variant="filled" isFullWidth endIcon={IconArrowUpRight}
            onClick={() => update(selected, { draft: prompt })} isDisabled={blocked}>{label}</Button>)}</div>
        </div>}
      {chat.messages.map((message, index) => <article key={index} className={`agent-message ${message.role}`}>
        <div className="agent-message-author">{message.role === "agent" && avatars[selected] && <img src={avatars[selected]} alt="" />}<span>{message.role === "user" ? "You" : agent?.name}</span></div>
        <p>{message.text}</p>
        {message.result?.plans.map((plan, i) => <div className="agent-plan" key={i}><span className="agents-eyebrow">CREATIVE PLAN</span><strong>{plan.title}</strong><small>{plan.status}{plan.credits !== null ? ` · Estimated ${plan.credits} credits` : ""}</small></div>)}
        {message.result?.assets.map((asset, i) => <div className="agent-image" key={asset.url}><img src={asset.url} alt={asset.label} referrerPolicy="no-referrer" />
          <Button dataTestId={`agent-place-${index}-${i}`} isFullWidth isDisabled={canvasBusy} endIcon={IconArrowUpRight} onClick={() => canvas(async () => { const bytes = await downloadImage(asset.url); await requestCanvas("image", { bytes: Array.from(bytes), name: `${agent?.name} — ${asset.label}` }); }, "Image added to the canvas.")}>Add to {editor === "figjam" ? "board" : "canvas"}</Button></div>)}
        {editor === "figjam" && message.role === "agent" && message.text && <Button dataTestId={`agent-note-${index}`} skin="negative" variant="text" size="small" endIcon={IconArrowUpRight}
          isDisabled={canvasBusy || message.text.length + (agent?.name.length || 0) + 2 > 5000} onClick={() => canvas(() => requestCanvas("note", { text: `${agent?.name}\n\n${message.text}` }), "Note added to the board.")}>Add note to board</Button>}
        {message.result?.questions.map((question, i) => <Button dataTestId={`agent-question-${index}-${i}`} className="agent-question" variant="outlined" skin="negative" key={question} isDisabled={blocked} onClick={() => update(selected, { draft: question })}>{question}</Button>)}
      </article>)}
      {busy && <div className="agent-thinking" role="status"><span /><span /><span /><small>{agent?.name || "Your agent"} is working</small></div>}
      {chat.error && <div className="agents-error" role="alert"><p>{chat.error}</p>
        {chat.task && !busy && <Button dataTestId="agent-check-result" size="small" onClick={resume}>Check result</Button>}
        {chat.uncertain && <Button dataTestId="agent-acknowledge" variant="outlined" skin="negative" onClick={() => setChats(previous => ({ ...previous, [selected]: emptyChat() }))}>I've checked Picsart — start a new chat</Button>}</div>}
      <div ref={bottomRef} />
    </div>}
    {oauth && agents.length > 0 && !picker && <div className="agents-composer-wrap"><div className="agents-composer">
      <label className="sr-only" htmlFor="agent-prompt">Message {agent?.name}</label>
      {chat.attachment && <div className="agents-attachment"><img src={chat.attachment.preview} alt="Selected canvas content" /><span>{chat.attachment.name}</span>
        <Button dataTestId="agent-remove-attachment" aria-label="Remove attachment" skin="negative" variant="text" size="small" centerIcon={IconClose} isDisabled={blocked} onClick={() => update(selected, { attachment: undefined })} /></div>}
      <textarea id="agent-prompt" rows={2} maxLength={8000} placeholder={`Ask ${agent?.name || "your agent"} anything…`} value={chat.draft} disabled={blocked}
        onChange={e => update(selected, { draft: e.target.value })} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="agents-compose-actions"><Button dataTestId="agent-attach" skin="negative" variant="text" size="small" startIcon={IconAddPhotoOutline} isDisabled={blocked || canvasBusy} onClick={capture}>Attach selection</Button>
        <Button dataTestId="agent-send" aria-label="Send message" size="small" centerIcon={IconArrowUp} isDisabled={blocked || !chat.draft.trim() || canvasBusy} onClick={send} /></div>
    </div><small className="agents-compose-hint">Enter to send · Shift + Enter for a new line</small></div>}
    {notice && <p className="agents-notice" role="status">{notice}</p>}
    <footer className="agents-footer"><span>PA staff beta · {editor === "figjam" ? "FigJam" : "Figma"}</span>
      <Button dataTestId="agent-other-tools" skin="negative" variant="text" size="small" endIcon={IconArrowUpRight}
        isDisabled={busy || canvasBusy || Object.values(chats).some(value => !!value.task || !!value.uncertain)}
        onClick={() => sendMessageToSandBox(true, "", TYPE_SWITCH_TAB, undefined, { tab: TabType.GENERATE_IMAGE })}>More tools</Button></footer>
  </AgentsShell>;
}
