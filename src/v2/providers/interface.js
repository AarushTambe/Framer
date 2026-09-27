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
exports.detectLanguage = detectLanguage;
exports.toPosixPath = toPosixPath;
exports.resolveRepoModuleSpecifier = resolveRepoModuleSpecifier;
exports.sortSymbolsDeterministically = sortSymbolsDeterministically;
exports.sortImportsDeterministically = sortImportsDeterministically;
exports.sortReferencesDeterministically = sortReferencesDeterministically;
// src/v2/providers/interface.ts
var fs_1 = require("fs");
var path_1 = require("path");
var paths_1 = require("../../core/repository/paths");
function detectLanguage(filePath) {
    var ext = path_1.default.extname(filePath).toLowerCase();
    if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
        return 'typescript';
    }
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
        return 'javascript';
    }
    return 'unknown';
}
function toPosixPath(p) {
    return p.replace(/\\/g, '/');
}
function resolveRepoModuleSpecifier(repoRoot, fromRelPath, rawSpecifier) {
    if (!rawSpecifier.startsWith('.')) {
        return { resolvedFile: null, isExternal: true };
    }
    var fromDir = path_1.default.dirname(path_1.default.resolve(repoRoot, fromRelPath));
    var baseTarget = path_1.default.resolve(fromDir, rawSpecifier);
    var strippedExtTarget = baseTarget.replace(/\.(m|c)?js$/i, '');
    var candidates = [
        baseTarget,
        "".concat(baseTarget, ".ts"),
        "".concat(baseTarget, ".tsx"),
        "".concat(baseTarget, ".d.ts"),
        "".concat(baseTarget, ".js"),
        "".concat(baseTarget, ".jsx"),
        path_1.default.join(baseTarget, 'index.ts'),
        path_1.default.join(baseTarget, 'index.tsx'),
        path_1.default.join(baseTarget, 'index.js'),
    ];
    if (strippedExtTarget !== baseTarget) {
        candidates.push("".concat(strippedExtTarget, ".ts"), "".concat(strippedExtTarget, ".tsx"), "".concat(strippedExtTarget, ".d.ts"));
    }
    for (var _i = 0, candidates_1 = candidates; _i < candidates_1.length; _i++) {
        var candidate = candidates_1[_i];
        try {
            if (fs_1.default.existsSync(candidate) && fs_1.default.statSync(candidate).isFile()) {
                if (!(0, paths_1.isPathInsideRepo)(repoRoot, candidate)) {
                    return { resolvedFile: null, isExternal: true };
                }
                var resolvedRoot = fs_1.default.realpathSync(repoRoot);
                var resolvedCandidate = fs_1.default.realpathSync(candidate);
                var rel = toPosixPath(path_1.default.relative(resolvedRoot, resolvedCandidate));
                if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) {
                    return { resolvedFile: null, isExternal: true };
                }
                return { resolvedFile: rel, isExternal: false };
            }
        }
        catch (_a) {
            // Ignore inaccessible candidate
        }
    }
    return { resolvedFile: null, isExternal: false };
}
function sortSymbolsDeterministically(symbols) {
    return __spreadArray([], symbols, true).sort(function (a, b) {
        if (a.filePath !== b.filePath)
            return a.filePath.localeCompare(b.filePath);
        if (a.startLine !== b.startLine)
            return a.startLine - b.startLine;
        if (a.endLine !== b.endLine)
            return a.endLine - b.endLine;
        return a.id.localeCompare(b.id);
    });
}
function sortImportsDeterministically(imports) {
    return __spreadArray([], imports, true).sort(function (a, b) {
        if (a.fromFile !== b.fromFile)
            return a.fromFile.localeCompare(b.fromFile);
        if (a.line !== b.line)
            return a.line - b.line;
        return a.rawSpecifier.localeCompare(b.rawSpecifier);
    });
}
function sortReferencesDeterministically(refs) {
    return __spreadArray([], refs, true).sort(function (a, b) {
        if (a.referencingFile !== b.referencingFile)
            return a.referencingFile.localeCompare(b.referencingFile);
        if (a.line !== b.line)
            return a.line - b.line;
        if (a.column !== b.column)
            return a.column - b.column;
        return a.symbolId.localeCompare(b.symbolId);
    });
}
