// tests/benchmark.ts
import fs from 'fs';
import path from 'path';
import { runInit } from '../src/cli/commands/init';
import { runIndex } from '../src/core/indexer/index';
import { getStatus } from '../src/core/indexer/status';
import { generateContext } from '../src/core/context/engine';

// FIX: Point to the new repository module instead of mcp/tools
import { validateSafePath } from '../src/core/repository/paths'; 

const TEST_DIR = path.join(__dirname, 'test-repo');

function setupTestRepo() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR);
    fs.mkdirSync(path.join(TEST_DIR, 'src'));
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'auth.ts'), 'export function verifyJWT(token: string) { return true; }\n');
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'main.ts'), 'import { verifyJWT } from "./auth";\nverifyJWT("abc");\n');
}

function runBenchmark() {
    console.log("=== Running Framer Validation ===");
    setupTestRepo();

    // 1. Safe gitignore & scaffolding
    runInit(TEST_DIR);
    if (!fs.existsSync(path.join(TEST_DIR, '.framer', 'project.md'))) throw new Error("Scaffold failed");
    if (!fs.readFileSync(path.join(TEST_DIR, '.gitignore'), 'utf-8').includes('.framer/index.db')) throw new Error("Gitignore update failed");
    console.log("✔ Scaffolding and gitignore override passed.");

    // 2. Incremental Index & Authoritative Status
    runIndex(TEST_DIR);
    if (!fs.existsSync(path.join(TEST_DIR, '.framer', 'index.db'))) throw new Error("Index creation failed");

    fs.writeFileSync(path.join(TEST_DIR, 'src', 'auth.ts'), 'export function verifyJWT(token: string) { return false; }\n');
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'new.ts'), 'console.log();\n');
    fs.rmSync(path.join(TEST_DIR, 'src', 'main.ts'));
    
    const status = getStatus(TEST_DIR);
    if (!status.modified.includes('src/auth.ts')) throw new Error("Status failed to catch modification");
    if (!status.added.includes('src/new.ts')) throw new Error("Status failed to catch addition");
    if (!status.deleted.includes('src/main.ts')) throw new Error("Status failed to catch deletion");
    console.log("✔ Incremental status diffing passed.");
    
    runIndex(TEST_DIR); // Re-index properly applies updates.

    // 3. Path Traversal Boundary Security
    try {
        validateSafePath(TEST_DIR, '../auth.ts');
        throw new Error("Path traversal should have thrown");
    } catch (e: any) {
        if (!e.message.includes("Security Violation")) throw e;
    }
    console.log("✔ Path boundary security passed.");

    // 4. Progressive / Token Efficiency Benchmark
    const manualContext = "src/auth.ts\n" + fs.readFileSync(path.join(TEST_DIR, 'src', 'auth.ts'), 'utf-8') + "\nsrc/new.ts\n" + fs.readFileSync(path.join(TEST_DIR, 'src', 'new.ts'), 'utf-8');
    const framerContext = generateContext(TEST_DIR, "verify token");
    
    console.log(`\nManual Context Size (Naive): ${manualContext.length} chars`);
    console.log(`Framer Dynamic Context Size: ${framerContext.length} chars`);
    console.log("✔ Validation complete.");
}

runBenchmark();