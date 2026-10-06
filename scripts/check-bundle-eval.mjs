import { readFileSync } from "node:fs";
import vm from "node:vm";

const BUNDLE = process.argv[2] || "dist/code.js";

let source;
try {
  source = readFileSync(BUNDLE, "utf8");
} catch {
  console.error(`check-bundle-eval: cannot read ${BUNDLE} — run \`npm run build\` first.`);
  process.exit(1);
}

const noop = () => undefined;

const figma = {
  command: "",
  currentPage: { selection: [], children: [], findOne: () => null },
  viewport: {
    bounds: { x: 0, y: 0, width: 1000, height: 1000 },
    center: { x: 0, y: 0 },
    scrollAndZoomIntoView: noop,
  },
  ui: { postMessage: noop, resize: noop, onmessage: undefined },
  showUI: noop,
  closePlugin: noop,
  notify: noop,
  on: noop,
  clientStorage: {
    getAsync: async () => undefined,
    setAsync: async () => undefined,
    deleteAsync: async () => undefined,
  },
  getNodeByIdAsync: async () => null,
  getImageByHash: () => null,
  createImage: () => ({ hash: "h", getSizeAsync: async () => ({ width: 1, height: 1 }) }),
  createRectangle: () => ({}),
  loadFontAsync: async () => undefined,
};

const quiet = { log: noop, warn: noop, error: noop, info: noop, debug: noop };

const context = vm.createContext({
  figma,
  __html__: "<html></html>",
  console: quiet,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => {
    throw new Error("check-bundle-eval: no network in this harness");
  },
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
});

try {
  new vm.Script(source, { filename: BUNDLE }).runInContext(context);
} catch (error) {
  console.error(`check-bundle-eval: ${BUNDLE} threw while being evaluated.\n`);
  console.error(error);
  console.error(
    `\nFigma evaluates this file on launch, so this is a plugin that does not start. ` +
      `If you are running \`npm run watch\`, it may also have written this bundle mid-edit.`
  );
  process.exit(1);
}

console.log(`check-bundle-eval: ok — ${BUNDLE} evaluates and boots.`);
process.exit(0);
