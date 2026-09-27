import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runInit } from '../src/cli/commands/init';
import { runIndex } from '../src/core/indexer/index';
import { ExplainEngine } from '../src/v2/explain/index';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.resolve(REPO_ROOT, 'src/cli/index.ts');

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(`Assertion Failed: ${message}`);
    }
}

function snapshotSrcHashes(rootDir: string): Record<string, string> {
    const hashes: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                hashes[full] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
            }
        }
    };
    walk(path.join(rootDir, 'src'));
    return hashes;
}

function runV2Phase4Tests() {
    console.log('=== Framer V2 Phase 4: Canonical Implementation Packet Tests ===\n');

    runInit(REPO_ROOT);
    runIndex(REPO_ROOT);

    const beforeHashes = snapshotSrcHashes(REPO_ROOT);
    const engine = new ExplainEngine(REPO_ROOT);

    const task = 'change how context is generated';
    const result = engine.explain(task);
    const packet = result.implementationPacket;

    // 1. Single External Context Representation & Semantically Grounded Primary Target Role
    assert(packet.task === task, 'Packet task must match input task');
    assert(
        !('contextPackage' in (result as unknown as Record<string, unknown>)),
        'ExplainResult must expose implementationPacket as the single external context representation without contextPackage'
    );
    assert(
        packet.budgetInfo.totalTokens ===
            packet.budgetInfo.stateTokens + packet.budgetInfo.codeTokens &&
            packet.budgetInfo.totalTokens > 0,
        'ImplementationPacket budgetInfo must be populated by internal ContextEngine budgeting'
    );
    assert(
        packet.targetSurface.primaryTargets.length === 1 &&
            packet.targetSurface.primaryTargets[0].filePath === 'src/core/context/engine.ts' &&
            packet.targetSurface.primaryTargets[0].role === 'LIKELY_MODIFICATION_TARGET',
        `Expected src/core/context/engine.ts as the sole LIKELY_MODIFICATION_TARGET, got [${packet.targetSurface.primaryTargets.map((t) => `${t.filePath}:${t.role}`).join(', ')}]`
    );
    assert(
        !packet.targetSurface.primaryTargets.some(
            (t) => t.filePath === 'src/cli/commands/context.ts'
        ),
        'Expected wrapper src/cli/commands/context.ts NOT to be classified as a primary modification target'
    );
    console.log(
        '[PASS] 1. Single Canonical Representation & Primary Target Semantics: src/core/context/engine.ts is the sole LIKELY_MODIFICATION_TARGET.'
    );

    // 2. Fresh-Session Implementation Sufficiency (Content-Level Verification)
    const engineTarget = packet.targetSurface.primaryTargets[0];
    assert(
        engineTarget.symbolsToModifyOrExtend.some((s) => s.name === 'ContextEngine') &&
            engineTarget.symbolsToModifyOrExtend.some((s) => s.name === 'generateContext') &&
            engineTarget.symbolsToModifyOrExtend.some((s) => s.name === 'ContextPackage'),
        'Expected ContextEngine, generateContext, and ContextPackage in engine.ts symbolsToModifyOrExtend'
    );
    assert(
        engineTarget.codeRanges.some(
            (r) =>
                r.startLine === 5 &&
                r.endLine === 82 &&
                r.content.includes('generateContext(task: string): ContextPackage') &&
                r.content.includes('this.retriever.search(task)') &&
                r.content.includes('getProjectState(this.repoRoot)')
        ),
        'Expected engine.ts codeRanges to contain the full untruncated logical range (5-82) of generateContext and ContextEngine'
    );

    const retrieverDep = packet.targetSurface.dependencies.find(
        (d) => d.filePath === 'src/core/retrieval/interface.ts'
    );
    assert(
        retrieverDep !== undefined &&
            retrieverDep.providedSymbols.some((s) => s.name === 'Retriever') &&
            retrieverDep.providedSymbols.some((s) => s.name === 'SearchResult') &&
            retrieverDep.codeRanges.some(
                (r) =>
                    r.content.includes('export interface Retriever') &&
                    r.content.includes('search(query: string, limit?: number): SearchResult[]')
            ),
        'Expected src/core/retrieval/interface.ts dependency with Retriever & SearchResult contracts'
    );

    const configDep = packet.targetSurface.dependencies.find(
        (d) => d.filePath === 'src/core/config/index.ts'
    );
    assert(
        configDep !== undefined &&
            configDep.providedSymbols.some((s) => s.name === 'getConfig') &&
            configDep.codeRanges.some(
                (r) => r.content.includes('export function getConfig') && r.content.includes('tokenBudget')
            ),
        'Expected src/core/config/index.ts dependency with getConfig implementation'
    );

    const stateDep = packet.targetSurface.dependencies.find(
        (d) => d.filePath === 'src/core/state/index.ts'
    );
    assert(
        stateDep !== undefined &&
            stateDep.providedSymbols.some((s) => s.name === 'getProjectState') &&
            stateDep.codeRanges.some((r) => r.content.includes('export function getProjectState')),
        'Expected src/core/state/index.ts dependency with getProjectState implementation'
    );

    const contextCliCaller = packet.targetSurface.callersAndEntryPoints.find(
        (c) => c.filePath === 'src/cli/commands/context.ts'
    );
    assert(
        contextCliCaller !== undefined &&
            contextCliCaller.invocationSites.some(
                (s) =>
                    s.content.includes('new ContextEngine') &&
                    s.content.includes('engine.generateContext(task)')
            ),
        'Expected caller src/cli/commands/context.ts to include actual ContextEngine.generateContext invocation site'
    );

    const mcpToolsCaller = packet.targetSurface.callersAndEntryPoints.find(
        (c) => c.filePath === 'src/mcp/tools.ts'
    );
    assert(
        mcpToolsCaller !== undefined &&
            mcpToolsCaller.invocationSites.some(
                (s) =>
                    s.content.includes('new ContextEngine') &&
                    s.content.includes('engine.generateContext')
            ),
        'Expected caller src/mcp/tools.ts to include actual ContextEngine.generateContext invocation site'
    );

    const phase3Test = packet.targetSurface.testTargets.find(
        (t) => t.filePath === 'tests/phase3.ts'
    );
    const phase5Test = packet.targetSurface.testTargets.find(
        (t) => t.filePath === 'tests/phase5.ts'
    );
    assert(
        phase3Test !== undefined &&
            phase3Test.assertionRanges.some(
                (r) =>
                    r.content.includes("engine.generateContext('authentication')") &&
                    r.content.includes('context.budgetInfo.totalTokens')
            ),
        'Expected tests/phase3.ts to include actual generateContext & budgetInfo behavioral assertions'
    );
    assert(
        phase5Test !== undefined &&
            phase5Test.assertionRanges.some(
                (r) =>
                    r.content.includes('engine.generateContext("workflow")') &&
                    r.content.includes('ctx.budgetInfo.totalTokens')
            ),
        'Expected tests/phase5.ts to include actual generateContext & budgetInfo behavioral assertions'
    );

    assert(
        packet.projectState.includes('project.md') &&
            packet.architecturalInvariants.some((inv) => inv.includes('Retriever Interface Boundary')) &&
            packet.architecturalInvariants.some((inv) => inv.includes('Token Budget Contract')) &&
            !packet.architecturalInvariants.some((inv) => inv.includes('Project State')) &&
            !packet.architecturalInvariants.some((inv) => inv.includes('Caller Import Contracts')),
        `Expected strictly code-grounded architectural invariants, got: ${JSON.stringify(packet.architecturalInvariants)}`
    );
    console.log(
        '[PASS] 2. Fresh-Session Sufficiency: Verified primary implementation body, dependency contracts, caller invocation sites, test assertions, project state, and clean architectural invariants.'
    );

    // 3. Level 1 File-Level Deduplication
    const sectionFiles: string[] = [
        ...packet.targetSurface.primaryTargets.map((x) => x.filePath),
        ...(packet.targetSurface.relevantContext?.map((x) => x.filePath) ?? []),
        ...packet.targetSurface.dependencies.map((x) => x.filePath),
        ...packet.targetSurface.callersAndEntryPoints.map((x) => x.filePath),
        ...packet.targetSurface.testTargets.map((x) => x.filePath),
    ];
    const uniqueSectionFiles = new Set(sectionFiles);
    assert(
        sectionFiles.length === uniqueSectionFiles.size,
        `Level 1 File Deduplication failed: duplicate file across packet sections in [${sectionFiles.join(', ')}]`
    );
    console.log(
        `[PASS] 3. Level 1 File Deduplication: All ${sectionFiles.length} packet files appear in strictly one section.`
    );

    // 4. Level 2 Symbol-Level Deduplication
    const allSymbolIds: string[] = [
        ...packet.targetSurface.primaryTargets.flatMap((t) =>
            t.symbolsToModifyOrExtend.map((s) => s.id)
        ),
        ...(packet.targetSurface.relevantContext?.flatMap((c) =>
            c.relevantSymbols.map((s) => s.id)
        ) ?? []),
        ...packet.targetSurface.dependencies.flatMap((d) => d.providedSymbols.map((s) => s.id)),
    ];
    assert(
        allSymbolIds.length === new Set(allSymbolIds).size,
        `Level 2 Symbol Deduplication failed: duplicate symbol IDs in [${allSymbolIds.join(', ')}]`
    );
    console.log(
        `[PASS] 4. Level 2 Symbol Deduplication: All ${allSymbolIds.length} surfaced symbols have unique canonical IDs.`
    );

    // 5. Level 3 & Level 4 Range and Relationship Deduplication
    const explainCaller = packet.targetSurface.callersAndEntryPoints.find(
        (c) => c.filePath === 'src/v2/explain/index.ts'
    );
    if (explainCaller) {
        assert(
            explainCaller.invocationSites.length === 1 &&
                explainCaller.invocationSites[0].startLine > 100 &&
                explainCaller.invocationSites[0].content.includes('contextEngine.generateContext'),
            `Expected src/v2/explain/index.ts caller range to contain only the body invocation site, got lines ${explainCaller.invocationSites.map((r) => `${r.startLine}-${r.endLine}`).join(', ')}`
        );
    }
    const mcpRanked = result.rankedFiles.find((f) => f.filePath === 'src/mcp/tools.ts');
    assert(
        mcpRanked !== undefined &&
            mcpRanked.evidence.some(
                (e) => e.signal === 'reference_match' && e.description.includes('lines 5, 71')
            ),
        'Expected Level 4 relationship evidence on src/mcp/tools.ts to aggregate all reference lines (lines 5, 71)'
    );
    console.log(
        '[PASS] 5. Level 3 & 4 Range/Relationship Deduplication: Multi-line references aggregated; zero import-only or type-header caller chunks.'
    );

    // 6. Relevance & Exclusion of Unrelated Peripheral Files
    assert(
        !uniqueSectionFiles.has('src/cli/commands/explain.ts') &&
            !uniqueSectionFiles.has('src/cli/commands/mcp.ts') &&
            !uniqueSectionFiles.has('src/cli/commands/search.ts') &&
            !uniqueSectionFiles.has('src/v2/intelligence/index.ts') &&
            !uniqueSectionFiles.has('src/core/retrieval/fts5.ts'),
        `Expected unrelated CLI commands, V2 internals, and non-dependencies to be excluded from packet, got [${sectionFiles.join(', ')}]`
    );
    console.log(
        '[PASS] 6. Relevance Boundary: Unrelated CLI commands, V2 intelligence internals, and non-target dependencies excluded.'
    );

    // 7. Token Efficiency (Budget is a ceiling, not a target to fill)
    assert(
        packet.budgetInfo.totalTokens > 0 &&
            packet.budgetInfo.totalTokens ===
                packet.budgetInfo.stateTokens + packet.budgetInfo.codeTokens &&
            packet.budgetInfo.totalTokens < packet.budgetInfo.budgetTokens,
        `Expected packet to stay within budget without greedily filling the ceiling (${packet.budgetInfo.totalTokens}/${packet.budgetInfo.budgetTokens})`
    );
    console.log(
        `[PASS] 7. Token Efficiency: Packet used ${packet.budgetInfo.totalTokens}/${packet.budgetInfo.budgetTokens} tokens (budget treated as ceiling, not target).`
    );

    // 8. Determinism
    const engineRepeat = new ExplainEngine(REPO_ROOT);
    const resultRepeat = engineRepeat.explain(task);
    assert(
        JSON.stringify(result.implementationPacket) ===
            JSON.stringify(resultRepeat.implementationPacket),
        'ImplementationPacket is not deterministic across independent runs'
    );
    console.log(
        '[PASS] 8. Determinism: Independent runs produced byte-identical ImplementationPackets.'
    );

    // 9. End-to-End CLI Contract
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const cliHuman = execSync(`${npx} tsx "${CLI_PATH}" explain "${task}"`, {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
    });
    assert(cliHuman.includes('## ARCHITECTURAL INVARIANTS'), 'Missing ## ARCHITECTURAL INVARIANTS');
    assert(cliHuman.includes('## IMPLEMENTATION PACKET'), 'Missing ## IMPLEMENTATION PACKET');
    assert(cliHuman.includes('### PRIMARY TARGETS'), 'Missing ### PRIMARY TARGETS');
    assert(cliHuman.includes('### DEPENDENCIES'), 'Missing ### DEPENDENCIES');
    assert(cliHuman.includes('### CALLERS / ENTRY POINTS'), 'Missing ### CALLERS / ENTRY POINTS');
    assert(cliHuman.includes('### TESTS'), 'Missing ### TESTS');
    assert(
        !/^## RELEVANT CODE$/m.test(cliHuman),
        'CLI output must not print duplicate ## RELEVANT CODE section outside ImplementationPacket'
    );

    const cliJson = execSync(`${npx} tsx "${CLI_PATH}" explain "${task}" --json`, {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
    });
    const parsed = JSON.parse(cliJson);
    assert(
        parsed.implementationPacket &&
            parsed.contextPackage === undefined &&
            parsed.implementationPacket.targetSurface.primaryTargets.length === 1 &&
            parsed.implementationPacket.targetSurface.primaryTargets[0].filePath ===
                'src/core/context/engine.ts',
        'CLI --json output must expose canonical implementationPacket without duplicate contextPackage'
    );
    console.log(
        '[PASS] 9. CLI Contract: `framer explain` renders packet snippets once and `--json` exposes single canonical implementationPacket.'
    );

    // 10. Source Immutability
    const afterHashes = snapshotSrcHashes(REPO_ROOT);
    assert(
        JSON.stringify(beforeHashes) === JSON.stringify(afterHashes),
        'Source files in src/ were modified during Phase 4 analysis'
    );
    console.log('[PASS] 10. Source Immutability: Zero source files modified during analysis.');

    console.log('\n=== Framer V2 Phase 4 Validation Complete ===');
}

runV2Phase4Tests();