/*
 * DockView — the "Privacy" settings page (renderer).
 * ---------------------------------------------------------------------------
 * Two groups:
 *   - Email: whether an email preview (.eml / .msg) may load its REMOTE images (a
 *     classic tracking pixel), OFF by default. Backs settings.store.emailRemoteImages,
 *     read live by the .eml viewer (email.ts) and forwarded through the convertAttachment
 *     IPC by the .msg viewer, so a flip applies to the next email opened, both formats.
 *   - Network: the tracker firewall + proxy. These actually live in MAIN (the default
 *     session's webRequest + setProxy); the switches here persist to settings.store and
 *     push the current value to main over VesktopNative.networkPrivacy on every change.
 *     The firewall defaults ON in main too, so blocking is live from startup — a flip
 *     here just keeps main in sync.
 *
 * GRAMMAR — mirrors GeneralPanel/ViewersPanel: deferred `h` (no module-top webpack),
 * @webpack/common primitives, FormTitle h3 sub-groups, semantic CSS variables only. The
 * page header ("Privacy") comes from the sidebar row's panel title, so it isn't repeated.
 * Binds the reactive settings store (settings.use) so a flip persists + re-renders.
 */

import { Forms, React, Switch, TextInput } from "@webpack/common";

import { pushFirewall, pushProxy } from "../networkPrivacy";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const PR = STRINGS.privacy;

export function PrivacyPanel() {
    const store = settings.use(["emailRemoteImages", "firewallEnabled", "proxyEnabled", "proxyRules", "proxyBypass"]);

    return h(
        "div",
        null,

        // --- Email ---------------------------------------------------------
        h(Forms.FormTitle, { tag: "h3" }, PR.emailGroup),
        h(
            Switch,
            {
                value: store.emailRemoteImages === true,
                note: PR.remoteImagesNote,
                hideBorder: true,
                onChange: (v: boolean) => { store.emailRemoteImages = v; }
            },
            PR.remoteImagesTitle
        ),

        // --- Network -------------------------------------------------------
        h(Forms.FormTitle, { tag: "h3", style: { marginTop: "20px" } }, PR.networkGroup),
        h(
            Switch,
            {
                value: store.firewallEnabled !== false,
                note: PR.firewallNote,
                onChange: (v: boolean) => {
                    store.firewallEnabled = v;
                    pushFirewall();
                }
            },
            PR.firewallTitle
        ),
        h(
            Switch,
            {
                value: store.proxyEnabled === true,
                note: PR.proxyNote,
                hideBorder: true,
                onChange: (v: boolean) => {
                    store.proxyEnabled = v;
                    pushProxy();
                }
            },
            PR.proxyTitle
        ),

        store.proxyEnabled === true &&
            h(
                "div",
                { style: { marginTop: "8px" } },
                h(Forms.FormTitle, { tag: "h5" }, PR.proxyRulesLabel),
                h(TextInput, {
                    value: store.proxyRules ?? "",
                    placeholder: PR.proxyRulesPlaceholder,
                    onChange: (v: string) => {
                        store.proxyRules = v;
                        pushProxy();
                    }
                }),
                h(Forms.FormTitle, { tag: "h5", style: { marginTop: "12px" } }, PR.proxyBypassLabel),
                h(TextInput, {
                    value: store.proxyBypass ?? "",
                    placeholder: PR.proxyBypassPlaceholder,
                    onChange: (v: string) => {
                        store.proxyBypass = v;
                        pushProxy();
                    }
                })
            )
    );
}
