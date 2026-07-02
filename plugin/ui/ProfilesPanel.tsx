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
 *  Open / Delete actions. Delete is a two-click confirm (label flips first click). */
function ProfileRow(props: {
    profile: ProfileInfo;
    busy: boolean;
    confirming: boolean;
    onOpen: (name: string) => void;
    onAskDelete: (name: string) => void;
    onConfirmDelete: (name: string) => void;
    onCancelDelete: () => void;
}) {
    const { profile, busy, confirming, onOpen, onAskDelete, onConfirmDelete, onCancelDelete } = props;
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
        // Open — disabled for the profile already running here (it IS this window).
        h(
            Button,
            {
                size: Button.Sizes.SMALL,
                color: Button.Colors.PRIMARY,
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
        profiles.length === 0
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
