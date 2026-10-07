import React, { useEffect, useState } from "react";
import type { Props } from "../SignIn/SignIn";
import usePluginHeight from "@hooks/usePluginHeight";
import { cancelSignIn, submitAuthResponse } from "@utils/credentialBridge";
import { SIGN_IN_DECLINED_ERR } from "@constants/errorMessages";
import { SIGN_IN_PASTE_PLACEHOLDER, signedInAs } from "@ui_constants/texts";
import { AgentsShell, Button as CascadeButton, TextField, IconArrowUpRight } from "./cascade";
import aura from "@assets/agents/aura.png";

export default function AgentsSignIn({ authState, showConfirmation, onDone, onRetry }: Props) {
  const [pasted, setPasted] = useState("");
  const [submitting, setSubmitting] = useState(false);
  usePluginHeight(720, 420);
  useEffect(() => { if (authState.status !== "awaiting") setPasted(""); setSubmitting(false); }, [authState.status]);
  const authorizeUrl = authState.status === "awaiting" ? authState.authorizeUrl : undefined;
  const reopen = () => { if (authorizeUrl) window.open(authorizeUrl, "_blank", "noopener,noreferrer"); };
  const canSubmit = !!pasted.trim() && !submitting;
  const submit = () => { if (!canSubmit) return; setSubmitting(true); submitAuthResponse(pasted.trim()); };
    const confirmed = showConfirmation && authState.status === "signedIn";
    const awaiting = authState.status === "awaiting";
    const working = authState.status === "starting" || authState.status === "working";
    const reason = authState.status === "denied" ? SIGN_IN_DECLINED_ERR : authState.status === "failed" ? authState.reason : "";
    return <AgentsShell>
      <div className="agents-auth">
        <img className="agents-auth-avatar" src={aura} alt="Aura, your creative director" />
        <span className="agents-eyebrow">YOUR CREATIVE TEAM</span>
        <h1>{confirmed ? "You're in." : awaiting ? "One quick hello." : working ? "Connecting to Picsart…" : "Let's reconnect."}</h1>
        <p className="agents-auth-description" role="status">{confirmed
          ? "Your account is connected. Let's check which agents are available for you."
          : awaiting ? "Finish signing in at accounts.picsart.com, then come back here."
          : working ? "Getting your account ready. This should only take a moment."
          : reason || "Sign in to bring your creative team into Figma and FigJam."}</p>
        {confirmed && authState.name && <p className="agents-account-name">{signedInAs(authState.name)}</p>}
        {awaiting && authState.mode === "paste" && <div className="agents-auth-code">
          <label htmlFor="signin-code">Paste the return address from your browser</label>
          <TextField id="signin-code" value={pasted} onChange={event => setPasted(event.target.value)}
            onEnter={submit} placeholder={SIGN_IN_PASTE_PLACEHOLDER} dataTestId="agent-auth-code" />
          <CascadeButton dataTestId="agent-auth-submit" isDisabled={!canSubmit} onClick={submit} isFullWidth>Finish sign-in</CascadeButton>
        </div>}
        <div className="agents-auth-actions">
          {confirmed ? <CascadeButton dataTestId="agent-auth-continue" isFullWidth onClick={onDone}>Continue to Agents</CascadeButton>
            : awaiting ? <CascadeButton dataTestId="agent-auth-browser" isFullWidth endIcon={IconArrowUpRight} onClick={reopen}>Open sign-in in browser</CascadeButton>
            : !working && <CascadeButton dataTestId="agent-auth-retry" isFullWidth onClick={onRetry}>Try signing in again</CascadeButton>}
          {!confirmed && <CascadeButton dataTestId="agent-auth-back" skin="negative" variant="text" isFullWidth
            onClick={working || awaiting ? () => void cancelSignIn() : onDone}>{working || awaiting ? "Cancel" : "Back to Agents"}</CascadeButton>}
        </div>
        <div className="agents-auth-detail"><span className="agents-status-dot" /><span>{confirmed ? "Connected with your Picsart account" : "Your account. Your creative space."}</span></div>
      </div>
      <footer className="agents-footer"><span>PA staff beta</span><span>Figma + FigJam</span></footer>
    </AgentsShell>;
}
