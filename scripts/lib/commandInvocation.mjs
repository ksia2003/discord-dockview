const WINDOWS_CMD_TOKEN = /^[A-Za-z0-9@_./:\\=,+-]+$/;

export function quoteWindowsCmdToken(token) {
    if (typeof token !== "string" || !WINDOWS_CMD_TOKEN.test(token)) {
        throw new Error(`Unsafe Windows command token: ${JSON.stringify(token)}`);
    }
    return `"${token}"`;
}

export function pnpmInvocation(args, { platform = process.platform, env = process.env } = {}) {
    if (platform !== "win32") return { executable: "pnpm", args };
    if (!Array.isArray(args) || args.length === 0 || !WINDOWS_CMD_TOKEN.test(args[0])) {
        throw new Error(`Unsafe Windows pnpm subcommand: ${JSON.stringify(args?.[0])}`);
    }

    const executable = env.ComSpec || env.COMSPEC || "cmd.exe";
    const [subcommand, ...rest] = args;
    // pnpm.cmd treats a quoted first token as the literal command name ("add"),
    // so keep the already-validated subcommand bare. Quote every remaining inert
    // token to prevent cmd metacharacter interpretation.
    const command = `pnpm ${subcommand} ${rest.map(quoteWindowsCmdToken).join(" ")}`.trimEnd();
    return { executable, args: ["/d", "/s", "/c", command] };
}
