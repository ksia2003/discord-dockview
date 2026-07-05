/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { join } from "path";

import { BASE_SESSION_DATA_DIR } from "./constants";
import { State } from "./settings";

// this is in a separate file to avoid circular dependencies
//
// The plugin files are shared CODE: every account profile must run the SAME plugin
// version, so an in-app OTA update applied under one account covers them all. Hence
// this resolves to the profile-INDEPENDENT base (BASE_SESSION_DATA_DIR) rather than
// the per-profile SESSION_DATA_DIR — otherwise updating account A would leave account
// B on the stale bundled plugin. Only settings/session stay per profile.
//
// For the default no-profile install, BASE_SESSION_DATA_DIR === the old
// SESSION_DATA_DIR, so this is byte-identical to before (no migration). An explicit
// State.store.vencordDir (a user-chosen custom dir) still wins unchanged.
export const VENCORD_FILES_DIR = State.store.vencordDir || join(BASE_SESSION_DATA_DIR, "vencordFiles");
