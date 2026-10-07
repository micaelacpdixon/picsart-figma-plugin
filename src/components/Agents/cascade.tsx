import React, { useEffect, useState } from "react";
import { Button } from "@picsart/design-system/components/Button";
import { Tag } from "@picsart/design-system/components/Tag";
import { IconMoon } from "@picsart/design-system/foundation/icons/IconMoon";
import { IconSun } from "@picsart/design-system/foundation/icons/IconSun";
import logo from "@assets/agents/picsart-logo.svg";
import "@picsart/design-system/foundation.css";
import "../../../node_modules/@picsart/design-system/components/Button/styles.css";
import "../../../node_modules/@picsart/design-system/components/Tag/styles.css";
import "../../../node_modules/@picsart/design-system/components/TextField/styles.css";
import "../../../node_modules/@picsart/design-system/components/Text/styles.css";
import "./styles.scss";

export { Button } from "@picsart/design-system/components/Button";
export { Text } from "@picsart/design-system/components/Text";
export { TextField } from "@picsart/design-system/components/TextField";
export { IconArrowUp } from "@picsart/design-system/foundation/icons/IconArrowUp";
export { IconArrowUpRight } from "@picsart/design-system/foundation/icons/IconArrowUpRight";
export { IconChevronDown } from "@picsart/design-system/foundation/icons/IconChevronDown";
export { IconAddPhotoOutline } from "@picsart/design-system/foundation/icons/IconAddPhotoOutline";
export { IconRefresh } from "@picsart/design-system/foundation/icons/IconRefresh";
export { IconArrowLeft } from "@picsart/design-system/foundation/icons/IconArrowLeft";
export { IconPlus } from "@picsart/design-system/foundation/icons/IconPlus";
export { IconCross as IconClose } from "@picsart/design-system/foundation/icons/IconCross";
export { IconSearch } from "@picsart/design-system/foundation/icons/IconSearch";

let chosenTheme: "light" | "dark" | undefined;

export function AgentsShell({ children }: { children: React.ReactNode }) {
  const [hostDark, setHostDark] = useState(() => document.documentElement.classList.contains("figma-dark"));
  const [theme, setTheme] = useState(chosenTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setHostDark(document.documentElement.classList.contains("figma-dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const resolved = theme ?? (hostDark ? "dark" : "light");
  return <section className="agents" data-theme={resolved} aria-label="Picsart AI Agents">
    <header className="agents-brand">
      <img src={logo} alt="Picsart" />
      <span className="agents-brand-divider" />
      <span className="agents-brand-title">AI Agents</span>
      <Tag skin="negative" mode="muted" size="large">Beta</Tag>
      <Button dataTestId="agent-theme" skin="negative" variant="text" size="small"
        centerIcon={resolved === "dark" ? IconSun : IconMoon}
        aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
        onClick={() => { chosenTheme = resolved === "dark" ? "light" : "dark"; setTheme(chosenTheme); }} />
    </header>
    {children}
  </section>;
}
