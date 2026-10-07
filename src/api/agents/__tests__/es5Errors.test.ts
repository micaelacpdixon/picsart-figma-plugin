import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

it("preserves status-based error handling in the plugin's ES5 build", () => {
  const source = readFileSync(new URL("../client.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({ exports: {}, require: () => ({ AGENTS_BASE: "https://example.invalid" }) });
  vm.runInContext(compiled, context);
  const isRecognized = vm.runInContext(`
    [401, 403, 404, 422, 429].every(status => {
      const error = new exports.AgentsError("Rejected", status);
      return error instanceof exports.AgentsError && error instanceof Error && error.status === status;
    })
  `, context);
  expect(isRecognized).toBe(true);
});
