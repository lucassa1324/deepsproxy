/*
 * File: token-economy.test.ts
 * Project: deepsproxy
 * Testes do Modo Economia de Tokens (serviço de otimizações de prompt).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_ECONOMY,
  TOOL_OUTPUT_MAX_CHARS,
  CACHE_TTL_MS,
  estimateTokens,
  estimateMessagesTokens,
  stripReasoningFromMessages,
  truncateToolMessages,
  truncateMessages,
  buildSummaryDigest,
  applyTokenEconomy,
  cachePayloadKey,
  responseCacheGet,
  responseCacheSet,
  hasMeaningfulContent,
  resetResponseCache,
  _responseCacheStore,
  getTokenEconomy,
  updateTokenEconomy,
  resetEconomyCache,
} from './services/token-economy.ts';

const tmp = join(tmpdir(), 'deepsproxy-economy-test');

test.before(() => {
  process.env.ECONOMY_FILE = join(tmp, 'economy.json');
  resetEconomyCache();
  resetResponseCache();
});

test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  resetEconomyCache();
  resetResponseCache();
  delete process.env.ECONOMY_FILE;
});

function msgs(n: number): any[] {
  const out: any[] = [{ role: 'system', content: 'sistema' }];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `mensagem ${i} `.repeat(50) });
    out.push({ role: 'assistant', content: `resposta ${i} `.repeat(50) });
  }
  out.push({ role: 'user', content: 'última mensagem do usuário' });
  return out;
}

test('economy: estima tokens por chars/4', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.ok(estimateMessagesTokens([{ role: 'user', content: 'x'.repeat(100) }]) >= 25);
});

test('economy: stripReasoning remove o raciocínio do histórico', () => {
  const input = [
    { role: 'assistant', content: 'oi', reasoning_content: 'pensando' },
    { role: 'user', content: 'olá' },
  ];
  const out = stripReasoningFromMessages(input);
  assert.equal(out[0].content, 'oi');
  assert.equal(out[0].reasoning_content, undefined);
  assert.equal(out[1].content, 'olá');
});

test('economy: truncateToolMessages limita apenas mensagens de tool', () => {
  const big = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 50);
  const input = [
    { role: 'user', content: 'normal' },
    { role: 'tool', tool_call_id: 't1', content: big },
    { role: 'function', name: 'f', content: big },
  ];
  const { messages, truncated } = truncateToolMessages(input, TOOL_OUTPUT_MAX_CHARS);
  assert.equal(truncated, 2);
  assert.equal(messages[0].content, 'normal');
  assert.ok(messages[1].content.length <= TOOL_OUTPUT_MAX_CHARS + 40);
  assert.ok(messages[1].content.includes('truncado'));
  assert.ok(messages[2].content.includes('truncado'));
});

test('economy: truncateMessages preserva system e última mensagem', () => {
  const input = msgs(6);
  const before = estimateMessagesTokens(input);
  const { messages: kept, dropped } = truncateMessages(input, Math.floor(before / 2));
  assert.ok(dropped.length > 0);
  assert.equal(kept[0].role, 'system');
  assert.equal(kept[kept.length - 1].content, 'última mensagem do usuário');
  assert.ok(estimateMessagesTokens(kept) <= Math.floor(before / 2) || kept.length === 2);
  // Sob orçamento: nada é descartado.
  const ok = truncateMessages(input, before * 10);
  assert.equal(ok.dropped.length, 0);
  assert.equal(ok.messages.length, input.length);
});

test('economy: buildSummaryDigest produz digest compacto', () => {
  const digest = buildSummaryDigest([
    { role: 'user', content: 'a'.repeat(500) },
    { role: 'assistant', content: 'b'.repeat(500) },
  ]);
  assert.ok(digest.length <= 1400);
  assert.ok(digest.includes('Usuário:'));
  assert.ok(digest.includes('Resposta:'));
});

test('economy: applyTokenEconomy respeita o master toggle', async () => {
  const settings = { ...DEFAULT_ECONOMY, enabled: false, stripReasoning: true, cachePrefix: true };
  const input = msgs(2);
  const { payload, actions } = await applyTokenEconomy({ messages: input }, settings);
  assert.deepEqual(payload.messages, input);
  assert.equal(actions.length, 0);
  assert.equal(payload._eco, undefined);
});

test('economy: applyTokenEconomy aplica stripReasoning + toolOutput + cachePrefix', async () => {
  const settings = {
    ...DEFAULT_ECONOMY,
    enabled: true,
    cachePrefix: true,
    stripReasoning: true,
    truncateToolOutput: true,
    maxContextTokens: 999999999,
  };
  const input = [
    { role: 'assistant', content: 'a', reasoning_content: 'pensou' },
    { role: 'tool', tool_call_id: 't', content: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10) },
  ];
  const { payload, actions } = await applyTokenEconomy({ messages: input }, settings);
  assert.equal(payload.messages[0].reasoning_content, undefined);
  assert.ok(payload.messages[1].content.includes('truncado'));
  assert.deepEqual(payload._eco, { cachePrefix: true });
  assert.ok(actions.includes('stripReasoning'));
  assert.ok(actions.some((a) => a.startsWith('toolOutput(')));
});

test('economy: applyTokenEconomy trunca histórico e opcionalmente resume', async () => {
  const input = msgs(6);
  const base = { ...DEFAULT_ECONOMY, enabled: true, truncateHistory: true, maxContextTokens: 800 };
  const { payload, actions } = await applyTokenEconomy({ messages: input }, base);
  assert.ok(actions.some((a) => a.startsWith('truncate(')));
  assert.ok(payload.messages.length < input.length);
  // Com summarizeHistory: chama o resumidor e insere o resumo.
  const withSummary = {
    ...DEFAULT_ECONOMY,
    enabled: true,
    summarizeHistory: true,
    truncateHistory: true,
    maxContextTokens: 800,
  };
  let called = false;
  const { payload: p2, actions: a2 } = await applyTokenEconomy(
    { messages: input },
    withSummary,
    { summarize: async () => { called = true; return 'RESUMO TESTE'; } }
  );
  assert.ok(called);
  assert.ok(a2.some((a) => a.startsWith('summary(llm')));
  const head = p2.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
  assert.ok(head.includes('RESUMO TESTE'));
  // Fallback: resumidor que falha -> digest.
  const { payload: p3, actions: a3 } = await applyTokenEconomy(
    { messages: input },
    withSummary,
    { summarize: async () => { throw new Error('boom'); } }
  );
  assert.ok(a3.some((a) => a.startsWith('summary(digest')));
  const head3 = p3.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
  assert.ok(head3.includes('[Resumo do histórico anterior]'));
});

test('economy: cache de respostas com TTL', () => {
  const key = 'abc';
  const body = { choices: [{ message: { role: 'assistant', content: 'olá' } }] };
  assert.equal(responseCacheGet(key), null);
  responseCacheSet(key, 200, body);
  const hit = responseCacheGet(key);
  assert.ok(hit);
  assert.equal(hit!.status, 200);
  assert.deepEqual(hit!.body, body);
  // Expira após o TTL.
  responseCacheSet('exp', 200, body);
  const entry = _responseCacheStore.get('exp');
  if (entry) entry.ts = Date.now() - CACHE_TTL_MS - 1000;
  assert.equal(responseCacheGet('exp'), null);
  resetResponseCache();
});

test('economy: resposta vazia não é cacheada nem devolvida', () => {
  const key = 'vazio';
  responseCacheSet(key, 200, { choices: [{ message: { role: 'assistant', content: '' } }] });
  assert.equal(responseCacheGet(key), null, 'get deve purgar entrada vazia');
  assert.equal(hasMeaningfulContent({ choices: [{ message: { content: '' } }] }), false);
  assert.equal(hasMeaningfulContent({ choices: [{ message: { content: '   ' } }] }), false);
  assert.equal(hasMeaningfulContent({ choices: [{ message: {} }] }), false);
  assert.equal(hasMeaningfulContent({ choices: [{ message: { content: 'ok' } }] }), true);
  assert.equal(hasMeaningfulContent({ choices: [{ message: { content: [{ type: 'text', text: 'x' }] } }] }), true);
  assert.equal(hasMeaningfulContent({ choices: [{ message: { tool_calls: [{ id: 't1' }] } }] }), true);
  resetResponseCache();
});

test('economy: cachePayloadKey é estável e independente da ordem', () => {
  const a = { model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.7 };
  const b = { temperature: 0.7, messages: [{ role: 'user', content: 'x' }], model: 'm' };
  assert.equal(cachePayloadKey(a), cachePayloadKey(b));
  const c = { model: 'm', messages: [{ role: 'user', content: 'y' }] };
  assert.notEqual(cachePayloadKey(a), cachePayloadKey(c));
});

test('economy: updateTokenEconomy valida e persiste', () => {
  resetEconomyCache();
  const saved = updateTokenEconomy({ enabled: true, maxContextTokens: 12345 });
  assert.equal(saved.enabled, true);
  assert.equal(saved.maxContextTokens, 12345);
  const loaded = getTokenEconomy();
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.maxContextTokens, 12345);
  // Valores inválidos são ignorados.
  const bad = updateTokenEconomy({ enabled: 'sim' as any, maxContextTokens: -5 });
  assert.equal(bad.enabled, true);
  assert.equal(bad.maxContextTokens, 12345);
  resetEconomyCache();
});
