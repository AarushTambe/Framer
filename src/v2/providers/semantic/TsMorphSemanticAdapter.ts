// src/v2/providers/semantic/TsMorphSemanticAdapter.ts
import fs from 'fs';
import path from 'path';
import { Project, SourceFile, Node, SyntaxKind } from 'ts-morph';
import { isPathInsideRepo, validateSafePath } from '../../../core/repository/paths';
import {
    CodeIntelligenceProvider,
    ImportEdge,
    ReferenceLocation,
    SupportedLanguage,
    SymbolRecord,
    resolveRepoModuleSpecifier,
    sortImportsDeterministically,
    sortReferencesDeterministically,
    sortSymbolsDeterministically,
    toPosixPath,
} from '../interface';

export class TsMorphSemanticAdapter implements CodeIntelligenceProvider {
    public readonly name = 'ts-morph-semantic';
    private project: Project;
    private trackedRelPaths = new Set<string>();
    private resolvedRepoRoot: string;

    constructor(private repoRoot: string) {
        this.resolvedRepoRoot = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : path.resolve(repoRoot);
        this.project = new Project({
            compilerOptions: {
                target: 99,
                module: 1,
                allowJs: true,
                esModuleInterop: true,
                resolveJsonModule: true,
                skipLibCheck: true,
            },
            skipAddingFilesFromTsConfig: true,
            skipFileDependencyResolution: true,
        });
    }

    supportsLanguage(language: SupportedLanguage): boolean {
        return language === 'typescript' || language === 'javascript';
    }

    syncRepositoryFiles(repoFiles: string[]): void {
        const nextSet = new Set(repoFiles.map(toPosixPath));

        for (const existingRel of Array.from(this.trackedRelPaths)) {
            if (!nextSet.has(existingRel)) {
                const absPath = path.resolve(this.repoRoot, existingRel);
                const sf = this.project.getSourceFile(absPath);
                if (sf) {
                    this.project.removeSourceFile(sf);
                }
                this.trackedRelPaths.delete(existingRel);
            }
        }

        for (const relPath of nextSet) {
            const safeAbs = validateSafePath(this.repoRoot, relPath);
            const existingSf = this.project.getSourceFile(safeAbs);
            if (!existingSf) {
                this.project.addSourceFileAtPathIfExists(safeAbs);
            } else {
                existingSf.refreshFromFileSystemSync();
            }
            this.trackedRelPaths.add(relPath);
        }
    }

    private getOrLoadSourceFile(relPath: string): SourceFile | null {
        const posixRel = toPosixPath(relPath);
        const safeAbs = validateSafePath(this.repoRoot, posixRel);
        let sf = this.project.getSourceFile(safeAbs);
        if (!sf && fs.existsSync(safeAbs)) {
            sf = this.project.addSourceFileAtPathIfExists(safeAbs);
            if (sf) this.trackedRelPaths.add(posixRel);
        }
        return sf || null;
    }

    analyzeFile(relPath: string): { symbols: SymbolRecord[]; imports: ImportEdge[] } {
        const posixRel = toPosixPath(relPath);
        const sf = this.getOrLoadSourceFile(posixRel);
        if (!sf) {
            return { symbols: [], imports: [] };
        }

        const symbols = this.extractSymbols(sf, posixRel);
        const imports = this.extractImports(sf, posixRel);

        return {
            symbols: sortSymbolsDeterministically(symbols),
            imports: sortImportsDeterministically(imports),
        };
    }

    private extractSymbols(sf: SourceFile, filePath: string): SymbolRecord[] {
        const records: SymbolRecord[] = [];

        for (const cls of sf.getClasses()) {
            const className = cls.getName();
            if (!className) continue;
            const classId = `${filePath}#${className}`;
            records.push({
                id: classId,
                name: className,
                kind: 'class',
                filePath,
                startLine: cls.getStartLineNumber(),
                endLine: cls.getEndLineNumber(),
                exported: cls.isExported(),
            });

            for (const method of cls.getMethods()) {
                const methodName = method.getName();
                if (!methodName) continue;
                records.push({
                    id: `${filePath}#${className}.${methodName}`,
                    name: methodName,
                    kind: 'method',
                    filePath,
                    startLine: method.getStartLineNumber(),
                    endLine: method.getEndLineNumber(),
                    exported: cls.isExported(),
                    parentSymbolId: classId,
                });
            }
        }

        for (const fn of sf.getFunctions()) {
            const fnName = fn.getName();
            if (!fnName) continue;
            records.push({
                id: `${filePath}#${fnName}`,
                name: fnName,
                kind: 'function',
                filePath,
                startLine: fn.getStartLineNumber(),
                endLine: fn.getEndLineNumber(),
                exported: fn.isExported(),
            });
        }

        for (const iface of sf.getInterfaces()) {
            const ifaceName = iface.getName();
            if (!ifaceName) continue;
            records.push({
                id: `${filePath}#${ifaceName}`,
                name: ifaceName,
                kind: 'interface',
                filePath,
                startLine: iface.getStartLineNumber(),
                endLine: iface.getEndLineNumber(),
                exported: iface.isExported(),
            });
        }

        for (const typeAlias of sf.getTypeAliases()) {
            const typeName = typeAlias.getName();
            if (!typeName) continue;
            records.push({
                id: `${filePath}#${typeName}`,
                name: typeName,
                kind: 'type',
                filePath,
                startLine: typeAlias.getStartLineNumber(),
                endLine: typeAlias.getEndLineNumber(),
                exported: typeAlias.isExported(),
            });
        }

        for (const enumDecl of sf.getEnums()) {
            const enumName = enumDecl.getName();
            if (!enumName) continue;
            records.push({
                id: `${filePath}#${enumName}`,
                name: enumName,
                kind: 'enum',
                filePath,
                startLine: enumDecl.getStartLineNumber(),
                endLine: enumDecl.getEndLineNumber(),
                exported: enumDecl.isExported(),
            });
        }

        for (const varStmt of sf.getVariableStatements()) {
            const isExported = varStmt.isExported();
            for (const decl of varStmt.getDeclarations()) {
                const varName = decl.getName();
                if (!varName) continue;
                const init = decl.getInitializer();
                const isFuncLike =
                    init &&
                    (Node.isArrowFunction(init) || Node.isFunctionExpression(init));

                records.push({
                    id: `${filePath}#${varName}`,
                    name: varName,
                    kind: isFuncLike ? 'function' : 'variable',
                    filePath,
                    startLine: varStmt.getStartLineNumber(),
                    endLine: varStmt.getEndLineNumber(),
                    exported: isExported,
                });
            }
        }

        return records;
    }

    private extractImports(sf: SourceFile, fromFile: string): ImportEdge[] {
        const edges: ImportEdge[] = [];

        for (const imp of sf.getImportDeclarations()) {
            const rawSpecifier = imp.getModuleSpecifierValue();
            const importedSymbols: string[] = [];

            const defaultImport = imp.getDefaultImport();
            if (defaultImport) {
                importedSymbols.push(defaultImport.getText());
            }

            const namespaceImport = imp.getNamespaceImport();
            if (namespaceImport) {
                importedSymbols.push(`* as ${namespaceImport.getText()}`);
            }

            for (const named of imp.getNamedImports()) {
                importedSymbols.push(named.getName());
            }

            const { resolvedFile, isExternal } = this.resolveImportTarget(imp, fromFile, rawSpecifier);

            edges.push({
                fromFile,
                rawSpecifier,
                resolvedFile,
                isExternal,
                importedSymbols: importedSymbols.sort(),
                isTypeOnly: imp.isTypeOnly(),
                line: imp.getStartLineNumber(),
            });
        }

        const callExpressions = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const callExpr of callExpressions) {
            if (callExpr.getExpression().getText() !== 'require') continue;
            const args = callExpr.getArguments();
            if (args.length !== 1 || !Node.isStringLiteral(args[0])) continue;

            const rawSpecifier = args[0].getLiteralValue();
            const { resolvedFile, isExternal } = resolveRepoModuleSpecifier(
                this.repoRoot,
                fromFile,
                rawSpecifier
            );

            const importedSymbols: string[] = [];
            const parent = callExpr.getParent();
            if (parent && Node.isVariableDeclaration(parent)) {
                const nameNode = parent.getNameNode();
                if (Node.isObjectBindingPattern(nameNode)) {
                    for (const el of nameNode.getElements()) {
                        importedSymbols.push(el.getName());
                    }
                } else {
                    importedSymbols.push(nameNode.getText());
                }
            }

            edges.push({
                fromFile,
                rawSpecifier,
                resolvedFile,
                isExternal,
                importedSymbols: importedSymbols.sort(),
                isTypeOnly: false,
                line: callExpr.getStartLineNumber(),
            });
        }

        return edges;
    }

    private resolveImportTarget(
        imp: ReturnType<SourceFile['getImportDeclarations']>[number],
        fromFile: string,
        rawSpecifier: string
    ): { resolvedFile: string | null; isExternal: boolean } {
        if (!rawSpecifier.startsWith('.')) {
            return { resolvedFile: null, isExternal: true };
        }

        const targetSf = imp.getModuleSpecifierSourceFile();
        if (targetSf) {
            const targetAbs = targetSf.getFilePath();
            if (isPathInsideRepo(this.repoRoot, targetAbs)) {
                const realTarget = fs.realpathSync(targetAbs);
                const rel = toPosixPath(path.relative(this.resolvedRepoRoot, realTarget));
                if (!rel.startsWith('node_modules/') && !rel.includes('/node_modules/')) {
                    return { resolvedFile: rel, isExternal: false };
                }
            }
            return { resolvedFile: null, isExternal: true };
        }

        return resolveRepoModuleSpecifier(this.repoRoot, fromFile, rawSpecifier);
    }

    findSymbolReferences(symbol: SymbolRecord): ReferenceLocation[] {
        const sf = this.getOrLoadSourceFile(symbol.filePath);
        if (!sf) return [];

        const targetNode = this.findDeclarationNode(sf, symbol);
        if (!targetNode || typeof (targetNode as any).findReferencesAsNodes !== 'function') {
            return [];
        }

        const locations: ReferenceLocation[] = [];
        const seenKeys = new Set<string>();

        const nameNode = (targetNode as any).getNameNode?.() || targetNode;
        const defLine = nameNode.getStartLineNumber();
        const defCol = sf.getLineAndColumnAtPos(nameNode.getStart()).column;
        const defKey = `${symbol.filePath}:${defLine}:${defCol}`;
        seenKeys.add(defKey);
        locations.push({
            symbolId: symbol.id,
            referencingFile: symbol.filePath,
            line: defLine,
            column: defCol,
            isDefinition: true,
            referencingSymbolId: symbol.id,
        });

        const refNodes: Node[] = (targetNode as any).findReferencesAsNodes();
        for (const refNode of refNodes) {
            const refSf = refNode.getSourceFile();
            const refAbs = refSf.getFilePath();

            if (!isPathInsideRepo(this.repoRoot, refAbs)) continue;
            const realRefAbs = fs.realpathSync(refAbs);
            const refRel = toPosixPath(path.relative(this.resolvedRepoRoot, realRefAbs));
            if (refRel.startsWith('node_modules/') || refRel.includes('/node_modules/')) continue;
            if (!this.trackedRelPaths.has(refRel)) continue;

            const pos = refNode.getStart();
            const { line, column } = refSf.getLineAndColumnAtPos(pos);
            const key = `${refRel}:${line}:${column}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            const enclosingSymbolId = this.findEnclosingSymbolId(refNode, refRel);

            locations.push({
                symbolId: symbol.id,
                referencingFile: refRel,
                line,
                column,
                isDefinition: false,
                referencingSymbolId: enclosingSymbolId,
            });
        }

        return sortReferencesDeterministically(locations);
    }

    private findDeclarationNode(sf: SourceFile, symbol: SymbolRecord): Node | null {
        if (symbol.kind === 'method' && symbol.parentSymbolId) {
            const parentName = symbol.parentSymbolId.split('#')[1];
            const cls = sf.getClass(parentName);
            return cls?.getMethod(symbol.name) || null;
        }
        if (symbol.kind === 'class') return sf.getClass(symbol.name) || null;
        if (symbol.kind === 'function') {
            return sf.getFunction(symbol.name) || sf.getVariableDeclaration(symbol.name) || null;
        }
        if (symbol.kind === 'interface') return sf.getInterface(symbol.name) || null;
        if (symbol.kind === 'type') return sf.getTypeAlias(symbol.name) || null;
        if (symbol.kind === 'enum') return sf.getEnum(symbol.name) || null;
        if (symbol.kind === 'variable') return sf.getVariableDeclaration(symbol.name) || null;
        return null;
    }

    private findEnclosingSymbolId(node: Node, filePath: string): string | undefined {
        let current: Node | undefined = node.getParent();
        while (current) {
            if (Node.isMethodDeclaration(current)) {
                const methodName = current.getName();
                const parentClass = current.getParentIfKind(SyntaxKind.ClassDeclaration);
                const className = parentClass?.getName();
                if (className && methodName) {
                    return `${filePath}#${className}.${methodName}`;
                }
            }
            if (Node.isFunctionDeclaration(current) && current.getName()) {
                return `${filePath}#${current.getName()}`;
            }
            if (Node.isClassDeclaration(current) && current.getName()) {
                return `${filePath}#${current.getName()}`;
            }
            if (Node.isVariableDeclaration(current) && current.getName()) {
                return `${filePath}#${current.getName()}`;
            }
            current = current.getParent();
        }
        return undefined;
    }
}
