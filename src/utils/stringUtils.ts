export function clampText(input: string, maxChars: number): string {
    if (input.length <= maxChars) return input;
    return `${input.slice(0, maxChars)}\n\n[truncated]`;
}

export function clampInteger(value: number, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || isNaN(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return Math.floor(value);
}

export function cleanupSummaryText(input: string): string {
    return input.replace(/\s+/g, " ").trim();
}

export function summarizeText(input: string): string {
    const cleaned = cleanupSummaryText(input);
    if (cleaned.length <= 240) return cleaned;
    return `${cleaned.slice(0, 140)} ... ${cleaned.slice(-80)}`;
}

export function splitRequirementBySections(requirement: string): string[] {
    const normalized = requirement.trim();
    if (!normalized) return [];
    const maxContextChars = 10000;
    const chunks = normalized
        .split(/\n(?=#{1,3}\s)|\n{2,}/g)
        .map((item) => item.trim())
        .filter(Boolean);
    if (chunks.length <= 1) return [normalized.slice(0, maxContextChars)];
    const merged: string[] = [];
    let bucket = "";
    for (const chunk of chunks) {
        if ((bucket + "\n\n" + chunk).length > maxContextChars && bucket) {
            merged.push(bucket);
            bucket = chunk;
        } else {
            bucket = bucket ? `${bucket}\n\n${chunk}` : chunk;
        }
    }
    if (bucket) merged.push(bucket);
    return merged.slice(0, 6);
}
