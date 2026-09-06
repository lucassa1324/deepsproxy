/*
 * File: agent.test.ts
 * Project: deepsproxy
 * Testes do modo agente nativo (server-side tool execution).
 *
 * No Gateway HTTP Puro o servidor NÃO executa ferramentas localmente: o loop
 * agêntico Turn 1..10 foi removido e as Tool Calls são repassadas no payload
 * HTTP/SSE para a IDE. runServerAgent lança um erro de desativação sempre.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isServerAgentSupported,
  listServerTools,
  runServerAgent,
} from './services/agent.ts';
import { registry } from './tools/registry.ts';
import { registerWebSearchTool } from './tools/web-search.ts';
import type { Provider } from './services/config.ts';

if (!registry.has('web_search')) registerWebSearchTool();

function openaiProvider(): Provider {
  return {
    id: 'mock',
    name: 'Mock OpenAI',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:9123/v1',
    apiKey: 'sk-test',
    model: '',
    enabled: true,
  };
}

test('agent: lista as tools de servidor registradas (web_search)', () => {
  const tools = listServerTools();
  assert.ok(tools.some((t) => t.name === 'web_search'));
  const ws = tools.find((t) => t.name === 'web_search')!;
  assert.ok(ws.description.length > 0);
  assert.equal(ws.parameters.type, 'object');
  assert.ok(ws.parameters.required?.includes('query'));
});

test('agent: isServerAgentSupported distingue HTTP de browser', () => {
  assert.equal(isServerAgentSupported(openaiProvider()), true);
  assert.equal(isServerAgentSupported({ ...openaiProvider(), type: 'gemini' }), true);
  assert.equal(isServerAgentSupported({ ...openaiProvider(), type: 'anthropic' }), true);
  assert.equal(isServerAgentSupported({ ...openaiProvider(), type: 'deepseek' }), false);
  assert.equal(isServerAgentSupported({ ...openaiProvider(), type: 'qwen' }), false);
  assert.equal(isServerAgentSupported({ ...openaiProvider(), type: 'openai-compatible', baseUrl: '' }), false);
});

test('agent: runServerAgent rejeita no Gateway Puro (sem execução local)', async () => {
  await assert.rejects(
    () =>
      runServerAgent(
        { model: 'gpt-test', messages: [{ role: 'user', content: 'oi' }] },
        openaiProvider()
      ),
    /Gateway HTTP Puro|desativado/
  );
});

test('agent: provedor não suportado lança erro mesmo no gateway puro', async () => {
  await assert.rejects(
    () =>
      runServerAgent(
        { model: 'x', messages: [{ role: 'user', content: 'oi' }] },
        { ...openaiProvider(), type: 'deepseek' }
      ),
    /não é suportado/
  );
});