/*
 * Pure tab-label layout helpers.
 *
 * CSS cannot produce a true middle ellipsis from one text node while preserving the
 * filename suffix. Split long labels into a flexible beginning and a fixed tail: when
 * space runs out only the beginning ellipsises, so the end of the stem and extension
 * remain visible. Short labels stay a single node and render untouched.
 */

export interface MiddleLabelParts {
    start: string;
    end: string;
}

const MIN_START_CODEPOINTS = 6;
const DEFAULT_TAIL_CODEPOINTS = 8;
const MAX_EXTENSION_CODEPOINTS = 10;

export function middleLabelParts(label: string): MiddleLabelParts | null {
    const chars = Array.from(label);
    if (chars.length < MIN_START_CODEPOINTS + DEFAULT_TAIL_CODEPOINTS + 2) return null;

    const dot = chars.lastIndexOf(".");
    const extensionLength = dot > 0 ? chars.length - dot : 0;
    const usefulExtension = extensionLength > 1 && extensionLength <= MAX_EXTENSION_CODEPOINTS;
    const desiredTail = usefulExtension
        ? Math.max(DEFAULT_TAIL_CODEPOINTS, extensionLength + 5)
        : DEFAULT_TAIL_CODEPOINTS;
    const tailLength = Math.min(desiredTail, chars.length - MIN_START_CODEPOINTS);

    return {
        start: chars.slice(0, -tailLength).join(""),
        end: chars.slice(-tailLength).join("")
    };
}
