import { readFileSync, writeFileSync } from "node:fs";
const source = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
// Never ship the public plugin's ID in the separately installed internal beta.
delete source.id;
if (process.env.PICSART_FIGMA_BETA_ID) source.id = process.env.PICSART_FIGMA_BETA_ID;
source.name = "Picsart AI Agents — PA staff beta";
source.main = "code.js";
source.ui = "ui.html";
source.editorType = ["figma", "figjam"];
source.menu.unshift({ name: "AI Agents", command: "AI-AGENTS" }, { separator: true });
source.networkAccess.allowedDomains = source.networkAccess.allowedDomains.filter(host => !host.includes("fonts.google"));
source.networkAccess.allowedDomains.push("https://api-staging.picsart.io");
// Returned image URLs are validated separately; these are Picsart's existing media hosts.
source.networkAccess.allowedDomains.push("https://*.picsart.com", "https://*.picsart.io");
delete source.networkAccess.devAllowedDomains;
source.networkAccess.reasoning = "Picsart account sign-in, staff-only staging Agents chat, and Picsart-generated image results.";
writeFileSync(new URL("../dist-beta/manifest.json", import.meta.url), JSON.stringify(source, null, 2) + "\n");
