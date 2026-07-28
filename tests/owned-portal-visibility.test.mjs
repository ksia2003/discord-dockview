import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    OWNED_PORTAL_HIDDEN_ATTRIBUTE,
    registerOwnedPortal,
    setOwnedPortalsTemporarilyHidden,
    unregisterOwnedPortal
} from "../plugin/host/ownedPortalVisibility.ts";

function portalNode() {
    const attributes = new Map();
    return {
        attributes,
        node: {
            setAttribute(name, value) { attributes.set(name, value); },
            removeAttribute(name) { attributes.delete(name); }
        }
    };
}

test("owned portals synchronously inherit and reflect temporary-hidden state", () => {
    const first = portalNode();
    const second = portalNode();

    setOwnedPortalsTemporarilyHidden(false);
    registerOwnedPortal(first.node);
    assert.equal(first.attributes.has(OWNED_PORTAL_HIDDEN_ATTRIBUTE), false);

    setOwnedPortalsTemporarilyHidden(true);
    assert.equal(first.attributes.get(OWNED_PORTAL_HIDDEN_ATTRIBUTE), "true");

    registerOwnedPortal(second.node);
    assert.equal(second.attributes.get(OWNED_PORTAL_HIDDEN_ATTRIBUTE), "true");

    setOwnedPortalsTemporarilyHidden(false);
    assert.equal(first.attributes.has(OWNED_PORTAL_HIDDEN_ATTRIBUTE), false);
    assert.equal(second.attributes.has(OWNED_PORTAL_HIDDEN_ATTRIBUTE), false);

    unregisterOwnedPortal(first.node);
    setOwnedPortalsTemporarilyHidden(true);
    assert.equal(first.attributes.has(OWNED_PORTAL_HIDDEN_ATTRIBUTE), false);
    assert.equal(second.attributes.get(OWNED_PORTAL_HIDDEN_ATTRIBUTE), "true");

    unregisterOwnedPortal(second.node);
    setOwnedPortalsTemporarilyHidden(false);
});

test("thread and voice portals use the owned contract without an html visibility selector", () => {
    const source = relative => readFileSync(new URL(relative, import.meta.url), "utf8");
    const css = source("../plugin/style.css");
    const mount = source("../plugin/host/mount.ts");
    const thread = source("../plugin/viewers/thread/threadPortal.ts");
    const voice = source("../plugin/viewers/voice/voiceChatPortal.ts");

    assert.match(css, /\[data-dockview-temporarily-hidden="true"\]\s*\{[^}]*display:\s*none !important;/s);
    assert.doesNotMatch(css, /html:not\(\.dockview-open\) \.dockview-(?:thread|voice-chat)-portal/);
    assert.match(mount, /setOwnedPortalsTemporarilyHidden\(temporarilyHidden\)/);
    assert.match(thread, /registerOwnedPortal\(node\)/);
    assert.match(thread, /unregisterOwnedPortal\(node\)/);
    assert.match(voice, /registerOwnedPortal\(node\)/);
    assert.match(voice, /unregisterOwnedPortal\(node\)/);
});
