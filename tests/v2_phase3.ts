import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runInit } from '../src/cli/commands/init';
import { runIndex } from '../src/core/indexer/index';
import { ExplainEngine, FileSurfaceEntry } from '../src/v2/explain/index';
import { EntryPointRecord, RelatedTestRecord, SymbolRecord } from '../src/v2/providers/interface';

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

function runV2Phase3Tests() {
    console.log('=== Framer V2 Phase 3: Explain Engine Self-Hosting Tests ===\n');

    // Ensure Framer's own index is initialized and up to date so V1 FTS5 lexical search is active
    runInit(REPO_ROOT);
    runIndex(REPO_ROOT);

    const beforeHashes = snapshotSrcHashes(REPO_ROOT);
    const engine = new ExplainEngine(REPO_ROOT);

    // Test 1: Natural-language feature request that previously failed in V1 context search
    const task1 =
        'Add a new CLI command that analyzes context token budget and retrieval chunks';
    const res1 = engine.explain(task1);

    const surfacedPaths1 = res1.rankedFiles.map((f: FileSurfaceEntry) => f.filePath);
    assert(
        surfacedPaths1.includes('src/core/context/engine.ts'),
        'Expected src/core/context/engine.ts in explain ranked files'
    );
    assert(
        surfacedPaths1.includes('src/cli/index.ts'),
        'Expected src/cli/index.ts in explain ranked files'
    );
    assert(
        surfacedPaths1.includes('src/core/retrieval/interface.ts'),
        'Expected dependency src/core/retrieval/interface.ts to be structurally expanded'
    );
    console.log(
        `[PASS] 1. Natural-Language Feature Request: Surfaced ${res1.rankedFiles.length} ranked files including engine.ts, cli/index.ts, and retrieval/interface.ts.`
    );

    // Test 2: Explainable Evidence & Role Distinction
    const engineEntry = res1.rankedFiles.find(
        (f: FileSurfaceEntry) => f.filePath === 'src/core/context/engine.ts'
    )!;
    assert(engineEntry.evidence.length >= 2, 'Expected multiple inspectable evidence signals on engine.ts');
    assert(
        engineEntry.roles.includes('LIKELY_MODIFICATION_TARGET'),
        'Expected engine.ts to be classified as LIKELY_MODIFICATION_TARGET'
    );
    assert(
        engineEntry.relevantSymbols.some(
            (s: SymbolRecord) => s.name === 'ContextEngine' || s.name === 'generateContext'
        ),
        'Expected ContextEngine / generateContext in engine.ts relevantSymbols'
    );

    const ifaceEntry = res1.rankedFiles.find(
        (f: FileSurfaceEntry) => f.filePath === 'src/core/retrieval/interface.ts'
    )!;
    assert(
        ifaceEntry.roles.includes('DEPENDENCY'),
        'Expected src/core/retrieval/interface.ts to carry DEPENDENCY role'
    );
    console.log(
        `[PASS] 2. Evidence & Role Distinction: engine.ts roles=[${engineEntry.roles.join(', ')}] with ${engineEntry.evidence.length} evidence items.`
    );

    // Test 3: Related Tests & Architectural Entry Points Discovery
    const testFiles1 = res1.tests.map((t: RelatedTestRecord) => t.testFile);
    assert(
        testFiles1.includes('tests/phase3.ts') && testFiles1.includes('tests/phase5.ts'),
        `Expected tests/phase3.ts and tests/phase5.ts in related tests, got ${testFiles1.join(', ')}`
    );

    const entryFiles1 = res1.entryPoints.map((e: EntryPointRecord) => e.filePath);
    assert(
        entryFiles1.includes('src/cli/index.ts') && entryFiles1.includes('src/mcp/tools.ts'),
        `Expected CLI and MCP entry points, got ${entryFiles1.join(', ')}`
    );
    console.log(
        `[PASS] 3. Tests & Entry Points: Found ${res1.tests.length} related tests and ${res1.entryPoints.length} architectural entry points.`
    );

    // Test 4: V1 ContextEngine Reuse & Token Budget Compliance
    assert(
        res1.contextPackage.chunks.length > 0,
        'Expected non-empty budgeted context chunks from V1 ContextEngine'
    );
    assert(
        res1.contextPackage.budgetInfo.totalTokens <= res1.contextPackage.budgetInfo.budgetTokens,
        'Context package exceeded configured token budget'
    );
    console.log(
        `[PASS] 4. V1 ContextEngine Reuse: Assembled ${res1.contextPackage.chunks.length} code chunks using ${res1.contextPackage.budgetInfo.totalTokens}/${res1.contextPackage.budgetInfo.budgetTokens} tokens.`
    );

    // Test 5: Determinism across repeated ExplainEngine runs
    const engine2 = new ExplainEngine(REPO_ROOT);
    const res1Repeat = engine2.explain(task1);
    assert(
        JSON.stringify(res1) === JSON.stringify(res1Repeat),
        'ExplainEngine output is not deterministic across independent runs'
    );
    console.log('[PASS] 5. Determinism: Independent ExplainEngine runs produced byte-identical structured results.');

    // Test 6: End-to-End CLI Execution (`framer explain "<task>"` and `framer explain "<task>" --json`)
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const cliHumanOutput = execSync(
        `${npx} tsx "${CLI_PATH}" explain "Add a new MCP tool to registerMcpTools"`,
        { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    assert(cliHumanOutput.includes('## FRAMER EXPLAIN'), 'CLI output missing ## FRAMER EXPLAIN header');
    assert(cliHumanOutput.includes('src/mcp/tools.ts'), 'CLI output missing src/mcp/tools.ts');
    assert(cliHumanOutput.includes('## CONTEXT BUDGET'), 'CLI output missing ## CONTEXT BUDGET section');

    const cliJsonOutput = execSync(
        `${npx} tsx "${CLI_PATH}" explain "Add a new MCP tool to registerMcpTools" --json`,
        { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    const parsedJson = JSON.parse(cliJsonOutput);
    assert(
        Array.isArray(parsedJson.rankedFiles) &&
            parsedJson.rankedFiles.some((f: any) => f.filePath === 'src/mcp/tools.ts'),
        'CLI --json output did not contain machine-consumable rankedFiles with src/mcp/tools.ts'
    );
    console.log('[PASS] 6. End-to-End CLI: `framer explain` human-readable and `--json` outputs verified.');

    // Test 7: Source-Code Read-Only Immutability
    const afterHashes = snapshotSrcHashes(REPO_ROOT);
    assert(
        JSON.stringify(beforeHashes) === JSON.stringify(afterHashes),
        'Source files in src/ were unexpectedly modified during explain execution'
    );
    console.log('[PASS] 7. Source Immutability: Zero source files modified during analysis.');

    console.log('\n=== Framer V2 Phase 3 Validation Complete ===');
}

runV2Phase3Tests();