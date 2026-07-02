/*
 * DockView — the "Profiles" settings page (renderer).
 * ---------------------------------------------------------------------------
 * Multi-account: each PROFILE is a fully separate data directory — its own Discord
 * login, its own Vencord/DockView settings, its own window/process. Opening a profile
 * spawns another instance of the app pointed at that directory (--profile=<name>); the
 * spawned instance shows a clean login. There's no token handling and no shared session,
 * so the settings/session collisions the shared-data clients hit are impossible here.
 *
 * This page shows the current profile, lists the profiles (Open / Delete each), and
 * offers a name input + "Create & open". It drives the native side (plugin/native.ts:
 * listProfiles / createProfile / openProfile / deleteProfile) through the same
 * VencordNative.pluginHelpers.DockView bridge UpdatePanel uses. Every native access is
 * guarded and degrades to an honest "unavailable" line (web builds have no bridge).
 *
 * GRAMMAR — mirrors UpdatePanel.tsx: deferred `h` (no module-top webpack), @webpack/common
 * primitives, semantic CSS variables only, sober settings-page voice. The page header
 * ("Profiles") comes from the sidebar row's panel title, so it isn't repeated. Delete is a
 * two-click "Delete → Confirm delete" affordance (no separate modal): the button re-labels
 * on first click and only deletes on the second, so an accidental click is recoverable.
 */

import { Button, Forms, React, Text, TextInput } from "@webpack/common";

import { STRINGS } from "../strings";

const h = (...args: any[]) => (React.createElement as any)(...args);

const P = STRINGS.profiles;

/** The value switchProfile takes to mean "the default (unnamed) install". Kept in
 *  sync with native-profiles.ts DEFAULT_SENTINEL (renderer can't import a main module),
 *  and picked so it can never collide with a real profile name (leading "@"). */
const DEFAULT_SENTINEL = "@default";

/** One profile as reported by native.listProfiles. */
interface ProfileInfo {
    name: string;
    active: boolean;
}
interface ProfilesList {
    profiles: ProfileInfo[];
    current: string | null;
    root: string;
}

/** The subset of native.ts (main) this page calls, via the pluginHelpers bridge. */
interface ProfilesNative {
    listProfiles: () => Promise<ProfilesList>;
    createProfile: (name: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
    openProfile: (name: string, extraArgs?: string[]) => Promise<{ ok: boolean; error?: string }>;
    switchProfile: (name: string) => Promise<{ ok: boolean; error?: string }>;
    deleteProfile: (name: string) => Promise<{ ok: boolean; error?: string }>;
}

/** Resolve the native bridge, or null if this build doesn't expose it. Mirrors
 *  UpdatePanel.getNative: verify each function is callable before trusting it. */
function getNative(): ProfilesNative | null {
    try {
        const n = (window as any).VencordNative?.pluginHelpers?.DockView;
        if (
            n &&
            typeof n.listProfiles === "function" &&
            typeof n.createProfile === "function" &&
            typeof n.openProfile === "function" &&
            typeof n.switchProfile === "function" &&
            typeof n.deleteProfile === "function"
        ) {
            return n as ProfilesNative;
        }
    } catch {
        /* fall through to unavailable */
    }
    return null;
}

/** One profile row: the name (with a "current" badge when it's this instance), and
 *  Switch / Open / Delete actions. Switch is the PRIMARY action (replace this window
 *  with the profile — one window); Open is the second-window power path. Both are
 *  disabled for the profile already running here. Delete is a two-click confirm (label
 *  flips first click). */
function ProfileRow(props: {
    profile: ProfileInfo;
    busy: boolean;
    confirming: boolean;
    onSwitch: (name: string) => void;
    onOpen: (name: string) => void;
    onAskDelete: (name: string) => void;
    onConfirmDelete: (name: string) => void;
    onCancelDelete: () => void;
}) {
    const { profile, busy, confirming, onSwitch, onOpen, onAskDelete, onConfirmDelete, onCancelDelete } = props;
    return h(
        "div",
        {
            style: {
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 0",
                borderTop: "1px solid var(--background-modifier-accent)"
            }
        },
        h(
            "div",
            { style: { flex: "1 1 auto", minWidth: 0 } },
            h(
                Text,
                {
                    variant: "text-md/medium",
                    style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                },
                profile.name
            ),
            profile.active &&
                h(
                    Text,
                    { variant: "text-xs/normal", style: { color: "var(--text-muted)" } },
                    P.currentBadge
                )
        ),
        // Switch — the primary action: replace THIS window with the profile (one window).
        // Disabled for the profile already running here (switching to yourself is a no-op).
        h(
            Button,
            {
                size: Button.Sizes.SMALL,
                color: Button.Colors.BRAND,
                disabled: busy || profile.active,
                onClick: () => onSwitch(profile.name)
            },
            P.switch
        ),
        // Open — a SECOND window beside this one (power path). Disabled for the running one.
        h(
            Button,
            {
                size: Button.Sizes.SMALL,
                color: Button.Colors.PRIMARY,
                look: Button.Looks.LINK,
                disabled: busy || profile.active,
                onClick: () => onOpen(profile.name)
            },
            P.open
        ),
        // Delete — two-click. First click asks (label flips); second confirms. The
        // running profile can't be deleted (native also refuses), so hide Delete there.
        !profile.active &&
            (confirming
                ? h(
                      "div",
                      { style: { display: "flex", gap: "6px" } },
                      h(
                          Button,
                          {
                              size: Button.Sizes.SMALL,
                              color: Button.Colors.RED,
                              disabled: busy,
                              onClick: () => onConfirmDelete(profile.name)
                          },
                          P.confirmDelete
                      ),
                      h(
                          Button,
                          {
                              size: Button.Sizes.SMALL,
                              color: Button.Colors.PRIMARY,
                              look: Button.Looks.LINK,
                              disabled: busy,
                              onClick: onCancelDelete
                          },
                          P.cancel
                      )
                  )
                : h(
                      Button,
                      {
                          size: Button.Sizes.SMALL,
                          color: Button.Colors.PRIMARY,
                          look: Button.Looks.LINK,
                          disabled: busy,
                          onClick: () => onAskDelete(profile.name)
                      },
                      P.delete
                  ))
    );
}

export function ProfilesPanel() {
    const { useState, useEffect, useCallback } = React;

    const native = getNative();

    const [list, setList] = useState<ProfilesList | null>(null);
    const [newName, setNewName] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    // The profile name whose Delete is armed (awaiting the confirm click), or null.
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!native) return;
        try {
            const l = await native.listProfiles();
            setList(l);
        } catch (err) {
            setStatus(P.error((err as Error)?.message ?? String(err)));
        }
    }, [native]);

    useEffect(() => {
        refresh();
    }, []);

    const onOpen = useCallback(
        async (name: string) => {
            if (!native) return;
            setBusy(true);
            setStatus(null);
            try {
                const res = await native.openProfile(name);
                setStatus(res.ok ? P.opened(name) : P.error(res.error ?? "unknown error"));
            } catch (err) {
                setStatus(P.error((err as Error)?.message ?? String(err)));
            } finally {
                setBusy(false);
            }
        },
        [native]
    );

    // Switch THIS window to another profile. On success the native side spawns the
    // target and quits us after a short grace, so this window is about to close — we
    // stay "busy" (no finally-clears-busy) and show a "Switching…" line until then.
    // `target` is a profile name, or DEFAULT_SENTINEL for the default install.
    const onSwitch = useCallback(
        async (target: string, label: string) => {
            if (!native) return;
            setBusy(true);
            setStatus(P.switching(label));
            try {
                const res = await native.switchProfile(target);
                if (!res.ok) {
                    setStatus(P.error(res.error ?? "unknown error"));
                    setBusy(false);
                }
                // On success we do NOT clear busy: the process is quitting momentarily.
            } catch (err) {
                setStatus(P.error((err as Error)?.message ?? String(err)));
                setBusy(false);
            }
        },
        [native]
    );

    const onCreateAndOpen = useCallback(async () => {
        if (!native) return;
        const name = newName.trim();
        setBusy(true);
        setStatus(null);
        try {
            const created = await native.createProfile(name);
            if (!created.ok) {
                setStatus(P.error(created.error ?? "unknown error"));
                return;
            }
            setNewName("");
            await refresh();
            const opened = await native.openProfile(created.name ?? name);
            setStatus(opened.ok ? P.opened(created.name ?? name) : P.error(opened.error ?? "unknown error"));
        } catch (err) {
            setStatus(P.error((err as Error)?.message ?? String(err)));
        } finally {
            setBusy(false);
        }
    }, [native, newName, refresh]);

    const onConfirmDelete = useCallback(
        async (name: string) => {
            if (!native) return;
            setBusy(true);
            setStatus(null);
            setConfirmDelete(null);
            try {
                const res = await native.deleteProfile(name);
                if (res.ok) {
                    setStatus(P.deleted(name));
                    await refresh();
                } else {
                    setStatus(P.error(res.error ?? "unknown error"));
                }
            } catch (err) {
                setStatus(P.error((err as Error)?.message ?? String(err)));
            } finally {
                setBusy(false);
            }
        },
        [native, refresh]
    );

    // --- bridge missing entirely → a single sober fallback line. ------------
    if (!native) {
        return h(
            "div",
            null,
            h(Forms.FormText, { style: { color: "var(--text-muted)" } }, P.unavailable)
        );
    }

    const current = list?.current ?? null;
    const profiles = list?.profiles ?? [];

    return h(
        "div",
        null,
        h(Forms.FormText, { style: { marginBottom: "8px", color: "var(--text-muted)" } }, P.intro),

        // Current profile indicator.
        h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", gap: "12px", margin: "8px 0 4px" } },
            h(Text, { variant: "text-sm/normal", style: { color: "var(--text-muted)" } }, P.currentLabel),
            h(Text, { variant: "text-sm/medium" }, current ?? P.defaultName)
        ),

        // Profile list.
        h(Forms.FormTitle, { tag: "h3", style: { marginTop: "16px" } }, P.listTitle),
        // A "Default" row appears only while running a named profile — Switch back to the
        // default install without opening a second window. (When already on Default, this
        // window IS the default, so there's nothing to switch to.)
        current !== null &&
            h(
                "div",
                {
                    style: {
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px 0",
                        borderTop: "1px solid var(--background-modifier-accent)"
                    }
                },
                h(
                    "div",
                    { style: { flex: "1 1 auto", minWidth: 0 } },
                    h(Text, { variant: "text-md/medium" }, P.defaultName)
                ),
                h(
                    Button,
                    {
                        size: Button.Sizes.SMALL,
                        color: Button.Colors.BRAND,
                        disabled: busy,
                        onClick: () => onSwitch(DEFAULT_SENTINEL, P.defaultName)
                    },
                    P.switch
                )
            ),
        profiles.length === 0 && current === null
            ? h(Forms.FormText, { style: { color: "var(--text-muted)", padding: "4px 0" } }, P.none)
            : h(
                  "div",
                  { style: { margin: "4px 0" } },
                  profiles.map(pf =>
                      h(ProfileRow, {
                          key: pf.name,
                          profile: pf,
                          busy,
                          confirming: confirmDelete === pf.name,
                          onSwitch: (n: string) => onSwitch(n, n),
                          onOpen,
                          onAskDelete: (n: string) => setConfirmDelete(n),
                          onConfirmDelete,
                          onCancelDelete: () => setConfirmDelete(null)
                      })
                  )
              ),

        h(Forms.FormDivider, { style: { margin: "16px 0" } }),

        // New profile.
        h(Forms.FormTitle, { tag: "h3" }, P.newTitle),
        h(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "6px" } },
            h(
                "div",
                { style: { flex: "1 1 auto" } },
                h(TextInput, {
                    value: newName,
                    placeholder: P.namePlaceholder,
                    maxLength: 32,
                    disabled: busy,
                    onChange: (v: string) => setNewName(v),
                    onKeyDown: (e: any) => {
                        if (e?.key === "Enter" && newName.trim() && !busy) onCreateAndOpen();
                    }
                })
            ),
            h(
                Button,
                {
                    size: Button.Sizes.SMALL,
                    color: Button.Colors.BRAND,
                    disabled: busy || !newName.trim(),
                    onClick: onCreateAndOpen
                },
                busy ? P.working : P.createOpen
            )
        ),

        // Honest note: each profile is a separate login + its own window/process.
        h(
            Forms.FormText,
            { style: { marginTop: "12px", color: "var(--text-muted)" } },
            P.note
        ),

        // Status line (last action result), when set.
        status &&
            h(
                Text,
                {
                    variant: "text-sm/normal",
                    style: { display: "block", marginTop: "10px", color: "var(--text-muted)" }
                },
                status
            )
    );
}
