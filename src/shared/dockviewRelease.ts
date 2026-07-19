/*
 * DockView release identity shared by the Vesktop (Electron) domain.
 * Copyright (c) 2026 DockView contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `package.json.version` remains the authoritative upstream/Vesktop version.
 * DockView intentionally has separate shell and plugin versions elsewhere; this
 * module only pins the public release repository and upstream Vesktop revision.
 */

/** The GitHub repository that publishes DockView releases. */
export const DOCKVIEW_RELEASE_REPOSITORY = "ksia2003/discord-dockview";

/** The Vesktop upstream commit that package.json's Vesktop version is pinned to. */
export const DOCKVIEW_VESKTOP_COMMIT = "8a718e00785f1e17153e49c2d7ffae094e5cecef";
