// src/v2/providers/syntax/TreeSitterSyntaxAdapter.ts
import fs from 'fs';
import Parser from 'tree-sitter';
import { validateSafePath } from '../../../core/repository/paths';
import {
    CodeIntelligenceProvider,
    ImportEdge,
    SupportedLanguage,
    SymbolRecord,
    resolveRepoModuleSpecifier,
    sortImportsDeterministically,
    sortSymbolsDeterministically,
    toPosixPath,
} from '../interface';

const TypeScriptGrammar = require('tree-sitter-typescript');

export class TreeSitterSyntaxAdapter implements CodeIntelligenceProvider {
    public readonly name = 'tree-sitter-syntax';
    private tsParser: Parser;
    private tsxParser: Parser;

    constructor(private repoRoot: string) {
        this.tsParser = new Parser();
        this.tsParser.setLanguage(TypeScriptGrammar.typescript);

        this.tsxParser = new Parser();
        this.tsxParser.setLanguage(TypeScriptGrammar.tsx);
    }

    supportsLanguage(language: SupportedLanguage): boolean {
        return language === 'typescript' || language === 'javascript';
    }

    syncRepositoryFiles(_repoFiles: string[]): void {
        // Stateless per file
    }

    analyzeFile(relPath: string): { symbols: SymbolRecord[]; imports: ImportEdge[] } {
        const posixRel = toPosixPath(relPath);
        const safeAbs = validateSafePath(this.repoRoot, posixRel);
        if (!fs.existsSync(safeAbs)) {
            return { symbols: [], imports: [] };
        }

        const source = fs.readFileSync(safeAbs, 'utf-8');
        const parser = posixRel.endsWith('.tsx') || posixRel.endsWith('.jsx')
            ? this.tsxParser
            : this.tsParser;

        const tree = parser.parse(source);
        const symbols: SymbolRecord[] = [];
        const imports: ImportEdge[] = [];

        this.walkProgram(tree.rootNode, posixRel, symbols, imports);

        return {
            symbols: sortSymbolsDeterministically(symbols),
            imports: sortImportsDeterministically(imports),
        };
    }

    private walkProgram(
        rootNode: Parser.SyntaxNode,
        filePath: string,
        symbols: SymbolRecord[],
        imports: ImportEdge[]
    ): void {
        for (const child of rootNode.namedChildren) {
            const isExported = child.type === 'export_statement';
            const declNode = isExported
                ? child.childForFieldName('declaration') || child.namedChildren[0]
                : child;

            if (child.type === 'import_statement') {
                const edge = this.parseImportNode(child, filePath);
                if (edge) imports.push(edge);
                continue;
            }

            if (!declNode) continue;

            const effectiveStartLine = (isExported ? child : declNode).startPosition.row + 1;
            const effectiveEndLine = (isExported ? child : declNode).endPosition.row + 1;

            if (declNode.type === 'class_declaration') {
                const nameNode = declNode.childForFieldName('name');
                if (!nameNode) continue;
                const className = nameNode.text;
                const classId = `${filePath}#${className}`;
                symbols.push({
                    id: classId,
                    name: className,
                    kind: 'class',
                    filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });

                const bodyNode = declNode.childForFieldName('body');
                if (bodyNode) {
                    for (const member of bodyNode.namedChildren) {
                        if (member.type === 'method_definition') {
                            const mNameNode = member.childForFieldName('name');
                            if (!mNameNode) continue;
                            const methodName = mNameNode.text;
                            symbols.push({
                                id: `${filePath}#${className}.${methodName}`,
                                name: methodName,
                                kind: 'method',
                                filePath,
                                startLine: member.startPosition.row + 1,
                                endLine: member.endPosition.row + 1,
                                exported: isExported,
                                parentSymbolId: classId,
                            });
                        }
                    }
                }
            } else if (declNode.type === 'function_declaration') {
                const nameNode = declNode.childForFieldName('name');
                if (!nameNode) continue;
                symbols.push({
                    id: `${filePath}#${nameNode.text}`,
                    name: nameNode.text,
                    kind: 'function',
                    filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            } else if (declNode.type === 'interface_declaration') {
                const nameNode = declNode.childForFieldName('name');
                if (!nameNode) continue;
                symbols.push({
                    id: `${filePath}#${nameNode.text}`,
                    name: nameNode.text,
                    kind: 'interface',
                    filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            } else if (declNode.type === 'type_alias_declaration') {
                const nameNode = declNode.childForFieldName('name');
                if (!nameNode) continue;
                symbols.push({
                    id: `${filePath}#${nameNode.text}`,
                    name: nameNode.text,
                    kind: 'type',
                    filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            } else if (declNode.type === 'enum_declaration') {
                const nameNode = declNode.childForFieldName('name');
                if (!nameNode) continue;
                symbols.push({
                    id: `${filePath}#${nameNode.text}`,
                    name: nameNode.text,
                    kind: 'enum',
                    filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            } else if (declNode.type === 'lexical_declaration' || declNode.type === 'variable_declaration') {
                for (const declarator of declNode.namedChildren) {
                    if (declarator.type !== 'variable_declarator') continue;
                    const nameNode = declarator.childForFieldName('name');
                    const valueNode = declarator.childForFieldName('value');
                    if (!nameNode || nameNode.type !== 'identifier') continue;
                    const isFuncLike =
                        valueNode &&
                        (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression');
                    symbols.push({
                        id: `${filePath}#${nameNode.text}`,
                        name: nameNode.text,
                        kind: isFuncLike ? 'function' : 'variable',
                        filePath,
                        startLine: effectiveStartLine,
                        endLine: effectiveEndLine,
                        exported: isExported,
                    });
                }
            }
        }
    }

    private parseImportNode(node: Parser.SyntaxNode, fromFile: string): ImportEdge | null {
        const sourceNode = node.childForFieldName('source');
        if (!sourceNode) return null;

        const rawSpecifier = sourceNode.text.replace(/^['"]|['"]$/g, '');
        const { resolvedFile, isExternal } = resolveRepoModuleSpecifier(
            this.repoRoot,
            fromFile,
            rawSpecifier
        );

        const importedSymbols: string[] = [];
        const isTypeOnly = node.text.startsWith('import type ');

        const collectNamedImports = (n: Parser.SyntaxNode) => {
            if (n.type === 'import_specifier') {
                const nameNode = n.childForFieldName('name') || n.namedChildren[0];
                if (nameNode) importedSymbols.push(nameNode.text);
                return;
            }
            if (n.type === 'namespace_import') {
                const idNode = n.namedChildren[0];
                if (idNode) importedSymbols.push(`* as ${idNode.text}`);
                return;
            }
            if (n.type === 'import_clause') {
                for (const c of n.namedChildren) {
                    if (c.type === 'identifier') {
                        importedSymbols.push(c.text);
                    } else {
                        collectNamedImports(c);
                    }
                }
                return;
            }
            for (const c of n.namedChildren) {
                collectNamedImports(c);
            }
        };

        collectNamedImports(node);

        return {
            fromFile,
            rawSpecifier,
            resolvedFile,
            isExternal,
            importedSymbols: importedSymbols.sort(),
            isTypeOnly,
            line: node.startPosition.row + 1,
        };
    }
}
