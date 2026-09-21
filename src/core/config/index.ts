// src/core/config/index.ts
import fs from 'fs';
import path from 'path';

export interface FramerConfig {
    tokenBudget: number;
    ignore: string[];
}

export function getConfig(repoRoot: string): FramerConfig {
    const defaultConfig: FramerConfig = { tokenBudget: 12000, ignore: [] };
    try {
        const configPath = path.join(repoRoot, '.framer', 'config.json');
        if (fs.existsSync(configPath)) {
            const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return { ...defaultConfig, ...parsed };
        }
    } catch (e) {
        // Fallback to default if config is missing or malformed
    }
    return defaultConfig;
}