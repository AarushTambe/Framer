"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// tests/v2_phase2.ts
var fs_1 = require("fs");
var path_1 = require("path");
var index_1 = require("../src/v2/intelligence/index");
var TreeSitterSyntaxAdapter_1 = require("../src/v2/providers/syntax/TreeSitterSyntaxAdapter");
var REPO_ROOT = path_1.default.resolve(__dirname, '..');
function assert(condition, message) {
    if (!condition) {
        throw new Error("Assertion Failed: ".concat(message));
    }
}
function runV2Phase2Tests() {
    console.log('=== Framer V2 Phase 2: Repository Intelligence Self-Hosting Tests ===\n');
    var intelligence = new index_1.RepositoryIntelligenceService(REPO_ROOT);
    // 1. Symbol extraction on src/core/context/engine.ts
    var engineSymbols = intelligence.getSymbolsInFile('src/core/context/engine.ts');
    var symbolNames = engineSymbols.map(function (s) { return s.name; });
    assert(symbolNames.includes('ContextPackage'), 'Expected ContextPackage interface in engine.ts');
    assert(symbolNames.includes('ContextEngine'), 'Expected ContextEngine class in engine.ts');
    assert(symbolNames.includes('generateContext'), 'Expected generateContext method in engine.ts');
    var generateContextSym = engineSymbols.find(function (s) { return s.id === 'src/core/context/engine.ts#ContextEngine.generateContext'; });
    assert(generateContextSym !== undefined, 'Expected deterministic ID src/core/context/engine.ts#ContextEngine.generateContext');
    assert(generateContextSym.startLine > 15 && generateContextSym.endLine > generateContextSym.startLine, "Expected valid source line range for generateContext, got ".concat(generateContextSym === null || generateContextSym === void 0 ? void 0 : generateContextSym.startLine, "-").concat(generateContextSym === null || generateContextSym === void 0 ? void 0 : generateContextSym.endLine));
    console.log("[PASS] 1. Symbol Extraction: Extracted ".concat(engineSymbols.length, " symbols from src/core/context/engine.ts (generateContext lines ").concat(generateContextSym.startLine, "-").concat(generateContextSym.endLine, ")."));
    // 2. Imports of src/core/context/engine.ts
    var engineImports = intelligence.getImportsOfFile('src/core/context/engine.ts');
    var resolvedImports = engineImports.map(function (i) { return i.resolvedFile; });
    assert(resolvedImports.includes('src/core/retrieval/interface.ts'), 'Expected engine.ts to resolve import to src/core/retrieval/interface.ts');
    assert(resolvedImports.includes('src/core/config/index.ts'), 'Expected engine.ts to resolve import to src/core/config/index.ts');
    assert(resolvedImports.includes('src/core/state/index.ts'), 'Expected engine.ts to resolve import to src/core/state/index.ts');
    console.log("[PASS] 2. Import Resolution: Resolved ".concat(engineImports.length, " repository-local imports for src/core/context/engine.ts."));
    // 3. Reverse dependencies (Who imports src/core/context/engine.ts?)
    var engineImporters = intelligence.getImportersOfFile('src/core/context/engine.ts');
    var importerFiles = engineImporters.map(function (i) { return i.fromFile; });
    assert(importerFiles.includes('src/cli/commands/context.ts'), 'Expected src/cli/commands/context.ts to import src/core/context/engine.ts');
    assert(importerFiles.includes('src/mcp/tools.ts'), 'Expected src/mcp/tools.ts to import src/core/context/engine.ts');
    console.log("[PASS] 3. Reverse Dependencies: Found ".concat(engineImporters.length, " importers of src/core/context/engine.ts (").concat(importerFiles.join(', '), ")."));
    // 4. Symbol definitions
    var ftsDefs = intelligence.findSymbolDefinitions('FTS5Retriever');
    assert(ftsDefs.length === 1, "Expected 1 definition for FTS5Retriever, got ".concat(ftsDefs.length));
    assert(ftsDefs[0].filePath === 'src/core/retrieval/fts5.ts', "Expected FTS5Retriever in src/core/retrieval/fts5.ts, got ".concat(ftsDefs[0].filePath));
    console.log("[PASS] 4. Symbol Definitions: Located FTS5Retriever in ".concat(ftsDefs[0].filePath, " (lines ").concat(ftsDefs[0].startLine, "-").concat(ftsDefs[0].endLine, ")."));
    // 5. Cross-file symbol references
    var contextEngineRefs = intelligence.findSymbolReferences('src/core/context/engine.ts#ContextEngine');
    var refFiles = new Set(contextEngineRefs.map(function (r) { return r.referencingFile; }));
    assert(refFiles.has('src/core/context/engine.ts'), 'Expected definition reference in engine.ts');
    assert(refFiles.has('src/cli/commands/context.ts'), 'Expected reference in src/cli/commands/context.ts');
    assert(refFiles.has('src/mcp/tools.ts'), 'Expected reference in src/mcp/tools.ts');
    assert(refFiles.has('tests/phase3.ts'), 'Expected reference in tests/phase3.ts');
    console.log("[PASS] 5. Symbol References: Found ".concat(contextEngineRefs.length, " references to ContextEngine across ").concat(refFiles.size, " files."));
    // 6. Related tests discovery via actual repository relationships
    var relatedTests = intelligence.findRelatedTests('src/core/context/engine.ts');
    var directTestFiles = relatedTests
        .filter(function (t) { return t.relationship === 'direct_import'; })
        .map(function (t) { return t.testFile; });
    assert(directTestFiles.includes('tests/phase3.ts'), 'Expected tests/phase3.ts as direct import test');
    assert(directTestFiles.includes('tests/phase5.ts'), 'Expected tests/phase5.ts as direct import test');
    console.log("[PASS] 6. Related Tests: Identified ".concat(relatedTests.length, " related tests for src/core/context/engine.ts (").concat(directTestFiles.join(', '), ")."));
    // Architectural entry points check
    var entryPoints = intelligence.findArchitecturalEntryPoints('src/core/context/engine.ts');
    var entryPaths = entryPoints.map(function (e) { return e.filePath; });
    assert(entryPaths.includes('src/cli/index.ts'), 'Expected src/cli/index.ts as upstream CLI entry point');
    assert(entryPaths.includes('src/cli/commands/context.ts'), 'Expected src/cli/commands/context.ts as CLI command entry point');
    assert(entryPaths.includes('src/mcp/server.ts'), 'Expected src/mcp/server.ts as upstream MCP entry point');
    console.log("[PASS] 6b. Architectural Entry Points: Connected src/core/context/engine.ts to ".concat(entryPaths.join(', '), "."));
    // Tier-2 Tree-sitter syntax provider parity verification
    var syntaxAdapter = new TreeSitterSyntaxAdapter_1.TreeSitterSyntaxAdapter(REPO_ROOT);
    var syntaxResult = syntaxAdapter.analyzeFile('src/core/context/engine.ts');
    var syntaxSymNames = syntaxResult.symbols.map(function (s) { return s.name; });
    assert(syntaxSymNames.includes('ContextEngine') && syntaxSymNames.includes('generateContext'), 'TreeSitterSyntaxAdapter failed to extract ContextEngine and generateContext');
    console.log("[PASS] 6c. Tier-2 Syntax Adapter: TreeSitterSyntaxAdapter extracted ".concat(syntaxResult.symbols.length, " symbols and ").concat(syntaxResult.imports.length, " imports."));
    // 7. Determinism across repeated runs
    var secondService = new index_1.RepositoryIntelligenceService(REPO_ROOT);
    var run1Payload = JSON.stringify({
        symbols: intelligence.getSymbolsInFile('src/core/context/engine.ts'),
        imports: intelligence.getImportsOfFile('src/core/context/engine.ts'),
        importers: intelligence.getImportersOfFile('src/core/context/engine.ts'),
        refs: intelligence.findSymbolReferences('src/core/context/engine.ts#ContextEngine'),
        tests: intelligence.findRelatedTests('src/core/context/engine.ts'),
    });
    var run2Payload = JSON.stringify({
        symbols: secondService.getSymbolsInFile('src/core/context/engine.ts'),
        imports: secondService.getImportsOfFile('src/core/context/engine.ts'),
        importers: secondService.getImportersOfFile('src/core/context/engine.ts'),
        refs: secondService.findSymbolReferences('src/core/context/engine.ts#ContextEngine'),
        tests: secondService.findRelatedTests('src/core/context/engine.ts'),
    });
    assert(run1Payload === run2Payload, 'Non-deterministic output between two independent service runs');
    console.log('[PASS] 7. Determinism: Independent analysis runs produced byte-identical JSON output.');
    // 8. Boundary safety (External packages & path traversal protection)
    var dbImports = intelligence.getImportsOfFile('src/core/indexer/db.ts');
    var sqliteImport = dbImports.find(function (i) { return i.rawSpecifier === 'better-sqlite3'; });
    assert(sqliteImport !== undefined, 'Expected better-sqlite3 import in db.ts');
    assert(sqliteImport.isExternal === true && sqliteImport.resolvedFile === null, 'External package better-sqlite3 must have isExternal=true and resolvedFile=null');
    var blockedTraversal = false;
    try {
        intelligence.getSymbolsInFile('../outside-repo-file.ts');
    }
    catch (err) {
        if (err.message.includes('Security Violation')) {
            blockedTraversal = true;
        }
    }
    assert(blockedTraversal, 'Expected Security Violation when querying path outside repository');
    var intelligenceSource = fs_1.default.readFileSync(path_1.default.join(REPO_ROOT, 'src/v2/intelligence/index.ts'), 'utf-8');
    assert(!intelligenceSource.includes("from 'ts-morph'") &&
        !intelligenceSource.includes("from 'tree-sitter'"), 'Provider type leakage detected in src/v2/intelligence/index.ts');
    console.log('[PASS] 8. Boundary Safety & Isolation: External packages isolated, path traversal blocked, zero provider type leakage.');
    console.log('\n=== Framer V2 Phase 2 Validation Complete ===');
}
runV2Phase2Tests();
