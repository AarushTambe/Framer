"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepositoryIntelligenceService = void 0;
var crypto_1 = require("crypto");
var fs_1 = require("fs");
var path_1 = require("path");
var ignore_1 = require("../../core/indexer/ignore");
var paths_1 = require("../../core/repository/paths");
var interface_1 = require("../providers/interface");
var TsMorphSemanticAdapter_1 = require("../providers/semantic/TsMorphSemanticAdapter");
var TreeSitterSyntaxAdapter_1 = require("../providers/syntax/TreeSitterSyntaxAdapter");
var RepositoryIntelligenceService = /** @class */ (function () {
    function RepositoryIntelligenceService(repoRoot, options) {
        var _a, _b;
        this.repoRoot = repoRoot;
        this.fileCache = new Map();
        this.discoveredFiles = [];
        this.isInitialized = false;
        this.semanticProvider = (_a = options === null || options === void 0 ? void 0 : options.semanticProvider) !== null && _a !== void 0 ? _a : new TsMorphSemanticAdapter_1.TsMorphSemanticAdapter(repoRoot);
        this.syntaxProvider = (_b = options === null || options === void 0 ? void 0 : options.syntaxProvider) !== null && _b !== void 0 ? _b : new TreeSitterSyntaxAdapter_1.TreeSitterSyntaxAdapter(repoRoot);
    }
    RepositoryIntelligenceService.prototype.hashFileContent = function (fullPath) {
        var buf = fs_1.default.readFileSync(fullPath);
        return crypto_1.default.createHash('sha256').update(buf).digest('hex');
    };
    RepositoryIntelligenceService.prototype.refreshRepository = function () {
        var _this = this;
        var ig = (0, ignore_1.getIgnorer)(this.repoRoot);
        var files = [];
        var traverse = function (currentDir, isRoot) {
            if (!fs_1.default.existsSync(currentDir))
                return;
            if (!isRoot && fs_1.default.existsSync(path_1.default.join(currentDir, '.framer'))) {
                return;
            }
            var entries = fs_1.default.readdirSync(currentDir, { withFileTypes: true });
            for (var _i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
                var entry = entries_1[_i];
                var fullPath = path_1.default.join(currentDir, entry.name);
                var relPath = (0, interface_1.toPosixPath)(path_1.default.relative(_this.repoRoot, fullPath));
                if (ig.ignores(relPath))
                    continue;
                if (relPath.startsWith('tests/') &&
                    entry.isDirectory() &&
                    (entry.name === 'test-repo' || entry.name.endsWith('-repo'))) {
                    continue;
                }
                var lstat = fs_1.default.lstatSync(fullPath);
                if (lstat.isSymbolicLink() && !(0, paths_1.isPathInsideRepo)(_this.repoRoot, fullPath))
                    continue;
                if (!lstat.isSymbolicLink() && !(0, paths_1.isPathInsideRepo)(_this.repoRoot, fullPath))
                    continue;
                if (entry.isDirectory()) {
                    traverse(fullPath, false);
                }
                else {
                    var lang = (0, interface_1.detectLanguage)(relPath);
                    if (lang !== 'unknown') {
                        files.push(relPath);
                    }
                }
            }
        };
        traverse(this.repoRoot, true);
        files.sort(function (a, b) { return a.localeCompare(b); });
        this.discoveredFiles = files;
        this.semanticProvider.syncRepositoryFiles(this.discoveredFiles);
        this.syntaxProvider.syncRepositoryFiles(this.discoveredFiles);
        var activeSet = new Set(this.discoveredFiles);
        for (var _i = 0, _a = Array.from(this.fileCache.keys()); _i < _a.length; _i++) {
            var cachedPath = _a[_i];
            if (!activeSet.has(cachedPath)) {
                this.fileCache.delete(cachedPath);
            }
        }
        for (var _b = 0, _c = this.discoveredFiles; _b < _c.length; _b++) {
            var relPath = _c[_b];
            this.ensureFileAnalyzed(relPath);
        }
        this.isInitialized = true;
    };
    RepositoryIntelligenceService.prototype.ensureInitialized = function () {
        if (!this.isInitialized) {
            this.refreshRepository();
        }
    };
    RepositoryIntelligenceService.prototype.ensureFileAnalyzed = function (relPath) {
        var posixRel = (0, interface_1.toPosixPath)(relPath);
        var safeAbs = (0, paths_1.validateSafePath)(this.repoRoot, posixRel);
        if (!fs_1.default.existsSync(safeAbs) || !fs_1.default.statSync(safeAbs).isFile()) {
            return null;
        }
        var language = (0, interface_1.detectLanguage)(posixRel);
        if (language === 'unknown') {
            return null;
        }
        var currentHash = this.hashFileContent(safeAbs);
        var cached = this.fileCache.get(posixRel);
        if (cached && cached.sha256 === currentHash) {
            return cached;
        }
        var analysis = {
            symbols: [],
            imports: [],
        };
        if (this.semanticProvider.supportsLanguage(language)) {
            try {
                analysis = this.semanticProvider.analyzeFile(posixRel);
            }
            catch (_a) {
                if (this.syntaxProvider.supportsLanguage(language)) {
                    analysis = this.syntaxProvider.analyzeFile(posixRel);
                }
            }
        }
        else if (this.syntaxProvider.supportsLanguage(language)) {
            analysis = this.syntaxProvider.analyzeFile(posixRel);
        }
        var record = {
            filePath: posixRel,
            language: language,
            sha256: currentHash,
            symbols: (0, interface_1.sortSymbolsDeterministically)(analysis.symbols),
            imports: (0, interface_1.sortImportsDeterministically)(analysis.imports),
        };
        this.fileCache.set(posixRel, record);
        return record;
    };
    RepositoryIntelligenceService.prototype.getTrackedFiles = function () {
        this.ensureInitialized();
        return __spreadArray([], this.discoveredFiles, true);
    };
    RepositoryIntelligenceService.prototype.getSymbolsInFile = function (filePath) {
        this.ensureInitialized();
        var posixRel = (0, interface_1.toPosixPath)(filePath);
        var info = this.ensureFileAnalyzed(posixRel);
        return info ? __spreadArray([], info.symbols, true) : [];
    };
    RepositoryIntelligenceService.prototype.getImportsOfFile = function (filePath) {
        this.ensureInitialized();
        var posixRel = (0, interface_1.toPosixPath)(filePath);
        var info = this.ensureFileAnalyzed(posixRel);
        return info ? __spreadArray([], info.imports, true) : [];
    };
    RepositoryIntelligenceService.prototype.getImportersOfFile = function (filePath) {
        this.ensureInitialized();
        var targetRel = (0, interface_1.toPosixPath)(filePath);
        (0, paths_1.validateSafePath)(this.repoRoot, targetRel);
        var importers = [];
        for (var _i = 0, _a = this.discoveredFiles; _i < _a.length; _i++) {
            var rel = _a[_i];
            var info = this.ensureFileAnalyzed(rel);
            if (!info)
                continue;
            for (var _b = 0, _c = info.imports; _b < _c.length; _b++) {
                var edge = _c[_b];
                if (!edge.isExternal && edge.resolvedFile === targetRel) {
                    importers.push(edge);
                }
            }
        }
        return (0, interface_1.sortImportsDeterministically)(importers);
    };
    RepositoryIntelligenceService.prototype.findSymbolDefinitions = function (symbolName) {
        this.ensureInitialized();
        var matches = [];
        for (var _i = 0, _a = this.discoveredFiles; _i < _a.length; _i++) {
            var rel = _a[_i];
            var info = this.ensureFileAnalyzed(rel);
            if (!info)
                continue;
            for (var _b = 0, _c = info.symbols; _b < _c.length; _b++) {
                var sym = _c[_b];
                if (sym.name === symbolName || sym.id.endsWith("#".concat(symbolName))) {
                    matches.push(sym);
                }
            }
        }
        return (0, interface_1.sortSymbolsDeterministically)(matches);
    };
    RepositoryIntelligenceService.prototype.findSymbolReferences = function (symbolIdOrName) {
        this.ensureInitialized();
        var targetSymbols = [];
        if (symbolIdOrName.includes('#')) {
            var filePath = symbolIdOrName.split('#')[0];
            var fileSyms = this.getSymbolsInFile(filePath);
            targetSymbols = fileSyms.filter(function (s) { return s.id === symbolIdOrName; });
        }
        else {
            targetSymbols = this.findSymbolDefinitions(symbolIdOrName);
        }
        if (targetSymbols.length === 0 || !this.semanticProvider.findSymbolReferences) {
            return [];
        }
        var allRefs = [];
        for (var _i = 0, targetSymbols_1 = targetSymbols; _i < targetSymbols_1.length; _i++) {
            var sym = targetSymbols_1[_i];
            var refs = this.semanticProvider.findSymbolReferences(sym);
            allRefs.push.apply(allRefs, refs);
        }
        return (0, interface_1.sortReferencesDeterministically)(allRefs);
    };
    RepositoryIntelligenceService.prototype.findRelatedTests = function (filePath) {
        this.ensureInitialized();
        var targetRel = (0, interface_1.toPosixPath)(filePath);
        (0, paths_1.validateSafePath)(this.repoRoot, targetRel);
        var isTestFile = function (p) {
            return p.startsWith('tests/') ||
                p.startsWith('test/') ||
                p.includes('.test.') ||
                p.includes('.spec.');
        };
        var results = new Map();
        var directImporters = this.getImportersOfFile(targetRel);
        var nonTestImporters = [];
        for (var _i = 0, directImporters_1 = directImporters; _i < directImporters_1.length; _i++) {
            var edge = directImporters_1[_i];
            if (isTestFile(edge.fromFile)) {
                results.set(edge.fromFile, {
                    testFile: edge.fromFile,
                    relationship: 'direct_import',
                    importedTargetFiles: [targetRel],
                });
            }
            else {
                nonTestImporters.push(edge.fromFile);
            }
        }
        for (var _a = 0, nonTestImporters_1 = nonTestImporters; _a < nonTestImporters_1.length; _a++) {
            var intermediateFile = nonTestImporters_1[_a];
            var secondHopEdges = this.getImportersOfFile(intermediateFile);
            for (var _b = 0, secondHopEdges_1 = secondHopEdges; _b < secondHopEdges_1.length; _b++) {
                var edge = secondHopEdges_1[_b];
                if (!isTestFile(edge.fromFile))
                    continue;
                if (results.has(edge.fromFile))
                    continue;
                results.set(edge.fromFile, {
                    testFile: edge.fromFile,
                    relationship: 'transitive_import',
                    importedTargetFiles: [intermediateFile],
                });
            }
        }
        var baseName = path_1.default.basename(targetRel, path_1.default.extname(targetRel)).toLowerCase();
        if (baseName !== 'index') {
            for (var _c = 0, _d = this.discoveredFiles; _c < _d.length; _c++) {
                var candidate = _d[_c];
                if (!isTestFile(candidate) || results.has(candidate))
                    continue;
                var testBase = path_1.default.basename(candidate, path_1.default.extname(candidate)).toLowerCase();
                if (testBase === baseName ||
                    testBase === "".concat(baseName, ".test") ||
                    testBase === "".concat(baseName, ".spec")) {
                    results.set(candidate, {
                        testFile: candidate,
                        relationship: 'naming_convention',
                        importedTargetFiles: [],
                    });
                }
            }
        }
        var relationshipRank = {
            direct_import: 1,
            transitive_import: 2,
            naming_convention: 3,
        };
        return Array.from(results.values()).sort(function (a, b) {
            var rankDiff = relationshipRank[a.relationship] - relationshipRank[b.relationship];
            if (rankDiff !== 0)
                return rankDiff;
            return a.testFile.localeCompare(b.testFile);
        });
    };
    /**
     * Identifies genuine application/runtime entry points (CLI binary entry, CLI command handlers,
     * and MCP server/tool boundaries). Does NOT treat internal subsystem `index.ts` files as
     * architectural entry points.
     */
    RepositoryIntelligenceService.prototype.findArchitecturalEntryPoints = function (areaOrFilePath) {
        this.ensureInitialized();
        var normalizedFilter = areaOrFilePath ? (0, interface_1.toPosixPath)(areaOrFilePath) : undefined;
        var entries = [];
        for (var _i = 0, _a = this.discoveredFiles; _i < _a.length; _i++) {
            var rel = _a[_i];
            if (rel === 'src/cli/index.ts' || rel === 'src/index.ts') {
                entries.push({
                    filePath: rel,
                    kind: 'cli_entry',
                    reason: 'Primary CLI entrypoint registering top-level commands',
                });
            }
            else if (rel.startsWith('src/cli/commands/')) {
                entries.push({
                    filePath: rel,
                    kind: 'cli_command',
                    reason: 'CLI command handler entrypoint',
                });
            }
            else if (rel === 'src/mcp/server.ts' || rel === 'src/mcp/tools.ts') {
                entries.push({
                    filePath: rel,
                    kind: 'mcp_entry',
                    reason: 'MCP server and tool registration entrypoint',
                });
            }
        }
        if (!normalizedFilter) {
            return entries.sort(function (a, b) { return a.filePath.localeCompare(b.filePath); });
        }
        var directImporterSet = new Set(this.getImportersOfFile(normalizedFilter).map(function (e) { return e.fromFile; }));
        var reachableFromTarget = new Set();
        var queue = [normalizedFilter];
        var visited = new Set([normalizedFilter]);
        while (queue.length > 0) {
            var current = queue.shift();
            reachableFromTarget.add(current);
            for (var _b = 0, _c = this.getImportersOfFile(current); _b < _c.length; _b++) {
                var edge = _c[_b];
                if (!visited.has(edge.fromFile)) {
                    visited.add(edge.fromFile);
                    queue.push(edge.fromFile);
                }
            }
        }
        return entries
            .filter(function (e) {
            if (e.filePath.startsWith(normalizedFilter))
                return true;
            // CLI command handlers only count as entry points for a target file if they directly import it
            if (e.kind === 'cli_command') {
                return directImporterSet.has(e.filePath);
            }
            // Top-level system boundaries (cli_entry, mcp_entry) can be reached transitively
            return reachableFromTarget.has(e.filePath);
        })
            .sort(function (a, b) { return a.filePath.localeCompare(b.filePath); });
    };
    return RepositoryIntelligenceService;
}());
exports.RepositoryIntelligenceService = RepositoryIntelligenceService;
