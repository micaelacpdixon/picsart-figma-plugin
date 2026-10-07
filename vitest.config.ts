import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { defineConfig } from "vitest/config";

// The alias table already lives in two places (webpack.config.js `resolve.alias`
// and tsconfig.json `paths`), and CLAUDE.md warns that adding an alias means
// editing both or watching bundling and type resolution disagree. Deriving the
// table from tsconfig here keeps a third hand-maintained copy from existing:
// add an alias in tsconfig and the tests pick it up with no edit to this file.
//
// Parsed with TypeScript's own reader rather than JSON.parse, because tsconfig is
// JSONC — it allows comments, and this repo's tsconfig has them.
const rootDir = process.cwd();
const tsconfigPath = resolve(rootDir, "tsconfig.json");
const parsed = ts.parseConfigFileTextToJson(
  tsconfigPath,
  readFileSync(tsconfigPath, "utf8")
);
if (parsed.error) {
  throw new Error(`Could not read ${tsconfigPath} to derive test aliases`);
}

const paths: Record<string, string[]> = parsed.config?.compilerOptions?.paths ?? {};

const alias = Object.keys(paths).map((pattern) => ({
  find: pattern.replace(/\/\*$/, ""),
  replacement: resolve(rootDir, paths[pattern][0].replace(/\/\*$/, "")),
}));

export default defineConfig({
  resolve: { alias },
  test: {
    // Node by default, because the tests worth having most are pure logic over
    // API response shapes and sandbox node handling, and neither needs a DOM.
    // A component test opts in per file with `// @vitest-environment jsdom`.
    environment: "node",
    // Cascade imports its component CSS; let Vite process those imports in jsdom.
    server: { deps: { inline: ["@picsart/design-system"] } },
    include: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
    exclude: ["node_modules", "dist"],
    // Figma plugin code reaches for browser globals that jsdom does not
    // implement (createImageBitmap, blob-URL Image.onload). Tests must not
    // pretend otherwise; anything needing a real decode is left to manual QA.
    restoreMocks: true,
  },
});
