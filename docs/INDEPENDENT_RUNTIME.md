# Independent DockView runtime

DockView and Vencord run and update from separate file trees. The stable release
remains unchanged while a newer development prerelease passes real-use testing.

## Runtime ownership

- `vencordFiles/` contains an unmodified build of the pinned official Vencord
  source: `vencordDesktopMain.js`, `vencordDesktopPreload.js`,
  `vencordDesktopRenderer.js`, and `vencordDesktopRenderer.css`.
- `dockviewFiles/` contains only DockView-owned output:
  `dockviewRenderer.js`, `dockviewMain.js`, `version.txt`, and the lazy viewer
  `chunk-*.js` files.
- Vesktop owns the narrow preload/main bridge that loads those files. Vencord
  keeps its normal updater UI and four-call native contract. Vesktop's
  `vencordUpdaterBridge` replaces only its update-check handler with a read-only
  check against the installed on-disk revision. The unmodified official Vencord
  handlers still download and apply the update; the bridge never reads or
  writes `dockviewFiles/`.
- The DockView updater may only replace files in `dockviewFiles/`.

DockView's renderer consumes the Vencord globals that Vesktop already exposes.
It is not copied into Vencord's plugin source tree and no Vencord source or
build script is patched.

## Start order

1. The official Vencord preload runs.
2. The official Vencord renderer registers its Discord patches.
3. Vesktop's renderer registers its own patches.
4. DockView registers its layout patch while Discord modules are still lazy,
   then starts its Flux, context-menu, CSS, and UI lifecycle when Vencord's
   webpack facade is ready.

## Migration and rollback

An install whose `vencordFiles/version.txt` starts with `dockview:` is the old
combined runtime. On first start of the separated shell, Vesktop replaces that
directory with the bundled, unmodified pinned Vencord build and installs the
bundled DockView runtime in `dockviewFiles/`. Later DockView updates never touch
`vencordFiles/`.

DockView 0.1.43 also left a valid-looking non-standalone Vencord build in the
default managed directory after removing the combined `version.txt`. That build
cannot use its Git updater because the installed directory has no `.git`
repository. The shell repairs this exact managed state to the bundled standalone
build once. A user-selected Vencord directory is preserved because it may be a
real Git checkout.

Rollback is a shell rollback: reinstalling the released `v0.1.42` package restores
the combined runtime. The old package and release assets remain available while
the separated runtime is tested as a development prerelease.

## Acceptance gates

- The official Vencord renderer contains no `DockView` code marker.
- The DockView renderer and main bundles contain no bundled copy of Vencord.
- Updating or replacing `vencordFiles/` leaves `dockviewFiles/` byte-for-byte
  unchanged and DockView starts after relaunch.
- Repeated Vencord checks do not duplicate downloads, and a successful update is
  reported as current immediately, before or after relaunch.
- A valid non-standalone runtime in the app-managed directory migrates to the
  bundled standalone build; a valid user-selected Git runtime does not.
- A DockView update manifest cannot name a Vencord core file or escape the
  DockView install directory.
- Existing DockView settings and `version.txt` comparison continue to work.
- Unit tests, typecheck, application build, and a real renderer smoke test pass
  before this branch is considered releasable.
