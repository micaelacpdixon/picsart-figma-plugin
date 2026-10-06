# AI Image Generator & Editor by Picsart — Figma plugin

A Figma plugin that calls the Picsart Creative APIs to remove backgrounds, enhance and upscale
images, and generate images from a text prompt. TypeScript + React, bundled with webpack.

This file is the reference: the two runtime contexts, the postMessage seam, and the traps
are all below. There is no separate architecture document.

A pointer here used to name `CLAUDE.md`, which `.gitignore` excludes along with every other
agent file — so anything a clone needs to be told has to live in a tracked file like this
one.

## Running it

```bash
npm install
npm run watch      # development build, rebuilds on change
npm run gate       # typecheck + lint + tests + both builds + two bundle checks. Run before pushing.
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | one-off development build to `dist/` |
| `npm run build:prod` | production build (minified, no source maps) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | `eslint .` |
| `npm test` | Vitest in watch mode |
| `npm run test:run` | Vitest once |
| `npm run gate` | all of the above that matter, in order |

**There is no `npm start`.** It used to exist and was a trap: `webpack.config.js` has no
`devServer` block, so `webpack serve` wrote nothing to `dist/` while `manifest.json` points at
`dist/code.js` and `dist/ui.html`. Figma silently loaded a stale build. Use `npm run watch`.

Node 20 (see `.nvmrc`).

## Loading it into Figma

1. Run a build first — `manifest.json` points at `dist/`, which is gitignored.
2. In Figma, right-click the canvas → **Plugins** → **Manage Plugins**.
3. Import this project's `manifest.json`.

In watch mode, sandbox changes (`src/code.ts`) hot-reload. UI changes (`src/ui.tsx`) need the
plugin re-run.

### You need a credential, and it is not optional

`src/ui.tsx` gates every tab behind a truthy credential, so **until one is stored, no panel
renders at all** — the plugin shows only its chooser screen. This is the step that decides
whether the first five minutes with this repo work, and it was documented nowhere.

There are **two** kinds, held in two independent `clientStorage` slots, and nothing migrates
between them. One is active at a time and a Picsart session takes precedence; both are
retained, so signing out falls back to a retained key rather than locking the plugin.

**Paste a developer API key** (`picsart_api_key`) — **this is the path that works today**:

1. Get a key from [console.picsart.io](https://console.picsart.io) → **Apps**. It is a paid
   product; the free allowance is small and **every button in this plugin spends credits**.
2. Launch the plugin, paste the key into the chooser, submit.
3. Change or remove it on the **Account Balance** tab, which is where the key form lives —
   it had a tab of its own ("Set API Key") until that route was folded into Account.
   **Remove API key** did not exist for a long time while this line claimed it did, and it
   is shown only when a key is actually stored. Removing it does **not** end a Picsart
   session; the two are independent.

**Sign in with a Picsart account** (`picsart_oauth`) — **the mechanism is in place and has not
yet been confirmed against a live Figma session.** Treat a real end-to-end sign-in as the
outstanding step before this is offered to anyone.

## The one thing to understand first

A Figma plugin is **two separate JavaScript environments** that share no memory and communicate
only by `postMessage`:

| | Sandbox | UI iframe |
|---|---|---|
| Entry | `src/code.ts` → `dist/code.js` | `src/ui.tsx` → `dist/ui.html` |
| Has | `figma.*`, canvas nodes, `clientStorage` | full `fetch`, DOM, React |
| Lacks | unrestricted network access | **`figma` does not exist** |

So: every network call to Picsart happens in the UI, and every canvas mutation happens in the
sandbox. Sandbox-side code lives at the repo root (`constants/`, `controllers/`, `routes/`,
`services/`); UI code lives in `src/`. An eslint rule blocks `figma` under `src/**` (except
`src/code.ts`, the sandbox entry point) because reaching for it there is a runtime crash that
TypeScript will not catch.

`ui.html` must ship as a single self-contained file — `InlineChunkHtmlPlugin` inlines the UI's
JS into it. Don't add UI assets that need to load as separate files at runtime.

## Project layout

```
constants/          message types, tabs, commands, endpoints, copy   (shared)
controllers/        one per menu command; all boot via openPanel.ts  (sandbox)
routes/             figma.command -> controller                      (sandbox)
services/           ImageProcessor, UiBridge, MessageListeners        (sandbox)
src/api/            every Picsart API call + sendMessageToSandBox     (UI)
src/components/     React components, incl. ui/ shared primitives    (UI)
src/context/        Balance, Active, Selection                        (UI)
src/hooks/          useSelectedImage — the single selection check     (UI)
src/types/          enums + messages.ts (postMessage payload types)  (shared)
```

## Adding a command

1. Menu entry (`name` + `command`) in `manifest.json`.
2. `COMMAND_*` constant in `constants/commands.ts`.
3. Tab in `TabType` (`src/types/enums.ts`); `constants/tabs.ts` derives `TAB_*` from it.
4. `controllers/XxxController.ts` — call `setMessageListeners(figma)` then `openPanel({ tab, height })`. Export it from `controllers/index.ts`.
5. Map command → controller in `constants/routes.ts`.
6. Component under `src/components/`, plus a `TabType` case in `renderPage()` in `src/ui.tsx`.

## Two rules worth stating up front

**Every API call costs the user money.** Guard each one against firing twice. A `useEffect`
dependency array alone is not enough — a fresh `Uint8Array` is a new identity — and a
`loading` flag must be in the submit guard, because the loading overlay blocks the mouse but
not the keyboard.

**Never `figma.ui.postMessage` directly.** Use `postToUi()` from `services/UiBridge.ts`. It
queues until the UI reports it has mounted, which replaced a `setTimeout(..., 400)` guess in
every controller. `services/__tests__/UiBridge.test.ts` is the spec for that seam: a dropped
boot message shows up as a blank panel with no error, so those tests are the only thing
standing between you and that.

## Tests

Vitest. Tests live in `__tests__/` beside the code, default environment `node`; a component
test opts into jsdom with `// @vitest-environment jsdom` on line 1. `vitest.config.ts` derives
its path aliases from `tsconfig.json`, so adding an alias needs no change there.

Note that `createImageBitmap` does not exist in jsdom and `Image.onload` never fires for blob
URLs, so anything needing a real image decode is manual QA, not a unit test.

**Two tests talk to the real API, and both skip themselves unless you opt in**, so
`npm run gate` is unaffected:

```bash
# Spends credits — one count:1 edit job.
PICSART_LIVE_KEY=paat-… npx vitest run src/api/__tests__/liveEdit.test.ts

# Spends nothing. Answers "does api.picsart.io accept a user bearer today?"
PICSART_LIVE_TOKEN=eyJ… npx vitest run src/api/__tests__/liveOAuth.test.ts --silent=false
```

Both deliberately go through the plugin's own request path rather than hand-rolled `fetch`
calls, and that is not a stylistic preference — a probe that bypasses the code proves the API
works, not that the plugin does. `liveOAuth`'s first version built its credential without
`expiresAt`, exercised a branch production never takes, and reported the wrong error message
as the plugin's behaviour; matching `credentialFromRecord` exactly is what caught a live
mislabel in `classifyTokenFailure`.

Neither can tell you anything about CORS: node performs no preflight. `liveOAuth` therefore
reads the preflight *directly* rather than inferring it from a request succeeding, and the
guard for the request path itself is the header assertion in `editImage.test.ts` against
`CORS_SAFE_REQUEST_HEADERS`.

## Contributing

Branch per feature, Google TypeScript Style Guide, two approvals from code owners.
`CONTRIBUTING.md` describes this repo: it carries the per-stage gate table and the Vitest
layout. It used to be generic Picsart-SDK boilerplate referencing `/tests/`, Python and
Java, and this line used to warn you off it.

## AI Agents / FigJam staff beta

The internal beta extends this plugin with Picsart's existing Agents chat, a live staging agent catalog, separate conversations per agent, explicit canvas attachments, result image placement, and editable FigJam notes. It uses this repository's Picsart OAuth flow and a company-hosted staging gateway. API keys are not accepted for Agents. The beta contains no developer CLI credentials or localhost service dependency.

Use Node 20.19–20.x and run `npm ci` then `npm run gate`. The gate also produces `dist-beta/manifest.json`, `code.js` and the self-contained `ui.html`. Import that manifest into Figma desktop via **Plugins → Development → Import plugin from manifest**. Use **AI Agents** in a Design or FigJam file, then sign in with your own approved Picsart account.

The default production build keeps Agents disabled and preserves the existing public plugin manifest/ID. The beta manifest has a distinct name, enables Figma and FigJam, and omits the public ID. For a later update to an already registered private beta, set `PICSART_FIGMA_BETA_ID` to that beta's assigned Figma ID when building. Never reuse the public ID for the internal beta.

Gilroy Regular, Medium, Semibold and Bold, the official Picsart SVG wordmark, and Aura/Mila portraits are bundled. The Agents theme follows Figma until the user chooses light or dark. Additional agents use initials and come from the authenticated catalog rather than a hardcoded availability list.

### Current release status and limits

- Local typecheck, lint, 562 tests, sandbox evaluation, production build and beta build pass; seven pre-existing tests are skipped. The beta UI is approximately 1.1 MiB, including the bundled fonts and two portraits, within its explicit 1.25 MiB build budget.
- The staff gateway must be deployed and enabled for each tester before chat works. An unavailable service is shown as an error; there is no simulated chat fallback.
- The compiled signed-out panel was visually checked at 420 × 720 in both themes: Gilroy is the computed body/button family, the official SVG loads, and there is no horizontal overflow. Native Figma import succeeded; native launch/sign-in verification was interrupted by the Mac locking.
- Current company OAuth and staging account/credit attribution still require end-to-end acceptance in the installed beta. Source wiring and successful build checks do not establish a live connection.
- Conversations and pending-task recovery last while this Agents panel remains open. Switching agents preserves each conversation, draft and pending task. Switching accounts clears them. Closing the plugin loses local recovery state; check Picsart before repeating an uncertain submission.
- Image results can be inserted into both editors. Video/audio and existing Picsart conversation history are not imported. FigJam notes are limited to 5,000 characters and use FigJam's native editable note font; the plugin UI uses Gilroy.
- Paid submissions are never automatically retried. Interrupted polling resumes the same task. An unknown submission outcome blocks that conversation until the user explicitly acknowledges checking Picsart.

Publish the staff beta only after hosted authentication, two-account isolation, credit attribution, uploads, image placement and native FigJam acceptance are verified. Follow the repository's code-owner review and release process. This is preparation for an internal beta, not a public release.
