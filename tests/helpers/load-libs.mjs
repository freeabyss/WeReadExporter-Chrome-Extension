/**
 * 在 Node 中加载扩展的纯逻辑模块（按 manifest 的顺序）。
 * 这些文件都是 IIFE 并挂到 globalThis.__WRX__，加载方式与 content script 一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

export const LIB_FILES = [
  'src/lib/namespace.js',
  'src/lib/md5.js',
  'src/lib/weread-hash.js',
  'src/lib/weread-decode.js',
  'src/lib/weread-state.js',
  'src/lib/weread-api.js',
  'src/lib/formats.js',
  'src/lib/exporter.js',
];

export const CONTENT_FILES = [
  'src/vendor/turndown.js',
  ...LIB_FILES,
  'src/ui.js',
  'src/content.js',
];

export function readFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** 加载纯逻辑模块，返回 __WRX__ 命名空间。 */
export function loadLibs() {
  for (const file of LIB_FILES) {
    vm.runInThisContext(readFile(file), { filename: file });
  }
  return globalThis.__WRX__;
}

/** 读取 golden 向量（由 reference 实现生成）。 */
export function loadVectors() {
  return JSON.parse(readFile('tests/fixtures/reference-vectors.json'));
}
