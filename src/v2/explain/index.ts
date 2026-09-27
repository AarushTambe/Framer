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

export interface LineRangeSnippet extends LineRange {
    content: string;
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

export interface ImplementationPacket {
    task: string;
    projectState: string;
    targetSurface: {
        primaryTargets: {
            filePath: string;
            role: 'LIKELY_MODIFICATION_TARGET';
            symbolsToModifyOrExtend: SymbolRecord[];
            codeRanges: LineRangeSnippet[];
        }[];
        relevantContext?: {
            filePath: string;
            role: 'RELEVANT_CONTEXT';
            relevantSymbols: SymbolRecord[];
            codeRanges: LineRangeSnippet[];
        }[];
        dependencies: {
            filePath: string;
            role: 'DEPENDENCY';
            providedSymbols: SymbolRecord[];
            codeRanges: LineRangeSnippet[];
        }[];
        callersAndEntryPoints: {
            filePath: string;
            role: 'REVERSE_DEPENDENCY' | 'ARCHITECTURAL_ENTRY_POINT';
            invocationSites: LineRangeSnippet[];
        }[];
        testTargets: {
            filePath: string;
            role: 'TEST_TARGET';
            relationship: 'direct_import' | 'transitive_import' | 'naming_convention';
            assertionRanges: LineRangeSnippet[];
        }[];
    };
    architecturalInvariants: string[];
    budgetInfo: ContextPackage['budgetInfo'];
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
    implementationPacket: ImplementationPacket;
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

const RANGE_MERGE_GAP_LINES = 3;
const COMPACT_CALLER_OR_TEST_MAX_LINES = 35;

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

interface CandidateChunk extends SearchResult {
    reason: string;
}

interface PacketSelectionPlan {
    primaryFiles: FileSurfaceEntry[];
    relevantContextFiles: FileSurfaceEntry[];
    dependencyFiles: FileSurfaceEntry[];
    callerAndEntryFiles: FileSurfaceEntry[];
    testFiles: FileSurfaceEntry[];
    chunks: CandidateChunk[];
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

    public explain(task: string): ExplainResult {
        const trackedFiles = this.intelligence.getTrackedFiles();

        const isTestFile = (p: string): boolean =>
            p.startsWith('tests/') ||
            p.startsWith('test/') ||
            p.includes('.test.') ||
            p.includes('.spec.');

        // 1. Task Interpretation
        const interpretation = this.interpretTask(task, trackedFiles);
        const termSet = new Set(interpretation.extractedTerms);
        const rawLower = task.toLowerCase();
        const explicitlyTargetsCli =
            termSet.has('cli') ||
            termSet.has('command') ||
            termSet.has('commands') ||
            rawLower.includes('framer ');
        const explicitlyTargetsMcp =
            termSet.has('mcp') || termSet.has('tool') || termSet.has('tools');

        interface MutableSurface {
            filePath: string;
            roles: Set<SurfaceRole>;
            evidenceMap: Map<string, EvidenceRecord>;
            symbolsMap: Map<string, SymbolRecord>;
            ranges: LineRange[];
            primaryScore: number;
            definedSymbolMatches: number;
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
                    primaryScore: 0,
                    definedSymbolMatches: 0,
                };
                surfaceMap.set(posix, entry);
            }
            return entry;
        };

        const addEvidence = (
            filePath: string,
            record: EvidenceRecord,
            isPrimary: boolean = false,
            dedupeKey?: string
        ) => {
            const entry = getOrCreateSurface(filePath);
            const key = dedupeKey ?? `${record.signal}:${record.description}`;
            if (!entry.evidenceMap.has(key)) {
                entry.evidenceMap.set(key, record);
                if (isPrimary) {
                    entry.primaryScore += record.weight;
                }
            }
        };

        // 2. Candidate Discovery via V1 FTS5Retriever (full task + per-term queries)
        const fullTaskHits = this.lexicalRetriever.search(task, 20);
        for (const hit of fullTaskHits) {
            const normPath = toPosixPath(hit.path);
            if (!trackedFiles.includes(normPath)) continue;
            addEvidence(
                normPath,
                {
                    signal: 'lexical_match',
                    description: `Matched full task query in FTS5 index (lines ${hit.startLine}-${hit.endLine})`,
                    weight: 4,
                },
                true
            );
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
            addEvidence(
                filePath,
                {
                    signal: 'lexical_match',
                    description: `FTS5 lexical match for task concept(s): ${matchedList.join(', ')}`,
                    weight,
                },
                true
            );
        }

        // 3. Candidate Discovery via Phase 2 Path & Symbol Matching
        for (const relPath of trackedFiles) {
            const pathTokens = splitIdentifierTokens(relPath);
            const matchedPathTokens = pathTokens.filter((t) => termSet.has(t));
            const uniquePathMatches = Array.from(new Set(matchedPathTokens)).sort();

            if (uniquePathMatches.length > 0) {
                if (!interpretation.matchedPaths.includes(relPath)) {
                    interpretation.matchedPaths.push(relPath);
                }
                addEvidence(
                    relPath,
                    {
                        signal: 'path_match',
                        description: `File path matches task concept(s): ${uniquePathMatches.join(', ')}`,
                        weight: uniquePathMatches.length * 2.5,
                    },
                    true
                );
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
                    surf.definedSymbolMatches += 1;
                    surf.ranges.push({
                        startLine: sym.startLine,
                        endLine: sym.endLine,
                        reason: `Symbol definition ${sym.name} (${sym.kind})`,
                    });

                    const kindBonus =
                        sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'method'
                            ? 1.0
                            : 0;

                    addEvidence(
                        relPath,
                        {
                            signal: 'symbol_match',
                            description: exactMatch
                                ? `Defines symbol '${sym.name}' (${sym.kind}, lines ${sym.startLine}-${sym.endLine}) matching task term`
                                : `Defines symbol '${sym.name}' (${sym.kind}, lines ${sym.startLine}-${sym.endLine}) overlapping task concept(s): ${Array.from(new Set(overlappingTokens)).join(', ')}`,
                            weight: (exactMatch ? 5 : overlappingTokens.length * 2) + kindBonus,
                        },
                        true
                    );
                }
            }
        }

        // Structural analogue / Entry point discovery when task explicitly targets CLI or MCP
        if (explicitlyTargetsCli) {
            if (trackedFiles.includes('src/cli/index.ts')) {
                const entrySurf = getOrCreateSurface('src/cli/index.ts');
                entrySurf.roles.add('ARCHITECTURAL_ENTRY_POINT');
                entrySurf.roles.add('LIKELY_MODIFICATION_TARGET');
                addEvidence(
                    'src/cli/index.ts',
                    {
                        signal: 'architectural_entry',
                        description: 'Primary CLI entrypoint where commands are registered',
                        weight: 5,
                    },
                    true,
                    'architectural_entry:src/cli/index.ts'
                );
            }
            if (trackedFiles.includes('src/cli/commands/context.ts')) {
                const peerSurf = getOrCreateSurface('src/cli/commands/context.ts');
                peerSurf.roles.add('RELEVANT_CONTEXT');
                addEvidence(
                    'src/cli/commands/context.ts',
                    {
                        signal: 'structural_peer',
                        description:
                            'Existing CLI command handler demonstrating command-to-engine wiring pattern',
                        weight: 3,
                    },
                    true
                );
            }
        }

        if (explicitlyTargetsMcp) {
            for (const mcpFile of ['src/mcp/tools.ts', 'src/mcp/server.ts']) {
                if (trackedFiles.includes(mcpFile)) {
                    const mcpSurf = getOrCreateSurface(mcpFile);
                    mcpSurf.roles.add('ARCHITECTURAL_ENTRY_POINT');
                    addEvidence(
                        mcpFile,
                        {
                            signal: 'architectural_entry',
                            description: 'MCP server/tool registration entrypoint matching task domain',
                            weight: 4.5,
                        },
                        true,
                        `architectural_entry:${mcpFile}`
                    );
                }
            }
        }

        // 4. Select Primary Non-Test Seed Candidates without arbitrary culling
        const allNonTestCandidates = Array.from(surfaceMap.values())
            .filter((s) => !isTestFile(s.filePath) && s.primaryScore > 0)
            .sort((a, b) => {
                if (b.primaryScore !== a.primaryScore) return b.primaryScore - a.primaryScore;
                return a.filePath.localeCompare(b.filePath);
            });

        const candidateMap = new Map<string, MutableSurface>();
        for (const c of allNonTestCandidates) {
            candidateMap.set(c.filePath, c);
        }

        const isDelegatingWrapper = (cand: MutableSurface): boolean => {
            const isCliLayer = cand.filePath.startsWith('src/cli/');
            const isMcpLayer = cand.filePath.startsWith('src/mcp/');

            if (isCliLayer && explicitlyTargetsCli) return false;
            if (isMcpLayer && explicitlyTargetsMcp) return false;
            if (task.includes(cand.filePath)) return false;

            for (const sym of cand.symbolsMap.values()) {
                if (termSet.has(sym.name.toLowerCase())) {
                    return false;
                }
            }

            const outgoing = this.intelligence.getImportsOfFile(cand.filePath);
            for (const imp of outgoing) {
                if (imp.isExternal || !imp.resolvedFile) continue;
                const importedTarget = candidateMap.get(imp.resolvedFile);
                if (
                    importedTarget &&
                    importedTarget.primaryScore >= 4.0 &&
                    (importedTarget.definedSymbolMatches > cand.definedSymbolMatches ||
                        isCliLayer ||
                        isMcpLayer)
                ) {
                    return true;
                }
            }
            return false;
        };

        const highConfidenceSeeds = allNonTestCandidates.filter(
            (s) => s.primaryScore >= 4.0 && !isDelegatingWrapper(s)
        );
        const preliminarySeeds =
            highConfidenceSeeds.length > 0
                ? highConfidenceSeeds
                : allNonTestCandidates.slice(0, 2);

        const allDependencies: ImportEdge[] = [];
        const allReverseDependencies: ImportEdge[] = [];
        const allTestsMap = new Map<string, RelatedTestRecord>();
        const allEntryPointsMap = new Map<string, EntryPointRecord>();

        for (const ep of this.intelligence.findArchitecturalEntryPoints()) {
            const surf = surfaceMap.get(ep.filePath);
            if (surf && surf.primaryScore >= 4.0 && !isDelegatingWrapper(surf)) {
                allEntryPointsMap.set(ep.filePath, ep);
                surf.roles.add('ARCHITECTURAL_ENTRY_POINT');
            }
        }

        // 5. Structural Expansion via Phase 2 RepositoryIntelligenceService
        for (const seed of preliminarySeeds) {
            const isPrimaryTarget = seed.primaryScore >= 4.0 && !isDelegatingWrapper(seed);
            if (isPrimaryTarget) {
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

                if (
                    seed.filePath === 'src/cli/index.ts' &&
                    imp.resolvedFile.startsWith('src/cli/commands/')
                ) {
                    const targetSurf = surfaceMap.get(imp.resolvedFile);
                    if (!targetSurf || targetSurf.primaryScore === 0) {
                        continue;
                    }
                }

                allDependencies.push(imp);

                const depSurf = getOrCreateSurface(imp.resolvedFile);
                depSurf.roles.add('DEPENDENCY');
                addEvidence(
                    imp.resolvedFile,
                    {
                        signal: 'dependency',
                        description: `Imported by candidate ${seed.filePath} (${imp.importedSymbols.join(', ') || imp.rawSpecifier})`,
                        weight: 2.0,
                    },
                    false,
                    `dependency:${seed.filePath}->${imp.resolvedFile}`
                );

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
                    addEvidence(
                        imp.fromFile,
                        {
                            signal: 'related_test',
                            description: `Test file directly importing candidate ${seed.filePath}`,
                            weight: 2.0,
                        },
                        false,
                        `related_test:${imp.fromFile}->${seed.filePath}`
                    );
                } else {
                    revSurf.roles.add('REVERSE_DEPENDENCY');
                    addEvidence(
                        imp.fromFile,
                        {
                            signal: 'reverse_dependency',
                            description: `Imports candidate ${seed.filePath} (${imp.importedSymbols.join(', ') || imp.rawSpecifier})`,
                            weight: 2.0,
                        },
                        false,
                        `reverse_dependency:${imp.fromFile}->${seed.filePath}`
                    );
                }
            }

            // 5c. Cross-File Symbol References
            const seedSymbols = Array.from(seed.symbolsMap.values());
            const perFileSymbolUsages = new Map<
                string,
                { sym: SymbolRecord; allLines: number[]; bodyLines: number[] }[]
            >();

            for (const sym of seedSymbols) {
                const refs = this.intelligence.findSymbolReferences(sym.id);
                const refsByFile = new Map<string, number[]>();

                for (const ref of refs) {
                    if (ref.isDefinition || ref.referencingFile === seed.filePath) continue;
                    let lines = refsByFile.get(ref.referencingFile);
                    if (!lines) {
                        lines = [];
                        refsByFile.set(ref.referencingFile, lines);
                    }
                    if (!lines.includes(ref.line)) {
                        lines.push(ref.line);
                    }
                }

                for (const [refFile, lines] of refsByFile.entries()) {
                    lines.sort((a, b) => a - b);
                    const refSurf = getOrCreateSurface(refFile);
                    if (isTestFile(refFile)) {
                        refSurf.roles.add('TEST_TARGET');
                    } else {
                        refSurf.roles.add('REVERSE_DEPENDENCY');
                    }

                    const refFileImports = this.intelligence.getImportsOfFile(refFile);
                    const importLines = new Set<number>(refFileImports.map((imp) => imp.line));
                    const maxImportLine =
                        refFileImports.length > 0
                            ? Math.max(...refFileImports.map((imp) => imp.line))
                            : 0;

                    const bodyLines = lines.filter(
                        (ln) => !importLines.has(ln) && ln > maxImportLine
                    );

                    let fileUsageList = perFileSymbolUsages.get(refFile);
                    if (!fileUsageList) {
                        fileUsageList = [];
                        perFileSymbolUsages.set(refFile, fileUsageList);
                    }
                    fileUsageList.push({ sym, allLines: lines, bodyLines });

                    const lineLabel =
                        lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`;

                    addEvidence(
                        refFile,
                        {
                            signal: 'reference_match',
                            description: `References symbol '${sym.name}' (${lineLabel})`,
                            weight: 1.5,
                        },
                        false,
                        `reference_match:${refFile}->${sym.id}`
                    );
                }
            }

            for (const [refFile, usageEntries] of perFileSymbolUsages.entries()) {
                const refSurf = getOrCreateSurface(refFile);
                const executableBodyUsages = usageEntries.filter(
                    (u) =>
                        u.bodyLines.length > 0 &&
                        u.sym.kind !== 'interface' &&
                        u.sym.kind !== 'type'
                );
                const activeBodyUsages =
                    executableBodyUsages.length > 0
                        ? executableBodyUsages
                        : usageEntries.filter((u) => u.bodyLines.length > 0);

                if (activeBodyUsages.length > 0) {
                    for (const u of activeBodyUsages) {
                        for (const usageLine of u.bodyLines) {
                            refSurf.ranges.push({
                                startLine: Math.max(1, usageLine - 5),
                                endLine: usageLine + 12,
                                reason: `Invokes/references ${u.sym.name} (line ${usageLine})`,
                            });
                        }
                    }
                } else if (refSurf.ranges.length === 0 && usageEntries.length > 0) {
                    const firstEntry = usageEntries[0];
                    const fallbackLine = firstEntry.allLines[0];
                    refSurf.ranges.push({
                        startLine: Math.max(1, fallbackLine - 2),
                        endLine: fallbackLine + 8,
                        reason: `References ${firstEntry.sym.name} (line ${fallbackLine})`,
                    });
                }
            }

            // 5d. Related Tests
            if (isPrimaryTarget) {
                const relatedTests = this.intelligence.findRelatedTests(seed.filePath);
                for (const testRec of relatedTests) {
                    const existingTest = allTestsMap.get(testRec.testFile);
                    if (!existingTest || testRec.relationship === 'direct_import') {
                        allTestsMap.set(testRec.testFile, testRec);
                    }
                    const testSurf = getOrCreateSurface(testRec.testFile);
                    testSurf.roles.add('TEST_TARGET');
                    addEvidence(
                        testRec.testFile,
                        {
                            signal: 'related_test',
                            description: `Related test (${testRec.relationship}) for ${seed.filePath}`,
                            weight: testRec.relationship === 'direct_import' ? 2.0 : 1.0,
                        },
                        false,
                        `related_test:${testRec.testFile}->${seed.filePath}`
                    );
                }
            }

            // 5e. Architectural Entry Points
            if (isPrimaryTarget) {
                const connectedEntries = this.intelligence.findArchitecturalEntryPoints(
                    seed.filePath
                );
                for (const ep of connectedEntries) {
                    allEntryPointsMap.set(ep.filePath, ep);
                    const epSurf = getOrCreateSurface(ep.filePath);
                    epSurf.roles.add('ARCHITECTURAL_ENTRY_POINT');
                    addEvidence(
                        ep.filePath,
                        {
                            signal: 'architectural_entry',
                            description: `${ep.reason} (connected to ${seed.filePath})`,
                            weight: 1.5,
                        },
                        false,
                        `architectural_entry:${ep.filePath}`
                    );
                }
            }
        }

        // 6. Finalize Deterministic Ranking & Surface Entries
        interface ScoredSurfaceEntry {
            entry: FileSurfaceEntry;
            primaryScore: number;
            definedSymbolMatches: number;
            roleTier: number;
        }

        const scoredEntries: ScoredSurfaceEntry[] = [];

        for (const surf of surfaceMap.values()) {
            if (surf.roles.size === 0) {
                surf.roles.add(isTestFile(surf.filePath) ? 'TEST_TARGET' : 'RELEVANT_CONTEXT');
            }

            const evidence = Array.from(surf.evidenceMap.values()).sort((a, b) => {
                if (b.weight !== a.weight) return b.weight - a.weight;
                return a.description.localeCompare(b.description);
            });

            const secondaryScore = evidence
                .filter(
                    (e) =>
                        e.signal !== 'lexical_match' &&
                        e.signal !== 'path_match' &&
                        e.signal !== 'symbol_match' &&
                        e.signal !== 'structural_peer'
                )
                .reduce((sum, ev) => sum + ev.weight, 0);

            const effectiveTotal = surf.primaryScore + Math.min(6.0, secondaryScore);
            const score = Math.round(effectiveTotal * 100) / 100;

            const fileSymbols = Array.from(surf.symbolsMap.values()).sort((a, b) => {
                if (a.startLine !== b.startLine) return a.startLine - b.startLine;
                return a.id.localeCompare(b.id);
            });

            const shouldIncludeSymbolDefinitions =
                surf.roles.has('LIKELY_MODIFICATION_TARGET') ||
                surf.roles.has('RELEVANT_CONTEXT') ||
                surf.roles.has('DEPENDENCY');

            if (
                fileSymbols.length === 0 &&
                shouldIncludeSymbolDefinitions &&
                !isTestFile(surf.filePath)
            ) {
                for (const s of this.intelligence.getSymbolsInFile(surf.filePath)) {
                    if (s.exported) fileSymbols.push(s);
                }
            }

            const ranges = this.consolidateRanges(
                surf.filePath,
                surf.ranges,
                fileSymbols,
                isTestFile(surf.filePath),
                shouldIncludeSymbolDefinitions
            );

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
                'RELEVANT_CONTEXT',
                'DEPENDENCY',
                'REVERSE_DEPENDENCY',
                'ARCHITECTURAL_ENTRY_POINT',
                'TEST_TARGET',
            ];
            const orderedRoles = roleOrder.filter((r) => surf.roles.has(r));

            let roleTier = 5;
            if (surf.roles.has('LIKELY_MODIFICATION_TARGET')) {
                roleTier = 1;
            } else if (surf.roles.has('RELEVANT_CONTEXT')) {
                roleTier = 2;
            } else if (surf.roles.has('DEPENDENCY') || surf.roles.has('REVERSE_DEPENDENCY')) {
                roleTier = 3;
            } else if (surf.roles.has('ARCHITECTURAL_ENTRY_POINT')) {
                roleTier = 4;
            } else if (surf.roles.has('TEST_TARGET')) {
                roleTier = 5;
            }

            scoredEntries.push({
                entry: {
                    filePath: surf.filePath,
                    roles: orderedRoles,
                    score,
                    evidence,
                    relevantSymbols: fileSymbols,
                    relevantRanges: ranges,
                    dependencies: fileDeps,
                    reverseDependencies: fileRevDeps,
                    relatedTests: fileTests,
                },
                primaryScore: surf.primaryScore,
                definedSymbolMatches: surf.definedSymbolMatches,
                roleTier,
            });
        }

        scoredEntries.sort((a, b) => {
            if (a.roleTier !== b.roleTier) return a.roleTier - b.roleTier;
            if (b.primaryScore !== a.primaryScore) return b.primaryScore - a.primaryScore;
            if (b.definedSymbolMatches !== a.definedSymbolMatches) {
                return b.definedSymbolMatches - a.definedSymbolMatches;
            }
            if (b.entry.score !== a.entry.score) return b.entry.score - a.entry.score;
            return a.entry.filePath.localeCompare(b.entry.filePath);
        });

        const rankedFiles = scoredEntries.map((s) => s.entry);

        const likelyModificationTargets = rankedFiles
            .filter((f) => f.roles.includes('LIKELY_MODIFICATION_TARGET'))
            .map((f) => f.filePath);

        const repositoryAreas = Array.from(
            new Set(
                rankedFiles
                    .filter((f) => !isTestFile(f.filePath) && f.score >= 2.0)
                    .map((f) => {
                        const parts = f.filePath.split('/');
                        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
                    })
            )
        ).sort();

        interpretation.detectedAreas = repositoryAreas;
        interpretation.matchedPaths.sort();
        interpretation.matchedSymbols.sort();

        const dedupedDependencies = this.dedupeImportEdges(allDependencies);
        const dedupedReverseDependencies = this.dedupeImportEdges(allReverseDependencies);

        // 7. Single-Pass Role-Prioritized Selection, Internal V1 ContextEngine Budgeting,
        // and Canonical ImplementationPacket Assembly
        const selectionPlan = this.buildSurfaceSelectionPlan(rankedFiles, allTestsMap);
        const scopedRetriever = new SurfaceScopedRetriever(selectionPlan.chunks);
        const contextEngine = new ContextEngine(this.repoRoot, scopedRetriever);
        const internalContextPackage = contextEngine.generateContext(task);

        const implementationPacket = this.buildImplementationPacket(
            task,
            selectionPlan,
            internalContextPackage,
            allTestsMap,
            dedupedDependencies
        );

        return {
            task,
            interpretation,
            repositoryAreas,
            entryPoints: Array.from(allEntryPointsMap.values()).sort((a, b) =>
                a.filePath.localeCompare(b.filePath)
            ),
            rankedFiles,
            likelyModificationTargets,
            dependencies: dedupedDependencies,
            reverseDependencies: dedupedReverseDependencies,
            tests: Array.from(allTestsMap.values()).sort((a, b) =>
                a.testFile.localeCompare(b.testFile)
            ),
            implementationPacket,
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
        symbols: SymbolRecord[],
        isTest: boolean,
        includeSymbolDefinitions: boolean
    ): LineRange[] {
        const safeAbs = validateSafePath(this.repoRoot, filePath);
        if (!fs.existsSync(safeAbs)) return [];
        const totalLines = fs.readFileSync(safeAbs, 'utf-8').split('\n').length;

        let filteredExplicit = [...explicitRanges];
        if (!includeSymbolDefinitions || isTest) {
            const bodyInvocationRanges = filteredExplicit.filter((r) =>
                r.reason.startsWith('Invokes/references')
            );
            if (bodyInvocationRanges.length > 0) {
                filteredExplicit = bodyInvocationRanges;
            }
        }

        const candidates: LineRange[] = [...filteredExplicit];

        if (!isTest && includeSymbolDefinitions) {
            for (const sym of symbols) {
                candidates.push({
                    startLine: sym.startLine,
                    endLine: sym.endLine,
                    reason: `${sym.kind} ${sym.name}`,
                });
            }
        }

        if (candidates.length === 0) {
            return [
                {
                    startLine: 1,
                    endLine: Math.min(totalLines, isTest ? 30 : 45),
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
            if (prev && curr.startLine <= prev.endLine + RANGE_MERGE_GAP_LINES) {
                prev.endLine = Math.max(prev.endLine, curr.endLine);
                if (!prev.reason.includes(curr.reason)) {
                    prev.reason = `${prev.reason}; ${curr.reason}`;
                }
            } else {
                merged.push({ ...curr });
            }
        }

        return merged;
    }

    private buildSurfaceSelectionPlan(
        rankedFiles: FileSurfaceEntry[],
        testsMap: Map<string, RelatedTestRecord>
    ): PacketSelectionPlan {
        const assignedFiles = new Set<string>();

        const primaryFiles: FileSurfaceEntry[] = [];
        for (const f of rankedFiles) {
            if (f.roles.includes('LIKELY_MODIFICATION_TARGET')) {
                primaryFiles.push(f);
                assignedFiles.add(f.filePath);
            }
        }

        const relevantContextFiles: FileSurfaceEntry[] = [];
        for (const f of rankedFiles) {
            if (assignedFiles.has(f.filePath)) continue;
            if (
                f.roles.includes('RELEVANT_CONTEXT') &&
                f.evidence.some((e) => e.signal === 'structural_peer')
            ) {
                relevantContextFiles.push(f);
                assignedFiles.add(f.filePath);
            }
        }

        const dependencyFiles: FileSurfaceEntry[] = [];
        for (const f of rankedFiles) {
            if (assignedFiles.has(f.filePath)) continue;
            if (f.roles.includes('DEPENDENCY')) {
                dependencyFiles.push(f);
                assignedFiles.add(f.filePath);
            }
        }

        const callerAndEntryFiles: FileSurfaceEntry[] = [];
        for (const f of rankedFiles) {
            if (assignedFiles.has(f.filePath)) continue;
            if (f.roles.includes('TEST_TARGET')) continue;

            const hasCallerOrEntryRole =
                f.roles.includes('REVERSE_DEPENDENCY') ||
                f.roles.includes('ARCHITECTURAL_ENTRY_POINT');
            if (!hasCallerOrEntryRole) continue;

            const hasDirectStructuralSignal = f.evidence.some(
                (e) =>
                    e.signal === 'reverse_dependency' ||
                    e.signal === 'reference_match' ||
                    e.signal === 'architectural_entry'
            );
            if (hasDirectStructuralSignal) {
                callerAndEntryFiles.push(f);
                assignedFiles.add(f.filePath);
            }
        }

        const directTestFiles: FileSurfaceEntry[] = [];
        for (const f of rankedFiles) {
            if (assignedFiles.has(f.filePath)) continue;
            if (!f.roles.includes('TEST_TARGET')) continue;
            const rec = testsMap.get(f.filePath);
            if (rec?.relationship === 'direct_import') {
                directTestFiles.push(f);
                assignedFiles.add(f.filePath);
            }
        }

        const orderedSelection = [
            ...primaryFiles,
            ...relevantContextFiles,
            ...dependencyFiles,
            ...callerAndEntryFiles,
            ...directTestFiles,
        ];

        const chunks: CandidateChunk[] = [];
        const seenChunkKeys = new Set<string>();

        for (const fileEntry of orderedSelection) {
            const safeAbs = validateSafePath(this.repoRoot, fileEntry.filePath);
            if (!fs.existsSync(safeAbs)) continue;
            const lines = fs.readFileSync(safeAbs, 'utf-8').split('\n');

            const isCallerOrTestOnly =
                callerAndEntryFiles.includes(fileEntry) || directTestFiles.includes(fileEntry);

            for (const range of fileEntry.relevantRanges) {
                const start = Math.max(1, range.startLine);
                // Preserve full consolidated logical ranges for primary targets, relevant context,
                // and dependencies; bound only callers/entry points and tests to compact windows.
                const end = isCallerOrTestOnly
                    ? Math.min(
                          lines.length,
                          range.endLine,
                          start + COMPACT_CALLER_OR_TEST_MAX_LINES - 1
                      )
                    : Math.min(lines.length, range.endLine);

                const key = `${fileEntry.filePath}:${start}-${end}`;
                if (seenChunkKeys.has(key)) continue;
                seenChunkKeys.add(key);

                const snippet = lines.slice(start - 1, end).join('\n');
                if (!snippet.trim()) continue;

                chunks.push({
                    path: fileEntry.filePath,
                    startLine: start,
                    endLine: end,
                    content: snippet,
                    score: fileEntry.score,
                    reason: range.reason,
                });
            }
        }

        return {
            primaryFiles,
            relevantContextFiles,
            dependencyFiles,
            callerAndEntryFiles,
            testFiles: directTestFiles,
            chunks,
        };
    }

    private buildImplementationPacket(
        task: string,
        plan: PacketSelectionPlan,
        contextPackage: ContextPackage,
        testsMap: Map<string, RelatedTestRecord>,
        dependencies: ImportEdge[]
    ): ImplementationPacket {
        const budgetedByFile = new Map<string, LineRangeSnippet[]>();
        const reasonLookup = new Map<string, string>();
        for (const c of plan.chunks) {
            reasonLookup.set(`${c.path}:${c.startLine}-${c.endLine}`, c.reason);
        }

        for (const chunk of contextPackage.chunks) {
            let list = budgetedByFile.get(chunk.path);
            if (!list) {
                list = [];
                budgetedByFile.set(chunk.path, list);
            }
            list.push({
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                reason:
                    reasonLookup.get(`${chunk.path}:${chunk.startLine}-${chunk.endLine}`) ??
                    'Relevant implementation range',
                content: chunk.content,
            });
        }

        const dedupeSymbols = (symbols: SymbolRecord[]): SymbolRecord[] => {
            const seen = new Set<string>();
            const out: SymbolRecord[] = [];
            for (const s of symbols) {
                if (!seen.has(s.id)) {
                    seen.add(s.id);
                    out.push(s);
                }
            }
            return out;
        };

        const primaryTargets = plan.primaryFiles
            .map((f) => ({
                filePath: f.filePath,
                role: 'LIKELY_MODIFICATION_TARGET' as const,
                symbolsToModifyOrExtend: dedupeSymbols(f.relevantSymbols),
                codeRanges: budgetedByFile.get(f.filePath) ?? [],
            }))
            .filter((t) => t.codeRanges.length > 0 || t.symbolsToModifyOrExtend.length > 0);

        const relevantContext = plan.relevantContextFiles
            .map((f) => ({
                filePath: f.filePath,
                role: 'RELEVANT_CONTEXT' as const,
                relevantSymbols: dedupeSymbols(f.relevantSymbols),
                codeRanges: budgetedByFile.get(f.filePath) ?? [],
            }))
            .filter((c) => c.codeRanges.length > 0 || c.relevantSymbols.length > 0);

        const packetDependencies = plan.dependencyFiles
            .map((f) => ({
                filePath: f.filePath,
                role: 'DEPENDENCY' as const,
                providedSymbols: dedupeSymbols(f.relevantSymbols),
                codeRanges: budgetedByFile.get(f.filePath) ?? [],
            }))
            .filter((d) => d.codeRanges.length > 0 || d.providedSymbols.length > 0);

        const callersAndEntryPoints = plan.callerAndEntryFiles
            .map((f) => ({
                filePath: f.filePath,
                role: (f.roles.includes('ARCHITECTURAL_ENTRY_POINT') &&
                !f.roles.includes('REVERSE_DEPENDENCY')
                    ? 'ARCHITECTURAL_ENTRY_POINT'
                    : 'REVERSE_DEPENDENCY') as 'REVERSE_DEPENDENCY' | 'ARCHITECTURAL_ENTRY_POINT',
                invocationSites: budgetedByFile.get(f.filePath) ?? [],
            }))
            .filter((c) => c.invocationSites.length > 0);

        const testTargets = plan.testFiles
            .map((f) => {
                const rec = testsMap.get(f.filePath);
                return {
                    filePath: f.filePath,
                    role: 'TEST_TARGET' as const,
                    relationship: rec?.relationship ?? ('direct_import' as const),
                    assertionRanges: budgetedByFile.get(f.filePath) ?? [],
                };
            })
            .filter((t) => t.assertionRanges.length > 0);

        const architecturalInvariants = this.deriveArchitecturalInvariants(
            plan,
            dependencies
        );

        const targetSurface: ImplementationPacket['targetSurface'] = {
            primaryTargets,
            dependencies: packetDependencies,
            callersAndEntryPoints,
            testTargets,
        };

        if (relevantContext.length > 0) {
            targetSurface.relevantContext = relevantContext;
        }

        return {
            task,
            projectState: contextPackage.stateContent,
            targetSurface,
            architecturalInvariants,
            budgetInfo: contextPackage.budgetInfo,
        };
    }

    /**
     * Derives strictly code-grounded architectural invariants (Retriever interface boundary,
     * path-security containment, and token-budget contracts).
     */
    private deriveArchitecturalInvariants(
        plan: PacketSelectionPlan,
        dependencies: ImportEdge[]
    ): string[] {
        const invariants: string[] = [];
        const primaryPaths = new Set(plan.primaryFiles.map((f) => f.filePath));
        const depPaths = new Set(plan.dependencyFiles.map((f) => f.filePath));

        if (
            primaryPaths.has('src/core/context/engine.ts') ||
            depPaths.has('src/core/retrieval/interface.ts')
        ) {
            invariants.push(
                'Retriever Interface Boundary: ContextEngine (src/core/context/engine.ts) must remain decoupled from SQLite persistence and interact with retrieval strictly via the Retriever interface (src/core/retrieval/interface.ts).'
            );
        }

        if (
            depPaths.has('src/core/repository/paths.ts') ||
            dependencies.some((d) => d.resolvedFile === 'src/core/repository/paths.ts')
        ) {
            invariants.push(
                'Repository Path-Security Boundary: All repository file reads and path resolutions must enforce containment via validateSafePath / isPathInsideRepo (src/core/repository/paths.ts).'
            );
        }

        if (
            primaryPaths.has('src/core/context/engine.ts') ||
            depPaths.has('src/core/config/index.ts')
        ) {
            invariants.push(
                'Token Budget Contract: Context generation must enforce the configured tokenBudget ceiling from getConfig (src/core/config/index.ts) such that budgetInfo.totalTokens (stateTokens + codeTokens) never exceeds budgetInfo.budgetTokens.'
            );
        }

        return invariants;
    }

    private dedupeImportEdges(edges: ImportEdge[]): ImportEdge[] {
        const map = new Map<string, ImportEdge>();
        for (const e of edges) {
            const key = `${e.fromFile}->${e.resolvedFile ?? e.rawSpecifier}:${e.importedSymbols.join(',')}`;
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