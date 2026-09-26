import fs from 'fs';
import { ContextEngine, ContextPackage } from '../../core/context/engine';
import { validateSafePath } from '../../core/repository/paths';
import { FTS5Retriever } from '../../core/retrieval/fts5';
import { Retriever, SearchResult } from '../../core/retrieval/interface';
import { RepositoryIntelligenceService } from '../intelligence/index';
import {
    EntryPointRecord,
    ImportEdge,
    RelatedTestRecord,
    SymbolRecord,
    toPosixPath,
} from '../providers/interface';

export type SurfaceRole =
    | 'ARCHITECTURAL_ENTRY_POINT'
    | 'LIKELY_MODIFICATION_TARGET'
    | 'RELEVANT_CONTEXT'
    | 'DEPENDENCY'
    | 'REVERSE_DEPENDENCY'
    | 'TEST_TARGET';

export type EvidenceSignal =
    | 'lexical_match'
    | 'path_match'
    | 'symbol_match'
    | 'reference_match'
    | 'dependency'
    | 'reverse_dependency'
    | 'architectural_entry'
    | 'related_test'
    | 'structural_peer';

export interface EvidenceRecord {
    signal: EvidenceSignal;
    description: string;
    weight: number;
}

export interface LineRange {
    startLine: number;
    endLine: number;
    reason: string;
}

export interface FileSurfaceEntry {
    filePath: string;
    roles: SurfaceRole[];
    score: number;
    evidence: EvidenceRecord[];
    relevantSymbols: SymbolRecord[];
    relevantRanges: LineRange[];
    dependencies: string[];
    reverseDependencies: string[];
    relatedTests: string[];
}

export interface TaskInterpretation {
    rawTask: string;
    extractedTerms: string[];
    matchedPaths: string[];
    matchedSymbols: string[];
    detectedAreas: string[];
}

export interface ExplainResult {
    task: string;
    interpretation: TaskInterpretation;
    repositoryAreas: string[];
    entryPoints: EntryPointRecord[];
    rankedFiles: FileSurfaceEntry[];
    likelyModificationTargets: string[];
    dependencies: ImportEdge[];
    reverseDependencies: ImportEdge[];
    tests: RelatedTestRecord[];
    contextPackage: ContextPackage;
}

const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
    'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
    'will', 'with', 'add', 'create', 'implement', 'make', 'new', 'update',
    'modify', 'change', 'support', 'feature', 'request', 'task', 'should',
    'can', 'into', 'when', 'where', 'which', 'what', 'how', 'all', 'need',
    'needed', 'called', 'using', 'used', 'use', 'file', 'files', 'code',
    'section', 'sections', 'relevant', 'analyzes', 'identifies', 'identify',
    'analyze', 'framer'
]);

function splitIdentifierTokens(identifier: string): string[] {
    return identifier
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-./\\]+/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);
}

/**
 * Adapter implementing V1's Retriever interface so V1's ContextEngine
 * can budget and assemble exact symbol/file ranges from the V2 Implementation Surface
 * without modifying V1 ContextEngine.
 */
class SurfaceScopedRetriever implements Retriever {
    constructor(private chunks: SearchResult[]) {}

    search(_query: string, limit: number = 1000): SearchResult[] {
        return this.chunks.slice(0, limit);
    }
}

export class ExplainEngine {
    private intelligence: RepositoryIntelligenceService;
    private lexicalRetriever: FTS5Retriever;

    constructor(
        private repoRoot: string,
        options?: {
            intelligence?: RepositoryIntelligenceService;
            lexicalRetriever?: FTS5Retriever;
        }
    ) {
        this.intelligence = options?.intelligence ?? new RepositoryIntelligenceService(repoRoot);
        this.lexicalRetriever = options?.lexicalRetriever ?? new FTS5Retriever(repoRoot);
    }

    public explain(task: string, options?: { maxSeedFiles?: number }): ExplainResult {
        const maxSeeds = options?.maxSeedFiles ?? 6;
        const trackedFiles = this.intelligence.getTrackedFiles();

        const isTestFile = (p: string): boolean =>
            p.startsWith('tests/') ||
            p.startsWith('test/') ||
            p.includes('.test.') ||
            p.includes('.spec.');

        // 1. Task Interpretation
        const interpretation = this.interpretTask(task, trackedFiles);

        interface MutableSurface {
            filePath: string;
            roles: Set<SurfaceRole>;
            evidenceMap: Map<string, EvidenceRecord>;
            symbolsMap: Map<string, SymbolRecord>;
            ranges: LineRange[];
        }

        const surfaceMap = new Map<string, MutableSurface>();
        const getOrCreateSurface = (filePath: string): MutableSurface => {
            const posix = toPosixPath(filePath);
            let entry = surfaceMap.get(posix);
            if (!entry) {
                entry = {
                    filePath: posix,
                    roles: new Set<SurfaceRole>(),
                    evidenceMap: new Map<string, EvidenceRecord>(),
                    symbolsMap: new Map<string, SymbolRecord>(),
                    ranges: [],
                };
                surfaceMap.set(posix, entry);
            }
            return entry;
        };

        const addEvidence = (filePath: string, record: EvidenceRecord) => {
            const entry = getOrCreateSurface(filePath);
            const key = `${record.signal}:${record.description}`;
            if (!entry.evidenceMap.has(key)) {
                entry.evidenceMap.set(key, record);
            }
        };

        // 2. Candidate Discovery via V1 FTS5Retriever (full task + per-term queries)
        const fullTaskHits = this.lexicalRetriever.search(task, 20);
        for (const hit of fullTaskHits) {
            const normPath = toPosixPath(hit.path);
            if (!trackedFiles.includes(normPath)) continue;
            addEvidence(normPath, {
                signal: 'lexical_match',
                description: `Matched full task query in FTS5 index (lines ${hit.startLine}-${hit.endLine})`,
                weight: 4,
            });
            getOrCreateSurface(normPath).ranges.push({
                startLine: hit.startLine,
                endLine: Math.min(hit.endLine, hit.startLine + 60),
                reason: 'FTS5 full-task lexical match',
            });
        }

        const termHitCounts = new Map<string, { terms: Set<string>; line: number }>();
        for (const term of interpretation.extractedTerms) {
            if (term.length < 3) continue;
            const hits = this.lexicalRetriever.search(term, 15);
            for (const hit of hits) {
                const normPath = toPosixPath(hit.path);
                if (!trackedFiles.includes(normPath)) continue;
                let info = termHitCounts.get(normPath);
                if (!info) {
                    info = { terms: new Set<string>(), line: hit.startLine };
                    termHitCounts.set(normPath, info);
                }
                info.terms.add(term);
            }
        }

        for (const [filePath, info] of termHitCounts.entries()) {
            const matchedList = Array.from(info.terms).sort();
            const weight = Math.min(6, matchedList.length * 1.5);
            addEvidence(filePath, {
                signal: 'lexical_match',
                description: `FTS5 lexical match for task concept(s): ${matchedList.join(', ')}`,
                weight,
            });
        }

        // 3. Candidate Discovery via Phase 2 Path & Symbol Matching
        const termSet = new Set(interpretation.extractedTerms);

        for (const relPath of trackedFiles) {
            const pathTokens = splitIdentifierTokens(relPath);
            const matchedPathTokens = pathTokens.filter((t) => termSet.has(t));
            const uniquePathMatches = Array.from(new Set(matchedPathTokens)).sort();

            if (uniquePathMatches.length > 0) {
                if (!interpretation.matchedPaths.includes(relPath)) {
                    interpretation.matchedPaths.push(relPath);
                }
                addEvidence(relPath, {
                    signal: 'path_match',
                    description: `File path matches task concept(s): ${uniquePathMatches.join(', ')}`,
                    weight: uniquePathMatches.length * 2.5,
                });
            }

            const fileSymbols = this.intelligence.getSymbolsInFile(relPath);
            for (const sym of fileSymbols) {
                const symLower = sym.name.toLowerCase();
                const symTokens = splitIdentifierTokens(sym.name);
                const exactMatch = termSet.has(symLower);
                const overlappingTokens = symTokens.filter((t) => termSet.has(t) && t.length >= 3);

                if (exactMatch || overlappingTokens.length > 0) {
                    if (!interpretation.matchedSymbols.includes(sym.name)) {
                        interpretation.matchedSymbols.push(sym.name);
                    }
                    const surf = getOrCreateSurface(relPath);
                    surf.symbolsMap.set(sym.id, sym);
                    surf.ranges.push({
                        startLine: sym.startLine,
                        endLine: sym.endLine,
                        reason: `Symbol definition ${sym.name} (${sym.kind})`,
                    });

                    addEvidence(relPath, {
                        signal: 'symbol_match',
                        description: exactMatch
                            ? `Defines symbol '${sym.name}' (${sym.kind}, lines ${sym.startLine}-${sym.endLine}) matching task term`
                            : `Defines symbol '${sym.name}' (${sym.kind}, lines ${sym.startLine}-${sym.endLine}) overlapping task concept(s): ${Array.from(new Set(overlappingTokens)).join(', ')}`,
                        weight: exactMatch ? 5 : overlappingTokens.length * 2,
                    });
                }
            }
        }

        // Structural analogue / Entry point discovery when task targets CLI commands or MCP tools
        const rawLower = task.toLowerCase();
        if (
            termSet.has('cli') ||
            termSet.has('command') ||
            termSet.has('commands') ||
            rawLower.includes('framer ')
        ) {
            if (trackedFiles.includes('src/cli/index.ts')) {
                const entrySurf = getOrCreateSurface('src/cli/index.ts');
                entrySurf.roles.add('ARCHITECTURAL_ENTRY_POINT');
                entrySurf.roles.add('LIKELY_MODIFICATION_TARGET');
                addEvidence('src/cli/index.ts', {
                    signal: 'architectural_entry',
                    description: 'Primary CLI entrypoint where commands are registered',
                    weight: 5,
                });
            }
            if (trackedFiles.includes('src/cli/commands/context.ts')) {
                const peerSurf = getOrCreateSurface('src/cli/commands/context.ts');
                peerSurf.roles.add('RELEVANT_CONTEXT');
                addEvidence('src/cli/commands/context.ts', {
                    signal: 'structural_peer',
                    description: 'Existing CLI command handler demonstrating command-to-engine wiring pattern',
                    weight: 3,
                });
            }
        }

        if (termSet.has('mcp') || termSet.has('tool') || termSet.has('tools')) {
            for (const mcpFile of ['src/mcp/tools.ts', 'src/mcp/server.ts']) {
                if (trackedFiles.includes(mcpFile)) {
                    const mcpSurf = getOrCreateSurface(mcpFile);
                    mcpSurf.roles.add('ARCHITECTURAL_ENTRY_POINT');
                    addEvidence(mcpFile, {
                        signal: 'architectural_entry',
                        description: 'MCP server/tool registration entrypoint matching task domain',
                        weight: 4.5,
                    });
                }
            }
        }

        // 4. Select Top Non-Test Seed Candidates for Structural Graph Expansion
        const preliminarySeeds = Array.from(surfaceMap.values())
            .filter((s) => !isTestFile(s.filePath))
            .map((s) => ({
                surface: s,
                seedScore: Array.from(s.evidenceMap.values()).reduce((acc, e) => acc + e.weight, 0),
            }))
            .sort((a, b) => {
                if (b.seedScore !== a.seedScore) return b.seedScore - a.seedScore;
                return a.surface.filePath.localeCompare(b.surface.filePath);
            })
            .slice(0, maxSeeds);

        const allDependencies: ImportEdge[] = [];
        const allReverseDependencies: ImportEdge[] = [];
        const allTestsMap = new Map<string, RelatedTestRecord>();
        const allEntryPointsMap = new Map<string, EntryPointRecord>();

        for (const ep of this.intelligence.findArchitecturalEntryPoints()) {
            if (surfaceMap.has(ep.filePath)) {
                allEntryPointsMap.set(ep.filePath, ep);
                getOrCreateSurface(ep.filePath).roles.add('ARCHITECTURAL_ENTRY_POINT');
            }
        }

        // 5. Structural Expansion via Phase 2 RepositoryIntelligenceService
        for (const { surface: seed, seedScore } of preliminarySeeds) {
            if (seedScore >= 3.5) {
                seed.roles.add('LIKELY_MODIFICATION_TARGET');
            } else {
                seed.roles.add('RELEVANT_CONTEXT');
            }

            if (seed.symbolsMap.size === 0) {
                for (const sym of this.intelligence.getSymbolsInFile(seed.filePath)) {
                    if (sym.exported) {
                        seed.symbolsMap.set(sym.id, sym);
                    }
                }
            }

            // 5a. Outgoing Imports (Dependencies)
            const imports = this.intelligence.getImportsOfFile(seed.filePath);
            for (const imp of imports) {
                if (imp.isExternal || !imp.resolvedFile) continue;
                allDependencies.push(imp);

                const depSurf = getOrCreateSurface(imp.resolvedFile);
                depSurf.roles.add('DEPENDENCY');
                addEvidence(imp.resolvedFile, {
                    signal: 'dependency',
                    description: `Imported by candidate ${seed.filePath} (${imp.importedSymbols.join(', ') || imp.rawSpecifier})`,
                    weight: 2.0,
                });

                const depSymbols = this.intelligence.getSymbolsInFile(imp.resolvedFile);
                for (const depSym of depSymbols) {
                    if (imp.importedSymbols.includes(depSym.name)) {
                        depSurf.symbolsMap.set(depSym.id, depSym);
                        depSurf.ranges.push({
                            startLine: depSym.startLine,
                            endLine: depSym.endLine,
                            reason: `Imported symbol ${depSym.name} used by ${seed.filePath}`,
                        });
                    }
                }
            }

            // 5b. Incoming Importers (Reverse Dependencies)
            const importers = this.intelligence.getImportersOfFile(seed.filePath);
            for (const imp of importers) {
                allReverseDependencies.push(imp);
                const revSurf = getOrCreateSurface(imp.fromFile);

                if (isTestFile(imp.fromFile)) {
                    revSurf.roles.add('TEST_TARGET');
                    addEvidence(imp.fromFile, {
                        signal: 'related_test',
                        description: `Test file directly importing candidate ${seed.filePath}`,
                        weight: 2.0,
                    });
                } else {
                    revSurf.roles.add('REVERSE_DEPENDENCY');
                    addEvidence(imp.fromFile, {
                        signal: 'reverse_dependency',
                        description: `Imports candidate ${seed.filePath} (${imp.importedSymbols.join(', ') || imp.rawSpecifier})`,
                        weight: 2.2,
                    });
                }
            }

            // 5c. Cross-File Symbol References
            for (const sym of Array.from(seed.symbolsMap.values()).slice(0, 4)) {
                const refs = this.intelligence.findSymbolReferences(sym.id);
                for (const ref of refs) {
                    if (ref.isDefinition || ref.referencingFile === seed.filePath) continue;
                    const refSurf = getOrCreateSurface(ref.referencingFile);
                    if (isTestFile(ref.referencingFile)) {
                        refSurf.roles.add('TEST_TARGET');
                    } else {
                        refSurf.roles.add('REVERSE_DEPENDENCY');
                    }
                    addEvidence(ref.referencingFile, {
                        signal: 'reference_match',
                        description: `References symbol '${sym.name}' at line ${ref.line}`,
                        weight: 1.8,
                    });
                }
            }

            // 5d. Related Tests
            const relatedTests = this.intelligence.findRelatedTests(seed.filePath);
            for (const testRec of relatedTests) {
                if (!allTestsMap.has(testRec.testFile)) {
                    allTestsMap.set(testRec.testFile, testRec);
                }
                const testSurf = getOrCreateSurface(testRec.testFile);
                testSurf.roles.add('TEST_TARGET');
                addEvidence(testRec.testFile, {
                    signal: 'related_test',
                    description: `Related test (${testRec.relationship}) for ${seed.filePath}`,
                    weight: testRec.relationship === 'direct_import' ? 2.0 : 1.2,
                });
            }

            // 5e. Architectural Entry Points
            const connectedEntries = this.intelligence.findArchitecturalEntryPoints(seed.filePath);
            for (const ep of connectedEntries) {
                allEntryPointsMap.set(ep.filePath, ep);
                const epSurf = getOrCreateSurface(ep.filePath);
                epSurf.roles.add('ARCHITECTURAL_ENTRY_POINT');
                addEvidence(ep.filePath, {
                    signal: 'architectural_entry',
                    description: `${ep.reason} (connected to ${seed.filePath})`,
                    weight: 2.0,
                });
            }
        }

        // 6. Finalize Deterministic Ranking & Surface Entries
        const rankedFiles: FileSurfaceEntry[] = [];

        for (const surf of surfaceMap.values()) {
            if (surf.roles.size === 0) {
                surf.roles.add(isTestFile(surf.filePath) ? 'TEST_TARGET' : 'RELEVANT_CONTEXT');
            }

            const evidence = Array.from(surf.evidenceMap.values()).sort((a, b) => {
                if (b.weight !== a.weight) return b.weight - a.weight;
                return a.description.localeCompare(b.description);
            });

            const rawScore = evidence.reduce((sum, ev) => sum + ev.weight, 0);
            const score = Math.round(rawScore * 100) / 100;

            const fileSymbols = Array.from(surf.symbolsMap.values()).sort((a, b) => {
                if (a.startLine !== b.startLine) return a.startLine - b.startLine;
                return a.id.localeCompare(b.id);
            });

            if (fileSymbols.length === 0) {
                for (const s of this.intelligence.getSymbolsInFile(surf.filePath)) {
                    if (s.exported) fileSymbols.push(s);
                }
            }

            const ranges = this.consolidateRanges(surf.filePath, surf.ranges, fileSymbols);

            const fileDeps = this.intelligence
                .getImportsOfFile(surf.filePath)
                .filter((i) => !i.isExternal && i.resolvedFile !== null)
                .map((i) => i.resolvedFile!)
                .filter((v, idx, arr) => arr.indexOf(v) === idx)
                .sort();

            const fileRevDeps = this.intelligence
                .getImportersOfFile(surf.filePath)
                .map((i) => i.fromFile)
                .filter((v, idx, arr) => arr.indexOf(v) === idx)
                .sort();

            const fileTests = this.intelligence
                .findRelatedTests(surf.filePath)
                .map((t) => t.testFile)
                .sort();

            const roleOrder: SurfaceRole[] = [
                'LIKELY_MODIFICATION_TARGET',
                'ARCHITECTURAL_ENTRY_POINT',
                'RELEVANT_CONTEXT',
                'REVERSE_DEPENDENCY',
                'DEPENDENCY',
                'TEST_TARGET',
            ];
            const orderedRoles = roleOrder.filter((r) => surf.roles.has(r));

            rankedFiles.push({
                filePath: surf.filePath,
                roles: orderedRoles,
                score,
                evidence,
                relevantSymbols: fileSymbols,
                relevantRanges: ranges,
                dependencies: fileDeps,
                reverseDependencies: fileRevDeps,
                relatedTests: fileTests,
            });
        }

        rankedFiles.sort((a, b) => {
            const aIsOnlyTest = a.roles.length === 1 && a.roles[0] === 'TEST_TARGET' ? 1 : 0;
            const bIsOnlyTest = b.roles.length === 1 && b.roles[0] === 'TEST_TARGET' ? 1 : 0;
            if (aIsOnlyTest !== bIsOnlyTest) return aIsOnlyTest - bIsOnlyTest;
            if (b.score !== a.score) return b.score - a.score;
            return a.filePath.localeCompare(b.filePath);
        });

        const likelyModificationTargets = rankedFiles
            .filter((f) => f.roles.includes('LIKELY_MODIFICATION_TARGET'))
            .map((f) => f.filePath);

        const repositoryAreas = Array.from(
            new Set(
                rankedFiles
                    .filter((f) => !isTestFile(f.filePath))
                    .slice(0, 8)
                    .map((f) => {
                        const parts = f.filePath.split('/');
                        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
                    })
            )
        ).sort();

        interpretation.detectedAreas = repositoryAreas;
        interpretation.matchedPaths.sort();
        interpretation.matchedSymbols.sort();

        // 7. Assemble Token-Budgeted Context by Reusing V1 ContextEngine
        const surfaceChunks = this.buildSurfaceChunks(rankedFiles);
        const scopedRetriever = new SurfaceScopedRetriever(surfaceChunks);
        const contextEngine = new ContextEngine(this.repoRoot, scopedRetriever);
        const contextPackage = contextEngine.generateContext(task);

        return {
            task,
            interpretation,
            repositoryAreas,
            entryPoints: Array.from(allEntryPointsMap.values()).sort((a, b) =>
                a.filePath.localeCompare(b.filePath)
            ),
            rankedFiles,
            likelyModificationTargets,
            dependencies: this.dedupeImportEdges(allDependencies),
            reverseDependencies: this.dedupeImportEdges(allReverseDependencies),
            tests: Array.from(allTestsMap.values()).sort((a, b) =>
                a.testFile.localeCompare(b.testFile)
            ),
            contextPackage,
        };
    }

    private interpretTask(task: string, trackedFiles: string[]): TaskInterpretation {
        const rawTokens = task
            .replace(/[^\p{L}\p{N}_\-./\\]/gu, ' ')
            .split(/\s+/)
            .filter(Boolean);

        const terms = new Set<string>();
        for (const tok of rawTokens) {
            const lower = tok.toLowerCase();
            if (!STOP_WORDS.has(lower) && lower.length >= 2) {
                terms.add(lower);
            }
            for (const sub of splitIdentifierTokens(tok)) {
                if (!STOP_WORDS.has(sub) && sub.length >= 2) {
                    terms.add(sub);
                }
            }
        }

        if (terms.size === 0) {
            for (const tok of rawTokens) {
                if (tok.length >= 2) terms.add(tok.toLowerCase());
            }
        }

        const matchedPaths: string[] = [];
        for (const file of trackedFiles) {
            if (task.includes(file)) {
                matchedPaths.push(file);
            }
        }

        return {
            rawTask: task,
            extractedTerms: Array.from(terms).sort(),
            matchedPaths,
            matchedSymbols: [],
            detectedAreas: [],
        };
    }

    private consolidateRanges(
        filePath: string,
        explicitRanges: LineRange[],
        symbols: SymbolRecord[]
    ): LineRange[] {
        const safeAbs = validateSafePath(this.repoRoot, filePath);
        if (!fs.existsSync(safeAbs)) return [];
        const totalLines = fs.readFileSync(safeAbs, 'utf-8').split('\n').length;

        const candidates: LineRange[] = [...explicitRanges];
        for (const sym of symbols.slice(0, 5)) {
            candidates.push({
                startLine: sym.startLine,
                endLine: sym.endLine,
                reason: `${sym.kind} ${sym.name}`,
            });
        }

        if (candidates.length === 0) {
            return [
                {
                    startLine: 1,
                    endLine: Math.min(totalLines, 60),
                    reason: 'Module overview & exports',
                },
            ];
        }

        const sorted = candidates
            .map((r) => ({
                startLine: Math.max(1, r.startLine),
                endLine: Math.min(totalLines, Math.max(r.startLine, r.endLine)),
                reason: r.reason,
            }))
            .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

        const merged: LineRange[] = [];
        for (const curr of sorted) {
            const prev = merged[merged.length - 1];
            if (prev && curr.startLine <= prev.endLine + 3) {
                prev.endLine = Math.max(prev.endLine, curr.endLine);
                if (!prev.reason.includes(curr.reason)) {
                    prev.reason = `${prev.reason}; ${curr.reason}`;
                }
            } else {
                merged.push({ ...curr });
            }
        }

        return merged.slice(0, 4);
    }

    private buildSurfaceChunks(rankedFiles: FileSurfaceEntry[]): SearchResult[] {
        const chunks: SearchResult[] = [];

        for (const fileEntry of rankedFiles) {
            const safeAbs = validateSafePath(this.repoRoot, fileEntry.filePath);
            if (!fs.existsSync(safeAbs)) continue;
            const lines = fs.readFileSync(safeAbs, 'utf-8').split('\n');

            for (const range of fileEntry.relevantRanges) {
                const start = Math.max(1, range.startLine);
                const end = Math.min(lines.length, range.endLine);
                const snippet = lines.slice(start - 1, end).join('\n');
                if (!snippet.trim()) continue;

                chunks.push({
                    path: fileEntry.filePath,
                    startLine: start,
                    endLine: end,
                    content: snippet,
                    score: fileEntry.score,
                });
            }
        }

        return chunks;
    }

    private dedupeImportEdges(edges: ImportEdge[]): ImportEdge[] {
        const map = new Map<string, ImportEdge>();
        for (const e of edges) {
            const key = `${e.fromFile}->${e.resolvedFile ?? e.rawSpecifier}:${e.line}`;
            if (!map.has(key)) {
                map.set(key, e);
            }
        }
        return Array.from(map.values()).sort((a, b) => {
            if (a.fromFile !== b.fromFile) return a.fromFile.localeCompare(b.fromFile);
            if (a.line !== b.line) return a.line - b.line;
            return a.rawSpecifier.localeCompare(b.rawSpecifier);
        });
    }
}