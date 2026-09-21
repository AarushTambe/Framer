export interface SearchResult {
    path: string;
    startLine: number;
    endLine: number;
    content: string;
    score: number;
}

export interface Retriever {
    search(query: string, limit?: number): SearchResult[];
}