/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ipcMain } from "electron";

import { validateSender } from "./utils/ipcWrappers";
import { getVencordUpdates } from "./utils/vencordUpdateCheck";
import { VENCORD_FILES_DIR } from "./vencordFilesDir";

const GET_UPDATES = "VencordGetUpdates";

function serialize<T>(fn: () => T | Promise<T>) {
    return async () => {
        try {
            return { ok: true as const, value: await fn() };
        } catch (error) {
            const value = error instanceof Error ? error : new Error(String(error));
            return {
                ok: false as const,
                error: {
                    ...value,
                    message: value.message,
                    name: value.name,
                    stack: value.stack
                }
            };
        }
    };
}

/**
 * Vencord owns the renderer UI and the update/apply handlers. Vesktop replaces
 * only the standalone check handler so checks stay read-only and use the
 * installed on-disk revision.
 */
export function installVencordUpdaterBridge(): void {
    const handler = serialize(() => getVencordUpdates(VENCORD_FILES_DIR));
    ipcMain.removeHandler(GET_UPDATES);
    ipcMain.handle(GET_UPDATES, invokeEvent => {
        validateSender(invokeEvent.senderFrame, GET_UPDATES);
        return handler();
    });
}
