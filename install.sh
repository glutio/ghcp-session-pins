#!/usr/bin/env bash
# install.sh - copy the session-pins extension into the Copilot CLI extensions
# directory so the CLI loads it on next startup.
#
# Usage (from the plugin directory):
#   ./install.sh
#
# Or from wherever a Copilot plugin marketplace installed the plugin, e.g.:
#   "<copilot-home>/installed-plugins/<marketplace>/session-pins/install.sh"
#
# Honors COPILOT_HOME: installs under "$COPILOT_HOME/extensions" when set,
# otherwise "$HOME/.copilot/extensions".

set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" || "${1:-}" == "-f" ]]; then
    FORCE=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$SCRIPT_DIR/extension"

# Resolve the Copilot home: prefer COPILOT_HOME (the CLI's configurable home),
# otherwise ~/.copilot. Refuse if the result is empty or a filesystem root, so the
# recursive delete below can never target an unintended location.
COPILOT_ROOT="${COPILOT_HOME:-}"
# Trim leading/trailing whitespace (the PowerShell installer trims too) so a value
# like " ~/.copilot " can't resolve to an unintended path before the ~ expansion
# and root-safety checks below.
COPILOT_ROOT="${COPILOT_ROOT#"${COPILOT_ROOT%%[![:space:]]*}"}"
COPILOT_ROOT="${COPILOT_ROOT%"${COPILOT_ROOT##*[![:space:]]}"}"
if [[ -z "$COPILOT_ROOT" ]]; then
    if [[ -z "${HOME:-}" ]]; then
        echo "Refusing to install: neither COPILOT_HOME nor HOME is set." >&2
        exit 1
    fi
    COPILOT_ROOT="$HOME/.copilot"
else
    # Expand a leading ~ (e.g. COPILOT_HOME=~/.copilot). Bash does not expand ~ that
    # comes from a variable, so without this the script would install under a literal
    # "./~/.copilot/..." relative to the current directory (and the recursive delete
    # would run there). Refuse if ~ is used but HOME is unset — otherwise "~/x" would
    # collapse to "/x" and operate under an unexpected location.
    case "$COPILOT_ROOT" in
        "~"|"~/"*)
            if [[ -z "${HOME:-}" ]]; then
                echo "Refusing to install: COPILOT_HOME uses '~' but HOME is not set." >&2
                exit 1
            fi
            if [[ "$COPILOT_ROOT" == "~" ]]; then
                COPILOT_ROOT="$HOME"
            else
                COPILOT_ROOT="$HOME/${COPILOT_ROOT#\~/}"
            fi
            ;;
    esac
fi
COPILOT_ROOT="${COPILOT_ROOT%/}"
if [[ -z "$COPILOT_ROOT" || "$COPILOT_ROOT" == "/" || "$COPILOT_ROOT" =~ ^[A-Za-z]:[\\/]?$ ]]; then
    echo "Refusing to install: resolved Copilot home '$COPILOT_ROOT' is a filesystem root." >&2
    exit 1
fi
# Refuse a Copilot home containing a ".." segment. A value like "/a/../.." or
# "C:\.." can normalize to a filesystem root (or an unexpected location), and the
# rm -rf below must never target such a path.
case "/${COPILOT_ROOT//\\//}/" in
    */../*)
        echo "Refusing to install: Copilot home '$COPILOT_ROOT' contains a '..' path segment. Set COPILOT_HOME to a normalized absolute path." >&2
        exit 1
        ;;
esac
# Refuse a non-absolute Copilot home. Otherwise EXT_DST would be relative and the
# rm -rf below could delete a directory under the current working directory. Accept
# POSIX absolute paths (/...) and Windows-style absolute paths (C:\... or C:/...).
if [[ "$COPILOT_ROOT" != /* && ! "$COPILOT_ROOT" =~ ^[A-Za-z]:[\\/] ]]; then
    echo "Refusing to install: Copilot home '$COPILOT_ROOT' is not an absolute path. Set COPILOT_HOME to a full path." >&2
    exit 1
fi

EXT_DST="$COPILOT_ROOT/extensions/session-pins"

if [[ ! -d "$EXT_SRC" ]]; then
    echo "Source folder not found: $EXT_SRC" >&2
    exit 1
fi

# Decide what to do by comparing the plugin's extension against the installed copy:
#   - not present         -> fresh install
#   - identical contents  -> up to date, nothing to copy (unless --force)
#   - contents differ      -> update in place, no --force needed
# This makes plugin updates apply automatically: the marketplace refreshes the plugin
# folder, and the next run of this script syncs the changed files into the extensions
# folder. --force is only an explicit override to recopy identical content.
STATE="installed"
if [[ -d "$EXT_DST" ]]; then
    if [[ $FORCE -eq 0 ]] && diff -r "$EXT_SRC" "$EXT_DST" >/dev/null 2>&1; then
        STATE="uptodate"
    else
        STATE="updated"
    fi
fi

if [[ "$STATE" == "uptodate" ]]; then
    echo "session-pins is already installed and up to date at $EXT_DST."
else
    rm -rf "$EXT_DST"
    mkdir -p "$EXT_DST"
    cp -R "$EXT_SRC/." "$EXT_DST/"
    if [[ "$STATE" == "updated" ]]; then
        echo "[OK] session-pins extension updated to the current version at $EXT_DST"
    else
        echo "[OK] session-pins extension installed to $EXT_DST"
    fi
fi

echo ""
if [[ "$STATE" == "uptodate" ]]; then
    cat <<'EOF'
Nothing to do — the installed extension already matches this plugin.
If /pin isn't available, relaunch with  copilot --experimental  (extensions only load in experimental mode).
EOF
elif [[ "$STATE" == "updated" ]]; then
    cat <<'EOF'
Next step: restart Copilot (relaunch with  copilot --experimental ) so the updated extension loads.
EOF
else
    cat <<'EOF'
Next step: relaunch with  copilot --experimental  (or run  /experimental  and restart)
so Copilot loads the extension at startup.
EOF
fi
cat <<'EOF'

Usage once active:
  /pin                       open the pinboard (browse / add / edit / enable / delete)
  /pin add <text>            pin an instruction
  /pin add @<path>           pin a live file
  Or just ask Copilot:  "Pin the rule that ... "  /  "Pin @notes.md"  /  "What's pinned?"

EOF