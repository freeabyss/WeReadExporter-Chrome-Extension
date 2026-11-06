#!/usr/bin/env node
/**
 * 把扩展打包成 zip（仅包含运行时需要的文件）。
 *
 * 运行：node tools/package.mjs
 * 产物：dist/weread-exporter-v<version>.zip
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const distDir = path.join(ROOT, 'dist');
const output = path.join(distDir, `weread-exporter-v${version}.zip`);

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(output)) fs.rmSync(output);

const entries = ['manifest.json', 'src', 'icons', 'docs', 'README.md', 'LICENSE'];
for (const entry of entries) {
  if (!fs.existsSync(path.join(ROOT, entry))) {
    throw new Error('缺少打包文件：' + entry);
  }
}

try {
  execFileSync('zip', ['-r', '-X', '-q', output, ...entries], {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (error) {
  console.error('打包失败：请确认系统已安装 zip 命令。');
  throw error;
}

const size = fs.statSync(output).size;
console.log(`✅ 已生成 ${path.relative(ROOT, output)}（${(size / 1024).toFixed(1)} KB）`);
console.log('   安装方式：解压后打开 chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」');
