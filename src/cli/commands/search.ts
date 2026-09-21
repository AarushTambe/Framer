// src/cli/commands/search.ts
import { FTS5Retriever } from '../../core/retrieval/fts5';

export function runSearch(repoRoot: string, query: string) {
    const retriever = new FTS5Retriever(repoRoot);
    const results = retriever.search(query, 10);
    console.log(JSON.stringify(results, null, 2));
}