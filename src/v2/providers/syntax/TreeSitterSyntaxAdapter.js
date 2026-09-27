"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TreeSitterSyntaxAdapter = void 0;
// src/v2/providers/syntax/TreeSitterSyntaxAdapter.ts
var fs_1 = require("fs");
var tree_sitter_1 = require("tree-sitter");
var paths_1 = require("../../../core/repository/paths");
var interface_1 = require("../interface");
var TypeScriptGrammar = require('tree-sitter-typescript');
var TreeSitterSyntaxAdapter = /** @class */ (function () {
    function TreeSitterSyntaxAdapter(repoRoot) {
        this.repoRoot = repoRoot;
        this.name = 'tree-sitter-syntax';
        this.tsParser = new tree_sitter_1.default();
        this.tsParser.setLanguage(TypeScriptGrammar.typescript);
        this.tsxParser = new tree_sitter_1.default();
        this.tsxParser.setLanguage(TypeScriptGrammar.tsx);
    }
    TreeSitterSyntaxAdapter.prototype.supportsLanguage = function (language) {
        return language === 'typescript' || language === 'javascript';
    };
    TreeSitterSyntaxAdapter.prototype.syncRepositoryFiles = function (_repoFiles) {
        // Stateless per file
    };
    TreeSitterSyntaxAdapter.prototype.analyzeFile = function (relPath) {
        var posixRel = (0, interface_1.toPosixPath)(relPath);
        var safeAbs = (0, paths_1.validateSafePath)(this.repoRoot, posixRel);
        if (!fs_1.default.existsSync(safeAbs)) {
            return { symbols: [], imports: [] };
        }
        var source = fs_1.default.readFileSync(safeAbs, 'utf-8');
        var parser = posixRel.endsWith('.tsx') || posixRel.endsWith('.jsx')
            ? this.tsxParser
            : this.tsParser;
        var tree = parser.parse(source);
        var symbols = [];
        var imports = [];
        this.walkProgram(tree.rootNode, posixRel, symbols, imports);
        return {
            symbols: (0, interface_1.sortSymbolsDeterministically)(symbols),
            imports: (0, interface_1.sortImportsDeterministically)(imports),
        };
    };
    TreeSitterSyntaxAdapter.prototype.walkProgram = function (rootNode, filePath, symbols, imports) {
        for (var _i = 0, _a = rootNode.namedChildren; _i < _a.length; _i++) {
            var child = _a[_i];
            var isExported = child.type === 'export_statement';
            var declNode = isExported
                ? child.childForFieldName('declaration') || child.namedChildren[0]
                : child;
            if (child.type === 'import_statement') {
                var edge = this.parseImportNode(child, filePath);
                if (edge)
                    imports.push(edge);
                continue;
            }
            if (!declNode)
                continue;
            var effectiveStartLine = (isExported ? child : declNode).startPosition.row + 1;
            var effectiveEndLine = (isExported ? child : declNode).endPosition.row + 1;
            if (declNode.type === 'class_declaration') {
                var nameNode = declNode.childForFieldName('name');
                if (!nameNode)
                    continue;
                var className = nameNode.text;
                var classId = "".concat(filePath, "#").concat(className);
                symbols.push({
                    id: classId,
                    name: className,
                    kind: 'class',
                    filePath: filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
                var bodyNode = declNode.childForFieldName('body');
                if (bodyNode) {
                    for (var _b = 0, _c = bodyNode.namedChildren; _b < _c.length; _b++) {
                        var member = _c[_b];
                        if (member.type === 'method_definition') {
                            var mNameNode = member.childForFieldName('name');
                            if (!mNameNode)
                                continue;
                            var methodName = mNameNode.text;
                            symbols.push({
                                id: "".concat(filePath, "#").concat(className, ".").concat(methodName),
                                name: methodName,
                                kind: 'method',
                                filePath: filePath,
                                startLine: member.startPosition.row + 1,
                                endLine: member.endPosition.row + 1,
                                exported: isExported,
                                parentSymbolId: classId,
                            });
                        }
                    }
                }
            }
            else if (declNode.type === 'function_declaration') {
                var nameNode = declNode.childForFieldName('name');
                if (!nameNode)
                    continue;
                symbols.push({
                    id: "".concat(filePath, "#").concat(nameNode.text),
                    name: nameNode.text,
                    kind: 'function',
                    filePath: filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            }
            else if (declNode.type === 'interface_declaration') {
                var nameNode = declNode.childForFieldName('name');
                if (!nameNode)
                    continue;
                symbols.push({
                    id: "".concat(filePath, "#").concat(nameNode.text),
                    name: nameNode.text,
                    kind: 'interface',
                    filePath: filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            }
            else if (declNode.type === 'type_alias_declaration') {
                var nameNode = declNode.childForFieldName('name');
                if (!nameNode)
                    continue;
                symbols.push({
                    id: "".concat(filePath, "#").concat(nameNode.text),
                    name: nameNode.text,
                    kind: 'type',
                    filePath: filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            }
            else if (declNode.type === 'enum_declaration') {
                var nameNode = declNode.childForFieldName('name');
                if (!nameNode)
                    continue;
                symbols.push({
                    id: "".concat(filePath, "#").concat(nameNode.text),
                    name: nameNode.text,
                    kind: 'enum',
                    filePath: filePath,
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    exported: isExported,
                });
            }
            else if (declNode.type === 'lexical_declaration' || declNode.type === 'variable_declaration') {
                for (var _d = 0, _e = declNode.namedChildren; _d < _e.length; _d++) {
                    var declarator = _e[_d];
                    if (declarator.type !== 'variable_declarator')
                        continue;
                    var nameNode = declarator.childForFieldName('name');
                    var valueNode = declarator.childForFieldName('value');
                    if (!nameNode || nameNode.type !== 'identifier')
                        continue;
                    var isFuncLike = valueNode &&
                        (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression');
                    symbols.push({
                        id: "".concat(filePath, "#").concat(nameNode.text),
                        name: nameNode.text,
                        kind: isFuncLike ? 'function' : 'variable',
                        filePath: filePath,
                        startLine: effectiveStartLine,
                        endLine: effectiveEndLine,
                        exported: isExported,
                    });
                }
            }
        }
    };
    TreeSitterSyntaxAdapter.prototype.parseImportNode = function (node, fromFile) {
        var sourceNode = node.childForFieldName('source');
        if (!sourceNode)
            return null;
        var rawSpecifier = sourceNode.text.replace(/^['"]|['"]$/g, '');
        var _a = (0, interface_1.resolveRepoModuleSpecifier)(this.repoRoot, fromFile, rawSpecifier), resolvedFile = _a.resolvedFile, isExternal = _a.isExternal;
        var importedSymbols = [];
        var isTypeOnly = node.text.startsWith('import type ');
        var collectNamedImports = function (n) {
            if (n.type === 'import_specifier') {
                var nameNode = n.childForFieldName('name') || n.namedChildren[0];
                if (nameNode)
                    importedSymbols.push(nameNode.text);
                return;
            }
            if (n.type === 'namespace_import') {
                var idNode = n.namedChildren[0];
                if (idNode)
                    importedSymbols.push("* as ".concat(idNode.text));
                return;
            }
            if (n.type === 'import_clause') {
                for (var _i = 0, _a = n.namedChildren; _i < _a.length; _i++) {
                    var c = _a[_i];
                    if (c.type === 'identifier') {
                        importedSymbols.push(c.text);
                    }
                    else {
                        collectNamedImports(c);
                    }
                }
                return;
            }
            for (var _b = 0, _c = n.namedChildren; _b < _c.length; _b++) {
                var c = _c[_b];
                collectNamedImports(c);
            }
        };
        collectNamedImports(node);
        return {
            fromFile: fromFile,
            rawSpecifier: rawSpecifier,
            resolvedFile: resolvedFile,
            isExternal: isExternal,
            importedSymbols: importedSymbols.sort(),
            isTypeOnly: isTypeOnly,
            line: node.startPosition.row + 1,
        };
    };
    return TreeSitterSyntaxAdapter;
}());
exports.TreeSitterSyntaxAdapter = TreeSitterSyntaxAdapter;
