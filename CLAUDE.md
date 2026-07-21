# DockView Vesktop fork

## Purpose

This repository is the DockView distribution of Vesktop. The product change is a
right-side dock for Discord content: channel context tabs, attachment viewers,
explicit embedded web tabs, and DockView-owned settings/update plumbing. Ordinary
Discord and Vesktop behavior should stay upstream unless a product decision says
otherwise.

The Vesktop base is pinned in `src/shared/dockviewRelease.ts`. Vencord is pinned in
`scripts/lib/vencordRef.mjs`; DockView is compiled into that pinned Vencord build by
`scripts/prepare-vencord.mjs`.

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

- `plugin/` — DockView Vencord user plugin, viewers, host, settings, and native
  conversion/update helpers.
- `src/main/dockviewWebview.ts` — the isolated Electron webview boundary.
- `src/main/utils/vencordLoader.ts` — installs/repairs the bundled DockView Vencord
  distribution.
- `src/main/shellUpdate.ts` — narrow app-installer migration path.
- `scripts/` — pinned Vencord composition, chunk builds, provenance, release
  metadata, and upstream monitoring.
- `static/vencordDist/` — generated Vencord core files. Heavy `chunk-*.js` files
  are ignored and must be regenerated for tests/packages/releases.
- `docs/` — release and upstream-maintenance procedures.

## Common commands

```bash
pnpm install --frozen-lockfile
pnpm prepareVencord
node scripts/vencord-candidate.mjs verify-generated static/vencordDist
pnpm test
pnpm build
pnpm package:dir
```

`pnpm prepareVencord` clones the exact Vencord tag, verifies its full commit,
injects DockView, builds all heavy chunks, and writes the generated distribution.
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
