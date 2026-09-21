// src/core/retrieval/interface.ts
export interface SearchResult {
    path: string;
    snippet: string;
    score: number;
}

export interface Retriever {
    search(query: string, limit?: number): SearchResult[];
}