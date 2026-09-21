// src/cli/commands/status.ts
import { getStatus } from '../../core/indexer/status';

export function runStatus(repoRoot: string) {
    console.log('Checking repository status against local index...\n');
    
    const status = getStatus(repoRoot);
    
    if (status.added.length === 0 && status.modified.length === 0 && status.deleted.length === 0) {
        console.log('Index is up to date with the working tree.');
        return;
    }

    if (status.added.length > 0) {
        console.log('Added:');
        status.added.forEach(file => console.log(`  + ${file}`));
    }
    
    if (status.modified.length > 0) {
        console.log('Modified:');
        status.modified.forEach(file => console.log(`  ~ ${file}`));
    }
    
    if (status.deleted.length > 0) {
        console.log('Deleted:');
        status.deleted.forEach(file => console.log(`  - ${file}`));
    }
    
    console.log('\nRun `framer index` to update the local cache.');
}