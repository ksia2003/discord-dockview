import assert from "node:assert/strict";
import test from "node:test";

import { middleLabelParts } from "../plugin/ui/tabLabels.ts";

test("short tab labels render untouched", () => {
    assert.equal(middleLabelParts("notes.md"), null);
    assert.equal(middleLabelParts("채널 정보"), null);
});

test("long filenames preserve the end of the stem and extension", () => {
    const parts = middleLabelParts("project-overview-final.html");
    assert.ok(parts);
    assert.equal(parts.start + parts.end, "project-overview-final.html");
    assert.match(parts.end, /final\.html$/);
    assert.ok(Array.from(parts.start).length >= 6);
});

test("long extensionless and unicode labels split without corrupting code points", () => {
    const plain = middleLabelParts("a-very-long-extensionless-title");
    assert.ok(plain);
    assert.equal(plain.start + plain.end, "a-very-long-extensionless-title");

    const unicode = middleLabelParts("실험-결과-🧪-최종-보고서-완성본.md");
    assert.ok(unicode);
    assert.equal(unicode.start + unicode.end, "실험-결과-🧪-최종-보고서-완성본.md");
    assert.equal(unicode.start.includes("�") || unicode.end.includes("�"), false);
});
