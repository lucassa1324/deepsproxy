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
import { spawn } from 'node:child_process';
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

/** Escolhe o asset da release adequado à plataforma (Windows prefere o .exe). */
export function pickAsset(release: ReleaseInfo, platform: NodeJS.Platform = process.platform): ReleaseAsset | null {
  if (platform === 'win32') {
    let best: ReleaseAsset | null = null;
    for (const a of release.assets) {
      if (!/DeepsProxy-.*-v?[\d.]+\.(?:exe|zip)$/i.test(a.name)) continue;
      if (/\.exe$/i.test(a.name)) return a;
      if (!best) best = a;
    }
    return best;
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
    spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).on('error', () => {});
  }
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
  try {
    openFile(downloadedPath);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ ok: false, error: String(err?.message ?? err) }, 500);
  }
});