const WINDOWS_CMD_TOKEN = /^[A-Za-z0-9@_./:\\=,+-]+$/;

function validateWindowsCmdToken(token) {
    if (typeof token !== "string" || !WINDOWS_CMD_TOKEN.test(token)) {
        throw new Error(`Unsafe Windows command token: ${JSON.stringify(token)}`);
    }
    return token;
}

export function quoteWindowsCmdToken(token) {
    return `"${validateWindowsCmdToken(token)}"`;
}

export function pnpmInvocation(args, { platform = process.platform, env = process.env } = {}) {
    if (platform !== "win32") return { executable: "pnpm", args };
    if (!Array.isArray(args) || args.length === 0) {
        throw new Error(`Unsafe Windows pnpm subcommand: ${JSON.stringify(args?.[0])}`);
    }

    const executable = env.ComSpec || env.COMSPEC || "cmd.exe";
    // pnpm.cmd preserves literal quote characters from %*, so quoted tokens become
    // package specs such as `"-w"`. Validate every token against a no-whitespace,
    // no-metacharacter allowlist and then pass the inert tokens unquoted.
    const command = `pnpm ${args.map(validateWindowsCmdToken).join(" ")}`;
    return { executable, args: ["/d", "/s", "/c", command] };
}
