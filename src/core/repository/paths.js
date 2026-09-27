"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPathInsideRepo = isPathInsideRepo;
exports.validateSafePath = validateSafePath;
var fs_1 = require("fs");
var path_1 = require("path");
function isPathInsideRepo(repoRoot, targetPath) {
    try {
        var resolvedTarget = fs_1.default.realpathSync(targetPath);
        var resolvedRoot = fs_1.default.realpathSync(repoRoot);
        var relative = path_1.default.relative(resolvedRoot, resolvedTarget);
        // If it evaluates to '..' or starts with '../' (or '..\' on Windows), or is an absolute path, it is outside.
        return !relative.startsWith('..' + path_1.default.sep) && relative !== '..' && !path_1.default.isAbsolute(relative);
    }
    catch (e) {
        // Missing files or broken symlinks cannot be evaluated securely, assume outside.
        return false;
    }
}
function validateSafePath(repoRoot, requestedPath) {
    var resolvedPath = path_1.default.resolve(repoRoot, requestedPath);
    if (!isPathInsideRepo(repoRoot, resolvedPath)) {
        throw new Error("Security Violation: Path traversal blocked. Cannot access ".concat(requestedPath));
    }
    return resolvedPath;
}
