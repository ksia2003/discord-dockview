# DockView for Vesktop (drop-in bundle)

This bundle is the **DockView Vencord build** packaged for people who already
use [Vesktop](https://github.com/Vencord/Vesktop) and just want the DockView
panel, without installing the full DockView fork.

DockView adds a right-side dock that previews chat attachments inline — PDF,
images, code/text, Markdown, CSV/TSV, HTML artifacts, docx, xlsx, mermaid,
Graphviz/.dot, Jupyter notebooks, and JSON/XML trees.

## What's in here

- `vencordDesktopMain.js`
- `vencordDesktopPreload.js`
- `vencordDesktopRenderer.js`
- `vencordDesktopRenderer.css`
- `version.txt` — which Vencord + DockView build this is
- `install-dockview.sh` (Linux) / `install-dockview.ps1` (Windows) — the installer
- `README.md` — this file

The four `vencordDesktop*` files are a complete Vencord build with DockView
compiled in. They are the **exact same files** the DockView fork installer ships.

## Important: this REPLACES your Vencord

Vencord only supports plugins compiled in at build time, so there is no way to
"keep your current Vencord and just add DockView." Installing this bundle
**replaces** the Vencord that Vesktop loads with **ours** — which is

> **stock Vencord + the DockView plugin.**

That means:

- All the **official Vencord plugins are still there** (this is stock Vencord,
  not a stripped-down build) — DockView is added on top.
- Your Vencord/plugin **settings are preserved** (they live separately from these
  files).
- You are **pinned to our Vencord version** (see `version.txt`). When we ship a
  newer DockView build, grab the new bundle and re-run the installer.

## How to install

### Easy way — run the installer

**Linux**

```bash
chmod +x install-dockview.sh
./install-dockview.sh
```

**Windows** (PowerShell, in the unzipped folder)

```powershell
.\install-dockview.ps1
```

If Windows blocks it:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-dockview.ps1
```

The installer copies the four files into your Vesktop custom-Vencord folder and
creates it if needed.

### Manual way — copy the four files yourself

Copy the four `vencordDesktop*` files into your Vesktop custom-Vencord directory:

- **Windows:** `%APPDATA%\vesktop\sessionData\vencordFilesCustom\`
- **Linux:** `~/.config/vesktop/sessionData/vencordFilesCustom/`
- **Linux (Flatpak):** `~/.var/app/dev.vencord.Vesktop/config/vesktop/sessionData/vencordFilesCustom/`

Create the `vencordFilesCustom` folder if it doesn't exist.

## After installing: FULLY restart Vesktop

Quit Vesktop completely (from the **tray icon → Quit**, not just closing the
window) and start it again. DockView should appear once Discord finishes loading.

## If DockView doesn't show up — enable the custom Vencord build

> **⚠️ Verify this step.** Vesktop may need to be told to load the custom Vencord
> files from `vencordFilesCustom/` rather than its own bundled Vencord. Depending
> on your Vesktop version this can be **automatic**, or it may require a setting.

If DockView isn't there after a full restart, open **Vesktop Settings → Vencord**
(the Vesktop settings, not Discord's) and look for an option to **use a custom /
local Vencord build** (sometimes labelled around `vencordDir` / "Custom Vencord
Location"). Enable it, then fully restart Vesktop again.

Do **not** hand-edit Vesktop's settings file to force this — use the in-app
toggle.
