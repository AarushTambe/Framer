import fs from 'fs';
import path from 'path';

export function isPathInsideRepo(repoRoot: string, targetPath: string): boolean {
    try {
        const resolvedTarget = fs.realpathSync(targetPath);
        const resolvedRoot = fs.realpathSync(repoRoot);
        const relative = path.relative(resolvedRoot, resolvedTarget);
        
        // If it evaluates to '..' or starts with '../' (or '..\' on Windows), or is an absolute path, it is outside.
        return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
    } catch (e) {
        // Missing files or broken symlinks cannot be evaluated securely, assume outside.
        return false;
    }
}

export function validateSafePath(repoRoot: string, requestedPath: string): string {
    const resolvedPath = path.resolve(repoRoot, requestedPath);
    if (!isPathInsideRepo(repoRoot, resolvedPath)) {
        throw new Error(`Security Violation: Path traversal blocked. Cannot access ${requestedPath}`);
    }
    return resolvedPath;
}