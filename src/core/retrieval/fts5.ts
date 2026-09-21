// src/core/retrieval/fts5.ts
import { Retriever, SearchResult } from './interface';
import { getDb } from '../indexer/db';

export class FTS5Retriever implements Retriever {
    constructor(private repoRoot: string) {}

    search(query: string, limit: number = 5): SearchResult[] {
        const db = getDb(this.repoRoot);
        if (!db) throw new Error("Database not initialized. Run `framer index` first.");
        
        // Extracts a snippet and uses internal FTS5 BM25 rank
        const stmt = db.prepare(`
            SELECT path, snippet(chunks, 1, '', '', '...', 64) as snippet, rank as score 
            FROM chunks 
            WHERE chunks MATCH ? 
            ORDER BY rank 
            LIMIT ?
        `);
        return stmt.all(query, limit) as SearchResult[];
    }
}