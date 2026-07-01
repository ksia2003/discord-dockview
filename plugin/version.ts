/*
 * DockView — plugin version.
 * ---------------------------------------------------------------------------
 * This is the CANONICAL HOME of the running plugin version. DOCKVIEW_PLUGIN_VERSION
 * is the compiled/running patch version, bumped per patch release. The build
 * (scripts/prepare-vencord.mjs) reads this literal at build time and is the SOLE
 * writer of static/vencordDist/version.txt.
 *
 * Pure module: no side effects, no heavy/webpack imports. Keep it dependency-free
 * TypeScript so the build script can read the literal without evaluating it.
 */

/** The compiled/running plugin patch version. Bump this per patch release. */
export const DOCKVIEW_PLUGIN_VERSION = "0.1.23";
