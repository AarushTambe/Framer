import { FTS5Retriever } from '../../core/retrieval/fts5';

export function runSearch(repoRoot: string, query: string) {
    const retriever = new FTS5Retriever(repoRoot);
    const results = retriever.search(query);

    if (results.length === 0) {
        console.log(`No results found for: "${query}"`);
        return;
    }

    console.log(`Search results for: "${query}"\n`);
    
    results.forEach((res, index) => {
        console.log(`${index + 1}. ${res.path} (Lines ${res.startLine}-${res.endLine})`);
        console.log(`   Score: ${res.score.toFixed(4)}`);
        const snippet = res.content.split('\n').slice(0, 3).join('\n');
        console.log(`   ${snippet}\n   ...\n`);
    });
}