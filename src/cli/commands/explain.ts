// src/cli/commands/explain.ts
import { ExplainEngine } from '../../v2/explain/index';

export function runExplain(repoRoot: string, task: string, options?: { json?: boolean }) {
    const engine = new ExplainEngine(repoRoot);
    const result = engine.explain(task);

    if (options?.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log('## FRAMER EXPLAIN\n');
    console.log(`## TASK\n${result.task}\n`);

    console.log('## TASK INTERPRETATION');
    console.log(`Concepts: ${result.interpretation.extractedTerms.join(', ') || '(none)'}`);
    if (result.interpretation.matchedSymbols.length > 0) {
        console.log(`Matched Symbols: ${result.interpretation.matchedSymbols.join(', ')}`);
    }
    if (result.interpretation.matchedPaths.length > 0) {
        console.log(`Matched Paths: ${result.interpretation.matchedPaths.join(', ')}`);
    }
    console.log('');

    console.log('## REPOSITORY AREAS');
    if (result.repositoryAreas.length === 0) {
        console.log('None identified.\n');
    } else {
        result.repositoryAreas.forEach((area) => console.log(`- ${area}`));
        console.log('');
    }

    console.log('## ARCHITECTURAL ENTRY POINTS');
    if (result.entryPoints.length === 0) {
        console.log('None identified.\n');
    } else {
        for (const ep of result.entryPoints) {
            console.log(`- ${ep.filePath} [${ep.kind}]: ${ep.reason}`);
        }
        console.log('');
    }

    console.log('## LIKELY IMPLEMENTATION SURFACE (MODIFICATION TARGETS)');
    if (result.likelyModificationTargets.length === 0) {
        console.log('No primary modification targets exceeded confidence threshold.\n');
    } else {
        for (const target of result.likelyModificationTargets) {
            console.log(`- ${target}`);
        }
        console.log('');
    }

    console.log('## RANKED RELEVANT FILES');
    const topFiles = result.rankedFiles.slice(0, 10);
    if (topFiles.length === 0) {
        console.log('No relevant files found.\n');
    } else {
        topFiles.forEach((file, idx) => {
            console.log(`${idx + 1}. ${file.filePath} (Score: ${file.score.toFixed(2)})`);
            console.log(`   Roles: ${file.roles.join(', ')}`);
            console.log('   Why:');
            for (const ev of file.evidence) {
                console.log(`     - [${ev.signal}] ${ev.description}`);
            }
            if (file.relevantSymbols.length > 0) {
                const symList = file.relevantSymbols
                    .map((s) => `${s.name} (${s.startLine}-${s.endLine})`)
                    .join(', ');
                console.log(`   Symbols: ${symList}`);
            }
            if (file.relevantRanges.length > 0) {
                const rangeList = file.relevantRanges
                    .map((r) => `${r.startLine}-${r.endLine}`)
                    .join(', ');
                console.log(`   Lines: ${rangeList}`);
            }
            console.log('');
        });
    }

    console.log('## DEPENDENCIES & REVERSE DEPENDENCIES');
    console.log(`Outgoing Local Dependencies: ${result.dependencies.length}`);
    for (const dep of result.dependencies.slice(0, 8)) {
        console.log(`  ${dep.fromFile} -> ${dep.resolvedFile} (${dep.importedSymbols.join(', ') || '*'})`);
    }
    console.log(`Incoming Reverse Dependencies: ${result.reverseDependencies.length}`);
    for (const rev of result.reverseDependencies.slice(0, 8)) {
        console.log(`  ${rev.fromFile} -> ${rev.resolvedFile} (${rev.importedSymbols.join(', ') || '*'})`);
    }
    console.log('');

    console.log('## RELATED TESTS');
    if (result.tests.length === 0) {
        console.log('No related tests identified.\n');
    } else {
        for (const t of result.tests) {
            console.log(`- ${t.testFile} (${t.relationship} via ${t.importedTargetFiles.join(', ') || 'naming'})`);
        }
        console.log('');
    }

    console.log('## RELEVANT CODE');
    if (result.contextPackage.chunks.length === 0) {
        console.log('No relevant code chunks fit within budget.\n');
    } else {
        for (const chunk of result.contextPackage.chunks) {
            console.log(`### ${chunk.path} (Lines ${chunk.startLine}-${chunk.endLine})`);
            console.log(chunk.content);
            console.log('---');
        }
        console.log('');
    }

    console.log('## CONTEXT BUDGET');
    console.log(`State: ${result.contextPackage.budgetInfo.stateTokens} tokens`);
    console.log(`Code:  ${result.contextPackage.budgetInfo.codeTokens} tokens`);
    console.log(
        `Total: ${result.contextPackage.budgetInfo.totalTokens} / ${result.contextPackage.budgetInfo.budgetTokens} tokens`
    );
}
