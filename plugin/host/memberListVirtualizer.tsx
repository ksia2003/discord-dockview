/*
 * DockView's narrow Members ListScroller adapter.
 *
 * The only entry point is memberListScrollerType(), called by the one precise
 * Vencord source patch in index.tsx. It receives the exact ListScroller type and
 * the Members component props from the live render; no React internals or fiber
 * descendants are inspected here.
 */

export const MEMBER_CELL_WIDTH = 264;
export const MEMBER_MAX_COLUMNS = 3;

type RowHeight = number | ((section: number, row: number) => number);
type ReactLike = { createElement: (type: any, props?: any, ...children: any[]) => any; };

export interface MemberListScrollerProps {
    paddingTop: number;
    sections: number[];
    sectionHeight: number | ((section: number) => number);
    rowHeight: RowHeight;
    renderSection: (item: any) => any;
    renderRow: (item: any) => any;
    onScroll: (...args: any[]) => any;
    [key: string]: any;
}

export interface MemberVirtualizerStats {
    hits: number;
    misses: number;
}

let stats: MemberVirtualizerStats = { hits: 0, misses: 0 };
let lastNonzeroWidth = MEMBER_CELL_WIDTH;
let nativeCellWidth = MEMBER_CELL_WIDTH;
let memberVirtualizerActive = false;
let settingReader: () => boolean = () => true;
let reactRuntime: any = null;

// A ListScroller component type is stable for the lifetime of a Discord build. Do not
// reuse a wrapper for another type: its ref and render contract belong to this exact type.
const wrapperCache = new WeakMap<object, any>();

export function columnsForMemberWidth(width: number, enabled = true, cellWidth = MEMBER_CELL_WIDTH): number {
    if (!enabled || !Number.isFinite(width) || width <= 0 || !Number.isFinite(cellWidth) || cellWidth <= 0) return 1;
    return Math.min(MEMBER_MAX_COLUMNS, Math.max(1, Math.floor(width / cellWidth)));
}

/** Store only real measurements. F9 temporarily collapses the dock to zero pixels. */
export function setMembersSlotWidth(width: number): void {
    if (Number.isFinite(width) && width > 0) lastNonzeroWidth = width;
}

export function getMembersSlotWidth(): number { return lastNonzeroWidth; }

export function setMemberCellWidth(width: number): void {
    if (Number.isFinite(width) && width > 0) nativeCellWidth = width;
}

export function memberColumns(): number {
    try {
        return columnsForMemberWidth(lastNonzeroWidth, settingReader(), nativeCellWidth);
    } catch {
        return 1;
    }
}

export function setMemberVirtualizerActive(active: boolean): void {
    memberVirtualizerActive = active;
}

export function setMemberVirtualizerReact(react: any): void {
    reactRuntime = react;
}

/** Keep settings access in the plugin lifecycle; this module remains a pure testable seam. */
export function setMemberVirtualizerSettingReader(reader: (() => boolean) | null): void {
    settingReader = reader ?? (() => true);
}

export function memberVirtualizerStats(): MemberVirtualizerStats { return { ...stats }; }
export function resetMemberVirtualizerStats(): void { stats = { hits: 0, misses: 0 }; }

export function projectMemberSections(sections: number[], columns: number): number[] {
    if (columns <= 1) return sections;
    return sections.map(count => Math.ceil(count / columns));
}

function sectionOffsets(sections: number[]): number[] {
    const offsets: number[] = [];
    let offset = 0;
    for (const count of sections) {
        offsets.push(offset);
        offset += count;
    }
    return offsets;
}

/** Convert the original global member index to the projected global row index. */
export function projectedGlobalRowIndex(sections: number[], columns: number, nativeIndex: number): number | null {
    if (!Number.isInteger(columns) || columns <= 0 || !Number.isInteger(nativeIndex) || nativeIndex < 0) return null;
    let remaining = nativeIndex;
    let projectedOffset = 0;
    for (const count of sections) {
        if (remaining < count) return projectedOffset + Math.floor(remaining / columns);
        remaining -= count;
        projectedOffset += Math.ceil(count / columns);
    }
    return null;
}

/** The inverse used by tests and by the ref proxy's documented mapping contract. */
export function sectionAndLocalMemberIndex(sections: number[], nativeIndex: number): { section: number; row: number } | null {
    if (!Number.isInteger(nativeIndex) || nativeIndex < 0) return null;
    let remaining = nativeIndex;
    for (let section = 0; section < sections.length; section++) {
        if (remaining < sections[section]) return { section, row: remaining };
        remaining -= sections[section];
    }
    return null;
}

function supportedProps(props: any): props is MemberListScrollerProps {
    if (!props || typeof props !== "object" || props.paddingTop !== 0 || !Array.isArray(props.sections)) return false;
    if (!["paddingTop", "sections", "sectionHeight", "rowHeight", "renderSection", "renderRow", "onScroll"]
        .every(key => Object.prototype.hasOwnProperty.call(props, key))) return false;
    if (typeof props.sectionHeight !== "number" && typeof props.sectionHeight !== "function") return false;
    if (typeof props.rowHeight !== "number" && typeof props.rowHeight !== "function") return false;
    if (typeof props.renderSection !== "function" || typeof props.renderRow !== "function") return false;
    if (typeof props.onScroll !== "function") return false;
    // The current live signature has no anchor method. A future non-null anchor changes
    // the ref contract, so preserve Discord's native component until it is proven.
    if (props.getAnchorId != null) return false;
    return props.sections.every((count: unknown) => Number.isInteger(count) && (count as number) >= 0);
}

function nativeRowItem(item: any, sectionOffset: number, nativeRow: number): any {
    return {
        ...item,
        row: nativeRow,
        rowIndex: sectionOffset + nativeRow
    };
}

function projectedRow(props: MemberListScrollerProps, item: any, columns: number, react: ReactLike): any {
    const section = item?.section;
    const projectedRowNumber = item?.row;
    const nativeCount = props.sections[section];
    if (!Number.isInteger(section) || nativeCount == null || !Number.isInteger(projectedRowNumber)
        || projectedRowNumber < 0 || projectedRowNumber >= Math.ceil(nativeCount / columns)) {
        return props.renderRow(item);
    }

    const offsets = sectionOffsets(props.sections);
    const firstNativeRow = projectedRowNumber * columns;
    const cellWidth = `${100 / columns}%`;
    const cells: any[] = [];
    for (let cell = 0; cell < columns; cell++) {
        const nativeRow = firstNativeRow + cell;
        if (nativeRow >= nativeCount) break;
        const rendered = props.renderRow(nativeRowItem(item, offsets[section], nativeRow));
        // A cell wrapper keeps an incomplete final row at 1/columns width. Flex growth
        // must not distribute the unused cells across the remaining members.
        cells.push(react.createElement(
            "div",
            {
                className: "dockview-member-virtual-cell",
                style: { flex: `0 0 ${cellWidth}`, width: cellWidth, minWidth: 0 }
            },
            rendered
        ));
    }
    return react.createElement(
        "div",
        {
            key: `${section}:${projectedRowNumber}`,
            className: `dockview-member-virtual-row dockview-member-virtual-row--${columns}`
        },
        ...cells
    );
}

function projectedRowHeight(props: MemberListScrollerProps, section: number, row: number, columns: number): number {
    const nativeCount = props.sections[section] ?? 0;
    let height = 0;
    for (let cell = 0; cell < columns; cell++) {
        const nativeRow = row * columns + cell;
        if (nativeRow >= nativeCount) break;
        const value = typeof props.rowHeight === "function"
            ? props.rowHeight(section, nativeRow)
            : props.rowHeight;
        if (Number.isFinite(value)) height = Math.max(height, value);
    }
    return height;
}

/** Adapt only the ListScroller's projected data fields. All other props survive intact. */
export function adaptMemberListScrollerProps(props: any, columns: number, react?: ReactLike): any {
    if (!Number.isInteger(columns) || columns <= 1 || !supportedProps(props)
        || !react || typeof react.createElement !== "function") {
        stats.misses++;
        return props;
    }
    stats.hits++;
    return {
        ...props,
        sections: projectMemberSections(props.sections, columns),
        rowHeight: (section: number, row: number) => projectedRowHeight(props, section, row, columns),
        renderRow: (item: any) => projectedRow(props, item, columns, react)
    };
}

type NativeRef = Record<PropertyKey, any> | null;
type NativeRefSource = NativeRef | (() => NativeRef);

function currentNativeRef(source: NativeRefSource): NativeRef {
    return typeof source === "function" ? source() : source;
}

/**
 * Make a non-mutating ref facade. Discord's focus path uses a global member index;
 * adapted ListScroller uses projected global rows, so only that one method is mapped.
 */
export function createMemberListRefProxy(source: NativeRefSource, sections: number[], columns: number): any {
    const target = currentNativeRef(source);
    if (!target && typeof source !== "function") return target;
    const proxyTarget = target ?? {};
    if (typeof proxyTarget !== "object" && typeof proxyTarget !== "function") return target;
    return new Proxy(proxyTarget, {
        get(_nativeTarget, property) {
            const current = currentNativeRef(source);
            if (!current || (typeof current !== "object" && typeof current !== "function")) return undefined;
            const value = Reflect.get(current, property, current);
            if (property !== "getSectionRowFromIndex" || typeof value !== "function") return value;
            return (nativeIndex: number, ...args: any[]) => {
                const projectedIndex = projectedGlobalRowIndex(sections, columns, nativeIndex);
                return value.call(current, projectedIndex == null ? nativeIndex : projectedIndex, ...args);
            };
        }
    });
}

function createScrollerWrapper(originalType: any): any {
    if (!reactRuntime || typeof reactRuntime.forwardRef !== "function") return originalType;
    const runtimeReact = reactRuntime;
    return runtimeReact.forwardRef((props: any, forwardedRef: any) => {
        const nativeRef = runtimeReact.useRef<NativeRef>(null);
        const columns = memberColumns();
        const adapted = adaptMemberListScrollerProps(props, columns, runtimeReact);
        const refProxy = runtimeReact.useMemo(
            () => createMemberListRefProxy(() => nativeRef.current, props.sections, columns),
            [columns, props.sections]
        );
        runtimeReact.useImperativeHandle(forwardedRef, () => refProxy, [refProxy]);
        return runtimeReact.createElement(originalType, { ...adapted, ref: nativeRef });
    });
}

/**
 * Source-patch seam for the live Members ListScroller call. Returning the original type
 * is the fail-closed path for every unproven or non-member invocation.
 */
export function memberListScrollerType(originalType: any, ownerProps: any): any {
    const columns = memberColumns();
    if (!memberVirtualizerActive
        || (typeof originalType !== "function" && (typeof originalType !== "object" || !originalType))
        || ownerProps?.className !== "dockview-context-native"
        || !ownerProps?.channel?.guild_id || columns <= 1) {
        stats.misses++;
        return originalType;
    }
    let wrapper = wrapperCache.get(originalType);
    if (!wrapper) {
        wrapper = createScrollerWrapper(originalType);
        if (wrapper === originalType) {
            stats.misses++;
            return originalType;
        }
        wrapperCache.set(originalType, wrapper);
    }
    stats.hits++;
    return wrapper;
}

export function resetMemberVirtualizerForTests(): void {
    stats = { hits: 0, misses: 0 };
    lastNonzeroWidth = MEMBER_CELL_WIDTH;
    nativeCellWidth = MEMBER_CELL_WIDTH;
    memberVirtualizerActive = false;
    settingReader = () => true;
    reactRuntime = null;
}
