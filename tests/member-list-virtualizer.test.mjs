import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    adaptMemberListScrollerProps,
    columnsForMemberWidth,
    commitMembersSlotWidth,
    createMemberListRefProxy,
    getMembersSlotWidth,
    memberColumns,
    memberListScrollerType,
    projectMemberSections,
    projectedGlobalRowIndex,
    resetMemberVirtualizerForTests,
    sectionAndLocalMemberIndex,
    setMemberCellWidth,
    setMemberVirtualizerActive,
    setMemberVirtualizerReact,
    setMemberVirtualizerSettingReader,
    setMembersSlotWidth
} from "../plugin/host/memberListVirtualizer.tsx";

const react = {
    createElement(type, props, ...children) {
        return { type, props: props ?? {}, children, key: props?.key ?? null };
    },
    forwardRef(render) { return { $$typeof: "forward-ref", render }; },
    useRef() { return { current: null }; },
    useMemo(factory) { return factory(); },
    useImperativeHandle() {}
};

function props(sections = [3, 2], rowHeight = 20) {
    return {
        paddingTop: 0,
        sections,
        sectionHeight: 32,
        rowHeight,
        renderSection: item => ({ heading: item.section }),
        renderRow: item => ({ section: item.section, row: item.row, rowIndex: item.rowIndex }),
        onScroll: () => {},
        extraHandler: () => {}
    };
}

function ownerProps() {
    return { className: "dockview-context-native", channel: { guild_id: "guild" } };
}

function canonicalizeMatch(regex) {
    const source = regex.source.replaceAll(/(\\*)\\i/g, (match, slashes) =>
        slashes.length % 2 === 0 ? `${slashes}(?:[A-Za-z_$][\\w$]*)` : match.slice(1)
    );
    return new RegExp(source, regex.flags);
}

test.afterEach(() => resetMemberVirtualizerForTests());

test("live props without getAnchorId adapt, while a future non-null anchor fails closed", () => {
    const input = props([3, 2]);
    const adapted = adaptMemberListScrollerProps(input, 2, react);
    assert.notEqual(adapted, input);
    assert.deepEqual(adapted.sections, [2, 1]);
    assert.equal(adapted.onScroll, input.onScroll);
    assert.equal(adapted.extraHandler, input.extraHandler);

    const future = { ...input, getAnchorId: () => "future" };
    assert.equal(adaptMemberListScrollerProps(future, 2, react), future);
    assert.equal(adaptMemberListScrollerProps({ ...input, getAnchorId: null }, 2, react).sections[0], 2);
});

test("native rowIndex stays global across original sections [2,6,2]", () => {
    const adapted = adaptMemberListScrollerProps(props([2, 6, 2]), 2, react);
    assert.deepEqual(adapted.sections, [1, 3, 1]);
    const seen = [];
    for (let section = 0; section < adapted.sections.length; section++) {
        for (let row = 0; row < adapted.sections[section]; row++) {
            const outer = adapted.renderRow({ section, row, rowIndex: row, untouched: "yes" });
            seen.push(outer.children.map(cell => cell.children[0]));
        }
    }
    assert.deepEqual(seen, [
        [{ section: 0, row: 0, rowIndex: 0 }, { section: 0, row: 1, rowIndex: 1 }],
        [{ section: 1, row: 0, rowIndex: 2 }, { section: 1, row: 1, rowIndex: 3 }],
        [{ section: 1, row: 2, rowIndex: 4 }, { section: 1, row: 3, rowIndex: 5 }],
        [{ section: 1, row: 4, rowIndex: 6 }, { section: 1, row: 5, rowIndex: 7 }],
        [{ section: 2, row: 0, rowIndex: 8 }, { section: 2, row: 1, rowIndex: 9 }]
    ]);
});

test("projected outer keys are section:row and sections never pair", () => {
    const adapted = adaptMemberListScrollerProps(props([3, 0, 5]), 2, react);
    assert.deepEqual(projectMemberSections([3, 0, 5], 2), [2, 0, 3]);
    const keys = [];
    for (let section = 0; section < adapted.sections.length; section++) {
        for (let row = 0; row < adapted.sections[section]; row++) {
            const outer = adapted.renderRow({ section, row });
            keys.push(outer.key);
            assert.equal(outer.children.every(cell => cell.children[0].section === section), true);
        }
    }
    assert.deepEqual(keys, ["0:0", "0:1", "2:0", "2:1", "2:2"]);
});

test("an incomplete final row keeps each present cell at exactly 1/columns width", () => {
    const adapted = adaptMemberListScrollerProps(props([5]), 3, react);
    const last = adapted.renderRow({ section: 0, row: 1 });
    assert.equal(last.children.length, 2);
    assert.deepEqual(last.children.map(cell => cell.props.style), [
        { flex: "0 0 33.333333333333336%", width: "33.333333333333336%", minWidth: 0 },
        { flex: "0 0 33.333333333333336%", width: "33.333333333333336%", minWidth: 0 }
    ]);
});

test("projected row height is the maximum constituent native height", () => {
    const numeric = adaptMemberListScrollerProps(props([5], 24), 3, react);
    assert.equal(numeric.rowHeight(0, 0), 24);
    assert.equal(numeric.rowHeight(0, 1), 24);
    const functional = adaptMemberListScrollerProps(
        props([5], (section, row) => row + section * 10 + 1),
        3,
        react
    );
    assert.equal(functional.rowHeight(0, 0), 3);
    assert.equal(functional.rowHeight(0, 1), 5);
});

test("native focus index maps original global members to projected rows before delegation", () => {
    assert.deepEqual(sectionAndLocalMemberIndex([2, 6, 2], 8), { section: 2, row: 0 });
    assert.equal(projectedGlobalRowIndex([2, 6, 2], 2, 0), 0);
    assert.equal(projectedGlobalRowIndex([2, 6, 2], 2, 2), 1);
    assert.equal(projectedGlobalRowIndex([2, 6, 2], 2, 7), 3);
    assert.equal(projectedGlobalRowIndex([2, 6, 2], 2, 8), 4);

    const calls = [];
    const native = {
        getSectionRowFromIndex(index, marker) { calls.push([index, marker]); return { index }; },
        scrollTo(index) { return index; },
        marker: "unchanged"
    };
    const proxy = createMemberListRefProxy(native, [2, 6, 2], 2);
    assert.deepEqual(proxy.getSectionRowFromIndex(8, "focus"), { index: 4 });
    assert.deepEqual(calls, [[4, "focus"]]);
    assert.equal(proxy.scrollTo, native.scrollTo);
    assert.equal(proxy.marker, "unchanged");
    assert.equal(native.getSectionRowFromIndex === proxy.getSectionRowFromIndex, false);

    let current = null;
    const lateProxy = createMemberListRefProxy(() => current, [2, 6, 2], 2);
    assert.equal(lateProxy.getSectionRowFromIndex, undefined);
    current = native;
    assert.deepEqual(lateProxy.getSectionRowFromIndex(8), { index: 4 });
});

test("helper returns exact native type for stopped, compact, OFF, malformed, and non-member paths", () => {
    const original = () => null;
    const owner = ownerProps();
    const scrollerProps = props([2, 2]);
    setMemberVirtualizerReact(react);
    setMemberCellWidth(264);
    setMembersSlotWidth(528);

    assert.equal(memberListScrollerType(original, owner), original, "stopped");
    setMemberVirtualizerActive(true);
    setMemberVirtualizerSettingReader(() => true);
    setMemberCellWidth(264);
    setMembersSlotWidth(264);
    assert.equal(memberListScrollerType(original, owner), original, "one column");
    setMembersSlotWidth(528);
    const wrapper = memberListScrollerType(original, owner);
    assert.notEqual(wrapper, original, "active guild owner props");
    assert.equal(memberListScrollerType(original, owner), wrapper, "cached wrapper");
    assert.equal(memberListScrollerType(original, { ...owner, channel: {} }), original, "group DM");
    assert.equal(memberListScrollerType(original, { ...owner, className: "members" }), original, "native panel");
    setMemberVirtualizerSettingReader(() => false);
    assert.equal(memberListScrollerType(original, owner), original, "setting OFF");
    setMemberVirtualizerSettingReader(() => true);
    assert.equal(memberListScrollerType(original, owner), wrapper, "owner has no scroller signature");

    // The owner gate is intentionally separate from ListScroller validation. The wrapper
    // returns the exact original call/props for malformed or future scroller signatures.
    const malformed = { ...scrollerProps, sections: "bad" };
    const malformedElement = wrapper.render(malformed, {});
    assert.equal(malformedElement.type, original);
    assert.equal(malformedElement.props.sections, "bad");
    const future = { ...scrollerProps, getAnchorId: () => "future" };
    const futureElement = wrapper.render(future, {});
    assert.equal(futureElement.type, original);
    assert.equal(futureElement.props.getAnchorId, future.getAnchorId);
});

test("F9 width observations retain the last real width and use native thresholds", () => {
    assert.equal(columnsForMemberWidth(0), 1);
    assert.equal(columnsForMemberWidth(527), 1);
    assert.equal(columnsForMemberWidth(528), 2);
    assert.equal(columnsForMemberWidth(791), 2);
    assert.equal(columnsForMemberWidth(792), 3);
    assert.equal(columnsForMemberWidth(5000), 3);
    assert.equal(columnsForMemberWidth(1000, false), 1);
    assert.equal(columnsForMemberWidth(Number.NaN), 1);
    setMembersSlotWidth(792);
    setMembersSlotWidth(0);
    assert.equal(getMembersSlotWidth(), 792);
});

test("F9 width commits the new column decision synchronously before its render callback", () => {
    setMemberVirtualizerSettingReader(() => true);
    setMemberCellWidth(264);
    setMembersSlotWidth(264);

    const decisions = [];
    assert.equal(commitMembersSlotWidth(560, 264, columns => {
        decisions.push({ columns, width: getMembersSlotWidth(), current: memberColumns() });
    }), 2);
    assert.deepEqual(decisions, [{ columns: 2, width: 560, current: 2 }]);

    assert.equal(commitMembersSlotWidth(840, 264, columns => {
        decisions.push({ columns, width: getMembersSlotWidth(), current: memberColumns() });
    }), 3);
    assert.deepEqual(decisions.at(-1), { columns: 3, width: 840, current: 3 });

    assert.equal(commitMembersSlotWidth(264, 264, columns => {
        decisions.push({ columns, width: getMembersSlotWidth(), current: memberColumns() });
    }), 1);
    assert.deepEqual(decisions.at(-1), { columns: 1, width: 264, current: 1 });

    setMemberVirtualizerSettingReader(() => false);
    const beforeOff = decisions.length;
    assert.equal(commitMembersSlotWidth(840, 264, () => decisions.push("unexpected")), 1);
    assert.equal(decisions.length, beforeOff, "setting OFF keeps the exact native one-column decision");
});

test("F9 measures and flushes member columns after applying the new live host width", () => {
    const source = readFileSync(new URL("../plugin/index.tsx", import.meta.url), "utf8");
    const contextBody = readFileSync(new URL("../plugin/ui/ContextTabBody.tsx", import.meta.url), "utf8");

    assert.match(
        source,
        /selectDockWidthPreset\(next\);\s*applyHostWidth\(\);\s*syncVisibleChatPortalsNow\(\);\s*commitF9MemberColumnsBeforePaint\(\);/
    );
    assert.match(
        source,
        /commitF9MemberColumnsBeforePaint[\s\S]*?getBoundingClientRect\(\)\.width[\s\S]*?commitMembersSlotWidth[\s\S]*?ReactDOM\.flushSync\(requestRender\)/
    );
    assert.match(contextBody, /new ResizeObserverType\(measure\)/);
});

test("source patch is anchored to the proven module and only replaces the ListScroller operand", () => {
    const source = readFileSync(new URL("../plugin/index.tsx", import.meta.url), "utf8");
    assert.match(source, /find: "content-inventory-hidden-entry"/);
    assert.match(source, /paddingTop:0,sectionHeight:\[\^,\]\+,rowHeight:this\\\.getRowHeightComputer/);
    assert.match(source, /replace: "\$1\$self\.memberListScrollerType\(\$2,this\.props\)"/);
    assert.match(source, /noWarn: true/);

    const fixture = 'return(0,i.jsx)(I.OZ,{role:o,"aria-label":k.intl.string(k.t["9Oq93m"]),ref:e=>{this._list=e,this.props.listRef.current=e,l.current=e?.getScrollerNode()??null},className:s()(V.ol,{[V.Ij]:u.Fr}),paddingTop:0,sectionHeight:r,rowHeight:this.getRowHeightComputer(),renderSection:this.renderSection,renderRow:this.renderRow,sections:e.map(e=>e.count),onScroll:this.handleScroll,fade:!0,...d,...a},t)';
    const replacement = canonicalizeMatch(/(\(0,\i\.\i\)\()([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?=,\{role:[^,]+,"aria-label":[\s\S]*?,ref:[\s\S]*?,className:[\s\S]*?,paddingTop:0,sectionHeight:[^,]+,rowHeight:this\.getRowHeightComputer\(\),renderSection:this\.renderSection,renderRow:this\.renderRow,sections:[^,]+\.map\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\.count\),onScroll:this\.handleScroll,fade:!0)/g);
    assert.deepEqual(fixture.match(replacement), ["(0,i.jsx)(I.OZ"], "the proven call has exactly one regex match");
    assert.equal(
        fixture.replace(replacement, "$1$self.memberListScrollerType($2,this.props)"),
        'return(0,i.jsx)($self.memberListScrollerType(I.OZ,this.props),{role:o,"aria-label":k.intl.string(k.t["9Oq93m"]),ref:e=>{this._list=e,this.props.listRef.current=e,l.current=e?.getScrollerNode()??null},className:s()(V.ol,{[V.Ij]:u.Fr}),paddingTop:0,sectionHeight:r,rowHeight:this.getRowHeightComputer(),renderSection:this.renderSection,renderRow:this.renderRow,sections:e.map(e=>e.count),onScroll:this.handleScroll,fade:!0,...d,...a},t)',
        "only the I.OZ operand is wrapped"
    );
    const contextBody = readFileSync(new URL("../plugin/ui/ContextTabBody.tsx", import.meta.url), "utf8");
    const generalPanel = readFileSync(new URL("../plugin/ui/GeneralPanel.tsx", import.meta.url), "utf8");
    assert.match(contextBody, /const columns = memberColumns\(\)/);
    assert.match(contextBody, /key: `members-\$\{columns\}`/);
    assert.match(generalPanel, /membersMultiColumn[\s\S]{0,300}requestRender/);
    assert.doesNotMatch(readFileSync(new URL("../plugin/host/slotComponents.ts", import.meta.url), "utf8"), /captureMemberScrollerDescendant|captureMemberListScrollerType/);
    assert.doesNotMatch(readFileSync(new URL("../plugin/ui/ContextTabBody.tsx", import.meta.url), "utf8"), /installMemberListVirtualizer|document\.querySelector/);
});
