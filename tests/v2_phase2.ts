// tests/v2_phase2.ts
import fs from 'fs';
import path from 'path';
import { RepositoryIntelligenceService } from '../src/v2/intelligence/index';
import {
    EntryPointRecord,
    ImportEdge,
    ReferenceLocation,
    RelatedTestRecord,
    SymbolRecord,
} from '../src/v2/providers/interface';
import { TreeSitterSyntaxAdapter } from '../src/v2/providers/syntax/TreeSitterSyntaxAdapter';

const REPO_ROOT = path.resolve(__dirname, '..');

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(`Assertion Failed: ${message}`);
    }
}

function runV2Phase2Tests() {
    console.log('=== Framer V2 Phase 2: Repository Intelligence Self-Hosting Tests ===\n');

    const intelligence = new RepositoryIntelligenceService(REPO_ROOT);

    // 1. Symbol extraction on src/core/context/engine.ts
    const engineSymbols = intelligence.getSymbolsInFile('src/core/context/engine.ts');
    const symbolNames = engineSymbols.map((s: SymbolRecord) => s.name);
    assert(symbolNames.includes('ContextPackage'), 'Expected ContextPackage interface in engine.ts');
    assert(symbolNames.includes('ContextEngine'), 'Expected ContextEngine class in engine.ts');
    assert(symbolNames.includes('generateContext'), 'Expected generateContext method in engine.ts');

    const generateContextSym = engineSymbols.find(
        (s: SymbolRecord) => s.id === 'src/core/context/engine.ts#ContextEngine.generateContext'
    );
    assert(
        generateContextSym !== undefined,
        'Expected deterministic ID src/core/context/engine.ts#ContextEngine.generateContext'
    );
    assert(
        generateContextSym!.startLine > 15 && generateContextSym!.endLine > generateContextSym!.startLine,
        `Expected valid source line range for generateContext, got ${generateContextSym?.startLine}-${generateContextSym?.endLine}`
    );
    console.log(
        `[PASS] 1. Symbol Extraction: Extracted ${engineSymbols.length} symbols from src/core/context/engine.ts (generateContext lines ${generateContextSym!.startLine}-${generateContextSym!.endLine}).`
    );

    // 2. Imports of src/core/context/engine.ts
    const engineImports = intelligence.getImportsOfFile('src/core/context/engine.ts');
    const resolvedImports = engineImports.map((i: ImportEdge) => i.resolvedFile);
    assert(
        resolvedImports.includes('src/core/retrieval/interface.ts'),
        'Expected engine.ts to resolve import to src/core/retrieval/interface.ts'
    );
    assert(
        resolvedImports.includes('src/core/config/index.ts'),
        'Expected engine.ts to resolve import to src/core/config/index.ts'
    );
    assert(
        resolvedImports.includes('src/core/state/index.ts'),
        'Expected engine.ts to resolve import to src/core/state/index.ts'
    );
    console.log(
        `[PASS] 2. Import Resolution: Resolved ${engineImports.length} repository-local imports for src/core/context/engine.ts.`
    );

    // 3. Reverse dependencies (Who imports src/core/context/engine.ts?)
    const engineImporters = intelligence.getImportersOfFile('src/core/context/engine.ts');
    const importerFiles = engineImporters.map((i: ImportEdge) => i.fromFile);
    assert(
        importerFiles.includes('src/cli/commands/context.ts'),
        'Expected src/cli/commands/context.ts to import src/core/context/engine.ts'
    );
    assert(
        importerFiles.includes('src/mcp/tools.ts'),
        'Expected src/mcp/tools.ts to import src/core/context/engine.ts'
    );
    console.log(
        `[PASS] 3. Reverse Dependencies: Found ${engineImporters.length} importers of src/core/context/engine.ts (${importerFiles.join(', ')}).`
    );

    // 4. Symbol definitions
    const ftsDefs = intelligence.findSymbolDefinitions('FTS5Retriever');
    assert(ftsDefs.length === 1, `Expected 1 definition for FTS5Retriever, got ${ftsDefs.length}`);
    assert(
        ftsDefs[0].filePath === 'src/core/retrieval/fts5.ts',
        `Expected FTS5Retriever in src/core/retrieval/fts5.ts, got ${ftsDefs[0].filePath}`
    );
    console.log(
        `[PASS] 4. Symbol Definitions: Located FTS5Retriever in ${ftsDefs[0].filePath} (lines ${ftsDefs[0].startLine}-${ftsDefs[0].endLine}).`
    );

    // 5. Cross-file symbol references
    const contextEngineRefs = intelligence.findSymbolReferences('src/core/context/engine.ts#ContextEngine');
    const refFiles = new Set(contextEngineRefs.map((r: ReferenceLocation) => r.referencingFile));
    assert(refFiles.has('src/core/context/engine.ts'), 'Expected definition reference in engine.ts');
    assert(refFiles.has('src/cli/commands/context.ts'), 'Expected reference in src/cli/commands/context.ts');
    assert(refFiles.has('src/mcp/tools.ts'), 'Expected reference in src/mcp/tools.ts');
    assert(refFiles.has('tests/phase3.ts'), 'Expected reference in tests/phase3.ts');
    console.log(
        `[PASS] 5. Symbol References: Found ${contextEngineRefs.length} references to ContextEngine across ${refFiles.size} files.`
    );

    // 6. Related tests discovery via actual repository relationships
    const relatedTests = intelligence.findRelatedTests('src/core/context/engine.ts');
    const directTestFiles = relatedTests
        .filter((t: RelatedTestRecord) => t.relationship === 'direct_import')
        .map((t: RelatedTestRecord) => t.testFile);
    assert(directTestFiles.includes('tests/phase3.ts'), 'Expected tests/phase3.ts as direct import test');
    assert(directTestFiles.includes('tests/phase5.ts'), 'Expected tests/phase5.ts as direct import test');
    console.log(
        `[PASS] 6. Related Tests: Identified ${relatedTests.length} related tests for src/core/context/engine.ts (${directTestFiles.join(', ')}).`
    );

    // Architectural entry points check
    const entryPoints = intelligence.findArchitecturalEntryPoints('src/core/context/engine.ts');
    const entryPaths = entryPoints.map((e: EntryPointRecord) => e.filePath);
    assert(entryPaths.includes('src/cli/index.ts'), 'Expected src/cli/index.ts as upstream CLI entry point');
    assert(
        entryPaths.includes('src/cli/commands/context.ts'),
        'Expected src/cli/commands/context.ts as CLI command entry point'
    );
    assert(entryPaths.includes('src/mcp/server.ts'), 'Expected src/mcp/server.ts as upstream MCP entry point');
    console.log(
        `[PASS] 6b. Architectural Entry Points: Connected src/core/context/engine.ts to ${entryPaths.join(', ')}.`
    );

    // Tier-2 Tree-sitter syntax provider parity verification
    const syntaxAdapter = new TreeSitterSyntaxAdapter(REPO_ROOT);
    const syntaxResult = syntaxAdapter.analyzeFile('src/core/context/engine.ts');
    const syntaxSymNames = syntaxResult.symbols.map((s: SymbolRecord) => s.name);
    assert(
        syntaxSymNames.includes('ContextEngine') && syntaxSymNames.includes('generateContext'),
        'TreeSitterSyntaxAdapter failed to extract ContextEngine and generateContext'
    );
    console.log(
        `[PASS] 6c. Tier-2 Syntax Adapter: TreeSitterSyntaxAdapter extracted ${syntaxResult.symbols.length} symbols and ${syntaxResult.imports.length} imports.`
    );

    // 7. Determinism across repeated runs
    const secondService = new RepositoryIntelligenceService(REPO_ROOT);
    const run1Payload = JSON.stringify({
        symbols: intelligence.getSymbolsInFile('src/core/context/engine.ts'),
        imports: intelligence.getImportsOfFile('src/core/context/engine.ts'),
        importers: intelligence.getImportersOfFile('src/core/context/engine.ts'),
        refs: intelligence.findSymbolReferences('src/core/context/engine.ts#ContextEngine'),
        tests: intelligence.findRelatedTests('src/core/context/engine.ts'),
    });
    const run2Payload = JSON.stringify({
        symbols: secondService.getSymbolsInFile('src/core/context/engine.ts'),
        imports: secondService.getImportsOfFile('src/core/context/engine.ts'),
        importers: secondService.getImportersOfFile('src/core/context/engine.ts'),
        refs: secondService.findSymbolReferences('src/core/context/engine.ts#ContextEngine'),
        tests: secondService.findRelatedTests('src/core/context/engine.ts'),
    });
    assert(run1Payload === run2Payload, 'Non-deterministic output between two independent service runs');
    console.log('[PASS] 7. Determinism: Independent analysis runs produced byte-identical JSON output.');

    // 8. Boundary safety (External packages & path traversal protection)
    const dbImports = intelligence.getImportsOfFile('src/core/indexer/db.ts');
    const sqliteImport = dbImports.find((i: ImportEdge) => i.rawSpecifier === 'better-sqlite3');
    assert(sqliteImport !== undefined, 'Expected better-sqlite3 import in db.ts');
    assert(
        sqliteImport!.isExternal === true && sqliteImport!.resolvedFile === null,
        'External package better-sqlite3 must have isExternal=true and resolvedFile=null'
    );

    let blockedTraversal = false;
    try {
        intelligence.getSymbolsInFile('../outside-repo-file.ts');
    } catch (err: any) {
        if (err.message.includes('Security Violation')) {
            blockedTraversal = true;
        }
    }
    assert(blockedTraversal, 'Expected Security Violation when querying path outside repository');

    const intelligenceSource = fs.readFileSync(
        path.join(REPO_ROOT, 'src/v2/intelligence/index.ts'),
        'utf-8'
    );
    assert(
        !intelligenceSource.includes("from 'ts-morph'") &&
            !intelligenceSource.includes("from 'tree-sitter'"),
        'Provider type leakage detected in src/v2/intelligence/index.ts'
    );
    console.log(
        '[PASS] 8. Boundary Safety & Isolation: External packages isolated, path traversal blocked, zero provider type leakage.'
    );

    console.log('\n=== Framer V2 Phase 2 Validation Complete ===');
}

runV2Phase2Tests();
