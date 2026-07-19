/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const enum DockViewIpcEvents {
    DEPRECATED_GET_VENCORD_PRELOAD_SCRIPT_PATH = "DEPRECATED_GET_VENCORD_PRELOAD_SCRIPT_PATH",
    GET_VENCORD_FILES_DIR = "VCD_GET_VENCORD_FILES_DIR",
    SET_FIREWALL_ENABLED = "VCD_SET_FIREWALL_ENABLED",
    SET_PROXY = "VCD_SET_PROXY",
    SET_VOICE_FIX_ENABLED = "VCD_SET_VOICE_FIX_ENABLED",
    WEB_TAB_DOWNLOAD = "VCD_WEB_TAB_DOWNLOAD",
    WEB_TAB_OPEN = "VCD_WEB_TAB_OPEN"
}
