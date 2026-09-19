#!/usr/bin/env node
/*
 * build-installer.mjs — Gera o DeepsProxy-Setup-<versão>.exe com o Inno Setup 6.
 *
 * Requer o Inno Setup 6 instalado (ISCC.exe). Se não encontrar, mostra como
 * instalar:
 *     winget install JRSoftware.InnoSetup
 *
 * Uso:  npm run build:install    (ou  node scripts/build-installer.mjs)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ISS = path.join(__dirname, 'desktop', 'DeepsProxy.iss');
const REL_ROOT = path.join(ROOT, 'release');

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;

log('== Procurando o Inno Setup (ISCC.exe) ==');
const candidates = [
  process.env.INNO_SETUP_PATH,
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
].filter(Boolean);

let iscc = candidates.find((c) => fs.existsSync(c));
if (!iscc) {
  const res = spawnSync('where', ['ISCC.exe'], { encoding: 'utf-8' });
  if (res.status === 0) iscc = res.stdout.trim().split(/\r?\n/)[0];
}

if (!iscc) {
  console.error('✖ Inno Setup 6 não encontrado.');
  console.error('  Instale com:  winget install JRSoftware.InnoSetup');
  console.error('  (ou defina INNO_SETUP_PATH apontando para ISCC.exe)');
  process.exit(1);
}

log(`ISCC.exe: ${iscc}`);
log(`Compilando: ${ISS}`);

const out = spawnSync(iscc, [`/DMyAppVersion=${APP_VERSION}`, ISS], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (out.status !== 0) process.exit(out.status || 1);

const installer = path.join(REL_ROOT, `DeepsProxy-Setup-${APP_VERSION}.exe`);
if (fs.existsSync(installer)) {
  log(`✔ Instalador gerado: ${installer} (${(fs.statSync(installer).size / 1024 / 1024).toFixed(1)} MB)`);
}

function log(msg) {
  console.log(`[build-installer] ${msg}`);
}