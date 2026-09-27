"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIgnorer = getIgnorer;
// src/core/indexer/ignore.ts
var fs_1 = require("fs");
var path_1 = require("path");
var ignore_1 = require("ignore");
function getIgnorer(repoRoot) {
    var ig = (0, ignore_1.default)();
    // Core Framer ignores
    ig.add(['.git', '.framer', 'node_modules', 'dist', 'build']);
    var gitignorePath = path_1.default.join(repoRoot, '.gitignore');
    if (fs_1.default.existsSync(gitignorePath)) {
        var gitignoreContent = fs_1.default.readFileSync(gitignorePath, 'utf-8');
        ig.add(gitignoreContent);
    }
    return ig;
}
