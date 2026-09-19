/*
 * File: update.test.ts
 * Project: deepsproxy
 * Testes do módulo de atualização (src/update.ts): parsing de versão,
 * comparação semântica, seleção de asset por plataforma e o check
 * completo com a API do GitHub mockada (sem rede).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  compareVersions,
  pickAsset,
  checkUpdateNow,
  clearUpdateCache,
  type ReleaseInfo,
} from './update.ts';

function makeRelease(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag_name: 'v1.1.0',
    name: 'v1.1.0',
    html_url: 'https://github.com/user/deepsproxy/releases/tag/v1.1.0',
    body: 'Correções e melhorias.',
    assets: [
      {
        name: 'DeepsProxy-Setup-1.1.0.exe',
        browser_download_url: 'https://github.com/user/deepsproxy/releases/download/v1.1.0/DeepsProxy-Setup-1.1.0.exe',
        size: 260123456,
      },
      {
        name: 'DeepsProxy-Portable-v1.1.0.zip',
        browser_download_url: 'https://github.com/user/deepsproxy/releases/download/v1.1.0/DeepsProxy-Portable-v1.1.0.zip',
        size: 331123456,
      },
      {
        name: 'DeepsProxy-Linux-v1.1.0.tar.gz',
        browser_download_url: 'https://github.com/user/deepsproxy/releases/download/v1.1.0/DeepsProxy-Linux-v1.1.0.tar.gz',
        size: 303123456,
      },
    ],
    ...overrides,
  };
}

test('parseVersion extrai x.y.z de tags variadas', () => {
  assert.equal(parseVersion('v1.2.3'), '1.2.3');
  assert.equal(parseVersion('1.2.3'), '1.2.3');
  assert.equal(parseVersion('release-2.0.1-beta'), '2.0.1');
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion('foo'), null);
});

test('compareVersions ordena corretamente', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.1.0', '1.0.9') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
});

test('pickAsset escolhe o instalador .exe no Windows (fallback para o zip)', () => {
  const onlyZip = makeRelease({ assets: [makeRelease().assets[1]] });
  assert.equal(pickAsset(makeRelease(), 'win32')!.name, 'DeepsProxy-Setup-1.1.0.exe');
  assert.equal(pickAsset(onlyZip, 'win32')!.name, 'DeepsProxy-Portable-v1.1.0.zip');
});

test('pickAsset escolhe o tar.gz no Linux (e não o .exe)', () => {
  assert.equal(pickAsset(makeRelease(), 'linux')!.name, 'DeepsProxy-Linux-v1.1.0.tar.gz');
  assert.equal(pickAsset(makeRelease(), 'darwin')!.name, 'DeepsProxy-Linux-v1.1.0.tar.gz');
});

test('checkUpdateNow desativado sem UPDATE_REPO', async () => {
  const s = await checkUpdateNow({ repoName: '', version: '1.0.0', fetchFn: async () => { throw new Error('não deve chamar'); } });
  assert.equal(s.enabled, false);
  assert.equal(s.updateAvailable, false);
  assert.equal(s.error, undefined);
});

test('checkUpdateNow reporta versão nova quando latest > atual', async () => {
  const fetchFn = async () => {
    return {
      ok: true,
      json: async () => makeRelease(),
    } as unknown as Response;
  };
  const s = await checkUpdateNow({ repoName: 'user/deepsproxy', version: '1.0.0', platform: 'win32', fetchFn });
  assert.equal(s.enabled, true);
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest, '1.1.0');
  assert.equal(s.asset!.name, 'DeepsProxy-Setup-1.1.0.exe');
  assert.equal(s.changelog, 'Correções e melhorias.');
});

test('checkUpdateNow sem update quando já está atualizado', async () => {
  const fetchFn = async () => {
    return { ok: true, json: async () => makeRelease({ tag_name: '1.0.0' }) } as unknown as Response;
  };
  const s = await checkUpdateNow({ repoName: 'user/deepsproxy', version: '1.0.0', platform: 'linux', fetchFn });
  assert.equal(s.updateAvailable, false);
});

test('checkUpdateNow captura erro de rede sem lançar exceção', async () => {
  const fetchFn = async () => {
    throw new Error('503 Service Unavailable');
  };
  const s = await checkUpdateNow({ repoName: 'user/deepsproxy', version: '1.0.0', fetchFn });
  assert.equal(s.enabled, true);
  assert.equal(s.updateAvailable, false);
  assert.match(s.error ?? '', /503/);
});

test('checkUpdateNow propaga status HTTP não-ok', async () => {
  const fetchFn = async () => ({ ok: false, status: 403, statusText: 'Forbidden' }) as unknown as Response;
  const s = await checkUpdateNow({ repoName: 'user/deepsproxy', version: '1.0.0', fetchFn });
  assert.match(s.error ?? '', /403/);
});

test('checkUpdate (cache) reaproveita resultado dentro do TTL', async () => {
  clearUpdateCache();
  const prevRepo = process.env.UPDATE_REPO;
  const prevFetch = globalThis.fetch;
  let calls = 0;
  process.env.UPDATE_REPO = 'user/deepsproxy';
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, json: async () => makeRelease() } as unknown as Response;
  }) as typeof fetch;

  try {
    const { checkUpdate } = await import('./update.ts');
    const first = await checkUpdate();
    const second = await checkUpdate();
    assert.equal(first.updateAvailable, true);
    assert.equal(second.updateAvailable, true);
    assert.equal(calls, 1, 'fetch executado uma única vez dentro do TTL');
  } finally {
    clearUpdateCache();
    if (prevRepo === undefined) delete process.env.UPDATE_REPO;
    else process.env.UPDATE_REPO = prevRepo;
    globalThis.fetch = prevFetch;
  }
});