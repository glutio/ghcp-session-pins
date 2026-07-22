---
name: install
description: One-time activation and updater for session-pins. Use when the user wants to activate, install, enable, or update the session-pins extension (it syncs the extension into the Copilot extensions folder; safe to run anytime — installs, auto-updates a stale copy, or reports it's already up to date).
argument-hint: ""
disable-model-invocation: true
---

Activate the **session-pins** extension for this Copilot CLI. Copilot CLI does not yet
auto-load a plugin's extension, so its extension must be copied into the Copilot extensions
folder. This command is safe to run anytime — it installs the extension, updates it if the
plugin was upgraded, or reports that it's already up to date. Do this now:

1. Locate the bundled installer and run the one for the current OS.

   Find it by globbing `**/session-pins/install.*` under the Copilot home — `$COPILOT_HOME`,
   or `~/.copilot` when `COPILOT_HOME` is unset. That resolves to
   `installed-plugins/<marketplace>/session-pins/`, which ships **both** scripts. Run the one that
   matches the current platform:
   - **Windows** → `install.ps1` (e.g. `pwsh -File <path>` or `& <path>`)
   - **macOS / Linux** → `install.sh` (e.g. `bash <path>`)

   Forward-slash globs work on every OS (including Windows). If more than one plugin folder matches
   (installed from multiple marketplaces), any of them works — they are identical. The installer
   also sits at the root of this plugin (the grandparent of this file, which lives at
   `skills/install/SKILL.md`), so a plugin-relative path works too if you can resolve it.

   Run the installer **with no extra flags** — do **not** pass `-Force` (PowerShell) or `--force`
   (bash). The installer already detects and applies updates on its own; the force flag only
   suppresses the "already up to date" fast path. Only add it if the user explicitly asks to force
   a reinstall.

   Show the user the script's path and ask permission before running it.

2. Report the outcome based on what the installer printed — the installer distinguishes three
   cases; relay the matching one and do not describe an up-to-date result as a fresh install:
   - **Installed** (`[OK] ... installed`): a fresh install. Tell the user to **relaunch Copilot
     with `copilot --experimental`** so the extension loads (extensions only load in experimental
     mode).
   - **Updated** (`[OK] ... updated to the current version`): the plugin was upgraded and the
     extension was refreshed. Tell the user to **restart Copilot** (relaunch with `--experimental`)
     so the updated extension loads.
   - **Already up to date** (`already installed and up to date` / `nothing to do`): tell the user
     session-pins is **already active and current** — no relaunch needed unless `/pin` isn't
     showing up (then relaunch with `--experimental`).

3. In all cases, show the usage lines the installer printed (`/pin`, `/pin add <text>`,
   `/pin add @<path>`, or just asking Copilot in plain language).

Do not modify the user's `settings.json` or run anything other than the bundled installer.

## Response template

Keep your replies predictable by reporting these fields in order (omit any that don't apply):

- **Installer path** — the full path you resolved (or that you could not find one).
- **Permission** — that you asked before running it, and whether the user approved.
- **Result** — one of `installed`, `updated`, `already up to date`, or `failed`.
- **Next step** — relaunch with `copilot --experimental` for `installed`/`updated`; nothing for
  `already up to date` (unless `/pin` is missing); or the remediation below for `failed`.
- **Usage** — the `/pin` usage lines the installer printed, once the extension is active.

## Failure handling

If any step cannot complete, **report what happened, suggest the most likely fix, and stop** —
do not silently retry, guess another path, or run anything other than the bundled installer.

- **No installer found** (the glob matches nothing): the plugin may not be installed, or
  `COPILOT_HOME` may point somewhere unexpected. Tell the user, and suggest they confirm the
  plugin is installed (`copilot plugin list` should show `session-pins`) and check whether
  `COPILOT_HOME` is set to a non-default location. Do not invent a path.
- **User declines permission**: do not run the installer. Explain that activation can't proceed
  without it, and that they can run `install.ps1` / `install.sh` from the plugin folder themselves,
  then relaunch with `copilot --experimental`.
- **Installer exits non-zero or prints an error** (e.g. it *Refuses to install* because
  `COPILOT_HOME` is a filesystem root / non-absolute / contains `..`, or a permissions/execution
  error): surface the installer's own message verbatim, and point at the likely cause — an
  unusual `COPILOT_HOME`, or (on Windows) PowerShell execution policy blocking the script (they can
  run it with `pwsh -ExecutionPolicy Bypass -File <path>`). Do not work around a refusal.
- **Installer output is unrecognized** (none of the three success phrases): report the raw output
  and do not claim success; suggest re-running once and, if it persists, checking the plugin
  install.
