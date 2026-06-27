#!/usr/bin/env bash
#
# DockView drop-in installer for existing Vesktop users (Linux).
#
# Copies the four DockView Vencord files sitting next to this script into your
# Vesktop custom-Vencord directory, replacing whatever Vencord build was there.
# See README.md in this bundle for what this is and the settings caveat.
#
# Usage:  ./install-dockview.sh
#
set -euo pipefail

# Where this script (and the four files) live.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FILES=(
    vencordDesktopMain.js
    vencordDesktopPreload.js
    vencordDesktopRenderer.js
    vencordDesktopRenderer.css
)

# Make sure all four files are present before we touch anything.
for f in "${FILES[@]}"; do
    if [[ ! -f "$SCRIPT_DIR/$f" ]]; then
        echo "ERROR: missing $f next to this script. Unzip the whole bundle and run again." >&2
        exit 1
    fi
done

# Candidate Vesktop config roots. Normal install first, then Flatpak.
CANDIDATES=(
    "${XDG_CONFIG_HOME:-$HOME/.config}/vesktop"
    "$HOME/.var/app/dev.vencord.Vesktop/config/vesktop"
)

TARGET=""
for base in "${CANDIDATES[@]}"; do
    if [[ -d "$base" ]]; then
        TARGET="$base/sessionData/vencordFilesCustom"
        echo "Found Vesktop config at: $base"
        break
    fi
done

# If neither exists yet, default to the standard (non-Flatpak) path and create it.
if [[ -z "$TARGET" ]]; then
    echo "No existing Vesktop config found; using the default location."
    TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/vesktop/sessionData/vencordFilesCustom"
fi

mkdir -p "$TARGET"

for f in "${FILES[@]}"; do
    cp -f "$SCRIPT_DIR/$f" "$TARGET/$f"
    echo "  copied $f"
done

echo
echo "✔ DockView Vencord files installed to:"
echo "    $TARGET"
echo
echo "Now FULLY restart Vesktop (quit from the tray, not just close the window)."
echo "If DockView doesn't show up, open Vesktop Settings -> Vencord and make sure"
echo "the custom Vencord build is enabled (see README.md)."
