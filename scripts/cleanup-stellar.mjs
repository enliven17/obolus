#!/usr/bin/env node
// Solana → Solana ve obolus → obolus temizleme scripti
// Kullanım: node scripts/cleanup-solana.mjs

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');

// ── Silinecek dosyalar ────────────────────────────────────────────────────────
const DELETE_FILES = [
  'backend/test-batch-e2e.js',
  'backend/test-e2e-v2.js',
  'scripts/smoke-testnet.mjs',
  'scripts/smoke-testnet.env.example',
];

// ── Görmezden gelinecek dizinler ──────────────────────────────────────────────
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'target', '.next', 'dist',
]);

// ── İşlenecek dosya uzantıları ────────────────────────────────────────────────
const EXTENSIONS = new Set([
  '.js', '.mjs', '.ts', '.tsx', '.json', '.md',
  '.toml', '.rs', '.yaml', '.yml', '.txt', '.env',
]);

// ── Metin değiştirme kuralları (sıra önemli) ─────────────────────────────────
const REPLACEMENTS = [
  // Tablo ve key isimleri (önce bunlar — daha spesifik)
  [/solana_dead_letter/g,        'solana_dead_letter'],
  [/solana_last_signature/g,       'solana_last_signature'],

  // SDK / paket adı
  [/obolus/g,                   'obolus'],

  // Solana SDK ve import ifadeleri
  [/@solana\/solana-web3.js/g,      '@solana/web3.js'],
  [/solana-web3.js/g,                'solana-web3.js'],

  // Env var isimleri
  [/SOLANA_AGENT_SECRET/g,         'SOLANA_AGENT_SECRET'],
  [/SOLANA_NETWORK/g,            'SOLANA_NETWORK'],
  [/SOLANA_USDC_MINT/g,        'SOLANA_USDC_MINT'],
  [/SOLANA_PROGRAM_ID/g,       'SOLANA_PROGRAM_ID'],

  // Token/coin isimleri (dikkatli — kelime sınırlarıyla)
  [/\bXLM\b/g,                    'SOL'],
  [/\bxlm\b/g,                    'sol'],
  [/amount_sol/g,                 'amount_sol'],
  [/amountSol/g,                  'amountSol'],
  [/sol_amount/g,                 'sol_amount'],
  [/solAmount/g,                  'solAmount'],
  [/pay_sol\b(?!ana)/g,           'pay_sol'],  // zaten doğru, dokunma

  // Kelime düzeyinde Solana → Solana (büyük/küçük harf korunarak)
  [/\bStellar\b/g,                'Solana'],
  [/\bstellar\b/g,                'solana'],
  [/\bSTELLAR\b/g,                'SOLANA'],

  // Yorum satırlarında kalan ifadeler
  [/Solana RPC/g,                    'Solana RPC'],
  [/Solana/g,                    'Solana'],
  [/lamports/g,                    'lamports'],
  [/lamport/g,                     'lamport'],
  [/Lamports/g,                    'Lamports'],
  [/Lamport/g,                     'Lamport'],
  [/SOL/g,                     'SOL'],
  [/SOL/g,                      'SOL'],
  [/base58 public key/g,                  'base58 public key'],
  [/base58/g,                     'base58'],
  [/token account/g,                  'token account'],
  [/Token Account/g,                  'Token Account'],
];

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────

function walkDir(dir, callback) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, callback);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      // .env dosyaları uzantısız olabilir
      const isEnv = entry.name.startsWith('.env') || entry.name.endsWith('.env') || entry.name.includes('.env.');
      if (EXTENSIONS.has(ext) || isEnv) {
        callback(full);
      }
    }
  }
}

function applyReplacements(content) {
  let result = content;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Ana işlem ─────────────────────────────────────────────────────────────────

let changed = 0;
let skipped = 0;
let deleted = 0;

// 1. Dosya sil
console.log('\n── Siliniyor ──────────────────────────────────────────');
for (const rel of DELETE_FILES) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) {
    fs.unlinkSync(full);
    console.log(`  DEL  ${rel}`);
    deleted++;
  } else {
    console.log(`  skip ${rel} (zaten yok)`);
  }
}

// 2. Metin değiştir
console.log('\n── Değiştiriliyor ─────────────────────────────────────');
walkDir(ROOT, (filePath) => {
  const rel = path.relative(ROOT, filePath);

  // Silinen dosyaları tekrar işleme
  if (DELETE_FILES.includes(rel.replace(/\\/g, '/'))) return;

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return; }

  const updated = applyReplacements(content);
  if (updated !== content) {
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log(`  MOD  ${rel}`);
    changed++;
  } else {
    skipped++;
  }
});

// 3. Özet
console.log(`\n── Özet ───────────────────────────────────────────────`);
console.log(`  Silinen : ${deleted} dosya`);
console.log(`  Değişen : ${changed} dosya`);
console.log(`  Değişmeyen: ${skipped} dosya`);
console.log('\nTamamlandı.\n');
