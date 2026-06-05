# DockView

Open PDFs, images, code, and interactive files in a side panel — right inside Discord.

## What is this

DockView is a Discord desktop app for Windows and Linux. Click any attachment in
chat and it opens in a panel docked to the side of the window, so you can read a
PDF or look at a screenshot without leaving the conversation. It looks and feels
like Discord because it's built on the same foundation — it just adds the side
panel on top.

Download it, install it, sign in. That's the whole setup.

## Features

- **PDFs** — read inline with page navigation, zoom, selectable text, and find-in-document.
- **Images** — open in the panel with zoom and pan; double-click to fit or go 1:1.
- **Code & text** — syntax highlighting, line numbers, word-wrap toggle, one-click copy.
- **Markdown** — rendered properly, with highlighted code blocks.
- **Interactive HTML** — sandboxed `.artifact` files run right in the panel.
- **The panel itself** — sits where the thread/member sidebar goes, resizes by dragging its edge, and each channel remembers the file you had open.

Nothing loads until you click an attachment, and the normal download button still works exactly as before.

## Why

If you spend time in Discord sharing lecture notes, documents, screenshots, or
code snippets, you know the routine: download the file, alt-tab to another app,
read it, come back. DockView keeps all of that in one window. Keep chatting on
the left, read the file on the right.

## Install

**[Download the latest release](https://github.com/ksia2003/discord-dockview/releases/latest)** and run the installer for your system:

- **Windows** — `DockView-Setup-*.exe`
- **Linux** — `.AppImage`, `.deb`, `.rpm`, or `.tar.gz`

Install, launch, log in to Discord. There's nothing else to set up — the side panel is built in.

<sub>Already using **Vencord**? You can run just the side-panel piece as a userplugin. The source lives in [`plugin/`](plugin/) — drop it into Vencord's `src/userplugins/`, add `pdfjs-dist marked highlight.js`, then build and enable "DockView" in Settings ▸ Plugins.</sub>

## Notes

- Desktop only. There's no mobile or web version.
- macOS isn't supported right now.

## Built on / License

DockView is a fork of [Vesktop](https://github.com/Vencord/Vesktop) and bundles
[Vencord](https://github.com/Vendicated/Vencord). All credit for the underlying
Discord desktop app and client mod goes to Vendicated and the Vesktop / Vencord
contributors.

Licensed under **GPL-3.0-or-later**, the same as its upstream projects. All
original copyright notices and license headers are kept intact.
