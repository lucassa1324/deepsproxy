#!/usr/bin/env node
/*
 * build-release.mjs — Monta a pasta portátil do DeepsProxy (payload do instalador).
 *
 * O que ele faz:
 *   1. Roda `npm run build` (tsc) para gerar dist/ (sem testes).
 *   2. Monta release/DeepsProxy/ com:
 *        - DeepsProxy.exe          (launcher C#, gerado nesta build)
 *        - icon.ico
 *        - node.exe                (Node runtime oficial, baixado do nodejs.org)
 *        - dist/                   (servidor compilado + assets de UI)
 *        - node_modules/           (deps de produção via npm ci)
 *        - browsers/               (Chromium instalado pelo Playwright)
 *        - templates/, *.json, .env (configs default)
 *   3. Gera release/DeepsProxy-Portable.zip como bônus.
 *
 * Uso:  npm run build:release   (ou  node scripts/build-release.mjs)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REL_ROOT = path.join(ROOT, 'release');
const REL = path.join(REL_ROOT, 'DeepsProxy');
const CACHE = path.join(REL_ROOT, '.cache');

const NODE_VERSION = process.env.DEEPSPROXY_NODE_VERSION || '22.11.0';
const NODE_ARCH = os.arch() === 'arm64' ? 'arm64' : 'x64';
const NODE_ZIP = `node-v${NODE_VERSION}-win-${NODE_ARCH}.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}`;

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;

const winScripts = path.join(__dirname, 'desktop');
const isWindows = process.platform === 'win32';
const NPM = isWindows ? 'npm.cmd' : 'npm';

function npmRun(args, opts = {}) {
  // No Windows, spawnSync de .cmd pode falhar (EINVAL). Chama o npm via
  // npm-cli.js diretamente no node atual (distribuição oficial) com fallback.
  if (isWindows) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) {
      return run(process.execPath, [cli, ...args], opts);
    }
  }
  return run(NPM, args, { shell: true, ...opts });
}

function log(msg) {
  console.log(`[build-release] ${msg}`);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...opts,
  });
  if (res.error) {
    throw new Error(`Erro ao executar "${cmd}": ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`Falha: ${cmd} ${args.join(' ')} (status ${res.status})`);
  }
  return res;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyPreserve(from, to) {
  mkdirp(path.dirname(to));
  fs.copyFileSync(from, to);
}

async function download(url, dest) {
  if (fs.existsSync(dest)) {
    log(`cache hit: ${path.basename(dest)}`);
    return;
  }
  log(`baixando ${url}`);
  mkdirp(path.dirname(dest));
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download falhou: ${res.status} ${res.statusText} (${url})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log(`ok: ${buf.length} bytes`);
}

function step1_build() {
  log('== PASSO 1: compilar dist (tsc) ==');
  npmRun(['run', 'build'], { cwd: ROOT });
}

function step2_copy_server() {
  log('== PASSO 2: copiar dist + assets para o release ==');
  rmrf(REL);
  mkdirp(REL);

  // Servidor compilado.
  fs.cpSync(path.join(ROOT, 'dist'), path.join(REL, 'dist'), { recursive: true });

  // Assets de UI que o tsc não copia (dashboard.ts/vnc.ts leem ao lado do JS).
  const uiAssets = ['index.html', 'chat.html', 'vnc-client.html', 'components', 'proxy-logo.svg'];
  for (const a of uiAssets) {
    const src = path.join(ROOT, 'src', 'ui', a);
    const dst = path.join(REL, 'dist', 'ui', a);
    fs.cpSync(src, dst, { recursive: true });
  }
  log('dist + UI assets copiados.');
}

function step3_configs() {
  log('== PASSO 3: configs e templates ==');

  // Templates usados pelo proxy (pastas de projeto) — pequenos.
  fs.cpSync(path.join(ROOT, 'templates'), path.join(REL, 'templates'), { recursive: true });

  // Estado inicial dos provedores/apps (a app recria em runtime se necessário).
  for (const f of ['providers.json', 'gateway-apps.json', 'gateway-economy.json', 'gateway-booster.json']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) copyPreserve(src, path.join(REL, f));
  }

  // .env default — SEM segredos (o operador/usuário edita se precisar).
  const envDefault = `# DeepsProxy - configuração padrão do release
# Edite este arquivo (com o DeepsProxy fechado) e reinicie para aplicar.
PORT=3005
GATEWAY_PORT=3006

# Abra automaticamente no navegador ao iniciar. O DeepsProxy.exe já abre a
# dashboard sozinho, então deixe desligado aqui.
OPEN_UI=false

# Chave mestra opcional. Deixe vazio para o dashboard abrir sem senha.
# Se preencher, o cliente precisa enviar esta chave nos requests.
API_KEY=

# Provedor principal: deepseek (recomendado, via navegador), qwen, gemini
# ou local (Ollama/LM Studio via API).
PROVIDER=deepseek

# Perfis do navegador (sessões de login). Vazio = pasta do app.
DEEPSEEK_PROFILE_DIR=
QWEN_PROFILE_DIR=
GEMINI_PROFILE_DIR=

# Login automático do Qwen (opcional). Se vazio, use o botão "Fazer login".
QWEN_EMAIL=
QWEN_PASSWORD=

# Endereços de API (usados quando PROVIDER != deepseek/qwen/gemini).
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=
LLM_MODEL=

# Gateway (porta 3006) para IDEs/agentes com chave virtual (aba Apps).
ENABLE_GATEWAY=true

# Atualização automática via GitHub Releases (formato: usuario/repo).
# Vazio = recurso desativado.
UPDATE_REPO=lucassa1324/deepsproxy
`;
  fs.writeFileSync(path.join(REL, '.env'), envDefault);

  // Diretórios de perfil (criados pelo runtime, mas já garantem permissão).
  for (const d of ['deepseek_profile', 'qwen_profile', 'gemini_profile']) {
    mkdirp(path.join(REL, d));
  }
  log('configs + templates prontos.');
}

function step4_node_modules() {
  log('== PASSO 4: dependências de produção (npm ci) ==');
  // O npm ci precisa do package.json + lock com as versões exatas.
  copyPreserve(path.join(ROOT, 'package.json'), path.join(REL, 'package.json'));
  copyPreserve(path.join(ROOT, 'package-lock.json'), path.join(REL, 'package-lock.json'));

  npmRun(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: REL,
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
  });

  // package.json/lock não são necessários no runtime (o js é ESM puro).
  fs.rmSync(path.join(REL, 'package.json'), { force: true });
  fs.rmSync(path.join(REL, 'package-lock.json'), { force: true });
}

function step5_chromium() {
  log('== PASSO 5: instalar Chromium (Playwright) no release ==');
  // Cache persistente fora do REL para re-builds não redownloadarem ~300MB.
  const browserCache = path.join(REL_ROOT, '.cache', 'browsers');
  mkdirp(browserCache);
  const browsers = path.join(REL, 'browsers');
  mkdirp(browsers);
  const cli = path.join(REL, 'node_modules', 'playwright', 'cli.js');
  run(process.execPath, [cli, 'install', 'chromium'], {
    cwd: REL,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache },
    stdio: 'inherit',
  });
  fs.cpSync(browserCache, browsers, { recursive: true });
  log('Chromium copiado para release/browsers.');
}

async function step6_node_runtime() {
  if (!isWindows) {
    log(`[skip passo 6] Node runtime embutido só no Windows (atual: ${process.platform}).`);
    return;
  }
  log('== PASSO 6: baixar node.exe oficial ==');
  const zipPath = path.join(CACHE, NODE_ZIP);
  const extractDir = path.join(CACHE, `node-${NODE_VERSION}`);
  await download(NODE_URL, zipPath);

  const nodeExe = path.join(REL, 'node.exe');
  if (fs.existsSync(nodeExe)) {
    log('node.exe já presente.');
    return;
  }

  // Extrai via Expand-Archive (PowerShell), robusto com caminhos acentuados.
  mkdirp(extractDir);
  const psQuote = (p) => "'" + String(p).replace(/'/g, "''") + "'";
  const expandCmd = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(extractDir)} -Force`;
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', expandCmd], { cwd: CACHE });
  // Acha node.exe na estrutura node-vX-win-x64/node.exe.
  let found = null;
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f === 'node.exe') return p;
      if (fs.statSync(p).isDirectory()) {
        const r = walk(p);
        if (r) return r;
      }
    }
    return null;
  };
  found = walk(extractDir);
  if (!found || !fs.existsSync(found)) {
    throw new Error('node.exe não encontrado no zip baixado.');
  }
  copyPreserve(found, nodeExe);
  fs.chmodSync(nodeExe, 0o755);
}

function step7_launcher() {
  log('== PASSO 7: gerar ícone e compilar launcher DeepsProxy.exe ==');
  // Ícone (PowerShell + System.Drawing, disponível no Windows).
  const iconPs1 = path.join(winScripts, 'make-icon.ps1');
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', iconPs1, REL_ROOT], {
    cwd: ROOT,
  });

  const csc = process.env.CSC_PATH
    || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!fs.existsSync(csc)) {
    throw new Error(`csc.exe não encontrado em ${csc}. Configure CSC_PATH.`);
  }
  const src = path.join(winScripts, 'launcher.cs');
  const out = path.join(REL, 'DeepsProxy.exe');
  run(csc, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    `/win32icon:${path.join(REL_ROOT, 'icon.ico')}`,
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    `/out:${out}`,
    src,
  ], { cwd: ROOT });
  if (!fs.existsSync(out)) throw new Error('Falha: DeepsProxy.exe não foi gerado.');
  log(`DeepsProxy.exe gerado (v${APP_VERSION}).`);
}

function step8_zip() {
  log('== PASSO 8: zip portátil ==');
  const osTmp = path.join(os.tmpdir(), `deepsproxy-tmp-${process.pid}`);
  rmrf(osTmp);
  fs.cpSync(REL, osTmp, { recursive: true });
  const zipPath = path.join(REL_ROOT, `DeepsProxy-Portable-v${APP_VERSION}.zip`);
  // Pasta raiz "DeepsProxy" dentro do zip para UX de extração.
  const parent = path.dirname(osTmp);
  run('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -Path '${path.join(parent, path.basename(osTmp))}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
  ], { cwd: ROOT });
  rmrf(osTmp);
  log(`ZIP gerado: ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

log('──────────────────────────────────────────────────────');
log(`DeepsProxy v${APP_VERSION} — build de release (${process.platform}-${process.arch})`);
log(`Saída: ${REL}`);
log('──────────────────────────────────────────────────────');

const steps = [step1_build, step2_copy_server, step3_configs, step4_node_modules, step5_chromium];
if (isWindows) steps.push(step6_node_runtime);
steps.push(step7_launcher);
if (isWindows) steps.push(step8_zip);

for (const s of steps) await s();

log('✔ Release montado. Para o instalador, rode: npm run build:install (requer Inno Setup 6).');