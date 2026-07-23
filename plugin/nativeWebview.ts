/*
 * DockView web-tab boundary.
 *
 * This policy ships in dockviewMain.js, so it can evolve with DockView without
 * changing Vesktop's app.asar. The shell passes only the two Electron capabilities
 * needed here: resolving the isolated partition and opening an external URL.
 */

export const DOCKVIEW_WEB_PARTITION = "persist:dockview-web";

interface BrowserWindowOptions {
    webPreferences?: Record<string, unknown>;
}

interface DownloadItem {
    cancel(): void;
    getURL(): string;
}

interface DockViewSession {
    setPermissionCheckHandler(handler: () => boolean): void;
    setPermissionRequestHandler(handler: (contents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void): void;
    on(event: "will-download", listener: (event: { preventDefault(): void }, item: DownloadItem) => void): void;
}

interface DockViewGuest {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
    on(event: "will-navigate" | "will-redirect", listener: (event: { preventDefault(): void; url: string }) => void): void;
}

interface DockViewWindow {
    webContents: {
        on(
            event: "will-attach-webview",
            listener: (
                event: { preventDefault(): void },
                webPreferences: Record<string, any>,
                params: Record<string, any> & { partition?: string; src?: string }
            ) => void
        ): void;
        on(event: "did-attach-webview", listener: (event: unknown, guest: DockViewGuest) => void): void;
    };
}

export interface DockViewWebviewHost {
    fromPartition(partition: string): DockViewSession;
    openExternal(url: string): void | Promise<void>;
}

export function configureBrowserWindow(options: BrowserWindowOptions): void {
    if (!options.webPreferences) options.webPreferences = {};
    options.webPreferences.webviewTag = true;
}

function isWebUrl(raw: string): boolean {
    try {
        const { protocol } = new URL(raw);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

function secureGuest(guest: DockViewGuest, host: DockViewWebviewHost): void {
    guest.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url)) void host.openExternal(url);
        return { action: "deny" };
    });

    guest.on("will-navigate", event => {
        if (!isWebUrl(event.url)) event.preventDefault();
    });

    guest.on("will-redirect", event => {
        if (!isWebUrl(event.url)) event.preventDefault();
    });
}

let partitionSecurityInstalled = false;

function installPartitionSecurity(host: DockViewWebviewHost): void {
    if (partitionSecurityInstalled) return;
    partitionSecurityInstalled = true;

    const isolatedSession = host.fromPartition(DOCKVIEW_WEB_PARTITION);
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolatedSession.on("will-download", (event, item) => {
        const url = item.getURL();
        try {
            item.cancel();
        } catch {
            /* already gone */
        }
        event.preventDefault();
        if (isWebUrl(url)) void host.openExternal(url);
    });
}

export function attachBrowserWindow(win: DockViewWindow, host: DockViewWebviewHost): void {
    installPartitionSecurity(host);

    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
        if (params.partition !== DOCKVIEW_WEB_PARTITION || !isWebUrl(params.src ?? "")) {
            event.preventDefault();
            return;
        }

        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.allowRunningInsecureContent = false;

        delete params.preload;
        delete params.nodeintegration;
        delete params.nodeintegrationinsubframes;
        delete params.disablewebsecurity;
        delete params.allowrunninginsecurecontent;
    });

    win.webContents.on("did-attach-webview", (_event, guest) => secureGuest(guest, host));
}
