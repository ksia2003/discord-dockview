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

import { Button, Forms, React, Switch, TextInput } from "@webpack/common";

import { saveEncryptionPasswords, syncMessageEncryption } from "../messageEncryption";
import { pushFirewall, pushProxy } from "../networkPrivacy";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const PR = STRINGS.privacy;

/** Load the stored passwords over IPC (decrypted from the safeStorage blob). Returns
 *  [] on any failure — the panel then shows the empty state. */
function loadStoredPasswords(): Promise<string[]> {
    const helpers = (window as any).VencordNative?.pluginHelpers?.DockView;
    if (!helpers?.loadPasswords) return Promise.resolve([]);
    return Promise.resolve(helpers.loadPasswords())
        .then((l: any) => (Array.isArray(l) ? l.filter((p: any) => typeof p === "string" && p) : []))
        .catch(() => []);
}

/** The message-encryption group: password add/remove (masked), cover text, marker.
 *  Passwords live in local state seeded from the encrypted store; every mutation
 *  persists through saveEncryptionPasswords (safeStorage) and re-arms the feature. */
function EncryptionGroup() {
    const store = settings.use(["messageEncryption", "encryptionCover", "encryptionMark"]);
    const [passwords, setPasswords] = React.useState<string[]>([]);
    const [draft, setDraft] = React.useState("");
    const [err, setErr] = React.useState<string | null>(null);

    React.useEffect(() => { loadStoredPasswords().then(setPasswords); }, []);

    const persist = async (next: string[]) => {
        const res = await saveEncryptionPasswords(next);
        if (res?.ok) { setPasswords(next); setErr(null); }
        else setErr(res?.error || PR.encStorageError);
    };
    const add = () => {
        const p = draft.trim();
        if (!p || passwords.includes(p)) { setDraft(""); return; }
        setDraft("");
        void persist([...passwords, p]);
    };
    const remove = (i: number) => void persist(passwords.filter((_, j) => j !== i));

    return h(
        "div",
        null,
        h(Forms.FormTitle, { tag: "h3", style: { marginTop: "20px" } }, PR.encGroup),
        h(
            Switch,
            {
                value: store.messageEncryption === true,
                note: PR.encEnableNote,
                hideBorder: true,
                onChange: (v: boolean) => { store.messageEncryption = v; syncMessageEncryption(); }
            },
            PR.encEnableTitle
        ),

        // Passwords
        h(Forms.FormTitle, { tag: "h5", style: { marginTop: "12px" } }, PR.encPasswordsTitle),
        h(Forms.FormText, { style: { marginBottom: "8px", color: "var(--text-muted)" } }, PR.encPasswordsNote),
        passwords.length === 0
            ? h(Forms.FormText, { style: { marginBottom: "8px", color: "var(--text-muted)" } }, PR.encNoPasswords)
            : passwords.map((_, i) =>
                h(
                    "div",
                    { key: i, style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" } },
                    h("span", { style: { flex: 1, color: "var(--text-normal)" } }, PR.encPasswordMasked + " " + (i + 1)),
                    h(
                        Button,
                        {
                            size: Button.Sizes.SMALL,
                            color: Button.Colors.RED,
                            onClick: () => remove(i)
                        },
                        PR.encRemove
                    )
                )
            ),
        h(
            "div",
            { style: { display: "flex", gap: "8px", marginTop: "4px" } },
            h("div", { style: { flex: 1 } }, h(TextInput, {
                type: "password",
                value: draft,
                placeholder: PR.encAddPlaceholder,
                onChange: (v: string) => setDraft(v)
            })),
            h(Button, { onClick: add }, PR.encAdd)
        ),
        err && h(Forms.FormText, { style: { marginTop: "6px", color: "var(--status-danger)" } }, err),

        // Cover text
        h(Forms.FormTitle, { tag: "h5", style: { marginTop: "16px" } }, PR.encCoverLabel),
        h(TextInput, {
            value: store.encryptionCover ?? "",
            placeholder: PR.encCoverPlaceholder,
            onChange: (v: string) => { store.encryptionCover = v; }
        }),
        h(Forms.FormText, { style: { marginTop: "4px", color: "var(--text-muted)" } }, PR.encCoverNote),

        // Marker
        h(Forms.FormTitle, { tag: "h5", style: { marginTop: "16px" } }, PR.encMarkLabel),
        h(TextInput, {
            value: store.encryptionMark ?? "",
            placeholder: PR.encMarkPlaceholder,
            onChange: (v: string) => { store.encryptionMark = v; }
        }),
        h(Forms.FormText, { style: { marginTop: "4px", color: "var(--text-muted)" } }, PR.encMarkNote)
    );
}

/** The Invidious group: a master switch + the instance URL. Both persist to the
 *  reactive store and are read live by the embed patch (invidiousEmbeds.ts) at
 *  render time, so a flip takes effect on the next YouTube embed with no reload. */
function InvidiousGroup() {
    const store = settings.use(["invidiousEmbeds", "invidiousInstance"]);

    return h(
        "div",
        null,
        h(Forms.FormTitle, { tag: "h3", style: { marginTop: "20px" } }, PR.invidiousGroup),
        h(
            Switch,
            {
                value: store.invidiousEmbeds === true,
                note: PR.invidiousNote,
                hideBorder: true,
                onChange: (v: boolean) => { store.invidiousEmbeds = v; }
            },
            PR.invidiousTitle
        ),

        store.invidiousEmbeds === true &&
            h(
                "div",
                { style: { marginTop: "8px" } },
                h(Forms.FormTitle, { tag: "h5" }, PR.invidiousInstanceLabel),
                h(TextInput, {
                    value: store.invidiousInstance ?? "",
                    placeholder: PR.invidiousInstancePlaceholder,
                    onChange: (v: string) => { store.invidiousInstance = v; }
                }),
                h(Forms.FormText, { style: { marginTop: "4px", color: "var(--text-muted)" } }, PR.invidiousInstanceNote)
            )
    );
}

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
                // A half-typed rules string can brick networking, so the fields only
                // persist on change and apply on blur or an explicit Apply — never
                // per keystroke.
                h(TextInput, {
                    value: store.proxyRules ?? "",
                    placeholder: PR.proxyRulesPlaceholder,
                    onChange: (v: string) => { store.proxyRules = v; },
                    onBlur: () => pushProxy()
                }),
                h(Forms.FormTitle, { tag: "h5", style: { marginTop: "12px" } }, PR.proxyBypassLabel),
                h(TextInput, {
                    value: store.proxyBypass ?? "",
                    placeholder: PR.proxyBypassPlaceholder,
                    onChange: (v: string) => { store.proxyBypass = v; },
                    onBlur: () => pushProxy()
                }),
                h(
                    "div",
                    { style: { marginTop: "8px" } },
                    h(Button, { size: Button.Sizes.SMALL, onClick: () => pushProxy() }, PR.proxyApply)
                )
            ),

        // --- Message encryption --------------------------------------------
        h(EncryptionGroup, null),

        // --- Invidious embeds ----------------------------------------------
        h(InvidiousGroup, null)
    );
}
