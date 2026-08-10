/* Original-byte image actions shared by the viewer menu and its context fallback. */

import { dvFetch } from "../../engine/fetch";
import { downloadUrl } from "../../external/openExternal";

export async function originalImageBlob(url: string): Promise<Blob> {
    const response = await dvFetch(url);
    if (!response.ok) throw new Error(String(response.status));
    return response.blob();
}

/** Write the source blob with its original MIME. Do not canvas-transcode the image. */
export async function copyOriginalImage(url: string): Promise<void> {
    try {
        const blob = await originalImageBlob(url);
        const ClipboardItemType = (globalThis as any).ClipboardItem;
        if (!ClipboardItemType || !navigator.clipboard?.write) return;
        await navigator.clipboard.write([new ClipboardItemType({ [blob.type || "image/png"]: blob })]);
    } catch {
        /* Clipboard support/permission differs by platform; keep the fallback silent. */
    }
}

export function saveOriginalImage(url: string, name: string | null): void {
    downloadUrl(url, name);
}
