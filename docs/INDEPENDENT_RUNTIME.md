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
- Runtime ABI v1 reduces the Vesktop bridge to one generic native invocation and
  two BrowserWindow lifecycle hooks. Native method registration and the web-tab
  policy live in `dockviewMain.js`.

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

DockView 0.1.43 also left a valid-looking non-standalone Vencord build after
removing the combined `version.txt`. That build cannot use its Git updater when
the installed directory has no `.git` repository. The shell repairs any such
file-only install to the bundled standalone build once, including a stale custom
path. A user-selected non-standalone directory is preserved only when it belongs
to a real Git checkout.

Before a DockView update commits any live file, it copies the complete current
runtime to `dockviewBackup/`. The Updates page offers **Restore previous version**
when that snapshot exists. A commit error restores the snapshot immediately; a
process crash leaves an in-progress marker that makes the next startup recover to
the compatible runtime bundled with the app.

Vencord recovery remains independent: an invalid or non-standalone app-managed
runtime is replaced by the pinned official standalone fallback at startup. A full
app rollback is still available by reinstalling an earlier DockView package, but it
is no longer the only way to undo a DockView runtime update.

## Acceptance gates

- The official Vencord renderer contains no `DockView` code marker.
- The DockView renderer and main bundles contain no bundled copy of Vencord.
- Updating or replacing `vencordFiles/` leaves `dockviewFiles/` byte-for-byte
  unchanged and DockView starts after relaunch.
- Repeated Vencord checks do not duplicate downloads, and a successful update is
  reported as current immediately, before or after relaunch.
- A valid file-only non-standalone runtime migrates to the bundled standalone
  build; a valid user-selected Git runtime does not.
- A DockView update manifest cannot name a Vencord core file or escape the
  DockView install directory.
- Tampered, incomplete, wrong-ABI, interrupted, and explicit rollback paths restore
  a complete known-good runtime without changing `vencordFiles/`.
- Existing DockView settings and `version.txt` comparison continue to work.
- Unit tests, typecheck, application build, and a real renderer smoke test pass
  before this branch is considered releasable.
