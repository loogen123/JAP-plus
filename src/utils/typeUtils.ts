export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) return false;
    for (const key in value) {
        if (typeof value[key] !== "string") {
            return false;
        }
    }
    return true;
}

export function isStringOrStringArrayRecord(value: unknown): value is Record<string, string | string[]> {
    if (!isRecord(value)) return false;
    for (const key in value) {
        const v = value[key];
        if (typeof v === "string") continue;
        if (Array.isArray(v) && v.every((item) => typeof item === "string")) continue;
        return false;
    }
    return true;
}
