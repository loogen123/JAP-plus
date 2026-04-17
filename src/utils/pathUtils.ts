import path from "path";

export function resolveWorkspacePath(input: unknown): string {
    if (typeof input !== "string") {
        throw new Error("workspacePath is required and must be a string");
    }
    const resolved = path.resolve(input);
    return resolved;
}

export function resolveOutputPath(input: unknown): string {
    if (typeof input !== "string") {
        throw new Error("outputPath is required and must be a string");
    }
    const resolved = path.resolve(input);
    return resolved;
}

export function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
    const relative = path.relative(workspacePath, targetPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function ensureInsideWorkspace(workspacePath: string, targetPath: string): string {
    if (!isInsideWorkspace(workspacePath, targetPath)) {
        throw new Error(`Path ${targetPath} is not inside workspace ${workspacePath}`);
    }
    return targetPath;
}

export function toWorkspaceRelativePath(workspacePath: string, targetPath: string): string {
    return path.relative(workspacePath, targetPath);
}
