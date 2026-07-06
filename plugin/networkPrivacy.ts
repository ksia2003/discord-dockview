/*
 * DockView — renderer→main bridge for the Privacy page's network controls.
 * ---------------------------------------------------------------------------
 * The tracker firewall and proxy actually live in main (the default session's
 * webRequest + setProxy); this module holds no state, it just pushes the current
 * settings.store values down to main over VesktopNative.networkPrivacy. Called once
 * on plugin start (so main matches the saved UI state) and by the Privacy panel on
 * every flip. The firewall defaults ON in main too, so blocking is already live
 * before the first push — this only keeps main in sync when the user changes it.
 */

import { settings } from "./settings";

function native() {
    return (window as any).VesktopNative?.networkPrivacy;
}

export function pushFirewall(): void {
    native()?.setFirewallEnabled?.(settings.store.firewallEnabled !== false);
}

export function pushProxy(): void {
    native()?.setProxy?.({
        enabled: settings.store.proxyEnabled === true,
        rules: settings.store.proxyRules ?? "",
        bypass: settings.store.proxyBypass ?? ""
    });
}

export function pushVoiceFix(): void {
    native()?.setVoiceFixEnabled?.(settings.store.voiceFixEnabled === true);
}

export function pushNetworkPrivacy(): void {
    pushFirewall();
    pushProxy();
    pushVoiceFix();
}
