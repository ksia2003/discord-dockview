import assert from "node:assert/strict";
import test from "node:test";

import registryModule from "../plugin/host/searchResultsRegistry.ts";
import forceRenderModule from "../plugin/engine/forceRender.ts";

const {
    SearchSurfaceRegistry,
    isSearchSurfaceActive,
    slateSearchEditorQuery
} = registryModule;
const { requestRender, setRenderer, subscribeRender } = forceRenderModule;

test("Search surfaces stay resident across file selection and guild channel switches", () => {
    const registry = new SearchSurfaceRegistry();
    const firstElement = {
        type: "SearchResults",
        key: "native-search",
        props: { query: "first" }
    };
    const providerStack = [{ type: "ThemeProvider", value: { theme: "dark" } }];

    const opened = registry.capture("guild:A", "channel:A-1", firstElement, providerStack);
    assert.equal(opened.firstOpen, true);
    assert.equal(registry.activate("guild:A"), true);
    assert.equal(registry.isActive("guild:A"), true);

    // Selecting a file only deactivates Search; it does not remove the native surface.
    assert.equal(registry.deactivate("guild:A"), true);
    assert.equal(registry.get("guild:A")?.element, firstElement);

    // A same-guild channel render updates native props/provider ownership while the
    // scope entry (and therefore the resident wrapper key) stays the same.
    const secondElement = {
        type: firstElement.type,
        key: firstElement.key,
        props: { query: "updated", filter: "has:file" }
    };
    const recaptured = registry.capture("guild:A", "channel:A-2", secondElement, providerStack);
    assert.equal(recaptured.firstOpen, false);
    assert.equal(recaptured.entry, opened.entry);
    assert.equal(recaptured.entry.scopeId, "guild:A");
    assert.equal(recaptured.entry.element, secondElement);
    assert.equal(recaptured.entry.sourceChannelId, "channel:A-2");
    assert.deepEqual(recaptured.entry.providerStack, providerStack);

    // Same React type/key is the reconciliation boundary: model the keyed resident
    // wrapper's child slot and prove a recapture updates props without replacing the
    // child-local state token (the native SearchResults scroll/local React state).
    const mountedChildren = new Map();
    const reconcile = entry => {
        const previous = mountedChildren.get(entry.scopeId);
        if (previous
            && previous.type === entry.element.type
            && previous.key === entry.element.key) {
            previous.props = entry.element.props;
            return previous;
        }
        const next = {
            type: entry.element.type,
            key: entry.element.key,
            props: entry.element.props,
            state: { mountCount: 1, scrollTop: 317 }
        };
        mountedChildren.set(entry.scopeId, next);
        return next;
    };
    const mounted = reconcile(opened.entry);
    const reconciled = reconcile(recaptured.entry);
    assert.equal(reconciled, mounted);
    assert.equal(reconciled.props.query, "updated");
    assert.deepEqual(reconciled.state, { mountCount: 1, scrollTop: 317 });

    // A queued owner close cannot win after the same turn recaptures SEARCH. This is the
    // non-SEARCH → SEARCH race that previously survived Set.delete() and removed the
    // freshly resident surface in its already-scheduled microtask.
    const pendingClose = registry.beginClose("guild:A");
    assert.ok(pendingClose);
    const thirdElement = {
        type: secondElement.type,
        key: secondElement.key,
        props: { query: "same-turn-recapture" }
    };
    registry.capture("guild:A", "channel:A-2", thirdElement, providerStack);
    assert.equal(registry.isCurrentClose("guild:A", pendingClose), false);
    assert.equal(registry.finishClose("guild:A", pendingClose), false);
    assert.equal(registry.get("guild:A")?.element, thirdElement);

    // A second guild is independent and cannot become active by merely being resident.
    const guildBElement = { type: "SearchResults", key: "native-search-b", props: { query: "B" } };
    registry.capture("guild:B", "channel:B-1", guildBElement, null);
    assert.equal(registry.isActive("guild:B"), false);
    assert.equal(registry.isActive("guild:A"), false);
    registry.activate("guild:A");
    assert.equal(registry.isActive("guild:A"), true);
    assert.equal(registry.isActive("guild:B"), false);

    // Only an explicit close removes a scope; stop/clear removes every resident surface.
    assert.equal(registry.removeIfSource("guild:A", "channel:B-stale"), false);
    assert.equal(registry.has("guild:A"), true);
    assert.equal(registry.removeIfSource("guild:A", "channel:A-2"), true);
    assert.equal(registry.has("guild:A"), false);
    registry.clear();
    assert.equal(registry.all().length, 0);
});

test("Search provider wrappers stay stable and resident guilds use a bounded LRU", () => {
    const registry = new SearchSurfaceRegistry(2);
    const ProviderA = () => null;
    const ProviderB = () => null;
    const element = query => ({ type: "SearchResults", key: "native-search", props: { query } });

    registry.capture("guild:A", "channel:A", element("A"), [
        { type: ProviderA, value: "A-old" },
        { type: ProviderB, value: "B-old" }
    ]);
    const a = registry.capture("guild:A", "channel:A", element("A2"), [
        { type: ProviderA, value: "A-new" }
    ]).entry;
    assert.deepEqual(a.providerStack?.map(provider => provider.type), [ProviderA, ProviderB]);
    assert.deepEqual(a.providerStack?.map(provider => provider.value), ["A-new", undefined]);

    registry.capture("guild:B", "channel:B", element("B"), null);
    // Touch A before opening C: the least-recently-used B scope is evicted, while the
    // recent A→C→A round-trip contract remains bounded to two mounted native trees.
    registry.capture("guild:A", "channel:A", element("A3"), null);
    const openedC = registry.capture("guild:C", "channel:C", element("C"), null);
    assert.deepEqual(openedC.evictedScopeIds, ["guild:B"]);
    assert.equal(registry.has("guild:A"), true);
    assert.equal(registry.has("guild:B"), false);
    assert.equal(registry.has("guild:C"), true);
    assert.equal(registry.all().length, 2);
});

test("Search tab and resident body derive active from one shared source", () => {
    const registry = new SearchSurfaceRegistry();
    const element = query => ({ type: "SearchResults", key: "native-search", props: { query } });
    const bodyActive = scopeId => isSearchSurfaceActive(registry, "guild:A", scopeId);

    // First open: the entry exists, but the body must not show active before activation.
    registry.capture("guild:A", "channel:A-1", element("first"), null);
    assert.equal(bodyActive("guild:A"), false);
    registry.activate("guild:A");
    // Tab and body agree: the current guild's surface is active immediately.
    assert.equal(bodyActive("guild:A"), true);

    // Channel info / file selection deactivates the SAME resident DOM...
    assert.equal(registry.deactivate("guild:A"), true);
    assert.equal(registry.get("guild:A") != null, true);
    assert.equal(bodyActive("guild:A"), false);
    // ...and returning to Search restores the SAME DOM to active.
    assert.equal(registry.activate("guild:A"), true);
    assert.equal(bodyActive("guild:A"), true);

    // The per-channel scope is what makes resident surfaces exclusive on screen: from a
    // guild:B channel, guild:A's resident surface is not the active one.
    registry.capture("guild:B", "channel:B-1", element("B"), null);
    registry.activate("guild:B");
    assert.equal(isSearchSurfaceActive(registry, "guild:B", "guild:A"), false);
    assert.equal(isSearchSurfaceActive(registry, "guild:B", "guild:B"), true);
});

test("close removes the resident surface; requery captures a fresh active body", () => {
    const registry = new SearchSurfaceRegistry();
    const element = query => ({ type: "SearchResults", key: "native-search", props: { query } });
    const first = registry.capture("guild:A", "channel:A-1", element("old"), null);
    registry.activate("guild:A");
    assert.equal(isSearchSurfaceActive(registry, "guild:A", "guild:A"), true);

    // Close: the entry is removed and nothing stays active.
    assert.equal(registry.remove("guild:A"), true);
    assert.equal(registry.has("guild:A"), false);
    assert.equal(isSearchSurfaceActive(registry, "guild:A", "guild:A"), false);

    // Requery after close is a FIRST open: a NEW resident body, active on activation.
    const reopened = registry.capture("guild:A", "channel:A-2", element("new"), null);
    assert.equal(reopened.firstOpen, true);
    assert.notEqual(reopened.entry, first.entry);
    assert.equal(isSearchSurfaceActive(registry, "guild:A", "guild:A"), false);
    registry.activate("guild:A");
    assert.equal(isSearchSurfaceActive(registry, "guild:A", "guild:A"), true);
});

test("native-authoritative close keeps the entry through the transition and never blocks a fresh search", () => {
    const registry = new SearchSurfaceRegistry();
    const element = query => ({ type: "SearchResults", key: "native-search", props: { query } });

    // Open: capture + activate.
    const opened = registry.capture("guild:A", "channel:A-1", element("has:file"), null);
    registry.activate("guild:A");
    assert.equal(isSearchSurfaceActive(registry, "guild:A", "guild:A"), true);

    // The dock's close click does NOT remove the entry — the native close is
    // authoritative. A stale SEARCH render during the transition is recaptured
    // (firstOpen false) and supersedes, never suppressed.
    const stale = registry.capture("guild:A", "channel:A-1", element("stale"), null);
    assert.equal(stale.firstOpen, false);
    assert.equal(stale.entry, opened.entry);
    assert.equal(registry.has("guild:A"), true);

    // The native non-SEARCH render confirms the close: the entry is removed on that
    // transition and nothing stays active.
    const closeToken = registry.beginClose("guild:A");
    assert.ok(closeToken);
    assert.equal(registry.isCurrentClose("guild:A", closeToken), true);
    assert.equal(registry.removeIfSource("guild:A", "channel:A-1"), true);
    assert.equal(registry.has("guild:A"), false);
    assert.equal(isSearchSurfaceActive(registry, "guild:A", "guild:A"), false);

    // A fresh search after the close is a FIRST open and activates immediately.
    const reopened = registry.capture("guild:A", "channel:A-1", element("has:file"), null);
    assert.equal(reopened.firstOpen, true);
    assert.notEqual(reopened.entry, opened.entry);
    registry.activate("guild:A");
    assert.equal(isSearchSurfaceActive(registry, "guild:A", "guild:A"), true);
});

test("native search editor query reads only Slate semantic content", () => {
    // Localized placeholder: the editor's placeholder text ("서버 검색") and its
    // aria-label are different translations, so a textContent vs aria-label equality
    // fallback misread the placeholder as a query and blocked the close removal.
    // Placeholder present → no query, whatever else the editor DOM contains.
    assert.equal(slateSearchEditorQuery(true, []), null);
    assert.equal(slateSearchEditorQuery(true, ["has:file"]), null);
    // Cleared Slate editor: no placeholder node and no non-empty slate strings.
    assert.equal(slateSearchEditorQuery(false, []), null);
    assert.equal(slateSearchEditorQuery(false, [null, "   "]), null);
    // Only actual slate strings are a query.
    assert.equal(slateSearchEditorQuery(false, ["has:file"]), "has:file");
    assert.equal(slateSearchEditorQuery(false, ["has:", "file"]), "has:file");
});

test("Search close hides the resident tree and reopen preserves its identity", () => {
    const registry = new SearchSurfaceRegistry();
    const opened = registry.capture("guild:A", "channel:A-1", { type: "SearchResults" }, null).entry;
    registry.activate("guild:A");
    assert.equal(registry.isVisible("guild:A"), true);
    assert.equal(registry.isActive("guild:A"), true);

    assert.equal(registry.hide("guild:A"), true);
    assert.equal(registry.isVisible("guild:A"), false);
    assert.equal(registry.isActive("guild:A"), false);
    assert.equal(registry.get("guild:A"), opened);

    registry.activate("guild:A");
    assert.equal(registry.isVisible("guild:A"), true);
    assert.equal(registry.isActive("guild:A"), true);
    assert.equal(registry.get("guild:A"), opened);
});

test("resident body repaints on the engine signal even when the panel renderer slot is stale", () => {
    // UnifiedHeaderTabs subscribes via subscribeRender; SearchResultsBody now subscribes
    // to the SAME signal. A stale or cleared DockPanel renderer slot must never leave
    // the body behind while the tab keeps repainting.
    const calls = { tab: 0, body: 0, panel: 0 };
    setRenderer(() => { calls.panel += 1; });
    const unsubTab = subscribeRender(() => { calls.tab += 1; });
    const unsubBody = subscribeRender(() => { calls.body += 1; });
    try {
        requestRender();
        assert.equal(calls.tab, 1);
        assert.equal(calls.body, 1);
        assert.equal(calls.panel, 1);

        // A rebind window clears the panel slot: the tab AND the body still repaint.
        setRenderer(null);
        requestRender();
        assert.equal(calls.tab, 2);
        assert.equal(calls.body, 2);
        assert.equal(calls.panel, 1);
    } finally {
        unsubTab();
        unsubBody();
        setRenderer(null);
    }
});
