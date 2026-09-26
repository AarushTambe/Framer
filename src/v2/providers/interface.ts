// src/v2/providers/interface.ts
import fs from 'fs';
import path from 'path';
import { isPathInsideRepo } from '../../core/repository/paths';

export type SupportedLanguage = 'typescript' | 'javascript' | 'unknown';

export type SymbolKind =
    | 'class'
    | 'interface'
    | 'function'
    | 'method'
    | 'type'
    | 'variable'
    | 'enum';

export interface SymbolRecord {
    id: string;
    name: string;
    kind: SymbolKind;
    filePath: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    parentSymbolId?: string;
}

export interface ImportEdge {
    fromFile: string;
    rawSpecifier: string;
    resolvedFile: string | null;
    isExternal: boolean;
    importedSymbols: string[];
    isTypeOnly: boolean;
    line: number;
}

export interface ReferenceLocation {
    symbolId: string;
    referencingFile: string;
    line: number;
    column: number;
    isDefinition: boolean;
    referencingSymbolId?: string;
}

export interface RelatedTestRecord {
    testFile: string;
    relationship: 'direct_import' | 'transitive_import' | 'naming_convention';
    importedTargetFiles: string[];
}

export interface EntryPointRecord {
    filePath: string;
    kind: 'cli_entry' | 'cli_command' | 'mcp_entry' | 'module_index';
    reason: string;
}

export interface FileIntelligence {
    filePath: string;
    language: SupportedLanguage;
    sha256: string;
    symbols: SymbolRecord[];
    imports: ImportEdge[];
}

export interface CodeIntelligenceProvider {
    readonly name: string;
    supportsLanguage(language: SupportedLanguage): boolean;
    syncRepositoryFiles(repoFiles: string[]): void;
    analyzeFile(relPath: string): { symbols: SymbolRecord[]; imports: ImportEdge[] };
    findSymbolReferences?(symbol: SymbolRecord): ReferenceLocation[];
}

export function detectLanguage(filePath: string): SupportedLanguage {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
        return 'typescript';
    }
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
        return 'javascript';
    }
    return 'unknown';
}

export function toPosixPath(p: string): string {
    return p.replace(/\\/g, '/');
}

export function resolveRepoModuleSpecifier(
    repoRoot: string,
    fromRelPath: string,
    rawSpecifier: string
): { resolvedFile: string | null; isExternal: boolean } {
    if (!rawSpecifier.startsWith('.')) {
        return { resolvedFile: null, isExternal: true };
    }

    const fromDir = path.dirname(path.resolve(repoRoot, fromRelPath));
    const baseTarget = path.resolve(fromDir, rawSpecifier);
    const strippedExtTarget = baseTarget.replace(/\.(m|c)?js$/i, '');

    const candidates: string[] = [
        baseTarget,
        `${baseTarget}.ts`,
        `${baseTarget}.tsx`,
        `${baseTarget}.d.ts`,
        `${baseTarget}.js`,
        `${baseTarget}.jsx`,
        path.join(baseTarget, 'index.ts'),
        path.join(baseTarget, 'index.tsx'),
        path.join(baseTarget, 'index.js'),
    ];

    if (strippedExtTarget !== baseTarget) {
        candidates.push(
            `${strippedExtTarget}.ts`,
            `${strippedExtTarget}.tsx`,
            `${strippedExtTarget}.d.ts`
        );
    }

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                if (!isPathInsideRepo(repoRoot, candidate)) {
                    return { resolvedFile: null, isExternal: true };
                }
                const resolvedRoot = fs.realpathSync(repoRoot);
                const resolvedCandidate = fs.realpathSync(candidate);
                const rel = toPosixPath(path.relative(resolvedRoot, resolvedCandidate));
                if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) {
                    return { resolvedFile: null, isExternal: true };
                }
                return { resolvedFile: rel, isExternal: false };
            }
        } catch {
            // Ignore inaccessible candidate
        }
    }

    return { resolvedFile: null, isExternal: false };
}

export function sortSymbolsDeterministically(symbols: SymbolRecord[]): SymbolRecord[] {
    return [...symbols].sort((a, b) => {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        if (a.startLine !== b.startLine) return a.startLine - b.startLine;
        if (a.endLine !== b.endLine) return a.endLine - b.endLine;
        return a.id.localeCompare(b.id);
    });
}

export function sortImportsDeterministically(imports: ImportEdge[]): ImportEdge[] {
    return [...imports].sort((a, b) => {
        if (a.fromFile !== b.fromFile) return a.fromFile.localeCompare(b.fromFile);
        if (a.line !== b.line) return a.line - b.line;
        return a.rawSpecifier.localeCompare(b.rawSpecifier);
    });
}

export function sortReferencesDeterministically(refs: ReferenceLocation[]): ReferenceLocation[] {
    return [...refs].sort((a, b) => {
        if (a.referencingFile !== b.referencingFile) return a.referencingFile.localeCompare(b.referencingFile);
        if (a.line !== b.line) return a.line - b.line;
        if (a.column !== b.column) return a.column - b.column;
        return a.symbolId.localeCompare(b.symbolId);
    });
}
