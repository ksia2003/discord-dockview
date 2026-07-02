/*
 * DockView — the "Privacy" settings page (renderer).
 * ---------------------------------------------------------------------------
 * One control today: whether an email preview (.eml / .msg) may load its REMOTE images
 * (a classic tracking pixel), OFF by default. The switch backs settings.store
 * .emailRemoteImages, which the .eml viewer reads live in the renderer (email.ts) and
 * the .msg viewer forwards through the convertAttachment IPC into main's sanitiser, so a
 * flip applies to the next email opened, both formats consistently.
 *
 * The single switch sits under an "Email" FormTitle h3 group. That grouping is
 * deliberate: it leaves room for a future tracker-firewall section to slot in as its own
 * group beside this one, with no page restructure — but we build NO firewall UI or
 * placeholder now.
 *
 * GRAMMAR — mirrors GeneralPanel/ViewersPanel: deferred `h` (no module-top webpack),
 * @webpack/common primitives, FormTitle h3 sub-group, semantic CSS variables only. The
 * page header ("Privacy") comes from the sidebar row's panel title, so it isn't repeated.
 * Binds the reactive settings store (settings.use) so a flip persists + re-renders.
 */

import { Forms, React, Switch } from "@webpack/common";

import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const PR = STRINGS.privacy;

export function PrivacyPanel() {
    const store = settings.use(["emailRemoteImages"]);

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
        )
    );
}
