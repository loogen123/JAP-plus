export function clampText(input: string, maxChars: number): string {
    if (input.length <= maxChars) return input;
    return input.slice(0, maxChars) + "...";
}

export function clampInteger(value: number, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || isNaN(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return Math.floor(value);
}

export function cleanupSummaryText(input: string): string {
    return input.replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\s+/g, " ").trim();
}

export function summarizeText(input: string): string {
    return clampText(cleanupSummaryText(input), 150);
}

export function splitRequirementBySections(requirement: string): string[] {
    const lines = requirement.split("\\n");
    const sections: string[] = [];
    let current = "";
    for (const line of lines) {
        if (line.startsWith("#")) {
            if (current.trim()) {
                sections.push(current.trim());
            }
            current = line + "\\n";
        } else {
            current += line + "\\n";
        }
    }
    if (current.trim()) {
        sections.push(current.trim());
    }
    return sections;
}
