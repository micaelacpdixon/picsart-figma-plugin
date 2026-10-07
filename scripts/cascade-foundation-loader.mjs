import postcss from "postcss";

// Use Cascade's shipped tokens without resetting the legacy tools or fetching
// remote font files. Gilroy is already embedded in the self-contained plugin.
export default function scopeCascade(source) {
  const css = postcss.parse(source);
  css.walkAtRules("font-face", rule => rule.remove());
  css.walkAtRules("layer", rule => {
    if (rule.params === "ds-reset") rule.walkRules(reset => {
      if (reset.selectors.some(selector => /\b(html|body)\b/.test(selector))) reset.remove();
    });
  });
  css.walkRules(rule => {
    if (rule.parent.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
    rule.selectors = rule.selectors.map(selector => {
      if (/\bhtml\b/.test(selector)) {
        return selector.replace(/\bhtml(?:\.(light|dark))?/g, (_, theme) =>
          theme ? `:where(.agents[data-theme="${theme}"])` : ":where(.agents)");
      }
      return `:where(.agents) ${selector}`;
    });
  });
  return css.toString();
};
