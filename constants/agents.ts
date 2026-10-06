// Agents ships only in the separate internal beta build until hosted QA is complete.
declare const __AGENTS_BETA__: boolean;
export const AGENTS_BETA = typeof __AGENTS_BETA__ !== "undefined" && __AGENTS_BETA__;
export const AGENTS_BASE = "https://api-staging.picsart.io/v1/figma/agents";
export const AGENTS_REQUEST = "agents-canvas-request";
export const AGENTS_RESPONSE = "agents-canvas-response";
export const AGENTS_HOST = "agents-host";
