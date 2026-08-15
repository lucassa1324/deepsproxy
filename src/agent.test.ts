/*
 * File: agent.test.ts
 * Project: deepsproxy
 * Testes do modo agente nativo (server-side tool execution).
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

function ddgHtml(): string {
  return [
    '<html><body>',
    '<a class="result__a" href="https://example.com/1">Exemplo Um</a>',
    '<a class="result__snippet">Primeiro trecho do exemplo.</a>',
    '<a class="result__a" href="https://example.com/2">Exemplo Dois</a>',
    '<a class="result__snippet">Segundo trecho do exemplo.</a>',
    '</body></html>',
  ].join('');
}

function completionJson(overrides: any): string {
  const body: any = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  if (overrides.choices) body.choices = overrides.choices;
  if (overrides.usage) body.usage = overrides.usage;
  return JSON.stringify(body);
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

test('agent: loop executa web_search e devolve a resposta final', async () => {
  const calls: Array<{ body: any }> = [];
  let completionsCall = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url.includes('/chat/completions')) {
      calls.push({ body });
      completionsCall++;
      if (completionsCall === 1) {
        return new Response(
          completionJson({
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_ws1',
                      type: 'function',
                      function: { name: 'web_search', arguments: '{"query":"preço do dólar hoje"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        completionJson({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'O dólar está em R$ 5,20 segundo o Exemplo Um.',
                reasoning_content: 'Pensei e busquei.',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('html.duckduckgo.com')) {
      return new Response(ddgHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return originalFetch(input, init);
  };

  try {
    const result = await runServerAgent(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Quanto está o dólar hoje?' }],
      },
      openaiProvider()
    );

    assert.equal(result.content, 'O dólar está em R$ 5,20 segundo o Exemplo Um.');
    assert.equal(result.reasoning, 'Pensei e busquei.');
    assert.equal(result.turns, 2);
    assert.equal(calls.length, 2);

    const first = calls[0].body;
    assert.ok(Array.isArray(first.tools));
    assert.equal(first.tools[0].function.name, 'web_search');
    assert.equal(first.tools[0].function.strict, undefined, 'strict é removido para compatibilidade');
    assert.equal(first.tools[0].function.parameters.additionalProperties, undefined);

    const second = calls[1].body;
    const roles = second.messages.map((m: any) => m.role);
    assert.ok(roles.includes('assistant'));
    assert.ok(roles.includes('tool'));
    const toolMsg = second.messages.find((m: any) => m.role === 'tool');
    assert.ok(toolMsg.content.includes('Exemplo Um'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent: loop para quando o modelo responde sem tool calls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/chat/completions')) {
      return new Response(
        completionJson({
          choices: [{ index: 0, message: { role: 'assistant', content: 'Sem ferramentas.' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(ddgHtml(), { status: 200 });
  };

  try {
    const result = await runServerAgent(
      { model: 'gpt-test', messages: [{ role: 'user', content: 'oi' }] },
      openaiProvider()
    );
    assert.equal(result.content, 'Sem ferramentas.');
    assert.equal(result.turns, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent: tool desconhecida vira erro e o loop continua', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/chat/completions')) {
      call++;
      const choices =
        call === 1
          ? [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_x',
                      type: 'function',
                      function: { name: 'tool_inexistente', arguments: '{"a":1}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ]
          : [{ index: 0, message: { role: 'assistant', content: 'Resposta final.' }, finish_reason: 'stop' }];
      return new Response(completionJson({ choices }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(ddgHtml(), { status: 200 });
  };

  try {
    const result = await runServerAgent(
      { model: 'gpt-test', messages: [{ role: 'user', content: 'x' }] },
      openaiProvider()
    );
    assert.equal(result.content, 'Resposta final.');
    assert.equal(result.turns, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent: provedor não suportado lança erro', async () => {
  await assert.rejects(
    () =>
      runServerAgent(
        { model: 'x', messages: [{ role: 'user', content: 'oi' }] },
        { ...openaiProvider(), type: 'deepseek' }
      ),
    /não é suportado/
  );
});

test('agent: maxTurns é respeitado (loop infinito para com erro)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/chat/completions')) {
      return new Response(
        completionJson({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_x', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(ddgHtml(), { status: 200 });
  };

  try {
    await assert.rejects(
      () =>
        runServerAgent(
          { model: 'gpt-test', messages: [{ role: 'user', content: 'oi' }] },
          openaiProvider(),
          { maxTurns: 2 }
        ),
      /maximum turns/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
