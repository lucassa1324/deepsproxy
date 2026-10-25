/*
 * File: usage.test.ts
 * Project: deepsproxy
 * Testes da telemetria de uso (src/services/usage.ts) e dos endpoints
 * /api/usage/* (summary, models, export). Persistência apontada para um
 * arquivo temporário inexistente para isolar o estado em memória.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.USAGE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-')), 'usage-logs.json');

import {
  computeModelRanking,
  computeSummary,
  getUsageRecords,
  getUsageSnapshot,
  periodToSince,
  recordUsage,
  recordsToCsv,
  resetUsage,
  type UsageRecord,
} from './services/usage.ts';
import { usageRoutes } from './routes/usage.ts';

let seq = 0;

function mk(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: Date.now(),
    status: 200,
    requestedModel: 'auto',
    finalModel: 'gpt-4o',
    provider: 'OpenAI',
    routingMode: 'auto',
    tokensPrompt: 10,
    tokensCompletion: 20,
    tokensTotal: 30,
    latencyMs: 150,
    ...overrides,
  };
}

test('periodToSince converte períodos conhecidos e recusa inválidos', () => {
  assert.equal(periodToSince('all').since, null);
  assert.equal(periodToSince('all').period, 'all');
  const { since, period } = periodToSince('24h');
  assert.equal(period, '24h');
  assert.ok(Math.abs((Date.now() - (since as number)) - 24 * 60 * 60 * 1000) < 5_000);
  assert.equal(periodToSince('coisa-estranha').period, 'all');
  assert.equal(periodToSince('30d').period, '30d');
});

test('recordUsage sanitiza registros inválidos (ts ausente é descartado)', () => {
  resetUsage();
  recordUsage(mk({ ts: NaN as any }));
  recordUsage({} as any);
  recordUsage(mk());
  assert.equal(getUsageSnapshot().length, 1);
  const [rec] = getUsageSnapshot();
  assert.equal(rec.tokensTotal, 30);
  assert.equal(rec.routingMode, 'auto');
  assert.equal(rec.finalModel, 'gpt-4o');
});

test('computeSummary consolida requests/erros/tokens/latência e topModel', () => {
  resetUsage();
  recordUsage(mk({ latencyMs: 150 }));
  recordUsage(mk({ tokensTotal: 0, tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 }));
  recordUsage(mk({ routingMode: 'manual', status: 500, finalModel: 'gemini-2.5-pro', latencyMs: 50 }));
  const summary = computeSummary('all');
  assert.equal(summary.totalRequests, 3);
  assert.equal(summary.totalErrors, 1);
  assert.equal(summary.totalTokens, 90); // 30 + (0 → fallback 10+20) + 30
  assert.equal(summary.autoRequests, 2);
  assert.equal(summary.manualRequests, 1);
  assert.equal(summary.avgLatencyMs, 100);
  assert.equal(summary.topModel?.model, 'gpt-4o');
  assert.equal(summary.topModel?.provider, 'OpenAI');
  assert.equal(summary.topModel?.requests, 2);
});

test('getUsageRecords filtra pelo período (24h exclui registros antigos)', () => {
  resetUsage();
  recordUsage(mk({ ts: Date.now() - 32 * 60 * 60 * 1000 }));
  recordUsage(mk());
  assert.equal(getUsageRecords('all').length, 2);
  assert.equal(getUsageRecords('24h').length, 1);
  assert.equal(computeSummary('7d').totalRequests, 2);
  assert.equal(computeSummary('24h').totalRequests, 1);
});

test('computeModelRanking agrega por modelo+provedor, com modo predominante e limite', () => {
  resetUsage();
  recordUsage(mk()); // auto gpt-4o/OpenAI
  recordUsage(mk({ routingMode: 'manual', tokensTotal: 5 })); // manual, MESMO par modelo+provedor
  recordUsage(mk({ requestedModel: 'claude-4-sonnet', finalModel: 'claude-4-sonnet', provider: 'Anthropic', routingMode: 'manual', latencyMs: 200 }));
  recordUsage(mk()); // auto gpt-4o/OpenAI de novo
  const ranking = computeModelRanking('all', 2);
  assert.equal(ranking.length, 2);
  assert.equal(ranking[0].model, 'gpt-4o');
  assert.equal(ranking[0].requests, 3);
  assert.equal(ranking[0].tokens, 65);
  assert.equal(ranking[0].autoRequests, 2);
  assert.equal(ranking[0].manualRequests, 1);
  assert.equal(ranking[0].predominantMode, 'auto');
  assert.equal(ranking[1].model, 'claude-4-sonnet');
  assert.equal(ranking[1].provider, 'Anthropic');
  assert.equal(ranking[1].predominantMode, 'manual');
  assert.equal(ranking[1].avgLatencyMs, 200);
  // Pedido predominante por bucket (rastreabilidade modo auto)
  assert.equal(ranking[0].predominantRequest, 'auto'); // 2 autos vs 1 manual no bucket gpt-4o
  assert.equal(ranking[1].predominantRequest, 'claude-4-sonnet');
  assert.equal(computeModelRanking('all', 50).length, 2);
});

test('computeModelRanking marca erro quando status >= 400', () => {
  resetUsage();
  recordUsage(mk({ status: 502, latencyMs: 10 }));
  const [stat] = computeModelRanking('all');
  assert.equal(stat.errors, 1);
  assert.equal(stat.requests, 1);
});

test('recordsToCsv monta header e protege valores com separador/aspas', () => {
  const csv = recordsToCsv([
    mk({ provider: 'Fora, Amarelo' }),
    mk(),
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'timestamp,status,requestedModel,finalModel,provider,routingMode,tokensPrompt,tokensCompletion,tokensTotal,latencyMs');
  assert.ok(lines[1].includes('"Fora, Amarelo"'));
  assert.ok(lines[1].endsWith(',150'));
});

test('GET /api/usage/summary|models|export respondem com agregações e CSV/JSON', async () => {
  resetUsage();
  recordUsage(mk());
  const prefix = process.env.USAGE_FILE;

  const sum = await usageRoutes.request('/api/usage/summary?period=all');
  assert.equal(sum.status, 200);
  const sumJson = await sum.json();
  assert.equal(sumJson.totalRequests, 1);
  assert.ok('topModel' in sumJson && 'totalTokens' in sumJson && 'autoRequests' in sumJson);

  const models = await usageRoutes.request('/api/usage/models?period=all&limit=5');
  assert.equal(models.status, 200);
  const modelsJson = await models.json();
  assert.equal(modelsJson.period, 'all');
  assert.equal(modelsJson.models.length, 1);
  assert.equal(modelsJson.models[0].model, 'gpt-4o');

  const csv = await usageRoutes.request('/api/usage/export?format=csv&period=all');
  assert.equal(csv.status, 200);
  assert.ok(String(csv.headers.get('content-type')).includes('text/csv'));
  assert.ok(String(csv.headers.get('content-disposition')).startsWith('attachment; filename='));
  // O BOM não aparece em res.text() (fetch consome por spec); valide os bytes.
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  assert.ok(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, 'CSV deve iniciar com BOM UTF-8');
  const csvBody = new TextDecoder().decode(csvBytes);
  assert.ok(csvBody.includes('requestedModel,finalModel'));

  const json = await usageRoutes.request('/api/usage/export?format=json&period=all');
  assert.equal(json.status, 200);
  const exportJson = await json.json();
  assert.equal(exportJson.records.length, 1);
  assert.equal(exportJson.period, 'all');

  const csvinvalid = await usageRoutes.request('/api/usage/summary?period=quebra');
  assert.equal((await csvinvalid.json()).period, 'all');

  // Rastreabilidade: /api/usage/recent devolve os registros mais recentes
  resetUsage();
  recordUsage(mk({ requestedModel: 'auto', finalModel: 'mock-final', latencyMs: 77 }));
  recordUsage(mk({ requestedModel: 'auto-free', finalModel: 'mock-final-2', provider: 'Mock' }));
  const recent = await usageRoutes.request('/api/usage/recent?limit=2');
  assert.equal(recent.status, 200);
  const recentJson = await recent.json();
  assert.equal(recentJson.records.length, 2);
  assert.equal(recentJson.records[0].requestedModel, 'auto-free'); // mais recente primeiro
  assert.equal(recentJson.records[1].finalModel, 'mock-final');
  assert.ok(recentJson.records[1].latencyMs === 77);

  assert.ok(prefix !== undefined);
});
