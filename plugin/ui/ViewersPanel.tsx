/*
 * DockView — the "Viewers" settings page (renderer).
 * ---------------------------------------------------------------------------
 * The master switch + per-category switches deciding which attachments open in the
 * dock. All bind to the reactive settings store (settings.use) so a flip persists and
 * re-renders; embed.ts reads the SAME store live (viewerEnabled) at the moment a chip
 * is clicked, so a toggle applies to the next click with no reload:
 *   - MASTER: "Open attachments in the dock". OFF = chip interception fully off;
 *     attachments behave like stock Discord (download / lightbox).
 *   - CATEGORY switches (one per engine/categoryMap ViewerCategory): each gates its
 *     formats' detection so an OFF category's chips fall back to stock Discord.
 * Master OFF disables (greys) the category switches — their state is preserved
 * underneath (the store values are untouched; only the controls are `disabled`), so
 * turning master back on restores each category to what it was.
 *
 * GRAMMAR — plain React.createElement over @webpack/common primitives (no JSX),
 * semantic CSS variables only. The page header ("Viewers") comes from the sidebar row's
 * panel title; FormTitle h3 heads the category sub-group. `h` defers the webpack React
 * proxy to call time (no module-top access → the plugin can't silently die).
 */

import { Forms, React, Switch } from "@vencord/types/webpack/common";

import type { ViewerCategory } from "../engine/categoryMap";
import { settings } from "../settings";
import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const V = STRINGS.viewers;

/** The category rows, in display order: [store key, label, note]. The store keys mirror
 *  engine/categoryMap's CATEGORY_SETTING (the same fields viewerEnabled reads). */
const CATEGORY_ROWS: Array<{ key: string; cat: ViewerCategory; label: string; note: string; }> = [
    { key: "viewerDocuments", cat: "documents", label: V.cat.documents, note: V.cat.documentsNote },
    { key: "viewerSpreadsheets", cat: "spreadsheets", label: V.cat.spreadsheets, note: V.cat.spreadsheetsNote },
    { key: "viewerImages", cat: "images", label: V.cat.images, note: V.cat.imagesNote },
    { key: "viewerExoticImages", cat: "exoticImages", label: V.cat.exoticImages, note: V.cat.exoticImagesNote },
    { key: "viewerCodeText", cat: "codeText", label: V.cat.codeText, note: V.cat.codeTextNote },
    { key: "viewerDiagrams", cat: "diagrams", label: V.cat.diagrams, note: V.cat.diagramsNote },
    { key: "viewerModels3d", cat: "models3d", label: V.cat.models3d, note: V.cat.models3dNote },
    { key: "viewerMedia", cat: "media", label: V.cat.media, note: V.cat.mediaNote },
    { key: "viewerPresentations", cat: "presentations", label: V.cat.presentations, note: V.cat.presentationsNote }
];

export function ViewersPanel() {
    // Subscribe to the master + every category key so a flip re-renders (and greys the
    // categories when master goes off). `use()` returns the live proxied store.
    const store = settings.use([
        "viewersMaster",
        ...CATEGORY_ROWS.map(r => r.key)
    ]);

    const master = store.viewersMaster !== false;

    return h(
        "div",
        null,

        // --- Master switch -------------------------------------------------
        h(
            Switch,
            {
                value: master,
                note: V.masterNote,
                onChange: (v: boolean) => { store.viewersMaster = v; }
            },
            V.masterTitle
        ),

        h(Forms.FormDivider, { style: { margin: "20px 0" } }),

        // --- Category group ------------------------------------------------
        h(Forms.FormTitle, { tag: "h3" }, V.categoriesTitle),
        h(
            Forms.FormText,
            { style: { marginBottom: "16px", color: "var(--text-muted)" } },
            V.categoriesNote
        ),

        // Each category switch. Disabled (greyed) when the master is off — the value is
        // left untouched, so master-on restores each category to what it was.
        ...CATEGORY_ROWS.map(row =>
            h(
                Switch,
                {
                    key: row.key,
                    value: store[row.key] !== false,
                    note: row.note,
                    disabled: !master,
                    onChange: (v: boolean) => { store[row.key] = v; }
                },
                row.label
            )
        )
    );
}
