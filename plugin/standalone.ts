/*
 * DockView independent renderer entry.
 *
 * This is loaded by Vesktop after the official Vencord renderer. It uses the
 * public globals Vencord exposes but is not compiled into Vencord's plugin map.
 */

import dockViewPlugin from "./index";
import { settings } from "./settings";
import { DOCKVIEW_PLUGIN_VERSION } from "./version";

const PLUGIN_NAME = "DockView";
const STYLE_ID = "dockview-independent-style";

const VencordRuntime = (globalThis as any).Vencord;
if (!VencordRuntime?.Plugins?.addPatch || !VencordRuntime?.Api?.PluginManager) {
    throw new Error("DockView requires the official Vencord desktop runtime");
}

const plugin = dockViewPlugin as any;
const cssText = typeof plugin.managedStyle === "string" ? plugin.managedStyle : "";
plugin.managedStyle = undefined;

function initialiseSettings(): void {
    (settings as any).pluginName = PLUGIN_NAME;

    const plugins = VencordRuntime.Settings.plugins as Record<string, Record<string, unknown>>;
    const current = plugins[PLUGIN_NAME] ?? (plugins[PLUGIN_NAME] = { enabled: true });
    for (const [key, definition] of Object.entries((settings as any).def as Record<string, any>)) {
        if (!(key in current) && definition && Object.hasOwn(definition, "default")) {
            current[key] = definition.default;
        }
    }
}

function installStyle(): void {
    if (!cssText || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = cssText;
    document.head.append(style);
}

function uninstallStyle(): void {
    document.getElementById(STYLE_ID)?.remove();
}

let started = false;

export function renderDockRail(): unknown {
    return plugin.renderDockRail();
}

export function start(): boolean {
    if (started) return true;
    initialiseSettings();
    installStyle();
    if (!VencordRuntime.Api.PluginManager.startPlugin(plugin)) {
        uninstallStyle();
        return false;
    }
    started = true;
    return true;
}

export function stop(): boolean {
    if (!started) return true;
    const stopped = VencordRuntime.Api.PluginManager.stopPlugin(plugin);
    uninstallStyle();
    started = false;
    return stopped !== false;
}

export function status(): { started: boolean; version: string; } {
    return { started, version: DOCKVIEW_PLUGIN_VERSION };
}

initialiseSettings();
for (const patch of plugin.patches ?? []) {
    VencordRuntime.Plugins.addPatch(patch, PLUGIN_NAME, PLUGIN_NAME);
}

void VencordRuntime.Webpack.onceReady.then(() => start());
window.addEventListener("beforeunload", () => stop(), { once: true });
