/*
 * update.ts — Verificação e aplicação de atualizações via GitHub Releases.
 *
 * O dashboard consulta /api/update/check; quando há nova versão, mostra um
 * banner com o botão "Baixar e atualizar". Ao clicar, o servidor baixa o
 * instalador (Windows) ou o portátil (Linux) da release e o abre.
 *
 * Configuração (.env):
 *   UPDATE_REPO=seu_usuário/deepsproxy   — repositório com as releases.
 *   Se vazio, o update fica desativado (banner nunca aparece).
 */

import { Hono } from 'hono';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_VERSION } from './version.ts';

export const GITHUB_API = 'https://api.github.com/repos';
const CACHE_MS = 5 * 60 * 1000;
const UA = 'DeepsProxy';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface ReleaseInfo {
  tag_name: string;
  name: string;
  html_url: string;
  body: string;
  assets: ReleaseAsset[];
}

export interface UpdateStatus {
  enabled: boolean;
  currentVersion: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  changelog: string | null;
  asset: { name: string; url: string; size: number } | null;
  error?: string;
}

interface CheckDeps {
  version?: string;
  repoName?: string;
  platform?: NodeJS.Platform;
  fetchFn?: typeof fetch;
}

/** Extrai "x.y.z" de uma tag como "v1.2.3" ou "1.2.3" (ou "release-1.2.3-beta"). */
export function parseVersion(tag: string | null | undefined): string | null {
  const m = /v?(\d+\.\d+\.\d+)/.exec(String(tag ?? ''));
  return m ? m[1] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Escolhe o asset da release adequado à plataforma (Windows prefere o .zip portátil para auto-atualização; o instalador .exe é fallback). */
export function pickAsset(release: ReleaseInfo, platform: NodeJS.Platform = process.platform): ReleaseAsset | null {
  if (platform === 'win32') {
    let zip: ReleaseAsset | null = null;
    let exe: ReleaseAsset | null = null;
    for (const a of release.assets) {
      if (!/DeepsProxy-.*-v?[\d.]+\.(?:exe|zip)$/i.test(a.name)) continue;
      if (/\.exe$/i.test(a.name)) {
        if (!exe) exe = a;
      } else if (/\.zip$/i.test(a.name)) {
        if (!zip) zip = a;
      }
    }
    return zip ?? exe;
  }
  // Linux (/darwin também cai aqui: abre o tar.gz genérico do Linux).
  for (const a of release.assets) {
    if (/DeepsProxy-Linux-.*\.tar\.gz$/i.test(a.name)) return a;
  }
  return null;
}

/** Busca a última release publicada no GitHub (API pública, sem token). */
export async function fetchLatestRelease(repoName: string, fetchFn: typeof fetch = fetch): Promise<ReleaseInfo> {
  const res = await fetchFn(`${GITHUB_API}/${repoName}/releases/latest`, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} (${res.statusText})`);
  return (await res.json()) as ReleaseInfo;
}

/** Lógica pura do check — separada para testes. */
export async function checkUpdateNow(deps: CheckDeps = {}): Promise<UpdateStatus> {
  const repoName = (deps.repoName ?? process.env.UPDATE_REPO ?? '').trim();
  const current = deps.version ?? APP_VERSION;
  const base: UpdateStatus = {
    enabled: !!repoName,
    currentVersion: current,
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    changelog: null,
    asset: null,
  };
  if (!repoName) return base;

  try {
    const release = await (deps.fetchFn ? fetchLatestRelease(repoName, deps.fetchFn) : fetchLatestRelease(repoName));
    const latest = parseVersion(release.tag_name);
    if (!latest) return { ...base, latest: release.tag_name, releaseUrl: release.html_url };
    const asset = pickAsset(release, deps.platform ?? process.platform);
    return {
      ...base,
      latest,
      updateAvailable: compareVersions(latest, current) > 0,
      releaseUrl: release.html_url,
      changelog: (release.body || '').trim().slice(0, 600) || null,
      asset: asset
        ? { name: asset.name, url: asset.browser_download_url, size: asset.size }
        : null,
    };
  } catch (err: any) {
    return { ...base, error: String(err?.message ?? err) };
  }
}

/* ------------------------- estado de download ------------------------- */

let cached: UpdateStatus | null = null;
let cacheAt = 0;
let downloadedPath: string | null = null;

export function clearUpdateCache() {
  cached = null;
  cacheAt = 0;
}

export async function checkUpdate(): Promise<UpdateStatus> {
  if (cached && Date.now() - cacheAt < CACHE_MS) return cached;
  cached = await checkUpdateNow();
  cacheAt = Date.now();
  return cached;
}

async function downloadFile(url: string, dest: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`Falha no download: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buf);
}

function openFile(filePath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).on('error', () => {});
  }
}

/* ------------------- auto-atualização (portátil Windows) ------------------- */

const UPDATE_DIR = path.join(os.tmpdir(), 'deepsproxy-update');

// Arquivos/dirs criados pelo usuário que DEVM ser preservados no swap.
const USER_FILES = ['providers.json', 'gateway-apps.json', 'gateway-economy.json', 'gateway-booster.json'];
const PROFILE_DIRS = ['deepseek_profile', 'qwen_profile', 'gemini_profile'];

function psQuote(p: string): string {
  return "'" + String(p).replace(/'/g, "''") + "'";
}

export function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar (Windows 10+/Linux/macOS) é rápido e entende zip. Fallback: Expand-Archive.
  const tarRes = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'ignore', windowsHide: true });
  if (!tarRes.error && tarRes.status === 0) return;
  const cmd = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`;
  const ps = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (ps.error || ps.status !== 0) {
    throw new Error(`Falha ao extrair o pacote de atualização (${ps.error?.message ?? `status ${ps.status}`})`);
  }
}

/** Se o zip tem uma única pasta raiz (padrão do build), retorna essa pasta; senão, o próprio dir. */
export function findTopDir(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());
  if (dirs.length === 1 && files.length === 0) return path.join(dir, dirs[0].name);
  return dir;
}

function copyFileIfExists(src: string, dst: string): void {
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}

/** Copia dados do usuário (perfis de login, .env e configs) para a versão nova. */
function copyUserData(appDir: string, stagedRoot: string): void {
  copyFileIfExists(path.join(appDir, '.env'), path.join(stagedRoot, '.env'));
  for (const f of USER_FILES) copyFileIfExists(path.join(appDir, f), path.join(stagedRoot, f));
  for (const d of PROFILE_DIRS) {
    const src = path.join(appDir, d);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(stagedRoot, d), { recursive: true, force: true });
    }
  }
}

/**
 * Script PowerShell que o servidor dispara (detached) antes de encerrar.
 * Espera o node sair, fecha o launcher da bandeja, troca a pasta do app pela
 * versão nova e relança o DeepsProxy.exe. Recebe tudo por variáveis de
 * ambiente (caminhos com espaços/acentos sem problemas de parsing).
 */
export function updaterScript(): string {
  return `
$ErrorActionPreference = 'Continue'
$App = $env:DEEPSPROXY_UPDATE_APP
$Staged = $env:DEEPSPROXY_UPDATE_STAGED
$Log = $env:DEEPSPROXY_UPDATE_LOG
$node = [int]($env:DEEPSPROXY_UPDATE_NODE_PID)
$lap = [int]($env:DEEPSPROXY_UPDATE_LAUNCHER_PID)
function Log($m) { try { Add-Content -LiteralPath $Log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) } catch {} }
Log 'inicio updater'
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
  $alive = $false
  if ($node -gt 0 -and (Get-Process -Id $node -ErrorAction SilentlyContinue)) { $alive = $true }
  if ($lap -gt 0 -and (Get-Process -Id $lap -ErrorAction SilentlyContinue)) { $alive = $true }
  if (-not $alive) { break }
  Start-Sleep -Milliseconds 500
}
if ($node -gt 0 -and (Get-Process -Id $node -ErrorAction SilentlyContinue)) { Log 'timeout esperando o servidor'; exit 2 }
Start-Sleep -Milliseconds 700
if ($lap -gt 0) { try { Stop-Process -Id $lap -Force -ErrorAction SilentlyContinue } catch {}; Start-Sleep -Milliseconds 500 }
$swapped = $false
$lastErr = ''
for ($i = 1; $i -le 12; $i++) {
  try {
    if (Test-Path -LiteralPath $App) { Remove-Item -LiteralPath $App -Recurse -Force -ErrorAction Stop }
    $parent = Split-Path -LiteralPath $App -Parent
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Move-Item -LiteralPath $Staged -Destination $App -ErrorAction Stop
    $swapped = $true
    break
  } catch {
    $lastErr = $_.Exception.Message
    Log ("tentativa {0} falhou: {1}" -f $i, $lastErr)
    Start-Sleep -Seconds 2
  }
}
if (-not $swapped) { Log ('falha final: ' + $lastErr); exit 3 }
Log 'swap ok, relancando'
$exe = Join-Path $App 'DeepsProxy.exe'
try { Start-Process -FilePath $exe -WorkingDirectory $App } catch { Log ('falha ao relançar: ' + $_.Exception.Message) }
Log 'fim'
`;
}

/**
 * Prepara e dispara a auto-atualização: extrai o zip baixado, preserva os
 * dados do usuário e sobe o updater detached. O servidor deve ser encerrado
 * logo após esta chamada para o updater conseguir trocar os arquivos.
 */
export function applySelfUpdate(appDir: string): { ok: true; mode: 'self-update' } {
  const zip = downloadedPath;
  if (!zip || !fs.existsSync(zip)) throw new Error('Pacote de atualização ainda não foi baixado.');

  const jobDir = path.join(UPDATE_DIR, `job-${process.pid}`);
  fs.rmSync(jobDir, { recursive: true, force: true });
  const extractDir = path.join(jobDir, 'unpacked');
  extractZip(zip, extractDir);

  const stagedRoot = findTopDir(extractDir);
  if (!fs.existsSync(path.join(stagedRoot, 'DeepsProxy.exe'))) {
    throw new Error('O pacote de atualização não contém DeepsProxy.exe (formato inválido?).');
  }
  if (!fs.existsSync(path.join(stagedRoot, 'dist', 'index.js'))) {
    throw new Error('O pacote de atualização está incompleto (dist/index.js ausente).');
  }

  // Preserva .env, configs e perfis de login na versão nova.
  copyUserData(appDir, stagedRoot);

  // Avisa o launcher da bandeja para encerrar de forma graciosa.
  try { fs.writeFileSync(path.join(appDir, 'update.flag'), String(process.pid)); } catch {}

  const scriptPath = path.join(jobDir, 'apply-update.ps1');
  fs.writeFileSync(scriptPath, updaterScript(), 'utf-8');
  const logPath = path.join(jobDir, 'updater.log');

  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DEEPSPROXY_UPDATE_APP: appDir,
      DEEPSPROXY_UPDATE_STAGED: stagedRoot,
      DEEPSPROXY_UPDATE_NODE_PID: String(process.pid),
      DEEPSPROXY_UPDATE_LAUNCHER_PID: String(process.ppid ?? 0),
      DEEPSPROXY_UPDATE_LOG: logPath,
    },
  }).unref();

  return { ok: true, mode: 'self-update' };
}

/* ------------------------- rotas HTTP ------------------------- */

export const updateApp = new Hono();

updateApp.get('/api/update/check', async (c) => c.json(await checkUpdate()));

updateApp.post('/api/update/download', async (c) => {
  if (!cached?.asset) {
    await checkUpdate();
  }
  if (!cached?.asset) {
    return c.json({ ok: false, error: cached?.error ?? 'update desativado ou sem release nova' }, 400);
  }
  if (downloadedPath && fs.existsSync(downloadedPath)) {
    return c.json({ ok: true, file: path.basename(downloadedPath), path: downloadedPath });
  }
  const dest = path.join(os.tmpdir(), 'deepsproxy-update', cached.asset.name);
  try {
    await downloadFile(cached.asset.url, dest);
    downloadedPath = dest;
    const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
    return c.json({ ok: true, file: path.basename(dest), path: dest, sizeMB });
  } catch (err: any) {
    return c.json({ ok: false, error: String(err?.message ?? err) }, 500);
  }
});

updateApp.post('/api/update/launch', async (c) => {
  if (!downloadedPath || !fs.existsSync(downloadedPath)) {
    return c.json({ ok: false, error: 'Instalador ainda não foi baixado.' }, 400);
  }
  // Modo portátil Windows (launcher 'DeepsProxy.exe' junto ao servidor):
  // auto-atualização — troca os arquivos e reinicia sozinho.
  const appDir = process.cwd();
  const packaged =
    fs.existsSync(path.join(appDir, 'DeepsProxy.exe')) && fs.existsSync(path.join(appDir, 'node.exe'));
  if (packaged && /\.zip$/i.test(downloadedPath)) {
    try {
      const r = applySelfUpdate(appDir);
      // Responde antes de encerrar o servidor; o updater espera o node sair.
      setTimeout(() => process.exit(0), 2500);
      return c.json(r);
    } catch (err: any) {
      return c.json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  }
  // Fallback (desenvolvimento, asset .exe ou Linux): apenas abre o arquivo.
  try {
    openFile(downloadedPath);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ ok: false, error: String(err?.message ?? err) }, 500);
  }
});