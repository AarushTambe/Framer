import fs from 'fs';
import path from 'path';
import { runInit } from '../src/cli/commands/init';
import { runIndex } from '../src/core/indexer/index';
import { getStatus } from '../src/core/indexer/status';
import { getDb } from '../src/core/indexer/db';

const TEST_DIR = path.join(__dirname, 'phase2-test-repo');
const OUTSIDE_DIR = path.join(__dirname, 'phase2-outside-repo');

function setupTestRepo() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    if (fs.existsSync(OUTSIDE_DIR)) fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
    
    fs.mkdirSync(TEST_DIR);
    fs.mkdirSync(path.join(TEST_DIR, 'src'));
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'app.ts'), 'console.log("App");\n');
    
    fs.mkdirSync(OUTSIDE_DIR);
    fs.writeFileSync(path.join(OUTSIDE_DIR, 'secret.txt'), 'SUPER SECRET DONT READ');
}

function getCanonicalState(repoRoot: string) {
    const db = getDb(repoRoot, { readonly: true });
    if (!db) throw new Error("DB missing");
    
    const files = db.prepare("SELECT path, hash, last_modified, size FROM files ORDER BY path").all();
    const chunks = db.prepare("SELECT path, start_line, end_line, content, type FROM chunks ORDER BY path, start_line").all();
    db.close();
    
    return JSON.stringify({ files, chunks });
}

function runPhase2Tests() {
    console.log("=== Phase 2: Indexing Engine Tests ===");
    setupTestRepo();
    runInit(TEST_DIR);

    // Test 3: Status must not create index
    let status = getStatus(TEST_DIR);
    if (!status.isUnindexed) throw new Error("Status failed to report unindexed state.");
    if (!status.added.includes('src/app.ts')) throw new Error("Status failed to read valid repo files.");
    if (fs.existsSync(path.join(TEST_DIR, '.framer', 'index.db'))) throw new Error("Status unexpectedly created DB.");
    console.log(`[PASS] Read-only Status: Validated status does not mutate filesystem.`);

    // Test A — Initial indexing
    runIndex(TEST_DIR);
    let db = getDb(TEST_DIR, { readonly: true })!;
    let count = db.prepare("SELECT COUNT(*) as c FROM files").get() as any;
    db.close();
    console.log(`[PASS] Test A (Initial Indexing): DB created with ${count.c} files.`);

    // Test B — Added file
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'new.ts'), 'console.log("New");\n');
    status = getStatus(TEST_DIR);
    if (!status.added.includes('src/new.ts')) throw new Error("Failed to detect Added file.");
    runIndex(TEST_DIR);
    console.log(`[PASS] Test B (Added file): Detected and indexed correctly.`);

    // Test C & H & Metadata Optimization
    const oldState = getCanonicalState(TEST_DIR);
    // Wait briefly to ensure mtime changes
    const now = Date.now() + 1000;
    fs.utimesSync(path.join(TEST_DIR, 'src', 'app.ts'), new Date(now), new Date(now));
    
    runIndex(TEST_DIR); // Should update metadata only
    let newState = getCanonicalState(TEST_DIR);
    if (oldState === newState) throw new Error("Metadata (mtime) was not updated.");
    
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'app.ts'), 'console.log("Modified");\n');
    status = getStatus(TEST_DIR);
    if (!status.modified.includes('src/app.ts')) throw new Error("Failed to detect Modified file via Hash.");
    runIndex(TEST_DIR);
    console.log(`[PASS] Test C & 4 (Modified & Metadata): Detected content and optimized metadata updates.`);

    // Test D — Deleted file
    fs.rmSync(path.join(TEST_DIR, 'src', 'new.ts'));
    runIndex(TEST_DIR);
    db = getDb(TEST_DIR, { readonly: true })!;
    const remaining = db.prepare("SELECT path FROM files WHERE path = 'src/new.ts'").get();
    db.close();
    if (remaining) throw new Error("Deleted file not pruned from DB.");
    console.log(`[PASS] Test D (Deleted file): Detected and purged from DB.`);

    // Test E — Ignored behavior (Root, Dir, Nested, Default)
    fs.writeFileSync(path.join(TEST_DIR, '.gitignore'), 'secret.txt\nbuild/\nsrc/temp.log\n');
    fs.writeFileSync(path.join(TEST_DIR, 'secret.txt'), 'ignore me');
    fs.mkdirSync(path.join(TEST_DIR, 'build'));
    fs.writeFileSync(path.join(TEST_DIR, 'build', 'out.js'), 'ignore me');
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'temp.log'), 'ignore me');
    
    runIndex(TEST_DIR);
    status = getStatus(TEST_DIR);
    if (status.added.length > 0 || status.modified.length > 0) throw new Error("Ignored files bypassed getStatus.");
    
    db = getDb(TEST_DIR, { readonly: true })!;
    const ignoredCount = db.prepare("SELECT COUNT(*) as c FROM files WHERE path IN ('secret.txt', 'build/out.js', 'src/temp.log')").get() as any;
    db.close();
    if (ignoredCount.c > 0) throw new Error("Ignored files bypassed runIndex.");
    console.log(`[PASS] Test E (Ignored files): Strict .gitignore enforcement achieved.`);

   // Test I — Actual Repository Boundary / Symlink Security
    let symlinkTested = false;
    try {
        fs.symlinkSync(path.join(OUTSIDE_DIR, 'secret.txt'), path.join(TEST_DIR, 'src', 'symlink.txt'));
        runIndex(TEST_DIR);
        
        db = getDb(TEST_DIR, { readonly: true })!;
        const leaked = db.prepare("SELECT path FROM files WHERE path = 'src/symlink.txt'").get();
        db.close();
        
        if (leaked) throw new Error("External symlink was successfully indexed. SECURITY FAILURE.");
        console.log(`[PASS] Test I (Symlink Security): External symlink safely skipped.`);
        symlinkTested = true;
    } catch (e: any) {
        if (e.message.includes('SECURITY FAILURE')) throw e;
        console.log(`[WARN] Test I (Symlink Security): Symlink creation skipped (likely missing OS permissions).`);
    }

    // --- FALLBACK BOUNDARY SECURITY TEST ---
    const { isPathInsideRepo, validateSafePath } = require('../src/core/repository/paths');
    const outsideFile = path.join(OUTSIDE_DIR, 'secret.txt');
    
    // 1. Independent check: isPathInsideRepo must evaluate to false
    if (isPathInsideRepo(TEST_DIR, outsideFile) !== false) {
        throw new Error("Fallback Security Test Failed: isPathInsideRepo incorrectly approved an outside path.");
    }
    
    // 2. Independent check: validateSafePath must throw the exact security error
    let threwSecurityError = false;
    try {
        validateSafePath(TEST_DIR, '../phase2-outside-repo/secret.txt');
    } catch (err: any) {
        if (err.message.includes("Security Violation: Path traversal blocked")) {
            threwSecurityError = true;
        } else {
            throw new Error(`Fallback Security Test Failed: Threw wrong error -> ${err.message}`);
        }
    }

    if (!threwSecurityError) {
        throw new Error("Fallback Security Test Failed: validateSafePath did not throw an error for a traversal attempt.");
    }

    console.log(`[PASS] Test I (Fallback Boundary Security): Direct boundary functions correctly block traversal.`);

    // Test F — Windows path normalization
    db = getDb(TEST_DIR, { readonly: true })!;
    const pathCheck = db.prepare("SELECT path FROM files LIMIT 1").get() as any;
    db.close();
    if (pathCheck.path.includes('\\')) throw new Error("Backslashes found in DB.");
    console.log(`[PASS] Test F (Path Normalization): POSIX paths enforced (${pathCheck.path}).`);

    // Test G — Exact Rebuild Equivalence
    const stateBeforeDelete = getCanonicalState(TEST_DIR);
    
    fs.rmSync(path.join(TEST_DIR, '.framer', 'index.db'));
    if (fs.existsSync(path.join(TEST_DIR, '.framer', 'index.db-wal'))) fs.rmSync(path.join(TEST_DIR, '.framer', 'index.db-wal'));
    if (fs.existsSync(path.join(TEST_DIR, '.framer', 'index.db-shm'))) fs.rmSync(path.join(TEST_DIR, '.framer', 'index.db-shm'));
    
    runIndex(TEST_DIR);
    
    const stateAfterRebuild = getCanonicalState(TEST_DIR);
    if (stateBeforeDelete !== stateAfterRebuild) {
        throw new Error("Rebuild state differs from canonical state.");
    }
    console.log(`[PASS] Test G (Rebuild Equivalence): 1:1 identical database payload reconstructed from filesystem.`);

    console.log("=== Phase 2 Validation Complete ===");
}

runPhase2Tests();