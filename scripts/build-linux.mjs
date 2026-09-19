#!/usr/bin/env node
/*
 * build-linux.mjs — Gera o release Linux do DeepsProxy (portátil, sem dependências).
 *
 * Como funciona:
 *   1. Compila o servidor com tsc (dist/) e monta o payload em release/.linux-build/.
 *   2. Roda um container node:22 (Docker) para baixar os artefatos POR PLATAFORMA:
 *        - node_modules/  (npm ci)  — sem binários de outra plataforma
 *        - browsers/      (chromium linux via Playwright)
 *        - node           (binário oficial nodejs.org linux-x64)
 *   3. Valida que o chromium embutido abre (smoke test) e gera o tar.gz.
 *
 * Resultado:  release/DeepsProxy-Linux-<versão>.tar.gz
 *
 * Requisitos: Docker Desktop rodando. Uso:  npm run build:linux
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REL_ROOT = path.join(ROOT, 'release');
const LINUX_SCRIPTS = path.join(__dirname, 'desktop', 'linux');
const BUILD_BASE = path.join(REL_ROOT, '.linux-build');
const REL = path.join(BUILD_BASE, 'DeepsProxy');

const NODE_VERSION = process.env.DEEPSPROXY_NODE_VERSION || '22.11.0';
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;

const isWindows = process.platform === 'win32';
const NPM = isWindows ? 'npm.cmd' : 'npm';

function log(msg) { console.log(`[build-linux] ${msg}`); }

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw new Error(`Erro ao executar "${cmd}": ${res.error.message}`);
  if (res.status !== 0) throw new Error(`Falha: ${cmd} ${args.join(' ')} (status ${res.status})`);
  return res;
}

function npmRun(args, opts = {}) {
  if (isWindows) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return run(process.execPath, [cli, ...args], opts);
  }
  return run(NPM, args, { shell: true, ...opts });
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function copyPreserve(from, to) { mkdirp(path.dirname(to)); fs.copyFileSync(from, to); }

function envDefault() {
  return `# DeepsProxy - configuração padrão do release Linux
# Edite este arquivo (com o DeepsProxy fechado) e reinicie para aplicar.
PORT=3005
GATEWAY_PORT=3006

# Abra automaticamente no navegador ao iniciar. O launcher já abre a
# dashboard sozinho, então deixe desligado aqui.
OPEN_UI=false

# Chave mestra opcional. Deixe vazio para o dashboard abrir sem senha.
API_KEY=

# Provedor principal: deepseek (recomendado, via navegador), qwen, gemini
# ou local (Ollama/LM Studio via API).
PROVIDER=deepseek

# Perfis do navegador (sessões de login). Vazio = pasta do app.
DEEPSEEK_PROFILE_DIR=
QWEN_PROFILE_DIR=
GEMINI_PROFILE_DIR=

# Login automático do Qwen (opcional).
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
}

function step1_build() {
  log('== PASSO 1: compilar dist (tsc) ==');
  npmRun(['run', 'build'], { cwd: ROOT });
}

function step2_assemble() {
  log('== PASSO 2: montar payload Linux ==');
  rmrf(BUILD_BASE);
  mkdirp(REL);

  // Servidor compilado + assets de UI.
  fs.cpSync(path.join(ROOT, 'dist'), path.join(REL, 'dist'), { recursive: true });
  for (const a of ['index.html', 'chat.html', 'vnc-client.html', 'components', 'proxy-logo.svg']) {
    const src = path.join(ROOT, 'src', 'ui', a);
    const dst = path.join(REL, 'dist', 'ui', a);
    fs.cpSync(src, dst, { recursive: true });
  }

  // Templates e estados iniciais.
  fs.cpSync(path.join(ROOT, 'templates'), path.join(REL, 'templates'), { recursive: true });
  for (const f of ['providers.json', 'gateway-apps.json', 'gateway-economy.json', 'gateway-booster.json']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) copyPreserve(src, path.join(REL, f));
  }

  // .env default (sem segredos) e diretórios de perfil.
  fs.writeFileSync(path.join(REL, '.env'), envDefault());
  for (const d of ['deepseek_profile', 'qwen_profile', 'gemini_profile']) mkdirp(path.join(REL, d));

  // Launcher Linux + instalador.
  for (const f of ['deepsproxy', 'install.sh', 'uninstall.sh', 'install-deps.sh', 'DeepsProxy.desktop']) {
    copyPreserve(path.join(LINUX_SCRIPTS, f), path.join(REL, f));
  }

  // Ícone PNG (para o menu de aplicativos).
  const iconPs1 = path.join(__dirname, 'desktop', 'make-icon-png.ps1');
  run(isWindows ? 'powershell' : 'pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', iconPs1, REL_ROOT], { cwd: ROOT });
  if (fs.existsSync(path.join(REL_ROOT, 'icon.png'))) {
    copyPreserve(path.join(REL_ROOT, 'icon.png'), path.join(REL, 'icon.png'));
  }

  // package.json/lock para o npm ci acontecer DENTRO do container (plat. linux).
  copyPreserve(path.join(ROOT, 'package.json'), path.join(REL, 'package.json'));
  copyPreserve(path.join(ROOT, 'package-lock.json'), path.join(REL, 'package-lock.json'));

  // Bootstrap rodado 100% no container (deps + browsers + node da plataforma certa).
  const buildDir = path.join(REL, '.build');
  mkdirp(buildDir);
  fs.writeFileSync(path.join(buildDir, 'bootstrap.sh'), bootstrapScript());
  log('payload pronto.');
}

function bootstrapScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

cd /app/DeepsProxy
export PLAYWRIGHT_BROWSERS_PATH=/app/DeepsProxy/browsers

echo "== [linux] pré-requisitos do container =="
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl xz-utils ca-certificates

if [ ! -d node_modules ]; then
  echo "== [linux] npm ci (produção) =="
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
fi

if [ ! -d browsers ] || [ -z "$(ls -A browsers 2>/dev/null)" ]; then
  echo "== [linux] instalando Chromium (Playwright) =="
  npx playwright install chromium
fi

# Deps de sistema que o Chromium precisa para rodar — instaladas aqui só para
# validar dentro do container (no PC do usuário o install.sh orienta).
if ! npx playwright install-deps chromium >/dev/null 2>&1; then
  echo "(avisos de install-deps ignorados)"
fi

echo "== [linux] baixando node ${NODE_VERSION} oficial =="
if [ ! -x /app/DeepsProxy/node ]; then
  curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  tar -xJf /tmp/node.tar.xz -C /tmp
  cp "/tmp/node-v${NODE_VERSION}-linux-x64/bin/node" /app/DeepsProxy/node
fi

echo "== [linux] permissões =="
chmod +x /app/DeepsProxy/node /app/DeepsProxy/deepsproxy /app/DeepsProxy/install.sh /app/DeepsProxy/uninstall.sh /app/DeepsProxy/install-deps.sh

echo "== [linux] validação: node + chromium (navegador EMBUTIDO) =="
/app/DeepsProxy/node --version
PLAYWRIGHT_BROWSERS_PATH=/app/DeepsProxy/browsers /app/DeepsProxy/node -e '
  const { chromium } = require("/app/DeepsProxy/node_modules/playwright");
  (async () => {
    const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    console.log("chromium ok:", b.version());
    await b.close();
  })().catch((e) => { console.error("LAUNCH FAIL:", e.message); process.exit(1); });
'

rm -f /app/DeepsProxy/package.json /app/DeepsProxy/package-lock.json
rm -rf /app/DeepsProxy/.build

echo "== [linux] gerando tar.gz (permissões preservadas) =="
cd /app
tar -czf "$DEEPSPROXY_TAR" DeepsProxy
echo "== [linux] payload pronto =="
`;
}

function step3_docker() {
  log('== PASSO 3: build dentro do container node:22 (Docker) ==');
  const probe = spawnSync('docker', ['info', '-f', '{{.ServerVersion}}'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    throw new Error('Docker não está rodando. Abra o Docker Desktop e tente de novo.');
  }
  const hostPath = path.resolve(BUILD_BASE).replace(/\\/g, '/');
  const tarName = `DeepsProxy-Linux-v${APP_VERSION}.tar.gz`;
  // O tar é criado DENTRO do container (tar Linux preserva o bit +x dos
  // scripts/launcher — o tar.exe do Windows não preserva).
  run('docker', [
    'run', '--rm',
    '-v', `${hostPath}:/app`,
    '-w', '/app',
    '-e', `DEEPSPROXY_TAR=/app/${tarName}`,
    'node:22-bookworm-slim',
    'bash', '/app/DeepsProxy/.build/bootstrap.sh',
  ], { cwd: ROOT });

  // Move o tar do build para a pasta release/.
  const built = path.join(BUILD_BASE, tarName);
  const final = path.join(REL_ROOT, tarName);
  if (!fs.existsSync(built)) throw new Error('Falha: tar.gz não foi gerado no container.');
  fs.copyFileSync(built, final);
  fs.rmSync(built, { force: true });
  const sizeMB = (fs.statSync(final).size / 1024 / 1024).toFixed(1);
  log(`✔ Linux pronto: ${final} (${sizeMB} MB)`);
  log('Instale com: extrair o tar.gz e rodar ./install.sh  (ou ./DeepsProxy/deepsproxy)');
}

log('──────────────────────────────────────────────────────');
log(`DeepsProxy v${APP_VERSION} — build LINUX (x64, via Docker)`);
log(`Saída: ${REL}`);
log('──────────────────────────────────────────────────────');

step1_build();
step2_assemble();
step3_docker();