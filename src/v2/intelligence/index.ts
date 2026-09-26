// src/v2/intelligence/index.ts
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getIgnorer } from '../../core/indexer/ignore';
import { isPathInsideRepo, validateSafePath } from '../../core/repository/paths';
import {
    CodeIntelligenceProvider,
    EntryPointRecord,
    FileIntelligence,
    ImportEdge,
    ReferenceLocation,
    RelatedTestRecord,
    SymbolRecord,
    detectLanguage,
    sortImportsDeterministically,
    sortReferencesDeterministically,
    sortSymbolsDeterministically,
    toPosixPath,
} from '../providers/interface';
import { TsMorphSemanticAdapter } from '../providers/semantic/TsMorphSemanticAdapter';
import { TreeSitterSyntaxAdapter } from '../providers/syntax/TreeSitterSyntaxAdapter';

export class RepositoryIntelligenceService {
    private semanticProvider: CodeIntelligenceProvider;
    private syntaxProvider: CodeIntelligenceProvider;
    private fileCache = new Map<string, FileIntelligence>();
    private discoveredFiles: string[] = [];
    private isInitialized = false;

    constructor(
        private repoRoot: string,
        options?: {
            semanticProvider?: CodeIntelligenceProvider;
            syntaxProvider?: CodeIntelligenceProvider;
        }
    ) {
        this.semanticProvider = options?.semanticProvider ?? new TsMorphSemanticAdapter(repoRoot);
        this.syntaxProvider = options?.syntaxProvider ?? new TreeSitterSyntaxAdapter(repoRoot);
    }

    private hashFileContent(fullPath: string): string {
        const buf = fs.readFileSync(fullPath);
        return crypto.createHash('sha256').update(buf).digest('hex');
    }

    public refreshRepository(): void {
        const ig = getIgnorer(this.repoRoot);
        const files: string[] = [];

        const traverse = (currentDir: string, isRoot: boolean) => {
            if (!fs.existsSync(currentDir)) return;

            if (!isRoot && fs.existsSync(path.join(currentDir, '.framer'))) {
                return;
            }

            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                const relPath = toPosixPath(path.relative(this.repoRoot, fullPath));

                if (ig.ignores(relPath)) continue;

                if (
                    relPath.startsWith('tests/') &&
                    entry.isDirectory() &&
                    (entry.name === 'test-repo' || entry.name.endsWith('-repo'))
                ) {
                    continue;
                }

                const lstat = fs.lstatSync(fullPath);
                if (lstat.isSymbolicLink() && !isPathInsideRepo(this.repoRoot, fullPath)) continue;
                if (!lstat.isSymbolicLink() && !isPathInsideRepo(this.repoRoot, fullPath)) continue;

                if (entry.isDirectory()) {
                    traverse(fullPath, false);
                } else {
                    const lang = detectLanguage(relPath);
                    if (lang !== 'unknown') {
                        files.push(relPath);
                    }
                }
            }
        };

        traverse(this.repoRoot, true);
        files.sort((a, b) => a.localeCompare(b));
        this.discoveredFiles = files;

        this.semanticProvider.syncRepositoryFiles(this.discoveredFiles);
        this.syntaxProvider.syncRepositoryFiles(this.discoveredFiles);

        const activeSet = new Set(this.discoveredFiles);
        for (const cachedPath of Array.from(this.fileCache.keys())) {
            if (!activeSet.has(cachedPath)) {
                this.fileCache.delete(cachedPath);
            }
        }

        for (const relPath of this.discoveredFiles) {
            this.ensureFileAnalyzed(relPath);
        }

        this.isInitialized = true;
    }

    private ensureInitialized(): void {
        if (!this.isInitialized) {
            this.refreshRepository();
        }
    }

    private ensureFileAnalyzed(relPath: string): FileIntelligence | null {
        const posixRel = toPosixPath(relPath);
        const safeAbs = validateSafePath(this.repoRoot, posixRel);
        if (!fs.existsSync(safeAbs) || !fs.statSync(safeAbs).isFile()) {
            return null;
        }

        const language = detectLanguage(posixRel);
        if (language === 'unknown') {
            return null;
        }

        const currentHash = this.hashFileContent(safeAbs);
        const cached = this.fileCache.get(posixRel);
        if (cached && cached.sha256 === currentHash) {
            return cached;
        }

        let analysis: { symbols: SymbolRecord[]; imports: ImportEdge[] } = {
            symbols: [],
            imports: [],
        };

        if (this.semanticProvider.supportsLanguage(language)) {
            try {
                analysis = this.semanticProvider.analyzeFile(posixRel);
            } catch {
                if (this.syntaxProvider.supportsLanguage(language)) {
                    analysis = this.syntaxProvider.analyzeFile(posixRel);
                }
            }
        } else if (this.syntaxProvider.supportsLanguage(language)) {
            analysis = this.syntaxProvider.analyzeFile(posixRel);
        }

        const record: FileIntelligence = {
            filePath: posixRel,
            language,
            sha256: currentHash,
            symbols: sortSymbolsDeterministically(analysis.symbols),
            imports: sortImportsDeterministically(analysis.imports),
        };

        this.fileCache.set(posixRel, record);
        return record;
    }

    public getTrackedFiles(): string[] {
        this.ensureInitialized();
        return [...this.discoveredFiles];
    }

    public getSymbolsInFile(filePath: string): SymbolRecord[] {
        this.ensureInitialized();
        const posixRel = toPosixPath(filePath);
        const info = this.ensureFileAnalyzed(posixRel);
        return info ? [...info.symbols] : [];
    }

    public getImportsOfFile(filePath: string): ImportEdge[] {
        this.ensureInitialized();
        const posixRel = toPosixPath(filePath);
        const info = this.ensureFileAnalyzed(posixRel);
        return info ? [...info.imports] : [];
    }

    public getImportersOfFile(filePath: string): ImportEdge[] {
        this.ensureInitialized();
        const targetRel = toPosixPath(filePath);
        validateSafePath(this.repoRoot, targetRel);

        const importers: ImportEdge[] = [];
        for (const rel of this.discoveredFiles) {
            const info = this.ensureFileAnalyzed(rel);
            if (!info) continue;
            for (const edge of info.imports) {
                if (!edge.isExternal && edge.resolvedFile === targetRel) {
                    importers.push(edge);
                }
            }
        }

        return sortImportsDeterministically(importers);
    }

    public findSymbolDefinitions(symbolName: string): SymbolRecord[] {
        this.ensureInitialized();
        const matches: SymbolRecord[] = [];

        for (const rel of this.discoveredFiles) {
            const info = this.ensureFileAnalyzed(rel);
            if (!info) continue;
            for (const sym of info.symbols) {
                if (sym.name === symbolName || sym.id.endsWith(`#${symbolName}`)) {
                    matches.push(sym);
                }
            }
        }

        return sortSymbolsDeterministically(matches);
    }

    public findSymbolReferences(symbolIdOrName: string): ReferenceLocation[] {
        this.ensureInitialized();

        let targetSymbols: SymbolRecord[] = [];
        if (symbolIdOrName.includes('#')) {
            const [filePath] = symbolIdOrName.split('#');
            const fileSyms = this.getSymbolsInFile(filePath);
            targetSymbols = fileSyms.filter((s) => s.id === symbolIdOrName);
        } else {
            targetSymbols = this.findSymbolDefinitions(symbolIdOrName);
        }

        if (targetSymbols.length === 0 || !this.semanticProvider.findSymbolReferences) {
            return [];
        }

        const allRefs: ReferenceLocation[] = [];
        for (const sym of targetSymbols) {
            const refs = this.semanticProvider.findSymbolReferences(sym);
            allRefs.push(...refs);
        }

        return sortReferencesDeterministically(allRefs);
    }

    public findRelatedTests(filePath: string): RelatedTestRecord[] {
        this.ensureInitialized();
        const targetRel = toPosixPath(filePath);
        validateSafePath(this.repoRoot, targetRel);

        const isTestFile = (p: string): boolean =>
            p.startsWith('tests/') ||
            p.startsWith('test/') ||
            p.includes('.test.') ||
            p.includes('.spec.');

        const results = new Map<string, RelatedTestRecord>();

        const directImporters = this.getImportersOfFile(targetRel);
        const nonTestImporters: string[] = [];

        for (const edge of directImporters) {
            if (isTestFile(edge.fromFile)) {
                results.set(edge.fromFile, {
                    testFile: edge.fromFile,
                    relationship: 'direct_import',
                    importedTargetFiles: [targetRel],
                });
            } else {
                nonTestImporters.push(edge.fromFile);
            }
        }

        for (const intermediateFile of nonTestImporters) {
            const secondHopEdges = this.getImportersOfFile(intermediateFile);
            for (const edge of secondHopEdges) {
                if (!isTestFile(edge.fromFile)) continue;
                if (results.has(edge.fromFile)) continue;
                results.set(edge.fromFile, {
                    testFile: edge.fromFile,
                    relationship: 'transitive_import',
                    importedTargetFiles: [intermediateFile],
                });
            }
        }

        const baseName = path.basename(targetRel, path.extname(targetRel)).toLowerCase();
        if (baseName !== 'index') {
            for (const candidate of this.discoveredFiles) {
                if (!isTestFile(candidate) || results.has(candidate)) continue;
                const testBase = path.basename(candidate, path.extname(candidate)).toLowerCase();
                if (
                    testBase === baseName ||
                    testBase === `${baseName}.test` ||
                    testBase === `${baseName}.spec`
                ) {
                    results.set(candidate, {
                        testFile: candidate,
                        relationship: 'naming_convention',
                        importedTargetFiles: [],
                    });
                }
            }
        }

        const relationshipRank: Record<RelatedTestRecord['relationship'], number> = {
            direct_import: 1,
            transitive_import: 2,
            naming_convention: 3,
        };

        return Array.from(results.values()).sort((a, b) => {
            const rankDiff = relationshipRank[a.relationship] - relationshipRank[b.relationship];
            if (rankDiff !== 0) return rankDiff;
            return a.testFile.localeCompare(b.testFile);
        });
    }

    public findArchitecturalEntryPoints(areaOrFilePath?: string): EntryPointRecord[] {
        this.ensureInitialized();
        const normalizedFilter = areaOrFilePath ? toPosixPath(areaOrFilePath) : undefined;

        const entries: EntryPointRecord[] = [];

        for (const rel of this.discoveredFiles) {
            if (rel === 'src/cli/index.ts' || rel === 'src/index.ts') {
                entries.push({
                    filePath: rel,
                    kind: 'cli_entry',
                    reason: 'Primary CLI entrypoint registering top-level commands',
                });
            } else if (rel.startsWith('src/cli/commands/')) {
                entries.push({
                    filePath: rel,
                    kind: 'cli_command',
                    reason: 'CLI command handler entrypoint',
                });
            } else if (rel === 'src/mcp/server.ts' || rel === 'src/mcp/tools.ts') {
                entries.push({
                    filePath: rel,
                    kind: 'mcp_entry',
                    reason: 'MCP server and tool registration entrypoint',
                });
            } else if (rel.startsWith('src/') && path.basename(rel) === 'index.ts') {
                entries.push({
                    filePath: rel,
                    kind: 'module_index',
                    reason: 'Subsystem module index entrypoint',
                });
            }
        }

        if (!normalizedFilter) {
            return entries.sort((a, b) => a.filePath.localeCompare(b.filePath));
        }

        const reachableFromTarget = new Set<string>();
        const queue: string[] = [normalizedFilter];
        const visited = new Set<string>([normalizedFilter]);

        while (queue.length > 0) {
            const current = queue.shift()!;
            reachableFromTarget.add(current);
            for (const edge of this.getImportersOfFile(current)) {
                if (!visited.has(edge.fromFile)) {
                    visited.add(edge.fromFile);
                    queue.push(edge.fromFile);
                }
            }
        }

        return entries
            .filter(
                (e) =>
                    e.filePath.startsWith(normalizedFilter) ||
                    reachableFromTarget.has(e.filePath)
            )
            .sort((a, b) => a.filePath.localeCompare(b.filePath));
    }
}
