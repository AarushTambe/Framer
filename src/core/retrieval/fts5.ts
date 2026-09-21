import { Retriever, SearchResult } from './interface';
import { getDb } from '../indexer/db';

export class FTS5Retriever implements Retriever {
    constructor(private repoRoot: string) {}

    /**
     * V1 Query Normalization:
     * Aggressively strips punctuation and native FTS5 operators (like *, OR, NEAR)
     * for SQL safety. Terms are forced into a quoted AND conjunction.
     * This intentionally limits natural FTS5 semantics to ensure a deterministic
     * and crash-free search experience for basic queries.
     */
    private sanitizeQuery(query: string): string {
        const clean = query.replace(/[^\p{L}\p{N}\s_]/gu, ' ').trim();
        if (!clean) return '';
        return clean.split(/\s+/).map(term => `"${term}"`).join(' AND ');
    }

    // Using 1000 as a technical safeguard against OOM on extremely broad queries,
    // not as a semantic retrieval limit. The Context Engine determines actual usage.
    search(query: string, limit: number = 1000): SearchResult[] {
        const db = getDb(this.repoRoot, { readonly: true });
        if (!db) return [];

        const safeQuery = this.sanitizeQuery(query);
        if (!safeQuery) return [];

        try {
            const stmt = db.prepare(`
                SELECT path, start_line as startLine, end_line as endLine, content, rank as score
                FROM chunks 
                WHERE chunks MATCH ? 
                ORDER BY rank 
                LIMIT ?
            `);
            
            const rows = stmt.all(safeQuery, limit) as SearchResult[];
            db.close();
            return rows;
        } catch (e) {
            if (db) db.close();
            console.error("Search error:", e);
            return [];
        }
    }
}