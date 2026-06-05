# DockView

DockView is a Discord desktop app for Windows and Linux. It is a **fork of
[Vesktop](https://github.com/Vencord/Vesktop)** that ships with
[Vencord](https://github.com/Vendicated/Vencord) **and the DockView Vencord
plugin built in**, so non-technical users only have to download and install —
no plugin setup, no GitHub downloads at runtime.

**Main features**:
- Vencord + the [DockView plugin](https://github.com/ksia2003/vencord-dockview) preinstalled (bundled, loaded locally — no network fetch)
- Much more lightweight and faster than the official Discord app
- Linux Screenshare with sound & wayland
- Much better privacy, since Discord has no access to your system

## Credits & License

DockView is licensed under the **GPL-3.0-or-later**, the same license as its
upstream projects. All original Vesktop and Vencord copyright notices, SPDX
headers and `LICENSE` are preserved unchanged; DockView only adds its own
modifications on top.

- Upstream desktop app: **Vesktop** by Vendicated & Vesktop contributors — https://github.com/Vencord/Vesktop
- Discord client mod: **Vencord** by Vendicated & Vencord contributors — https://github.com/Vendicated/Vencord
- Bundled plugin: **DockView** — https://github.com/ksia2003/vencord-dockview

## Installing

Download the latest installer for your OS (Windows `.exe` or Linux
`AppImage`/`deb`/`rpm`/`tar.gz`) from the
[Releases page](https://github.com/ksia2003/DockView/releases).

## Building from Source

You need to have the following dependencies installed:
- [Git](https://git-scm.com/downloads)
- [Node.js](https://nodejs.org/en/download)
- pnpm: `npm install --global pnpm`

Packaging will create builds in the dist/ folder

```sh
git clone https://github.com/ksia2003/DockView
cd DockView

# Install Dependencies
pnpm i

# Build the bundled Vencord (+ DockView plugin) into static/vencordDist.
# This clones & builds Vencord with the DockView userplugin injected.
node scripts/prepare-vencord.mjs

# Either run it without packaging
pnpm start

# Or package (will build packages for your OS)
pnpm package

# Or package to a directory only
pnpm package:dir
```

The four bundled Vencord desktop files live in `static/vencordDist/` and are
copied into the app's data directory at first launch by
`src/main/utils/vencordLoader.ts` (no download from GitHub).

## Building LibVesktop from Source

This is a small C++ helper library Vesktop uses on Linux to emit D-Bus events. By default, prebuilt binaries for x64 and arm64 are used.

If you want to build it from source:
1. Install build dependencies:
    - Debian/Ubuntu: `apt install build-essential python3 curl pkg-config libglib2.0-dev`
    - Fedora: `dnf install @c-development @development-tools python3 curl pkgconf-pkg-config glib2-devel`
2. Run `pnpm buildLibVesktop`
3. From now on, building Vesktop will use your own build