import fs from "fs/promises";
import path from "path";

export async function ensureDirectoryWritable(dirPath: string): Promise<void> {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        await fs.access(dirPath, fs.constants.W_OK);
    } catch (err: any) {
        throw new Error(`Directory is not writable: ${dirPath}. Details: ${err.message}`);
    }
}

export async function listDirectoryNames(dirPath: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort();
    } catch {
        return [];
    }
}

export async function listFileNames(dirPath: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries
            .filter(e => e.isFile())
            .map(e => e.name)
            .sort();
    } catch {
        return [];
    }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
