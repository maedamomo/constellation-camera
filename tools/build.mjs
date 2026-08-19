#!/usr/bin/env node
// src/*.js と tools/template.html から、1 ファイルで完結する index.html を作る。
// 通信も外部ファイルもなしで動くようにするため、モジュールを依存順に並べて
// import / export を落としてから埋め込む。
//
//   node tools/build.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

// 依存の順に並べる（data → astro → 各処理 → app）
const ORDER = [
  'data.js', 'astro.js', 'detect.js', 'solve.js',
  'exif.js', 'altaz.js', 'overlay.js', 'sample.js', 'app.js',
];

const strip = (code) =>
  code
    // import 文はまとめて削除（複数行のものも含む）
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+/gm, '');

const parts = ORDER.map((f) => {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  return `// ===== ${f} =====\n${strip(code).trim()}\n`;
});

const js = parts.join('\n') + '\ninit();\n';
const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
if (!tpl.includes('/*INLINE*/')) throw new Error('template.html に /*INLINE*/ がありません');
const html = tpl.replace('/*INLINE*/', () => js);

const dest = path.join(HERE, '..', 'index.html');
fs.writeFileSync(dest, html);
process.stderr.write(`wrote ${dest} (${(html.length / 1024).toFixed(0)} KB)\n`);
