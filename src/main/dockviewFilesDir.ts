/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// DockView-owned runtime directory, separate from official Vencord.

import { join } from "path";

import { SESSION_DATA_DIR } from "./constants";

export const DOCKVIEW_FILES_DIR = join(SESSION_DATA_DIR, "dockviewFiles");
