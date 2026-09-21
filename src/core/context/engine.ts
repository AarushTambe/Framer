import fs from 'fs';
import path from 'path';
import { Retriever, SearchResult } from '../retrieval/interface';
import { getConfig } from '../config';

export interface ContextPackage {
    task: string;
    stateContent: string;
    chunks: SearchResult[];
    budgetInfo: {
        budgetTokens: number;
        stateTokens: number;
        codeTokens: number;
        totalTokens: number;
    };
}

export class ContextEngine {
    constructor(private repoRoot: string, private retriever: Retriever) {}

    // V1 Token Estimate: 1 token ≈ 4 characters
    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    private getProjectState(): string {
        const stateFiles = ['project.md', 'tasks.md', 'decisions.md'];
        return stateFiles
            .map(f => {
                const fp = path.join(this.repoRoot, '.framer', f);
                return fs.existsSync(fp) ? `### ${f}\n${fs.readFileSync(fp, 'utf-8')}` : '';
            })
            .filter(Boolean)
            .join('\n\n');
    }

    generateContext(task: string): ContextPackage {
        const config = getConfig(this.repoRoot);
        const budgetTokens = config.tokenBudget || 12000;
        
        let stateContent = this.getProjectState();
        let stateTokens = this.estimateTokens(stateContent);
        
        // Truncate state if it exceeds the budget
        if (stateTokens > budgetTokens) {
            const truncMsg = "\n... [State truncated due to budget constraints]";
            const truncMsgTokens = this.estimateTokens(truncMsg);
            const allowedStateTokens = Math.max(0, budgetTokens - truncMsgTokens);
            const allowedChars = allowedStateTokens * 4;
            
            if (allowedChars > 0) {
                stateContent = stateContent.substring(0, allowedChars) + truncMsg;
            } else {
                stateContent = truncMsg; // Extreme constraint fallback
            }
            
            stateTokens = this.estimateTokens(stateContent);
            if (stateTokens > budgetTokens) stateTokens = budgetTokens; // Safety ceiling
        }

        const remainingTokens = Math.max(0, budgetTokens - stateTokens);
        const selectedChunks: SearchResult[] = [];
        let codeTokens = 0;

        if (remainingTokens > 0) {
            // No hardcoded 50 limit, purely dynamic based on budget
            const candidates = this.retriever.search(task);
            
            for (const chunk of candidates) {
                const chunkText = `#### ${chunk.path} (Lines ${chunk.startLine}-${chunk.endLine})\n\`\`\`\n${chunk.content}\n\`\`\`\n\n`;
                const chunkTokens = this.estimateTokens(chunkText);
                
                if (codeTokens + chunkTokens <= remainingTokens) {
                    selectedChunks.push(chunk);
                    codeTokens += chunkTokens;
                } else {
                    break; // Budget exhausted
                }
            }
        }

        return {
            task,
            stateContent,
            chunks: selectedChunks,
            budgetInfo: {
                budgetTokens,
                stateTokens,
                codeTokens,
                totalTokens: stateTokens + codeTokens
            }
        };
    }
}