# session-pins — developer notes

Personal working copy / backup of the **session-pins** Copilot CLI plugin. The
canonical published copy lives in the Agency Playground marketplace repo; this
folder keeps the source together with a persistent test suite (the marketplace
PR only carries the runtime files).

## Layout

```
session-pins/
  .claude-plugin/plugin.json   Marketplace manifest (name, homepage, postInstallMessage, ...)
  agency.json                  Engine/platform/author metadata (engines: ["copilot"])
  extension/extension.mjs      The whole plugin: /pin command, prompt hook, agent tools
  install.ps1 / install.sh     One-time activation (Copilot CLI can't auto-load extensions yet)
  README.md                    User-facing readme
  package.json                 `npm test` wiring
  test/                        Persistent test suite (see below)
```

## What the plugin does

A single `/pin` command plus agent-callable tools that pin editable instructions
and live files into every prompt of a Copilot CLI session. Pins are stored in
`pins.json` in the session folder (`session.workspacePath`) and travel with the
session. File pins under `<session>/files` are stored relative and resolved at
read time; files elsewhere are stored absolute.

## Testing

```
cd session-pins
npm test
```

The suite runs the **real** `extension/extension.mjs` unmodified. Because the
extension imports `@github/copilot-sdk/extension` (only present inside the
installed CLI), `test/sdk-loader.mjs` is an ESM loader hook that resolves that
bare specifier to `test/sdk-mock.mjs`, which returns a test-controlled session
object. `test/run.mjs` then drives the tools and the prompt hook against
throwaway temp session folders.

Coverage (all behaviours that came out of code review):
- **Consent gates** — every model-initiated pin (`pin_file`, `pin_prompt`) asks
  for confirmation, refuses when no elicitation UI is available, and only pins on
  approval. Direct `/pin` invocation is not gated.
- **XML escaping** — injected file contents and prompt text escape `< & >`, and
  the `id`/`path` attributes on the `<live-file-pin>` / `<prompt-pin>` wrappers
  escape `< & > " '` so untrusted paths/content can't break the wrapper
  (prompt-injection boundary).
- **Malformed pins** — a partially-corrupt `pins.json` never crashes a command;
  invalid entries are dropped on load with a warning.
- **Durable saves** — `saveStore` fsyncs a temp file then renames it atomically,
  leaves valid/complete JSON, no `.tmp` litter, and serializes concurrent saves.

## Local install (manual test in the CLI)

```powershell
# Windows
& .\install.ps1 -Force
```

```bash
# macOS/Linux
./install.sh
```

Then restart Copilot CLI (launched with `--experimental`) and try `/pin`, or ask
Copilot to pin an instruction or a file.

## Pushing changes to the marketplace PR

The published plugin is submitted via a PR to the Agency Playground repo
(`plugins/session-pins/`). To update it, copy the runtime files
(`extension/`, `.claude-plugin/`, `agency.json`, `install.*`, `README.md`) into
the playground clone, normalize to LF/UTF-8-no-BOM, commit, and push the PR
branch. The `test/`, `package.json`, and this file are dev-only and are **not**
part of the marketplace submission.
