/*
 * DockView — dedicated top-level settings SECTION (renderer wiring).
 * ---------------------------------------------------------------------------
 * DockView gets its OWN header in Discord's user-settings sidebar — same visual
 * rank as "Vencord Settings" — with a row per page (Updates / Examples / About).
 *
 * WHY A WRAP, NOT THE PUBLIC API. Vencord's Settings plugin exposes
 * `customEntries`/`customSections`, but those only add rows UNDER the one
 * "Vencord Settings" header (they feed the `vencordEntries` array inside its
 * `buildLayout`). There is no public API for a SECOND top-level section. So we
 * wrap the Settings plugin's own `buildLayout(originalLayoutBuilder)` — the
 * method its webpack patch calls as `$self.buildLayout(root)` to splice the
 * Vencord section into Discord's settings layout. Our wrapper runs the original,
 * then splices OUR section node in right after `vencord_section`.
 *
 * ROBUSTNESS. This is deliberately self-sufficient and defensive:
 *   - We reuse the plugin's OWN `buildEntry(...)` to build our rows, so the
 *     SIDEBAR_ITEM / PANEL / CATEGORY / CUSTOM node shapes always match whatever
 *     the live Settings plugin produces — no replicated node literals to drift.
 *   - We read the SECTION `type` off the live `vencord_section` node instead of
 *     resolving a layout-type enum ourselves, so our node's type is byte-identical
 *     to Vencord's own section type in this build.
 *   - The whole injection is wrapped in try/catch: any failure returns the
 *     UNTOUCHED vanilla layout, so a bug here can never take the settings UI down.
 *   - Idempotent: if our section is already present (a re-render, or a missed
 *     teardown) we don't add a second one.
 *
 * TEARDOWN. install() saves the original method and replaces it with the wrapper;
 * uninstall() restores the original (only if ours is still the installed one, so
 * we never clobber another wrapper). A stopped/restarted plugin therefore leaves
 * the Settings plugin exactly as it found it. It also tolerates the Settings
 * plugin loading after us (install() no-ops when it isn't ready — start() runs
 * after plugin init, so it is normally present).
 */

import { AboutPanel } from "./AboutPanel";
import { isUpdateFlagged } from "./autoCheck";
import { GallerySection } from "./GallerySection";
import { GeneralPanel } from "./GeneralPanel";
import { PerformancePanel } from "./PerformancePanel";
import { PrivacyPanel } from "./PrivacyPanel";
import { ROW_ICONS } from "./SettingsRowIcons";
import { STRINGS } from "../strings";
import { UpdatePanel } from "./UpdatePanel";
import { ViewersPanel } from "./ViewersPanel";

const SECTION_KEY = "dockview_section";

// The wrapper we install, tagged so uninstall() can recognise it and refuse to
// restore over a different wrapper (defensive against concurrent wrappers).
type WrappedBuildLayout = ((builder: any) => any[]) & { __dockViewWrapped?: true; };

// The original buildLayout we replaced, held so we can restore it on stop().
let originalBuildLayout: ((builder: any) => any[]) | null = null;

/** Resolve the live Settings plugin object, or null if it isn't ready yet.
 *  `Vencord` is the renderer global (ambient in @vencord/types). */
function getSettingsPlugin(): any | null {
    try {
        return (Vencord as any)?.Plugins?.plugins?.Settings ?? null;
    } catch {
        return null;
    }
}

/** Build the three DockView rows via the Settings plugin's own buildEntry, so the
 *  node shapes match its native ones exactly. Each row is a SIDEBAR_ITEM whose
 *  panel mounts the Component on demand (lazy CUSTOM node). */
function buildDockViewEntries(plugin: any): any[] {
    const S = STRINGS.settings;
    const buildEntry = plugin.buildEntry.bind(plugin);
    return [
        buildEntry({
            key: "dockview_general",
            title: S.general,
            Component: GeneralPanel,
            Icon: ROW_ICONS.general
        }),
        buildEntry({
            key: "dockview_viewers",
            title: S.viewers,
            Component: ViewersPanel,
            Icon: ROW_ICONS.viewers
        }),
        buildEntry({
            key: "dockview_performance",
            title: S.performance,
            Component: PerformancePanel,
            Icon: ROW_ICONS.performance
        }),
        buildEntry({
            key: "dockview_privacy",
            title: S.privacy,
            Component: PrivacyPanel,
            Icon: ROW_ICONS.privacy
        }),
        buildEntry({
            // When a background check has flagged a newer build, mark the Updates row
            // with a trailing bullet so it stands out in the sidebar (a cheap, native-
            // looking highlight). The layout rebuilds when the settings UI (re)opens, so
            // the mark appears on the next open after the daily check; the row's panel
            // clears the flag once viewed. No mark in the steady state.
            key: "dockview_updates",
            title: isUpdateFlagged() ? `${S.updates} •` : S.updates,
            Component: UpdatePanel,
            Icon: ROW_ICONS.updates
        }),
        buildEntry({
            key: "dockview_examples",
            title: S.examples,
            Component: GallerySection,
            Icon: ROW_ICONS.examples
        }),
        buildEntry({
            key: "dockview_about",
            title: S.about,
            Component: AboutPanel,
            Icon: ROW_ICONS.about
        })
    ];
}

/** Given the finished layout (with `vencord_section` already spliced in), insert
 *  our DockView section directly after it. Idempotent + fully guarded: on ANY
 *  problem it returns the layout untouched so the settings UI never breaks. */
function injectSection(plugin: any, layout: any[]): any[] {
    try {
        if (!Array.isArray(layout)) return layout;
        // Already present (re-render / missed teardown) → leave as-is.
        if (layout.some(n => n?.key === SECTION_KEY)) return layout;

        const vencordIdx = layout.findIndex(n => n?.key === "vencord_section");
        if (vencordIdx === -1) return layout; // not the root layout we target

        // Match Vencord's own SECTION node type exactly (read off the live node),
        // rather than resolving a layout-type enum ourselves.
        const sectionType = layout[vencordIdx]?.type;
        if (sectionType == null) return layout;

        const dockViewSection = {
            key: SECTION_KEY,
            type: sectionType,
            useTitle: () => STRINGS.settings.section,
            buildLayout: () => buildDockViewEntries(plugin)
        };

        layout.splice(vencordIdx + 1, 0, dockViewSection);
        return layout;
    } catch {
        // Any failure degrades to the vanilla layout.
        return layout;
    }
}

/** Install the buildLayout wrapper on the live Settings plugin. Idempotent —
 *  no-ops if the Settings plugin isn't ready or our wrapper is already installed. */
export function installDockViewSection(): void {
    const plugin = getSettingsPlugin();
    if (!plugin || typeof plugin.buildLayout !== "function") return;

    const current = plugin.buildLayout as WrappedBuildLayout;
    if (current.__dockViewWrapped) return; // already installed

    originalBuildLayout = current.bind(plugin);

    const wrapped: WrappedBuildLayout = function (this: any, builder: any) {
        const layout = originalBuildLayout!(builder);
        return injectSection(plugin, layout);
    };
    wrapped.__dockViewWrapped = true;

    plugin.buildLayout = wrapped;
}

/** Restore the original buildLayout — only if OURS is still the installed one, so
 *  we never clobber a different wrapper. Safe no-op if never installed. */
export function uninstallDockViewSection(): void {
    const plugin = getSettingsPlugin();
    if (!plugin) { originalBuildLayout = null; return; }

    const current = plugin.buildLayout as WrappedBuildLayout;
    if (current?.__dockViewWrapped && originalBuildLayout) {
        plugin.buildLayout = originalBuildLayout;
    }
    originalBuildLayout = null;
}
