---
name: install
description: Activate or update session-pins — sync its extension into your Copilot extensions folder (safe to run anytime; installs, auto-updates a stale copy, or reports it's already up to date).
argument-hint: ""
---

Activate the **session-pins** extension for this Copilot CLI. Copilot CLI does not yet
auto-load a plugin's extension, so its extension must be copied into the Copilot extensions
folder. This command is safe to run anytime — it installs the extension, updates it if the
plugin was upgraded, or reports that it's already up to date. Do this now:

1. Locate the bundled installer and run the one for the current OS.

   Find it by globbing **`**/session-pins/install.*`** under the Copilot home — `$COPILOT_HOME`,
   or `~/.copilot` when `COPILOT_HOME` is unset. That resolves to
   `installed-plugins/<marketplace>/session-pins/`, which ships **both** scripts. Run the one that
   matches the current platform:
   - **Windows** → `install.ps1` (e.g. `pwsh -File <path>` or `& <path>`)
   - **macOS / Linux** → `install.sh` (e.g. `bash <path>`)

   Forward-slash globs work on every OS (including Windows). If more than one plugin folder matches
   (installed from multiple marketplaces), any of them works — they are identical. The installer
   also sits at the root of this plugin (the parent of the `commands/` folder holding this file),
   so a plugin-relative path works too if you can resolve it.

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
