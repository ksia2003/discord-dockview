# Releasing DockView

Upstream detection and candidate PRs are documented in
[`UPSTREAM_MAINTENANCE.md`](UPSTREAM_MAINTENANCE.md). Those candidates remain
drafts until the real-use gate passes; this document covers the release that
follows.

Every release follows the same short checklist, so nothing gets forgotten between
versions. A release ships two things from one GitHub release: the app installers
(for a fresh install) and the DockView plugin bundle (which the in-app updater
fetches to update the panel without reinstalling the app).

## Version domains and metadata

DockView deliberately has three independent versions:

- `package.json.version` is the authoritative Vesktop/Electron app version. It
  follows upstream Vesktop and is **never** bumped just for a DockView change.
- `src/shared/dockviewVersion.ts` owns the DockView shell version. It represents
  code in the installer/app.asar domain.
- `plugin/version.ts` owns the DockView plugin/release version and therefore the
  `v*` release tag used by plugin OTA.

`src/shared/dockviewRelease.ts` pins the DockView repository and Vesktop upstream
commit. The plugin deliberately mirrors the repository literal because it is
compiled inside Vencord's separate source domain. Build tooling composes and checks
these values without collapsing them:

```bash
node scripts/print-dockview-release-metadata.mjs
node scripts/print-dockview-release-metadata.mjs --field tag
node scripts/verify-dockview-release-metadata.mjs
```

On a tag-triggered workflow run, CI rejects a pushed tag that does not equal
the validated metadata tag. Manual dispatch continues to use the metadata tag.

The schema-2 OTA `manifest.json` remains backwards compatible and now additively
includes `vesktop: { version, commit }`. Existing 0.1.35 clients ignore that
unknown field; all existing plugin, shell, and files fields keep their shape.

## Checklist

1. **Choose the version domain, then bump it if needed.** For a plugin-only
   release, edit `plugin/version.ts` and raise
   `DOCKVIEW_PLUGIN_VERSION` (e.g. `0.1.25` → `0.1.26`).
   Shell/native changes also require a `DOCKVIEW_SHELL_VERSION` bump and new
   installers; they cannot be delivered by plugin OTA alone. Keep
   `package.json.version` aligned with upstream Vesktop rather than DockView.

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

4. **Let CI run.** The `Release` workflow (`.github/workflows/release.yml`) keeps
   the upstream Linux, Windows, and macOS build legs, then:
    - creates the `v0.1.26` release (titled `dockview 0.1.26`),
    - uploads the platform installers + `latest*.yml`,
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

<Only if this release changed the app shell (main/preload):>
This release includes app-level changes. DockView will run the matching verified
installer when the install method supports it; otherwise download it below and
reinstall over the current app (your login and settings are kept).
```

**How to tell whether a release needs the installer:** if the change is only in
the panel/viewers (renderer), the in-app updater delivers it. If it touches the
Electron shell — anything under `src/main/` or `src/preload/`, or a new native
IPC or window handling — users need the installer to get it.
For those shell/native changes, bump the shell version and ship new installers.
The updater's `manifest.json` records relaunch information automatically
(`needsRelaunch`), but say it in the notes too.

## One-time bridge (historical)

The `plugin-v0.1.25` release is a one-off legacy manifest that lets pre-0.1.22
clients (which looked for the retired `plugin-v*` release stream) discover the
current `v*` channel and update onto it. It is **not** part of the normal release
flow — it exists once, to rescue old installs, and new clients ignore it.
