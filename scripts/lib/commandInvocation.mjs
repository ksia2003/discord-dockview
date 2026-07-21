const WINDOWS_CMD_TOKEN = /^[A-Za-z0-9@_./:\\=,+-]+$/;

export function quoteWindowsCmdToken(token) {
    if (typeof token !== "string" || !WINDOWS_CMD_TOKEN.test(token)) {
        throw new Error(`Unsafe Windows command token: ${JSON.stringify(token)}`);
    }
    return `"${token}"`;
}

export function pnpmInvocation(args, { platform = process.platform, env = process.env } = {}) {
    if (platform !== "win32") return { executable: "pnpm", args };

    const executable = env.ComSpec || env.COMSPEC || "cmd.exe";
    const command = `pnpm ${args.map(quoteWindowsCmdToken).join(" ")}`;
    return { executable, args: ["/d", "/s", "/c", command] };
}
