import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb } from './db';
import { getIgnorer } from './ignore';
import { isPathInsideRepo } from '../repository/paths';

function hashFile(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

export function getStatus(repoRoot: string) {
    const ig = getIgnorer(repoRoot);
    const existingFiles = new Map<string, string>();
    
    // Read-only connection; will return null if no DB exists
    const db = getDb(repoRoot, { readonly: true });
    
    if (db) {
        db.prepare("SELECT path, hash FROM files").all().forEach((row: any) => {
            existingFiles.set(row.path, row.hash);
        });
        db.close(); // Close immediately after read
    }

    const currentFiles = new Set<string>();
    const added: string[] = [];
    const modified: string[] = [];

    function traverse(currentPath: string) {
        if (!fs.existsSync(currentPath)) return;
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
            
            if (ig.ignores(relPath)) continue;

            const lstat = fs.lstatSync(fullPath);
            if (lstat.isSymbolicLink() && !isPathInsideRepo(repoRoot, fullPath)) continue;
            if (!lstat.isSymbolicLink() && !isPathInsideRepo(repoRoot, fullPath)) continue;

            if (entry.isDirectory()) {
                traverse(fullPath);
            } else {
                currentFiles.add(relPath);
                const currentHash = hashFile(fullPath);
                const existingHash = existingFiles.get(relPath);

                if (!existingHash) added.push(relPath);
                else if (existingHash !== currentHash) modified.push(relPath);
            }
        }
    }

    traverse(repoRoot);

    const deleted = Array.from(existingFiles.keys()).filter(oldFile => !currentFiles.has(oldFile));

    return { 
        added: added.sort(), 
        modified: modified.sort(), 
        deleted: deleted.sort(),
        isUnindexed: db === null
    };
}