import { FTS5Retriever } from '../../core/retrieval/fts5';
import { ContextEngine } from '../../core/context/engine';

export function runContext(repoRoot: string, task: string) {
    const retriever = new FTS5Retriever(repoRoot);
    const engine = new ContextEngine(repoRoot, retriever);
    
    const contextPackage = engine.generateContext(task);

    console.log("## FRAMER CONTEXT");
    console.log(`## TASK: ${contextPackage.task}\n`);
    console.log("## STATE");
    console.log(contextPackage.stateContent || "No state files found.\n");
    
    console.log("## RELEVANT CODE");
    if (contextPackage.chunks.length === 0) {
        console.log("No relevant code chunks found within budget.");
    } else {
        const grouped = contextPackage.chunks.reduce((acc, chunk) => {
            if (!acc[chunk.path]) acc[chunk.path] = [];
            acc[chunk.path].push(chunk);
            return acc;
        }, {} as Record<string, typeof contextPackage.chunks>);

        for (const [filePath, chunks] of Object.entries(grouped)) {
            console.log(`### ${filePath}`);
            for (const chunk of chunks) {
                console.log(`// Lines ${chunk.startLine} - ${chunk.endLine}`);
                console.log(chunk.content);
                console.log('---');
            }
        }
    }

    console.log("\n## TOKEN BUDGET");
    console.log(`State: ${contextPackage.budgetInfo.stateTokens} tokens`);
    console.log(`Code:  ${contextPackage.budgetInfo.codeTokens} tokens`);
    console.log(`Total: ${contextPackage.budgetInfo.totalTokens} / ${contextPackage.budgetInfo.budgetTokens} tokens`);
}