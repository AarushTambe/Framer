// src/cli/commands/init.ts
import fs from 'fs';
import path from 'path';

export function runInit(repoRoot: string) {
    const framerDir = path.join(repoRoot, '.framer');
    if (!fs.existsSync(framerDir)) {
        fs.mkdirSync(framerDir);
    }

    const defaultFiles = {
        'project.md': '# Project\n\nHigh-level architecture and purpose.',
        'tasks.md': '# Tasks\n\n## Current\n\n## Next',
        'decisions.md': '# Decisions\n\nArchitectural decisions log.',
        'config.json': JSON.stringify({ tokenBudget: 12000, ignore: [] }, null, 2)
    };

    for (const [file, content] of Object.entries(defaultFiles)) {
        const filePath = path.join(framerDir, file);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, content, 'utf-8');
        }
    }

    // Safely append to .gitignore
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const ignoreEntry = '.framer/index.db\n';
    
    if (fs.existsSync(gitignorePath)) {
        const currentIgnore = fs.readFileSync(gitignorePath, 'utf-8');
        if (!currentIgnore.includes('.framer/index.db')) {
            fs.appendFileSync(gitignorePath, `\n# Framer Cache\n${ignoreEntry}`);
        }
    } else {
        fs.writeFileSync(gitignorePath, ignoreEntry);
    }
    
    console.log("Framer initialized successfully. Project state files created in .framer/");
}