/*
 * DockView — encrypted-at-rest secret storage (main process).
 * ---------------------------------------------------------------------------
 * The message-encryption passwords must NEVER sit in plaintext in the Vencord
 * settings store (that JSON is world-readable on disk). Instead the password list
 * is serialised, encrypted with Electron's safeStorage (the OS keychain / DPAPI /
 * libsecret, keyed to the user account), and written as an opaque blob next to the
 * app's data. The renderer only ever holds the decrypted list in memory for the
 * lifetime it needs it, and asks main to persist a new list.
 *
 * WHY safeStorage. It ties the ciphertext to the logged-in OS user via the
 * platform keystore, so copying the blob to another machine/account yields nothing.
 * When the platform has no backend available (a headless Linux with no keyring),
 * safeStorage.isEncryptionAvailable() is false; we then refuse to write rather than
 * silently storing plaintext, and report that to the renderer so the UI can explain
 * it. (The message-encryption feature simply stays password-less in that case —
 * default-off, no risk.)
 *
 * NO ELECTRON IMPORT AT MODULE TOP. Like native-profiles.ts, this reaches
 * safeStorage/app via a runtime require("electron") behind a local type, so the
 * build's dep scanner (which turns `import ... from "X"` into an npm dep to bundle)
 * never treats "electron" as an external package the Vencord clone must install.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/** The blob file lives in the same user-data dir the profile/app data uses. */
const SECRETS_FILE = "dockview-secrets.bin";

/** Minimal shape of the Electron bits we touch (avoids an `electron` import). */
interface ElectronSafeStorage {
    isEncryptionAvailable(): boolean;
    encryptString(plaintext: string): Buffer;
    decryptString(encrypted: Buffer): string;
}
interface ElectronApp { getPath(name: string): string; }

function electron(): { safeStorage: ElectronSafeStorage; app: ElectronApp; } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("electron");
}

/** The directory the encrypted blob is written into: the env-pinned Vencord data
 *  dir when set (matches the running profile), else the platform's app-data path. */
function dataDir(): string {
    const env = process.env.VENCORD_USER_DATA_DIR;
    if (env) return env;
    try {
        return electron().app.getPath("userData");
    } catch {
        // Extremely defensive: if app isn't ready for some reason, fall back to a
        // conventional per-OS app-data location so we still write somewhere sane.
        const home = homedir();
        if (process.platform === "win32") return process.env.APPDATA || join(home, "AppData", "Roaming");
        if (process.platform === "darwin") return join(home, "Library", "Application Support");
        return process.env.XDG_CONFIG_HOME || join(home, ".config");
    }
}

function blobPath(): string {
    return join(dataDir(), SECRETS_FILE);
}

/** Persist a list of passwords, encrypted with safeStorage. Returns { ok } or a
 *  structured error. An empty list is written as an empty encrypted blob (a valid
 *  "no passwords" state), so a user clearing all passwords is honoured. */
export async function savePasswordsImpl(passwords: string[]): Promise<{ ok: boolean; error?: string; }> {
    const list = Array.isArray(passwords) ? passwords.filter(p => typeof p === "string") : [];
    let safe: ElectronSafeStorage;
    try {
        safe = electron().safeStorage;
    } catch {
        return { ok: false, error: "Secure storage is unavailable in this environment" };
    }
    if (!safe.isEncryptionAvailable()) {
        return { ok: false, error: "The OS keychain is unavailable, so passwords can't be stored securely" };
    }
    try {
        const encrypted = safe.encryptString(JSON.stringify(list));
        await mkdir(dataDir(), { recursive: true });
        await writeFile(blobPath(), encrypted);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `Could not save passwords: ${(err as Error)?.message ?? err}` };
    }
}

/** Load + decrypt the stored password list. A missing blob is the normal empty
 *  state (returns []); a decrypt failure (blob from another user/machine) also
 *  returns [] rather than throwing — the feature just has no usable passwords. */
export async function loadPasswordsImpl(): Promise<string[]> {
    let encrypted: Buffer;
    try {
        encrypted = await readFile(blobPath());
    } catch {
        return []; // no blob yet
    }
    try {
        const safe = electron().safeStorage;
        if (!safe.isEncryptionAvailable()) return [];
        const json = safe.decryptString(encrypted);
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter(p => typeof p === "string") : [];
    } catch {
        return [];
    }
}
