/*
 * DockView — viewer-scoped privacy settings.
 *
 * This page intentionally contains no app-wide network, messaging, or account
 * controls. DockView only owns privacy choices made inside its own viewers.
 */

import { Forms, React, Switch } from "@vencord/types/webpack/common";

import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

export function PrivacyPanel() {
    const store = settings.use(["emailRemoteImages"]);
    const copy = STRINGS.privacy;

    return h(
        "div",
        null,
        h(Forms.FormTitle, { tag: "h3" }, copy.emailGroup),
        h(
            Switch,
            {
                value: store.emailRemoteImages === true,
                note: copy.remoteImagesNote,
                hideBorder: true,
                onChange: (value: boolean) => { store.emailRemoteImages = value; }
            },
            copy.remoteImagesTitle
        )
    );
}
