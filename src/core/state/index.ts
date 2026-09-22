import fs from 'fs';
import path from 'path';

export function getProjectState(repoRoot: string): string {
    const stateFiles = ['project.md', 'tasks.md', 'decisions.md'];
    return stateFiles
        .map(f => {
            const fp = path.join(repoRoot, '.framer', f);
            return fs.existsSync(fp) ? `### ${f}\n${fs.readFileSync(fp, 'utf-8')}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}