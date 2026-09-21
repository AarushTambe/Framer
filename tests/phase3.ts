import fs from 'fs';
import path from 'path';
import { runInit } from '../src/cli/commands/init';
import { runIndex } from '../src/core/indexer/index';
import { FTS5Retriever } from '../src/core/retrieval/fts5';
import { ContextEngine } from '../src/core/context/engine';

const TEST_DIR = path.join(__dirname, 'phase3-test-repo');

function setupTestRepo() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR);
    fs.mkdirSync(path.join(TEST_DIR, 'src'));
    
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'middleware.ts'), 
        'export function authMiddleware() {\n  console.log("authentication middleware running");\n}\n'
    );
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'server.ts'), 
        'import { authMiddleware } from "./middleware";\napp.use(authMiddleware);\n'
    );
    
    let largeFile = '';
    for (let i = 0; i < 1500; i++) {
        if (i === 505) {
            largeFile += 'const secret = "authentication token";\n';
        } else if (i === 1100) {
            largeFile += 'function verify() { return "authentication"; }\n';
        } else if (i === 1300) {
            largeFile += 'const status = "authentication required";\n';
        } else {
            largeFile += `// line ${i}\n`;
        }
    }
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'large.ts'), largeFile);
    
    fs.mkdirSync(path.join(TEST_DIR, '.framer'));
    fs.writeFileSync(path.join(TEST_DIR, '.framer', 'config.json'), JSON.stringify({ tokenBudget: 200 }));
}

function runPhase3Tests() {
    console.log("=== Phase 3: Modular Retrieval Tests ===");
    setupTestRepo();
    runInit(TEST_DIR);
    runIndex(TEST_DIR);

    const retriever = new FTS5Retriever(TEST_DIR);

    // Test A & B — Basic search & Multiple files
    const results = retriever.search('authentication');
    if (results.length < 3) throw new Error(`Expected at least 3 chunks, got ${results.length}`);
    const paths = new Set(results.map(r => r.path));
    if (!paths.has('src/middleware.ts') || !paths.has('src/large.ts')) {
        throw new Error("Failed to return multiple relevant files.");
    }
    console.log("[PASS] Test A & B: Basic search returned expected files without arbitrary semantic limits.");

    // Test C — Ranking
    const exactQuery = retriever.search('authentication middleware');
    if (exactQuery[0].path !== 'src/middleware.ts') {
        throw new Error("Ranking failure: Exact phrase match did not rank first.");
    }
    console.log("[PASS] Test C: Ranking (BM25) correctly prioritized the exact match.");

    // Test D — Multiple chunks
    const largeFileMatches = results.filter(r => r.path === 'src/large.ts');
    if (largeFileMatches.length < 2) {
        throw new Error("Failed to return multiple distinct chunks for the same file.");
    }
    console.log("[PASS] Test D: Multiple chunks extracted effectively from a single file.");

    // Test E — Query safety
    try {
        const unsafeResults = retriever.search('auth* (middleware) OR "drop table" ;');
        if (!Array.isArray(unsafeResults)) throw new Error("Unsafe query did not return an array.");
        console.log("[PASS] Test E: Query safety - control characters escaped safely.");
    } catch (e) {
        throw new Error("Query safety failed: " + e);
    }

    // Test F — Determinism
    const run1 = retriever.search('authentication');
    const run2 = retriever.search('authentication');
    if (JSON.stringify(run1) !== JSON.stringify(run2)) {
        throw new Error("Retriever output is not deterministic.");
    }
    console.log("[PASS] Test F: Determinism - Identical queries produce identical output order.");

    // Test G & H — Context Budget & Progressive Context
    const engine = new ContextEngine(TEST_DIR, retriever);
    const context = engine.generateContext('authentication');
    
    if (context.budgetInfo.totalTokens > 200) {
        throw new Error(`Context Engine exceeded budget! Total: ${context.budgetInfo.totalTokens}`);
    }
    if (context.chunks.length === results.length) {
        throw new Error("Context Engine failed to prune chunks to fit budget.");
    }
    console.log(`[PASS] Test G & H: Context Budget and Progressive selection respected (${context.budgetInfo.totalTokens}/200).`);

    // Test I — Layer separation (Static analysis of the Engine source code)
    const engineSource = fs.readFileSync(path.join(__dirname, '../src/core/context/engine.ts'), 'utf-8');
    if (engineSource.includes('better-sqlite3') || engineSource.includes('indexer/db')) {
        throw new Error("Layer Separation Violation: Context Engine directly imports SQLite or persistence layer.");
    }
    console.log("[PASS] Test I: Layer separation verified via source inspection (ContextEngine does not import DB).");

    // Test J — Project-state-over-budget handling
    fs.writeFileSync(path.join(TEST_DIR, '.framer', 'config.json'), JSON.stringify({ tokenBudget: 20 }));
    // Force project.md to be larger than 20 tokens
    fs.writeFileSync(path.join(TEST_DIR, '.framer', 'project.md'), 'X'.repeat(500)); 
    
    const strictEngine = new ContextEngine(TEST_DIR, retriever);
    const strictContext = strictEngine.generateContext('authentication');
    
    if (strictContext.budgetInfo.totalTokens > 20) {
        throw new Error(`Project state truncation failed. Budget was 20, used: ${strictContext.budgetInfo.totalTokens}`);
    }
    if (!strictContext.stateContent.includes('truncated')) {
        throw new Error("Missing truncation warning in state content.");
    }
    console.log(`[PASS] Test J: Project state exceeding budget correctly truncated (${strictContext.budgetInfo.totalTokens}/20 tokens).`);

    console.log("=== Phase 3 Validation Complete ===");
}

runPhase3Tests();