// src/core/context/engine.ts
import fs from 'fs';
import path from 'path';
import { FTS5Retriever } from '../retrieval/fts5';

export function generateContext(repoRoot: string, task: string): string {
    const stateFiles = ['project.md', 'tasks.md', 'decisions.md'];
    const stateContent = stateFiles
        .map(f => {
            const fp = path.join(repoRoot, '.framer', f);
            return fs.existsSync(fp) ? `### ${f}\n${fs.readFileSync(fp, 'utf-8')}` : '';
        })
        .filter(Boolean)
        .join('\n\n');

    // Retrieve configurable token budget
    let config = { tokenBudget: 12000 };
    try {
        const configPath = path.join(repoRoot, '.framer', 'config.json');
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
    } catch (e) {}

    const maxBudget = config.tokenBudget; 
    const stateLen = stateContent.length;

    const retriever = new FTS5Retriever(repoRoot);
    const searchResults = retriever.search(task, 10);

    let codeContext = '### RELEVANT CODE\n\n';
    let currentLen = stateLen + codeContext.length;

    for (const result of searchResults) {
        const filePath = path.join(repoRoot, result.path);
        if (!fs.existsSync(filePath)) continue;
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        
        const snippetToAdd = `#### ${result.path}\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
        
        // Push full file if budget allows; push snippet summary if constrained
        if (currentLen + snippetToAdd.length > maxBudget) {
            const fallbackSnippet = `#### ${result.path} (Summary)\n\`\`\`\n${result.snippet}\n\`\`\`\n\n`;
            if (currentLen + fallbackSnippet.length <= maxBudget) {
                codeContext += fallbackSnippet;
                currentLen += fallbackSnippet.length;
            }
        } else {
            codeContext += snippetToAdd;
            currentLen += snippetToAdd.length;
        }
    }

    return `## FRAMER CONTEXT\n\n## TASK\n${task}\n\n## STATE\n${stateContent}\n\n${codeContext}`;
}