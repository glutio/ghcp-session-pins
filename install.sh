#!/usr/bin/env bash
# install.sh - copy the session-pins extension into the canonical Copilot CLI
# extensions directory so the CLI loads it on next startup.
#
# Usage (from the plugin directory):
#   ./install.sh
#
# Or from anywhere, if the plugin is installed via the Agency Playground marketplace:
#   "$HOME/.copilot/installed-plugins/agency-playground/session-pins/install.sh"

set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" || "${1:-}" == "-f" ]]; then
    FORCE=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$SCRIPT_DIR/extension"

# Refuse to run if HOME is unset/empty or "/", so the recursive delete below can
# never target an unintended location (e.g. "/.copilot/extensions/session-pins").
if [[ -z "${HOME:-}" || "$HOME" == "/" ]]; then
    echo "Refusing to install: \$HOME is unset or '/'. Set HOME to your home directory and retry." >&2
    exit 1
fi

EXT_DST="$HOME/.copilot/extensions/session-pins"

if [[ ! -d "$EXT_SRC" ]]; then
    echo "Source folder not found: $EXT_SRC" >&2
    exit 1
fi

# Install the extension unless it already exists and --force was not supplied.
# The destination is cleared before copying so an upgrade can't leave stale files.
if [[ -d "$EXT_DST" && $FORCE -eq 0 ]]; then
    echo "session-pins extension already installed at $EXT_DST (re-run with --force to overwrite)."
else
    rm -rf "$EXT_DST"
    mkdir -p "$EXT_DST"
    cp -R "$EXT_SRC/." "$EXT_DST/"
    echo "[OK] session-pins extension installed to $EXT_DST"
fi

cat <<EOF

Next steps:
  1. Enable experimental mode so Copilot loads extensions:
       launch with  copilot --experimental   (or run  /experimental  inside Copilot),
       then restart your Copilot CLI session so the extension loads at startup.
  2. Try:   /pin add Remember to run tests before committing.
  3. Or ask Copilot:  Create a notes.md and pin it.

EOF
