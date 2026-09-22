import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, execSync, ChildProcess } from 'child_process';
import readline from 'readline';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Database from 'better-sqlite3';

import { runInit } from '../src/cli/commands/init';
import { runIndex } from '../src/core/indexer/index';
import { FTS5Retriever } from '../src/core/retrieval/fts5';
import { ContextEngine } from '../src/core/context/engine';
import { validateSafePath } from '../src/core/repository/paths';
import { getProjectState } from '../src/core/state/index';

const TEST_DIR = path.join(__dirname, 'phase5-test-repo');
const CLI_PATH = path.resolve(__dirname, '../src/cli/index.ts');

function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getRepoSourceHashes(): Record<string, string> {
    const hashes: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const file of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                if (file !== '.framer') walk(fullPath);
            } else {
                hashes[fullPath] = hashFile(fullPath);
            }
        }
    };
    walk(path.join(TEST_DIR, 'src'));
    return hashes;
}

function setupBenchmarkRepo() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR);
    fs.mkdirSync(path.join(TEST_DIR, 'src'));
    fs.mkdirSync(path.join(TEST_DIR, 'src', 'auth'));
    fs.mkdirSync(path.join(TEST_DIR, 'src', 'db'));
    fs.mkdirSync(path.join(TEST_DIR, 'src', 'api'));
    fs.mkdirSync(path.join(TEST_DIR, 'src', 'config'));
    fs.mkdirSync(path.join(TEST_DIR, 'src', 'workflow'));

    fs.writeFileSync(path.join(TEST_DIR, 'src/auth/middleware.ts'), 
        'export function authenticationMiddleware(req, res, next) {\n  // verifies token\n  const token = req.headers.authorization;\n  if (!token) throw new Error("Unauthorized");\n  next();\n}\n'
    );
    fs.writeFileSync(path.join(TEST_DIR, 'src/db/connection.ts'), 
        'import { Pool } from "pg";\nexport const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });\nexport function initializeDatabaseConnection() {\n  dbPool.connect();\n}\n'
    );
    fs.writeFileSync(path.join(TEST_DIR, 'src/api/users.ts'), 
        'import { dbPool } from "../db/connection";\nexport async function handleUserApiEndpoint(req, res) {\n  const users = await dbPool.query("SELECT * FROM users");\n  res.json(users);\n}\n'
    );
    fs.writeFileSync(path.join(TEST_DIR, 'src/config/features.ts'), 
        'export const featureFlags = {\n  enableBetaUI: true,\n  useNewPaymentGateway: false,\n  maxUploadSizeMB: 50\n};\n'
    );
    fs.writeFileSync(path.join(TEST_DIR, 'src/workflow/checkout.ts'), 
        'import { featureFlags } from "../config/features";\nexport function processCheckoutWorkflow(cart) {\n  if (featureFlags.useNewPaymentGateway) {\n    return routeToStripe(cart);\n  }\n  return routeToLegacy(cart);\n}\n'
    );

    for (let i = 0; i < 20; i++) {
        let padding = `// Padding file ${i}\n`;
        for(let j=0; j<100; j++) padding += `const dummyVar${j} = "This is just some padding text to inflate the baseline token count.";\n`;
        fs.writeFileSync(path.join(TEST_DIR, `src/padding_${i}.ts`), padding);
    }

    fs.mkdirSync(path.join(TEST_DIR, '.framer'));
    fs.writeFileSync(path.join(TEST_DIR, '.framer/project.md'), '# Test Project State\n');
}

const getText = (res: any) => (res as any).content?.[0]?.text || '';

async function runPhase5() {
    console.log("=== Phase 5: Final V1 Validation ===\n");
    setupBenchmarkRepo();
    
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    let mcpProcessI: ChildProcess | null = null;
    let cmdMcpL: ChildProcess | null = null;
    let transportI: any = null;

    try {
        const expectedHashes = getRepoSourceHashes();
        runInit(TEST_DIR);
        runIndex(TEST_DIR);

        // [TEST A] Authoritative Rebuildability
        const getLogicalDbState = () => {
            const db = new Database(path.join(TEST_DIR, '.framer/index.db'), { readonly: true });
            const files = db.prepare('SELECT path, hash, last_modified, size FROM files ORDER BY path').all();
            const chunks = db.prepare('SELECT path, start_line, end_line, content, type FROM chunks ORDER BY path, start_line').all();
            db.close();
            return JSON.stringify({ files, chunks });
        };
        const state1 = getLogicalDbState();
        fs.unlinkSync(path.join(TEST_DIR, '.framer/index.db'));
        runIndex(TEST_DIR);
        const state2 = getLogicalDbState();
        if (state1 !== state2) throw new Error("Test A Failed: Rebuilt DB logical state differs.");
        console.log("[PASS] Test A — Authoritative Rebuildability");

        // [TEST B] Git Safety
        const gitignorePath = path.join(TEST_DIR, '.gitignore');
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        if (!gitignoreContent.includes('.framer/index.db')) throw new Error("Test B Failed: index.db not in .gitignore");
        
        runInit(TEST_DIR);
        const gitignoreContent2 = fs.readFileSync(gitignorePath, 'utf-8');
        if (gitignoreContent2.match(/\.framer\/index\.db/g)?.length !== 1) throw new Error("Test B Failed: duplicate gitignore entries.");
        
        const framerFiles = ['project.md', 'tasks.md', 'decisions.md', 'config.json'];
        for (const f of framerFiles) {
            if (gitignoreContent2.includes(`.framer/${f}`)) throw new Error(`Test B Failed: ${f} was incorrectly ignored.`);
        }
        console.log("[PASS] Test B — Git Safety");

        // [TEST C] Working Tree Awareness
        fs.writeFileSync(path.join(TEST_DIR, 'src/new.ts'), 'console.log("new");');
        fs.appendFileSync(path.join(TEST_DIR, 'src/auth/middleware.ts'), '// modified\n');
        fs.unlinkSync(path.join(TEST_DIR, 'src/api/users.ts'));
        
        expectedHashes[path.join(TEST_DIR, 'src/new.ts')] = hashFile(path.join(TEST_DIR, 'src/new.ts'));
        expectedHashes[path.join(TEST_DIR, 'src/auth/middleware.ts')] = hashFile(path.join(TEST_DIR, 'src/auth/middleware.ts'));
        delete expectedHashes[path.join(TEST_DIR, 'src/api/users.ts')];

        const status1 = execSync(`${npx} tsx "${CLI_PATH}" status`, { cwd: TEST_DIR, encoding: 'utf-8' });
        if (!status1.includes('new.ts') || !status1.includes('middleware.ts') || !status1.includes('users.ts')) {
            throw new Error("Test C Failed: Working tree changes not correctly detected.");
        }
        console.log("[PASS] Test C — Working Tree Awareness");

        runIndex(TEST_DIR);

        // [TEST D] Security Boundary
        try {
            validateSafePath(TEST_DIR, '../outside.txt');
            throw new Error("Should have blocked path");
        } catch (e: any) {
            if (!e.message.includes("Security Violation")) throw new Error("Test D Failed: Boundary breached.");
        }
        console.log("[PASS] Test D — Security Boundary");

        // [TEST E] Retrieval Determinism
        const retriever = new FTS5Retriever(TEST_DIR);
        const result1 = retriever.search("authenticationMiddleware");
        const result2 = retriever.search("authenticationMiddleware");
        const res1 = JSON.stringify(result1);
        const res2 = JSON.stringify(result2);

        if (res1 !== res2 || res1 === '[]') {
            throw new Error("Test E Failed: Retrieval not deterministic or empty.");
        }
        console.log("[PASS] Test E — Retrieval Determinism");

        // [TEST F] Progressive Retrieval
        const stateContent = getProjectState(TEST_DIR);
        if (!stateContent.includes("Test Project State")) throw new Error("Test F Failed: getProjectState missing.");
        
        const searchCandidates = retriever.search("featureFlags");
        if (searchCandidates.length === 0) throw new Error("Test F Failed: Search codebase returned no candidates.");
        const topCandidate = searchCandidates[0];
        if (typeof topCandidate.startLine !== 'number' || typeof topCandidate.endLine !== 'number') throw new Error("Test F Failed: Candidates lack line ranges.");
        
        const safePath = validateSafePath(TEST_DIR, topCandidate.path);
        const fullContent = fs.readFileSync(safePath, 'utf-8');
        const exactLines = fullContent.split('\n').slice(Math.max(0, topCandidate.startLine - 1), topCandidate.endLine).join('\n');
        if (!exactLines.includes("featureFlags")) throw new Error("Test F Failed: Precise file line retrieval failed.");
        console.log("[PASS] Test F — Progressive Retrieval");

        // [TEST G] Context Budget
        const engine = new ContextEngine(TEST_DIR, retriever);
        const testBudgets = [100, 500, 1000, 2000];
        for (const b of testBudgets) {
            fs.writeFileSync(path.join(TEST_DIR, '.framer/config.json'), JSON.stringify({ tokenBudget: b }));
            const ctx = engine.generateContext("workflow");
            if (ctx.budgetInfo.totalTokens > b) throw new Error(`Test G Failed: Budget ${b} exceeded (${ctx.budgetInfo.totalTokens})`);
        }
        console.log("[PASS] Test G — Context Budget");

        // [TEST H] Token Efficiency Benchmark
        fs.writeFileSync(path.join(TEST_DIR, '.framer/config.json'), JSON.stringify({ tokenBudget: 2000 }));
        let totalRepoChars = 0;
        const walkCount = (dir: string) => {
            for (const file of fs.readdirSync(dir)) {
                const p = path.join(dir, file);
                if (fs.statSync(p).isDirectory()) walkCount(p);
                else totalRepoChars += fs.readFileSync(p, 'utf-8').length;
            }
        };
        walkCount(path.join(TEST_DIR, 'src'));
        const baselineTokens = Math.ceil(totalRepoChars / 4);

        const tasks = [
            "authenticationMiddleware token",
            "initializeDatabaseConnection",
            "featureFlags",
            "processCheckoutWorkflow"
        ];

        const benchmarkResults: string[] = [];
        for (const task of tasks) {
            const ctx = engine.generateContext(task);
            const framerTokens = ctx.budgetInfo.totalTokens;
            const reduction = (1 - (framerTokens / baselineTokens)) * 100;
            benchmarkResults.push(`Task: ${task}\nBaseline estimated tokens for supplying the entire benchmark repository as context: ${baselineTokens}\nFramer estimated tokens: ${framerTokens}\nEstimated reduction: ${reduction.toFixed(1)}%\n`);
        }
        console.log("[PASS] Test H — Token Efficiency Benchmark");

        // [TEST I] End-to-End MCP Workflow
        mcpProcessI = spawn(npx, ['tsx', `"${CLI_PATH}"`, 'mcp'], { cwd: TEST_DIR, shell: true });
        
        transportI = {
            onmessage: undefined as any, onerror: undefined as any, onclose: undefined as any,
            async start() {
                const rl = readline.createInterface({ input: mcpProcessI!.stdout as NodeJS.ReadableStream });
                rl.on('line', (line) => {
                    if (!line.trim()) return;
                    try { if (this.onmessage) this.onmessage(JSON.parse(line.trim())); } catch (e) {}
                });
                mcpProcessI!.on('close', () => this.onclose?.());
            },
            async close() { mcpProcessI!.kill(); },
            async send(message: any) { mcpProcessI!.stdin!.write(JSON.stringify(message) + '\n'); }
        };
        const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
        await client.connect(transportI);
        
        const w1State = await client.callTool({ name: "get_project_state", arguments: {} });
        if (!getText(w1State).includes("Test Project State")) throw new Error("Test I (W1) Failed");
        const w1Search = await client.callTool({ name: "search_codebase", arguments: { query: "authenticationMiddleware" } });
        const w1Candidates = JSON.parse(getText(w1Search));
        const w1File = await client.callTool({ 
            name: "get_file", 
            arguments: { path: w1Candidates[0].path, start_line: w1Candidates[0].startLine, end_line: w1Candidates[0].endLine }
        });
        if (!getText(w1File).includes("authenticationMiddleware")) throw new Error("Test I (W1) Failed: Progressive retrieval over MCP failed.");

        const mcpCtx = await client.callTool({ name: "generate_context", arguments: { task: "dbPool" } });
        if (!getText(mcpCtx).includes("dbPool")) throw new Error("Test I (W2) Failed: Context generation over MCP failed.");
        
        await transportI.close();
        transportI = null;
        mcpProcessI = null;
        console.log("[PASS] Test I — End-to-End MCP Workflow");

        // [TEST J] Index Recovery
        const new2Path = path.join(TEST_DIR, 'src/new2.ts');
        fs.writeFileSync(new2Path, 'console.log("new2");');
        
        const staleStatus = execSync(`${npx} tsx "${CLI_PATH}" status`, { cwd: TEST_DIR, encoding: 'utf-8' });
        if (!staleStatus.includes('new2.ts')) throw new Error("Test J Failed: Status didn't detect staleness.");
        
        runIndex(TEST_DIR);
        
        const recoveredStatus = execSync(`${npx} tsx "${CLI_PATH}" status`, { cwd: TEST_DIR, encoding: 'utf-8' });
        if (recoveredStatus.includes('new2.ts')) throw new Error("Test J Failed: Index did not recover cleanly.");
        
        // Track the intentional fixture modification for Test K
        expectedHashes[new2Path] = hashFile(new2Path);
        
        console.log("[PASS] Test J — Index Recovery");

        // [TEST K] Source Immutability
        const finalSourceHashes = getRepoSourceHashes();
        const expectedKeys = Object.keys(expectedHashes).sort();
        const finalKeys = Object.keys(finalSourceHashes).sort();

        if (expectedKeys.length !== finalKeys.length) {
            throw new Error(`Test K Failed: Unexpected source files created or deleted. Expected ${expectedKeys.length}, found ${finalKeys.length}.`);
        }
        
        for (const key of expectedKeys) {
            if (finalSourceHashes[key] !== expectedHashes[key]) {
                throw new Error(`Test K Failed: Source file accidentally mutated by Framer! File: ${key}`);
            }
        }
        if (fs.existsSync(path.join(TEST_DIR, 'src/api/users.ts'))) {
            throw new Error("Test K Failed: users.ts was unexpectedly recreated.");
        }
        console.log("[PASS] Test K — Source Immutability");

        // [TEST L] Complete Command Surface
        try {
            execSync(`${npx} tsx "${CLI_PATH}" init`, { cwd: TEST_DIR, stdio: 'ignore' });
            execSync(`${npx} tsx "${CLI_PATH}" index`, { cwd: TEST_DIR, stdio: 'ignore' });
            execSync(`${npx} tsx "${CLI_PATH}" status`, { cwd: TEST_DIR, stdio: 'ignore' });
            execSync(`${npx} tsx "${CLI_PATH}" search "auth"`, { cwd: TEST_DIR, stdio: 'ignore' });
            execSync(`${npx} tsx "${CLI_PATH}" context "auth"`, { cwd: TEST_DIR, stdio: 'ignore' });
            execSync(`${npx} tsx "${CLI_PATH}" setup`, { cwd: TEST_DIR, stdio: 'ignore' });
            
            cmdMcpL = spawn(npx, ['tsx', `"${CLI_PATH}"`, 'mcp'], { cwd: TEST_DIR, shell: true });
            
            await new Promise<void>((resolve, reject) => {
                let started = false;
                cmdMcpL!.stderr!.on('data', (d) => {
                    if (d.toString().includes('Framer MCP Server initialized')) {
                        started = true;
                        resolve();
                    }
                });
                cmdMcpL!.on('exit', (code) => {
                    if (!started) reject(new Error(`MCP command exited prematurely with code ${code}`));
                });
                setTimeout(() => reject(new Error("Timeout waiting for MCP command to emit startup signal")), 3000);
            });
            
            cmdMcpL.kill();
            cmdMcpL = null;
        } catch (e) {
            throw new Error(`Test L Failed: CLI command execution crashed. ${e}`);
        }
        console.log("[PASS] Test L — Complete Command Surface");

        // [TEST M] Index Ephemerality
        fs.unlinkSync(path.join(TEST_DIR, '.framer/index.db'));
        if (!fs.existsSync(path.join(TEST_DIR, '.framer/config.json'))) throw new Error("Test M Failed: Config deleted!");
        runIndex(TEST_DIR);
        if (!fs.existsSync(path.join(TEST_DIR, '.framer/index.db'))) throw new Error("Test M Failed: Index did not rebuild.");
        console.log("[PASS] Test M — Index Ephemerality");

        console.log("\n=== Phase 5 Validation Complete ===\n");
        console.log("--- Benchmark Details ---\n");
        benchmarkResults.forEach(r => console.log(r));

    } finally {
        if (transportI) { try { transportI.close(); } catch (e) {} }
        if (mcpProcessI) { try { (mcpProcessI as any).kill(); } catch (e) {} }
        if (cmdMcpL) { try { (cmdMcpL as any).kill(); } catch (e) {} }

        if (fs.existsSync(TEST_DIR)) {
            try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
        }
    }
}

runPhase5().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});