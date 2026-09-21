// src/cli/commands/indexCmd.ts
import { runIndex as coreIndex } from '../../core/indexer/index';

export function runIndex(repoRoot: string) {
    console.log('Indexing repository...');
    coreIndex(repoRoot);
    console.log('Index update complete.');
}