import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export function getDb(repoRoot: string, options: { readonly?: boolean } = {}) {
    const framerDir = path.join(repoRoot, '.framer');
    
    if (!fs.existsSync(framerDir)) {
        if (options.readonly) return null;
        throw new Error('Framer not initialized. Run `framer init`.');
    }
    
    const dbPath = path.join(framerDir, 'index.db');
    
    if (options.readonly) {
        if (!fs.existsSync(dbPath)) return null;
        return new Database(dbPath, { readonly: true, fileMustExist: true });
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    
    // Schema Note: FTS5 rowid is used as the internal chunk identifier for the 
    // current database instance. It is NOT persistent across index rebuilds.
    db.exec(`
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            last_modified INTEGER NOT NULL,
            size INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
            path,
            content,
            start_line UNINDEXED,
            end_line UNINDEXED,
            type UNINDEXED
        );
    `);
    
    return db;
}