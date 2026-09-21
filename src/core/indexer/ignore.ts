// src/core/indexer/ignore.ts
import fs from 'fs';
import path from 'path';
import ignore, { Ignore } from 'ignore';

export function getIgnorer(repoRoot: string): Ignore {
    const ig = ignore();
    
    // Core Framer ignores
    ig.add(['.git', '.framer', 'node_modules', 'dist', 'build']);
    
    const gitignorePath = path.join(repoRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        ig.add(gitignoreContent);
    }
    
    return ig;
}