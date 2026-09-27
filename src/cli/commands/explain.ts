import { ExplainEngine, LineRangeSnippet } from '../../v2/explain/index';

function printCodeRanges(ranges: LineRangeSnippet[]) {
    for (const r of ranges) {
        console.log(`  // Lines ${r.startLine}-${r.endLine} (${r.reason})`);
        console.log(r.content);
        console.log('  ---');
    }
}

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
    for (const dep of result.dependencies) {
        console.log(
            `  ${dep.fromFile} -> ${dep.resolvedFile} (${dep.importedSymbols.join(', ') || '*'})`
        );
    }
    console.log(`Incoming Reverse Dependencies: ${result.reverseDependencies.length}`);
    for (const rev of result.reverseDependencies) {
        console.log(
            `  ${rev.fromFile} -> ${rev.resolvedFile} (${rev.importedSymbols.join(', ') || '*'})`
        );
    }
    console.log('');

    console.log('## RELATED TESTS');
    if (result.tests.length === 0) {
        console.log('No related tests identified.\n');
    } else {
        for (const t of result.tests) {
            console.log(
                `- ${t.testFile} (${t.relationship} via ${t.importedTargetFiles.join(', ') || 'naming'})`
            );
        }
        console.log('');
    }

    const packet = result.implementationPacket;

    console.log('## ARCHITECTURAL INVARIANTS');
    if (packet.architecturalInvariants.length === 0) {
        console.log('None identified.\n');
    } else {
        for (const inv of packet.architecturalInvariants) {
            console.log(`- ${inv}`);
        }
        console.log('');
    }

    console.log('## IMPLEMENTATION PACKET\n');

    console.log('### PROJECT STATE');
    console.log(packet.projectState ? `${packet.projectState.trim()}\n` : 'No state files found.\n');

    console.log('### PRIMARY TARGETS');
    if (packet.targetSurface.primaryTargets.length === 0) {
        console.log('None.\n');
    } else {
        for (const pt of packet.targetSurface.primaryTargets) {
            const syms = pt.symbolsToModifyOrExtend
                .map((s) => `${s.name} (${s.kind}, lines ${s.startLine}-${s.endLine})`)
                .join(', ');
            console.log(`#### ${pt.filePath} [${pt.role}]`);
            if (syms) console.log(`  Symbols: ${syms}`);
            printCodeRanges(pt.codeRanges);
        }
        console.log('');
    }

    if (packet.targetSurface.relevantContext && packet.targetSurface.relevantContext.length > 0) {
        console.log('### RELEVANT CONTEXT');
        for (const rc of packet.targetSurface.relevantContext) {
            const syms = rc.relevantSymbols
                .map((s) => `${s.name} (${s.kind}, lines ${s.startLine}-${s.endLine})`)
                .join(', ');
            console.log(`#### ${rc.filePath} [${rc.role}]`);
            if (syms) console.log(`  Symbols: ${syms}`);
            printCodeRanges(rc.codeRanges);
        }
        console.log('');
    }

    console.log('### DEPENDENCIES');
    if (packet.targetSurface.dependencies.length === 0) {
        console.log('None.\n');
    } else {
        for (const dep of packet.targetSurface.dependencies) {
            const syms = dep.providedSymbols
                .map((s) => `${s.name} (${s.kind}, lines ${s.startLine}-${s.endLine})`)
                .join(', ');
            console.log(`#### ${dep.filePath} [${dep.role}]`);
            if (syms) console.log(`  Provided Symbols: ${syms}`);
            printCodeRanges(dep.codeRanges);
        }
        console.log('');
    }

    console.log('### CALLERS / ENTRY POINTS');
    if (packet.targetSurface.callersAndEntryPoints.length === 0) {
        console.log('None.\n');
    } else {
        for (const caller of packet.targetSurface.callersAndEntryPoints) {
            console.log(`#### ${caller.filePath} [${caller.role}]`);
            printCodeRanges(caller.invocationSites);
        }
        console.log('');
    }

    console.log('### TESTS');
    if (packet.targetSurface.testTargets.length === 0) {
        console.log('None.\n');
    } else {
        for (const test of packet.targetSurface.testTargets) {
            console.log(`#### ${test.filePath} [${test.role}, ${test.relationship}]`);
            printCodeRanges(test.assertionRanges);
        }
        console.log('');
    }

    console.log('## CONTEXT BUDGET');
    console.log(`State: ${packet.budgetInfo.stateTokens} tokens`);
    console.log(`Code:  ${packet.budgetInfo.codeTokens} tokens`);
    console.log(`Total: ${packet.budgetInfo.totalTokens} / ${packet.budgetInfo.budgetTokens} tokens`);
}