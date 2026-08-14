import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = relative => readFileSync(new URL(relative, import.meta.url), "utf8");

test("visible tab selection does not reapply dock geometry", () => {
    const mount = source("../plugin/host/mount.ts");
    const tabs = source("../plugin/engine/tabs.ts");
    assert.match(
        mount,
        /export function revealDock\(\): void \{[\s\S]{0,400}if \(!temporarilyHidden\) return;[\s\S]{0,160}applyOpenState\(\);/
    );
    assert.doesNotMatch(tabs, /hostActions\(\)\.applyOpenState\(\)/);
});

test("ordinary unified channels mount only the visible tab strip", () => {
    const panel = source("../plugin/ui/DockPanel.tsx");
    const unified = source("../plugin/host/unifiedHeader.tsx");
    assert.match(unified, /export function hasUnifiedChannelHeader/);
    assert.match(unified, /channelHeaderTitle\?\.channelId === channelId/);
    assert.match(panel, /const unifiedHeader = hasUnifiedChannelHeader\(channelId\)/);
    assert.match(panel, /unifiedHeader\s*\? null\s*:\s*React\.createElement/s);
});

test("tab geometry is measured only for selection, list, or resize changes", () => {
    const tabs = source("../plugin/ui/DockTabs.tsx");
    assert.match(tabs, /useLayoutEffect\(revealActive, \[revealActive, fileActiveId, tabIds\]\)/);
    assert.doesNotMatch(tabs, /useLayoutEffect\(\(\) => \{[\s\S]{0,500}\}\);/);
    assert.match(tabs, /new ResizeObserver\(report\)/);
});
