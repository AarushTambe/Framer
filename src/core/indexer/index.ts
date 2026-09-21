import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from './db';
import { getIgnorer } from './ignore';
import { isPathInsideRepo } from '../repository/paths';

function hashFile(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

export function runIndex(repoRoot: string) {
    const db = getDb(repoRoot);
    if (!db) throw new Error("Could not initialize DB.");
    
    const ig = getIgnorer(repoRoot);

    interface FileMeta { hash: string, last_modified: number, size: number }
    const existingFiles = new Map<string, FileMeta>();
    db.prepare("SELECT path, hash, last_modified, size FROM files").all().forEach((row: any) => {
        existingFiles.set(row.path, { hash: row.hash, last_modified: row.last_modified, size: row.size });
    });

    const currentFiles = new Set<string>();
    const toInsert: {relPath: string, hash: string, stat: fs.Stats, fullPath: string}[] = [];
    const toUpdateMeta: {relPath: string, stat: fs.Stats}[] = [];
    const toDelete: string[] = [];

    function traverse(currentPath: string) {
        if (!fs.existsSync(currentPath)) return;
        
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
            
            // Ignores
            if (ig.ignores(relPath)) continue;

            // Strict Repository Boundary Validation (handles symlinks)
            const lstat = fs.lstatSync(fullPath);
            if (lstat.isSymbolicLink()) {
                if (!isPathInsideRepo(repoRoot, fullPath)) {
                    console.warn(`Warning: Skipping symlink pointing outside repository: ${fullPath}`);
                    continue;
                }
            } else if (!isPathInsideRepo(repoRoot, fullPath)) {
                console.warn(`Warning: Skipping path outside repository boundary: ${fullPath}`);
                continue;
            }

            if (entry.isDirectory()) {
                traverse(fullPath);
            } else {
                currentFiles.add(relPath);
                
                // Actual file processing
                const realStat = fs.statSync(fullPath);
                const currentHash = hashFile(fullPath);
                const existing = existingFiles.get(relPath);

                if (!existing) {
                    // New file
                    toInsert.push({ relPath, hash: currentHash, stat: realStat, fullPath });
                } else if (existing.hash !== currentHash) {
                    // Hash changed -> Delete old, insert new
                    toDelete.push(relPath);
                    toInsert.push({ relPath, hash: currentHash, stat: realStat, fullPath });
                } else if (existing.last_modified !== realStat.mtimeMs || existing.size !== realStat.size) {
                    // Hash unchanged, metadata changed -> Update metadata only
                    toUpdateMeta.push({ relPath, stat: realStat });
                }
            }
        }
    }

    traverse(repoRoot);

    // Prune deleted files
    for (const oldFile of existingFiles.keys()) {
        if (!currentFiles.has(oldFile)) {
            toDelete.push(oldFile);
        }
    }

    const updateTx = db.transaction(() => {
        const deleteChunks = db.prepare("DELETE FROM chunks WHERE path = ?");
        const deleteFiles = db.prepare("DELETE FROM files WHERE path = ?");
        const insertFileStmt = db.prepare("INSERT OR REPLACE INTO files (path, hash, last_modified, size) VALUES (?, ?, ?, ?)");
        const updateMetaStmt = db.prepare("UPDATE files SET last_modified = ?, size = ? WHERE path = ?");
        const insertChunkStmt = db.prepare("INSERT INTO chunks (path, content, start_line, end_line, type) VALUES (?, ?, ?, ?, ?)");

        for (const p of toDelete) {
            deleteChunks.run(p);
            deleteFiles.run(p);
        }

        for (const item of toUpdateMeta) {
            updateMetaStmt.run(item.stat.mtimeMs, item.stat.size, item.relPath);
        }

        for (const item of toInsert) {
            insertFileStmt.run(item.relPath, item.hash, item.stat.mtimeMs, item.stat.size);
            
            const content = fs.readFileSync(item.fullPath, 'utf-8');
            const lines = content.split('\n');
            const CHUNK_SIZE = 500;
            for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
                const chunkLines = lines.slice(i, i + CHUNK_SIZE);
                insertChunkStmt.run(item.relPath, chunkLines.join('\n'), i + 1, i + chunkLines.length, 'file');
            }
        }
    });

    updateTx();
    
    // Explicit close for safe deletion/rebuilds
    db.close();
}