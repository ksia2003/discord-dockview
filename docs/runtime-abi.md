# DockView Runtime ABI

DockView is loaded by Vesktop but updated independently from both Vesktop and
Vencord. Runtime ABI v1 is the small contract that makes that separation stable.

## Shell-owned contract

The app shell:

- installs or repairs `dockviewFiles`;
- reads and injects `dockviewRenderer.js`;
- loads `dockviewMain.js`;
- exposes one validated `DV_INVOKE` IPC channel;
- calls the runtime before and after creating the main BrowserWindow;
- retains a legacy adapter for DockView runtimes through 0.1.47.

The preload bridge exposes `dockview.invoke(method, ...args)`. Its old named
methods delegate to the same channel only for transition compatibility.

## Runtime-owned contract

`dockviewMain.js` exports:

- `DOCKVIEW_RUNTIME_ABI_VERSION`;
- `invoke(event, method, args)`;
- `configureBrowserWindow(options)`;
- `attachBrowserWindow(window, hostCapabilities)`.

The method allowlist and web-tab security policy live in the runtime. Adding a
native viewer helper therefore changes DockView only, not `app.asar`.

`hostCapabilities` deliberately contains only partition lookup and external URL
opening. The runtime already executes in Electron's main process, but keeping
the lifecycle interface narrow makes ownership and tests explicit.

## Compatibility and failure rules

- ABI v1 accepts old release manifests that do not declare `runtimeAbi`.
- An update manifest declaring another ABI is rejected before files are staged.
- A newer incompatible installed runtime is replaced by the compatible bundled
  recovery copy on startup.
- A pre-ABI runtime uses the shell's legacy named-method and webview adapters.
- Changing the ABI requires an app-shell release and a migration path. Changing
  methods inside ABI v1 requires only a DockView runtime release.
