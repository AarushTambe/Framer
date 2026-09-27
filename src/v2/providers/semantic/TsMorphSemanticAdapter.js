"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TsMorphSemanticAdapter = void 0;
// src/v2/providers/semantic/TsMorphSemanticAdapter.ts
var fs_1 = require("fs");
var path_1 = require("path");
var ts_morph_1 = require("ts-morph");
var paths_1 = require("../../../core/repository/paths");
var interface_1 = require("../interface");
var TsMorphSemanticAdapter = /** @class */ (function () {
    function TsMorphSemanticAdapter(repoRoot) {
        this.repoRoot = repoRoot;
        this.name = 'ts-morph-semantic';
        this.trackedRelPaths = new Set();
        this.resolvedRepoRoot = fs_1.default.existsSync(repoRoot) ? fs_1.default.realpathSync(repoRoot) : path_1.default.resolve(repoRoot);
        this.project = new ts_morph_1.Project({
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
    TsMorphSemanticAdapter.prototype.supportsLanguage = function (language) {
        return language === 'typescript' || language === 'javascript';
    };
    TsMorphSemanticAdapter.prototype.syncRepositoryFiles = function (repoFiles) {
        var nextSet = new Set(repoFiles.map(interface_1.toPosixPath));
        for (var _i = 0, _a = Array.from(this.trackedRelPaths); _i < _a.length; _i++) {
            var existingRel = _a[_i];
            if (!nextSet.has(existingRel)) {
                var absPath = path_1.default.resolve(this.repoRoot, existingRel);
                var sf = this.project.getSourceFile(absPath);
                if (sf) {
                    this.project.removeSourceFile(sf);
                }
                this.trackedRelPaths.delete(existingRel);
            }
        }
        for (var _b = 0, nextSet_1 = nextSet; _b < nextSet_1.length; _b++) {
            var relPath = nextSet_1[_b];
            var safeAbs = (0, paths_1.validateSafePath)(this.repoRoot, relPath);
            var existingSf = this.project.getSourceFile(safeAbs);
            if (!existingSf) {
                this.project.addSourceFileAtPathIfExists(safeAbs);
            }
            else {
                existingSf.refreshFromFileSystemSync();
            }
            this.trackedRelPaths.add(relPath);
        }
    };
    TsMorphSemanticAdapter.prototype.getOrLoadSourceFile = function (relPath) {
        var posixRel = (0, interface_1.toPosixPath)(relPath);
        var safeAbs = (0, paths_1.validateSafePath)(this.repoRoot, posixRel);
        var sf = this.project.getSourceFile(safeAbs);
        if (!sf && fs_1.default.existsSync(safeAbs)) {
            sf = this.project.addSourceFileAtPathIfExists(safeAbs);
            if (sf)
                this.trackedRelPaths.add(posixRel);
        }
        return sf || null;
    };
    TsMorphSemanticAdapter.prototype.analyzeFile = function (relPath) {
        var posixRel = (0, interface_1.toPosixPath)(relPath);
        var sf = this.getOrLoadSourceFile(posixRel);
        if (!sf) {
            return { symbols: [], imports: [] };
        }
        var symbols = this.extractSymbols(sf, posixRel);
        var imports = this.extractImports(sf, posixRel);
        return {
            symbols: (0, interface_1.sortSymbolsDeterministically)(symbols),
            imports: (0, interface_1.sortImportsDeterministically)(imports),
        };
    };
    TsMorphSemanticAdapter.prototype.extractSymbols = function (sf, filePath) {
        var records = [];
        for (var _i = 0, _a = sf.getClasses(); _i < _a.length; _i++) {
            var cls = _a[_i];
            var className = cls.getName();
            if (!className)
                continue;
            var classId = "".concat(filePath, "#").concat(className);
            records.push({
                id: classId,
                name: className,
                kind: 'class',
                filePath: filePath,
                startLine: cls.getStartLineNumber(),
                endLine: cls.getEndLineNumber(),
                exported: cls.isExported(),
            });
            for (var _b = 0, _c = cls.getMethods(); _b < _c.length; _b++) {
                var method = _c[_b];
                var methodName = method.getName();
                if (!methodName)
                    continue;
                records.push({
                    id: "".concat(filePath, "#").concat(className, ".").concat(methodName),
                    name: methodName,
                    kind: 'method',
                    filePath: filePath,
                    startLine: method.getStartLineNumber(),
                    endLine: method.getEndLineNumber(),
                    exported: cls.isExported(),
                    parentSymbolId: classId,
                });
            }
        }
        for (var _d = 0, _e = sf.getFunctions(); _d < _e.length; _d++) {
            var fn = _e[_d];
            var fnName = fn.getName();
            if (!fnName)
                continue;
            records.push({
                id: "".concat(filePath, "#").concat(fnName),
                name: fnName,
                kind: 'function',
                filePath: filePath,
                startLine: fn.getStartLineNumber(),
                endLine: fn.getEndLineNumber(),
                exported: fn.isExported(),
            });
        }
        for (var _f = 0, _g = sf.getInterfaces(); _f < _g.length; _f++) {
            var iface = _g[_f];
            var ifaceName = iface.getName();
            if (!ifaceName)
                continue;
            records.push({
                id: "".concat(filePath, "#").concat(ifaceName),
                name: ifaceName,
                kind: 'interface',
                filePath: filePath,
                startLine: iface.getStartLineNumber(),
                endLine: iface.getEndLineNumber(),
                exported: iface.isExported(),
            });
        }
        for (var _h = 0, _j = sf.getTypeAliases(); _h < _j.length; _h++) {
            var typeAlias = _j[_h];
            var typeName = typeAlias.getName();
            if (!typeName)
                continue;
            records.push({
                id: "".concat(filePath, "#").concat(typeName),
                name: typeName,
                kind: 'type',
                filePath: filePath,
                startLine: typeAlias.getStartLineNumber(),
                endLine: typeAlias.getEndLineNumber(),
                exported: typeAlias.isExported(),
            });
        }
        for (var _k = 0, _l = sf.getEnums(); _k < _l.length; _k++) {
            var enumDecl = _l[_k];
            var enumName = enumDecl.getName();
            if (!enumName)
                continue;
            records.push({
                id: "".concat(filePath, "#").concat(enumName),
                name: enumName,
                kind: 'enum',
                filePath: filePath,
                startLine: enumDecl.getStartLineNumber(),
                endLine: enumDecl.getEndLineNumber(),
                exported: enumDecl.isExported(),
            });
        }
        for (var _m = 0, _o = sf.getVariableStatements(); _m < _o.length; _m++) {
            var varStmt = _o[_m];
            var isExported = varStmt.isExported();
            for (var _p = 0, _q = varStmt.getDeclarations(); _p < _q.length; _p++) {
                var decl = _q[_p];
                var varName = decl.getName();
                if (!varName)
                    continue;
                var init = decl.getInitializer();
                var isFuncLike = init &&
                    (ts_morph_1.Node.isArrowFunction(init) || ts_morph_1.Node.isFunctionExpression(init));
                records.push({
                    id: "".concat(filePath, "#").concat(varName),
                    name: varName,
                    kind: isFuncLike ? 'function' : 'variable',
                    filePath: filePath,
                    startLine: varStmt.getStartLineNumber(),
                    endLine: varStmt.getEndLineNumber(),
                    exported: isExported,
                });
            }
        }
        return records;
    };
    TsMorphSemanticAdapter.prototype.extractImports = function (sf, fromFile) {
        var edges = [];
        for (var _i = 0, _a = sf.getImportDeclarations(); _i < _a.length; _i++) {
            var imp = _a[_i];
            var rawSpecifier = imp.getModuleSpecifierValue();
            var importedSymbols = [];
            var defaultImport = imp.getDefaultImport();
            if (defaultImport) {
                importedSymbols.push(defaultImport.getText());
            }
            var namespaceImport = imp.getNamespaceImport();
            if (namespaceImport) {
                importedSymbols.push("* as ".concat(namespaceImport.getText()));
            }
            for (var _b = 0, _c = imp.getNamedImports(); _b < _c.length; _b++) {
                var named = _c[_b];
                importedSymbols.push(named.getName());
            }
            var _d = this.resolveImportTarget(imp, fromFile, rawSpecifier), resolvedFile = _d.resolvedFile, isExternal = _d.isExternal;
            edges.push({
                fromFile: fromFile,
                rawSpecifier: rawSpecifier,
                resolvedFile: resolvedFile,
                isExternal: isExternal,
                importedSymbols: importedSymbols.sort(),
                isTypeOnly: imp.isTypeOnly(),
                line: imp.getStartLineNumber(),
            });
        }
        var callExpressions = sf.getDescendantsOfKind(ts_morph_1.SyntaxKind.CallExpression);
        for (var _e = 0, callExpressions_1 = callExpressions; _e < callExpressions_1.length; _e++) {
            var callExpr = callExpressions_1[_e];
            if (callExpr.getExpression().getText() !== 'require')
                continue;
            var args = callExpr.getArguments();
            if (args.length !== 1 || !ts_morph_1.Node.isStringLiteral(args[0]))
                continue;
            var rawSpecifier = args[0].getLiteralValue();
            var _f = (0, interface_1.resolveRepoModuleSpecifier)(this.repoRoot, fromFile, rawSpecifier), resolvedFile = _f.resolvedFile, isExternal = _f.isExternal;
            var importedSymbols = [];
            var parent_1 = callExpr.getParent();
            if (parent_1 && ts_morph_1.Node.isVariableDeclaration(parent_1)) {
                var nameNode = parent_1.getNameNode();
                if (ts_morph_1.Node.isObjectBindingPattern(nameNode)) {
                    for (var _g = 0, _h = nameNode.getElements(); _g < _h.length; _g++) {
                        var el = _h[_g];
                        importedSymbols.push(el.getName());
                    }
                }
                else {
                    importedSymbols.push(nameNode.getText());
                }
            }
            edges.push({
                fromFile: fromFile,
                rawSpecifier: rawSpecifier,
                resolvedFile: resolvedFile,
                isExternal: isExternal,
                importedSymbols: importedSymbols.sort(),
                isTypeOnly: false,
                line: callExpr.getStartLineNumber(),
            });
        }
        return edges;
    };
    TsMorphSemanticAdapter.prototype.resolveImportTarget = function (imp, fromFile, rawSpecifier) {
        if (!rawSpecifier.startsWith('.')) {
            return { resolvedFile: null, isExternal: true };
        }
        var targetSf = imp.getModuleSpecifierSourceFile();
        if (targetSf) {
            var targetAbs = targetSf.getFilePath();
            if ((0, paths_1.isPathInsideRepo)(this.repoRoot, targetAbs)) {
                var realTarget = fs_1.default.realpathSync(targetAbs);
                var rel = (0, interface_1.toPosixPath)(path_1.default.relative(this.resolvedRepoRoot, realTarget));
                if (!rel.startsWith('node_modules/') && !rel.includes('/node_modules/')) {
                    return { resolvedFile: rel, isExternal: false };
                }
            }
            return { resolvedFile: null, isExternal: true };
        }
        return (0, interface_1.resolveRepoModuleSpecifier)(this.repoRoot, fromFile, rawSpecifier);
    };
    TsMorphSemanticAdapter.prototype.findSymbolReferences = function (symbol) {
        var _a, _b;
        var sf = this.getOrLoadSourceFile(symbol.filePath);
        if (!sf)
            return [];
        var targetNode = this.findDeclarationNode(sf, symbol);
        if (!targetNode || typeof targetNode.findReferencesAsNodes !== 'function') {
            return [];
        }
        var locations = [];
        var seenKeys = new Set();
        var nameNode = ((_b = (_a = targetNode).getNameNode) === null || _b === void 0 ? void 0 : _b.call(_a)) || targetNode;
        var defLine = nameNode.getStartLineNumber();
        var defCol = sf.getLineAndColumnAtPos(nameNode.getStart()).column;
        var defKey = "".concat(symbol.filePath, ":").concat(defLine, ":").concat(defCol);
        seenKeys.add(defKey);
        locations.push({
            symbolId: symbol.id,
            referencingFile: symbol.filePath,
            line: defLine,
            column: defCol,
            isDefinition: true,
            referencingSymbolId: symbol.id,
        });
        var refNodes = targetNode.findReferencesAsNodes();
        for (var _i = 0, refNodes_1 = refNodes; _i < refNodes_1.length; _i++) {
            var refNode = refNodes_1[_i];
            var refSf = refNode.getSourceFile();
            var refAbs = refSf.getFilePath();
            if (!(0, paths_1.isPathInsideRepo)(this.repoRoot, refAbs))
                continue;
            var realRefAbs = fs_1.default.realpathSync(refAbs);
            var refRel = (0, interface_1.toPosixPath)(path_1.default.relative(this.resolvedRepoRoot, realRefAbs));
            if (refRel.startsWith('node_modules/') || refRel.includes('/node_modules/'))
                continue;
            if (!this.trackedRelPaths.has(refRel))
                continue;
            var pos = refNode.getStart();
            var _c = refSf.getLineAndColumnAtPos(pos), line = _c.line, column = _c.column;
            var key = "".concat(refRel, ":").concat(line, ":").concat(column);
            if (seenKeys.has(key))
                continue;
            seenKeys.add(key);
            var enclosingSymbolId = this.findEnclosingSymbolId(refNode, refRel);
            locations.push({
                symbolId: symbol.id,
                referencingFile: refRel,
                line: line,
                column: column,
                isDefinition: false,
                referencingSymbolId: enclosingSymbolId,
            });
        }
        return (0, interface_1.sortReferencesDeterministically)(locations);
    };
    TsMorphSemanticAdapter.prototype.findDeclarationNode = function (sf, symbol) {
        if (symbol.kind === 'method' && symbol.parentSymbolId) {
            var parentName = symbol.parentSymbolId.split('#')[1];
            var cls = sf.getClass(parentName);
            return (cls === null || cls === void 0 ? void 0 : cls.getMethod(symbol.name)) || null;
        }
        if (symbol.kind === 'class')
            return sf.getClass(symbol.name) || null;
        if (symbol.kind === 'function') {
            return sf.getFunction(symbol.name) || sf.getVariableDeclaration(symbol.name) || null;
        }
        if (symbol.kind === 'interface')
            return sf.getInterface(symbol.name) || null;
        if (symbol.kind === 'type')
            return sf.getTypeAlias(symbol.name) || null;
        if (symbol.kind === 'enum')
            return sf.getEnum(symbol.name) || null;
        if (symbol.kind === 'variable')
            return sf.getVariableDeclaration(symbol.name) || null;
        return null;
    };
    TsMorphSemanticAdapter.prototype.findEnclosingSymbolId = function (node, filePath) {
        var current = node.getParent();
        while (current) {
            if (ts_morph_1.Node.isMethodDeclaration(current)) {
                var methodName = current.getName();
                var parentClass = current.getParentIfKind(ts_morph_1.SyntaxKind.ClassDeclaration);
                var className = parentClass === null || parentClass === void 0 ? void 0 : parentClass.getName();
                if (className && methodName) {
                    return "".concat(filePath, "#").concat(className, ".").concat(methodName);
                }
            }
            if (ts_morph_1.Node.isFunctionDeclaration(current) && current.getName()) {
                return "".concat(filePath, "#").concat(current.getName());
            }
            if (ts_morph_1.Node.isClassDeclaration(current) && current.getName()) {
                return "".concat(filePath, "#").concat(current.getName());
            }
            if (ts_morph_1.Node.isVariableDeclaration(current) && current.getName()) {
                return "".concat(filePath, "#").concat(current.getName());
            }
            current = current.getParent();
        }
        return undefined;
    };
    return TsMorphSemanticAdapter;
}());
exports.TsMorphSemanticAdapter = TsMorphSemanticAdapter;
