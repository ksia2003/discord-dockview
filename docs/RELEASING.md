# Releasing DockView

Every release follows the same short checklist, so nothing gets forgotten between
versions. A release ships two things from one GitHub release: the app installers
(for a fresh install) and the DockView plugin bundle (which the in-app updater
fetches to update the panel without reinstalling the app).

The app is Vesktop, so `package.json.version` stays pinned to the Vesktop base
version — **never** bump it for a DockView change. Releases are versioned by the
DockView plugin version instead.

## Checklist

1. **Bump the plugin version.** Edit `plugin/version.ts` and raise
   `DOCKVIEW_PLUGIN_VERSION` (e.g. `0.1.25` → `0.1.26`).

2. **Commit it** on its own:

   ```bash
   git -c user.name=ksia2003 -c user.email=ksia2003@gmail.com \
       commit -am "Bump DockView to 0.1.26"
   ```

3. **Tag and push.** The tag drives the whole release:

   ```bash
   git tag v0.1.26
   git push origin master
   git push origin v0.1.26
   ```

4. **Let CI run.** The `Release` workflow (`.github/workflows/release.yml`) builds
   on Linux and Windows, then:
   - creates the `v0.1.26` release (titled `dockview 0.1.26`),
   - uploads the installers + `latest*.yml` (Windows `.exe`, Linux
     `.AppImage`/`.deb`/`.rpm`/`.tar.gz`, x64 and arm64),
   - regenerates `manifest.json` and uploads the plugin bundle (the four
     `vencordDesktop*` files, `version.txt`, the `chunk-*.js` files, and
     `manifest.json`) as extra assets on the same release.

5. **Write the release notes.** CI seeds a one-line placeholder; replace it with
   real notes (template below):

   ```bash
   gh release edit v0.1.26 --notes-file notes.md
   ```

6. **Verify the update assets.** Confirm the plugin bundle landed, or the in-app
   updater has nothing to fetch:

   ```bash
   gh release view v0.1.26 --json assets -q '.assets[].name' | grep manifest.json
   ```

   You should also see `vencordDesktopRenderer.js` and the `chunk-*.js` files.

7. **Mark it latest** (CI usually does, but confirm):

   ```bash
   gh release edit v0.1.26 --latest
   ```

## Release-notes template

Keep it plain and user-facing. 2–6 "What's new" bullets in everyday language
(what changed for the person using it, not the implementation), then one
"Updating" line.

```markdown
## What's new

- <a change, in plain words — what it does for you>
- <another>
- <another>

## Updating

Already running DockView? Open **DockView settings → Updates → Check for
updates**, then Apply — the panel updates in place, no reinstall.

<Only if this release changed the app shell (main/preload — e.g. profiles,
tray, window behaviour):>
This release includes app-level changes, which need the installer: download it
below and reinstall over your current install (your login and settings are kept).
```

**How to tell whether a release needs the installer:** if the change is only in
the panel/viewers (renderer), the in-app updater delivers it. If it touches the
Electron shell — anything under `src/main/` or `src/preload/`, or a new native
IPC (profiles, tray menus, window handling) — users need the installer to get it.
The updater's `manifest.json` records this automatically (`needsRelaunch`), but
say it in the notes too.

## One-time bridge (historical)

The `plugin-v0.1.25` release is a one-off legacy manifest that lets pre-0.1.22
clients (which looked for the retired `plugin-v*` release stream) discover the
current `v*` channel and update onto it. It is **not** part of the normal release
flow — it exists once, to rescue old installs, and new clients ignore it.
