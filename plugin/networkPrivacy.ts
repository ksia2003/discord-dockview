/*
 * DockView — renderer→main bridge for the Privacy page's network controls.
 * ---------------------------------------------------------------------------
 * The tracker firewall and proxy actually live in main (the default session's
 * webRequest + setProxy); the voice policy is also persisted in main's Vesktop
 * settings so it is active before Discord contents are created. This module pushes
 * the current settings.store values down to main over VesktopNative.networkPrivacy:
 * once on plugin start and by the Privacy/Performance panels on every flip.
 * The firewall defaults ON in main, while the voice policy defaults ON in both
 * stores, so startup remains safe even before the first renderer push.
 */

import { settings } from "./settings";

function native() {
    return (window as any).VesktopNative?.networkPrivacy;
}

export function pushFirewall(): void {
    native()?.setFirewallEnabled?.(settings.store.firewallEnabled !== false);
}

export function pushProxy(): void {
    Promise.resolve(
        native()?.setProxy?.({
            enabled: settings.store.proxyEnabled === true,
            rules: settings.store.proxyRules ?? "",
            bypass: settings.store.proxyBypass ?? ""
        })
    ).catch(() => {});
}

export function pushVoiceFix(): void {
    native()?.setVoiceFixEnabled?.(settings.store.voiceFixEnabled === true);
}

export function pushNetworkPrivacy(): void {
    pushFirewall();
    pushProxy();
    pushVoiceFix();
}
