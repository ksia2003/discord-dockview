/*
 * DockView renderer → main runtime bridge.
 *
 * Runtime ABI v1 exposes one generic `invoke(method, ...args)` entry. The named
 * methods remain as a compatibility fallback for Vesktop shells through 0.1.47,
 * so a DockView-only update can cross the ABI transition without first requiring
 * an app reinstall.
 */

type DockViewBridge = {
    invoke?: (method: string, ...args: unknown[]) => Promise<unknown>;
    [method: string]: unknown;
};

function getBridge(): DockViewBridge | null {
    try {
        return (window as any).VesktopNative?.dockview ?? null;
    } catch {
        return null;
    }
}

export function hasNativeMethod(method: string): boolean {
    const bridge = getBridge();
    return !!bridge && (typeof bridge.invoke === "function" || typeof bridge[method] === "function");
}

export async function invokeNative<T>(method: string, ...args: unknown[]): Promise<T> {
    const bridge = getBridge();
    if (!bridge) throw new Error(`DockView: native bridge unavailable for ${method}`);

    if (typeof bridge.invoke === "function") {
        return bridge.invoke(method, ...args) as Promise<T>;
    }

    const legacy = bridge[method];
    if (typeof legacy === "function") {
        return (legacy as (...values: unknown[]) => Promise<T>)(...args);
    }

    throw new Error(`DockView: native method unavailable: ${method}`);
}
