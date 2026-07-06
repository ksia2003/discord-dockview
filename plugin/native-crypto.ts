/*
 * DockView — StegCloak-compatible message crypto (main process).
 * ---------------------------------------------------------------------------
 * The zero-width steganographic encryption used by the Privacy page's message
 * encryption. Outgoing text is AES-256-CTR encrypted, the ciphertext is encoded
 * as a run of zero-width Unicode characters, and that invisible run is embedded
 * inside a visible cover string; Discord only ever stores the cover + the hidden
 * bytes. A recipient running the same feature with a matching password reveals
 * the plaintext transparently.
 *
 * WHY HAND-ROLLED, NOT THE `stegcloak` npm PACKAGE. The published `stegcloak`
 * pulls a CLI-oriented dependency tree (clipboardy — which spawns platform
 * binaries — plus chalk/ora/inquirer/commander) and browser crypto shims
 * (browserify-cipher/crypto-browserify/pbkdf2) that are pointless in a Node main
 * bundle where node:crypto is native. So this reimplements StegCloak's algorithm
 * directly on node:crypto and keeps ONLY `lzutf8` (its LZ-UTF8 compressor) as an
 * npm dep. The byte format is deliberately identical to StegCloak's, so a message
 * this module produces reveals under the real library and vice-versa (verified
 * bidirectionally, with and without the HMAC integrity flag).
 *
 * THE FORMAT (StegCloak wire layout, per component)
 *   1. compress(plaintext)          → LZ-UTF8 bytes
 *   2. complement each byte (~b)     → the "secret" buffer
 *   3. encrypt:  salt(8) ‖ [hmac(32)] ‖ AES-256-CTR(secret)
 *        key material = PBKDF2-SHA512(password, salt, 10000, 48B) split iv(16)/key(32)
 *   4. bytes → 8-bit binary string → 2-bit groups → one of 6 zero-width chars
 *      (a leading flag char records encrypt/integrity), Huffman-compacted
 *   5. embed the zero-width run inside the cover string at a word boundary.
 *
 * This module is Node-only (node:crypto + lzutf8) and holds NO password state —
 * the renderer passes the password(s) on each call, so main stays stateless, the
 * same discipline as the rest of native.ts. Errors are thrown with StegCloak's
 * error names ("PayloadNotFoundError" / "DecryptionError" / "IntegrityError") so
 * the caller can distinguish not-cloaked / wrong-password / tampered.
 */

import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import * as lzutf8 from "lzutf8";

/** The six zero-width characters StegCloak encodes into (U+200C, U+200D, U+2061..U+2064). */
const ZWC = ["‌", "‍", "⁡", "⁢", "⁣", "⁤"];

// ── crypto core (StegCloak components/encrypt.js) ───────────────────────────

/** PBKDF2-SHA512, 10000 iterations, 48 bytes — split into a 16-byte IV + 32-byte key. */
function deriveIvKey(password: string, salt: Buffer): { iv: Buffer; key: Buffer; } {
    const ivKey = pbkdf2Sync(password, salt, 10000, 48, "sha512");
    return { iv: ivKey.subarray(0, 16), key: ivKey.subarray(16) };
}

function encryptSecret(secret: Buffer, password: string, integrity: boolean): Buffer {
    const salt = randomBytes(8);
    const { iv, key } = deriveIvKey(password, salt);
    const cipher = createCipheriv("aes-256-ctr", key, iv);
    const payload = Buffer.concat([cipher.update(secret), cipher.final()]);
    if (integrity) {
        const hmac = createHmac("sha256", key).update(secret).digest();
        return Buffer.concat([salt, hmac, payload]);
    }
    return Buffer.concat([salt, payload]);
}

function decryptSecret(data: Buffer, password: string, integrity: boolean): Buffer {
    const salt = data.subarray(0, 8);
    const cipherText = integrity ? data.subarray(40) : data.subarray(8);
    const hmacData = integrity ? data.subarray(8, 40) : null;
    const { iv, key } = deriveIvKey(password, salt);
    const decipher = createDecipheriv("aes-256-ctr", key, iv);
    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    if (integrity && hmacData) {
        const check = createHmac("sha256", key).update(decrypted).digest();
        if (check.length !== hmacData.length || !timingSafeEqual(check, hmacData)) {
            throw named("IntegrityError", "Integrity check failed (wrong password or tampered data)");
        }
    }
    return decrypted;
}

// ── compaction (StegCloak components/compact.js + util.js) ───────────────────

function compress(str: string): Buffer {
    return Buffer.from(lzutf8.compress(str, { outputEncoding: "Buffer" }) as Uint8Array);
}
function decompress(buf: Buffer): string {
    return lzutf8.decompress(buf, { inputEncoding: "Buffer", outputEncoding: "String" }) as string;
}

/** Bitwise-complement every byte (StegCloak's `compliment`). */
function complement(buf: Buffer): Buffer {
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = ~buf[i] & 0xff;
    return out;
}

function zeroPad(width: number, n: number | string): string {
    const s = String(n);
    return "0".repeat(width).slice(s.length) + s;
}
function bytesToBin(buf: Buffer): string {
    let out = "";
    for (const b of buf) out += zeroPad(8, b.toString(2));
    return out;
}
function binToBytes(str: string): Buffer {
    const arr: number[] = [];
    for (let i = 0; i < str.length; i += 8) arr.push(parseInt(str.slice(i, i + 8), 2));
    return Buffer.from(arr);
}

/** Replace each pattern[i] with replace[i] across the string, in order. */
function serialReplace(data: string, patterns: string[], replacements: string[]): string {
    for (let i = 0; i < patterns.length; i++) data = data.split(patterns[i]).join(replacements[i]);
    return data;
}

/** StegCloak's run-length ranking: pick the two zero-width chars whose doubled runs
 *  compress best, so the invisible stream shrinks. Byte-identical to the original. */
function findOptimal(secret: string, chars: string[]): string[] {
    const dict: Record<string, Record<number, number>> = {};
    for (const c of chars) dict[c] = {};
    const size = secret.length;
    for (let j = 0; j < size; j++) {
        let count = 1;
        while (j < size && secret[j] === secret[j + 1]) { count++; j++; }
        if (count >= 2) {
            let itr = count;
            while (itr >= 2) {
                dict[secret[j]][itr] = (dict[secret[j]][itr] || 0) + Math.floor(count / itr) * (itr - 1);
                itr--;
            }
        }
    }
    const ranked: [string, number][] = [];
    for (const key in dict) for (const c in dict[key]) ranked.push([key + c, dict[key][c]]);
    ranked.sort((a, b) => b[1] - a[1]);
    let req = ranked.filter(v => v[0][1] === "2").slice(0, 2).map(c => c[0][0]);
    if (req.length !== 2) {
        const diff = chars.filter(c => !req.includes(c));
        req = req.concat(diff.slice(0, 2 - req.length));
    }
    return req.slice().sort();
}

const HUFF_MAP = [
    ZWC[0] + ZWC[1], ZWC[0] + ZWC[2], ZWC[0] + ZWC[3],
    ZWC[1] + ZWC[2], ZWC[1] + ZWC[3], ZWC[2] + ZWC[3]
];
function shrink(secret: string): string {
    const rc = findOptimal(secret, ZWC.slice(0, 4));
    const flag = ZWC[HUFF_MAP.indexOf(rc[0] + rc[1])];
    return flag + serialReplace(secret, [rc[0] + rc[0], rc[1] + rc[1]], [ZWC[4], ZWC[5]]);
}
function expand(secret: string): string {
    const rc = HUFF_MAP[ZWC.indexOf(secret[0])].split("");
    return serialReplace(secret.slice(1), [ZWC[4], ZWC[5]], [rc[0] + rc[0], rc[1] + rc[1]]);
}

// ── zero-width encode/decode + cover embed (StegCloak components/message.js) ──

function dataToZwc(integrity: boolean, crypt: boolean, bin: string): string {
    const flag = integrity && crypt ? ZWC[0] : crypt ? ZWC[1] : ZWC[2];
    let out = flag;
    for (let i = 0; i < bin.length; i += 2) out += ZWC[parseInt(bin[i] + bin[i + 1], 2)];
    return out;
}
function zwcToData(str: string): { encrypt: boolean; integrity: boolean; data: Buffer; } {
    const flagIndex = ZWC.indexOf(str[0]);
    const encrypt = flagIndex === 0 || flagIndex === 1;
    const integrity = flagIndex === 0;
    let bin = "";
    for (const ch of str.slice(1)) bin += zeroPad(2, ZWC.indexOf(ch).toString(2));
    return { encrypt, integrity, data: binToBytes(bin) };
}

/** Pull the zero-width run back out of a cover string. Throws PayloadNotFoundError
 *  when the text carries no hidden stream. */
function detach(str: string): string {
    let detached = "";
    for (const word of str.split(" ")) {
        const chars = word.split("");
        if (chars.some(c => ZWC.includes(c))) {
            const limit = chars.findIndex(c => ZWC.indexOf(c) === -1);
            detached = limit === -1 ? word : word.slice(0, limit);
        }
    }
    if (!detached) throw named("PayloadNotFoundError", "No hidden data found in the message");
    return detached;
}

function embed(cover: string, secret: string): string {
    const arr = cover.split(" ");
    const target = Math.floor(Math.random() * Math.floor(arr.length / 2));
    return arr.slice(0, target + 1)
        .concat([secret + arr[target + 1]])
        .concat(arr.slice(target + 2))
        .join(" ");
}

// ── public API ──────────────────────────────────────────────────────────────

/** Whether a string carries any StegCloak zero-width character (cheap gate). */
export function isCloaked(str: string): boolean {
    for (const z of ZWC) if (str.includes(z)) return true;
    return false;
}

/** Encrypt `message` under `password`, hiding the ciphertext inside `cover`.
 *  `integrity` adds an HMAC-SHA256 tag (lets decrypt distinguish a wrong password
 *  from a tampered payload). Throws on a single-word cover. */
export function hide(message: string, password: string, cover: string, integrity = true): string {
    if (cover.split(" ").length < 2) throw new Error("Cover text needs at least two words");
    const secret = complement(compress(String(message)));
    const payload = encryptSecret(secret, password, integrity);
    const stream = shrink(dataToZwc(integrity, true, bytesToBin(payload)));
    return embed(cover, stream);
}

/** Reveal a StegCloak message with `password`. Throws PayloadNotFoundError (no
 *  hidden data), DecryptionError (wrong password, non-integrity payload garbled),
 *  or IntegrityError (right structure, HMAC mismatch). */
export function reveal(cloaked: string, password: string): string {
    const { data, integrity, encrypt } = zwcToData(expand(detach(cloaked)));
    if (!encrypt) throw named("DecryptionError", "Message is not encrypted");
    let decrypted: Buffer;
    try {
        decrypted = decryptSecret(data, password, integrity);
    } catch (e) {
        if ((e as Error).name === "IntegrityError") throw e;
        throw named("DecryptionError", "Wrong password or corrupted payload");
    }
    try {
        return decompress(complement(decrypted));
    } catch {
        // A wrong password on a non-integrity payload decrypts to garbage that the
        // LZ-UTF8 stage can't parse — surface it as a decryption failure, not a crash.
        throw named("DecryptionError", "Wrong password or corrupted payload");
    }
}

/** Build an Error with a specific `.name` (StegCloak's error taxonomy). */
function named(name: string, message: string): Error {
    const err = new Error(message);
    err.name = name;
    return err;
}
