# DockView Vesktop fork

## Purpose

This repository is the DockView distribution of Vesktop. The product change is a
right-side dock for Discord content: channel context tabs, attachment viewers,
explicit embedded web tabs, and DockView-owned settings/update plumbing. Ordinary
Discord and Vesktop behavior should stay upstream unless a product decision says
otherwise.

The Vesktop base is pinned in `src/shared/dockviewRelease.ts`. Vencord is pinned in
`scripts/lib/vencordRef.mjs`; `scripts/prepare-vencord.mjs` builds the official
Vencord source unchanged, then builds DockView as a separate runtime.

## Important boundaries

- Ordinary HTTP(S) left-clicks use Vesktop's upstream OS-browser behavior.
- A message link's `message` menu (and linked-image `image-context` menu) gets the
  explicit **Open in DockView** action without replacing Discord's existing items.
- Discord's untrusted-domain confirmation is not patched.
- Embedded sites use only `persist:dockview-web`. The main process denies guest
  permissions, Node/preload injection, non-HTTP(S) navigation, and guest popups.
- Voice/WebRTC, screen sharing, global media capture, proxy/firewall, message
  encryption, Discord parser changes, DOM optimization, and account profiles are
  outside DockView. Keep their upstream behavior.
- Viewer-specific conversion and email remote-image policy are DockView scope.
- The temporary shell updater exists for installed-client migration. It may fetch
  and execute installers only from the configured DockView GitHub release path.
- Never publish, tag, deploy, or replace a user's installed app during ordinary
  development or verification.

`tests/minimal-fork.test.mjs` is the executable boundary check. If a new `src/`
file must differ from the pinned Vesktop commit, add it to that allowlist only with
an explicit reason.

## Layout

- `plugin/` — DockView renderer, viewers, host, settings, and native
  conversion/update helpers. It consumes Vencord's exported globals but is not
  copied into Vencord's plugin tree.
- `src/main/dockviewWebview.ts` — the isolated Electron webview boundary.
- `src/main/utils/vencordLoader.ts` — installs/repairs only official Vencord files.
- `src/main/vencordUpdaterBridge.ts` and
  `src/main/utils/vencordUpdateCheck.ts` — keep Vencord's update check read-only
  while its unmodified standalone runtime owns download and apply.
- `src/main/utils/dockviewLoader.ts` — installs/updates only DockView-owned files.
- `src/main/shellUpdate.ts` — narrow app-installer migration path.
- `scripts/` — independent Vencord/DockView builds, chunk builds, provenance, release
  metadata, and upstream monitoring.
- `static/vencordDist/` — generated official Vencord core files.
- `static/dockviewDist/` — generated DockView renderer/main. Heavy `chunk-*.js`
  files are ignored and regenerated for tests/packages/releases.
- `docs/` — release and upstream-maintenance procedures.

## Common commands

```bash
pnpm install --frozen-lockfile
pnpm prepareVencord
node scripts/verify-runtime-bundles.mjs
pnpm test
pnpm build
pnpm package:dir
```

`pnpm prepareVencord` clones the exact Vencord tag, verifies its full commit,
builds it without modification, then builds DockView and all heavy chunks into a
different output tree.
Run it after any `plugin/`, Vencord dependency, or build-script change. The build
contains a Vencord timestamp, so the renderer bundle may differ byte-for-byte across
runs while its source identity and functional inputs remain the same.

`pnpm package:dir` is a local packaging check only. Release publishing is handled
by `.github/workflows/release.yml` after an explicit matching version tag.

## Release/version rules

- `package.json.version` follows upstream Vesktop.
- `plugin/version.ts` is the DockView/plugin release version and `v*` tag.
- `src/shared/dockviewVersion.ts` is the app-shell migration version.
- Shell changes require installers and a shell-version bump; plugin-only changes
  require only a plugin-version bump.
- Keep Linux, Windows, and upstream macOS release legs. DockView runtime assets and
  the verified manifest extend that workflow; they do not replace platform builds.
