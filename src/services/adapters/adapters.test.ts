import test from 'node:test';
import assert from 'node:assert';

import { sanitizeRegistry, Provider } from '../config.ts';
import { adapterHttpErrorResponse } from './base.ts';
import { GeminiAdapter, buildGeminiBody, fromGeminiResponse } from './gemini.ts';
import { AnthropicAdapter, toAnthropicMessages, fromAnthropicResponse } from './anthropic.ts';
import { OllamaAdapter, fromOllamaResponse } from './ollama.ts';
import { RateLimiter, withRetry, HttpError } from './throttle.ts';

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'Provedor',
    type: 'gemini',
    baseUrl: '',
    apiKey: 'teste',
    model: 'gemini-2.0-flash',
    enabled: true,
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) =>
    handler(String(input?.url ?? input), init);
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/* ------------------------- Config ------------------------- */

test('config: sanitizeRegistry preserva tipos novos e aplica base URL padrão', () => {
  const { registry, error } = sanitizeRegistry({
    active: 'g',
    providers: [
      { id: 'g', name: 'Gemini', type: 'gemini', apiKey: 'abc' },
      { id: 'a', name: 'Anthropic', type: 'anthropic', apiKey: 'chave' },
      { id: 'o', name: 'Ollama', type: 'ollama' },
      { id: 'x', name: 'Custom', type: 'openai-compatible', baseUrl: 'http://meu/v1' },
    ],
  });
  assert.strictEqual(error, undefined);
  assert.ok(registry);
  const byId = Object.fromEntries(registry!.providers.map((p) => [p.id, p]));
  assert.strictEqual(byId.g.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.strictEqual(byId.g.apiKey, 'abc');
  assert.strictEqual(byId.a.baseUrl, 'https://api.anthropic.com/v1');
  assert.strictEqual(byId.o.baseUrl, 'http://localhost:11434');
  assert.strictEqual(byId.x.baseUrl, 'http://meu/v1');
});

/* ------------------------- Gemini ------------------------- */

test('gemini: buildGeminiBody traduz system/tool/assistant para Gemini', () => {
  const body = buildGeminiBody({
    model: 'gemini-2.0-flash',
    temperature: 0.5,
    messages: [
      { role: 'system', content: 'Você é útil' },
      { role: 'user', content: 'Oi' },
      { role: 'assistant', content: 'Olá!', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'edit_file', content: 'ok' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }, { type: 'text', text: 'o que é?' }] },
    ],
  });
  assert.deepStrictEqual(body.systemInstruction, { parts: [{ text: 'Você é útil' }] });
  assert.strictEqual(body.generationConfig.temperature, 0.5);
  assert.strictEqual(body.contents[0].role, 'user');
  assert.deepStrictEqual(body.contents[0].parts, [{ text: 'Oi' }]);
  assert.strictEqual(body.contents[1].role, 'model');
  assert.deepStrictEqual(body.contents[1].parts[0], { text: 'Olá!' });
  assert.deepStrictEqual(body.contents[1].parts[1].functionCall, { name: 'edit_file', args: { path: 'a.txt' } });
  assert.strictEqual(body.contents[2].role, 'user');
  assert.deepStrictEqual(body.contents[2].parts[0].functionResponse, { name: 'edit_file', response: { result: 'ok' } });
  assert.deepStrictEqual(body.contents[2].parts[1], { inline_data: { mime_type: 'image/png', data: 'QUJD' } });
  assert.deepStrictEqual(body.contents[2].parts[2], { text: 'o que é?' });
});

test('gemini: buildGeminiBody remove keywords não suportados do schema das tools (Trae/Cursor)', () => {
  const body = buildGeminiBody({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'buscar',
          description: 'Busca',
          parameters: {
            type: 'object',
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            additionalProperties: false,
            properties: {
              q: { type: 'string', minLength: 1 },
              n: { type: 'integer', anyOf: [{ type: 'integer' }, { type: 'null' }], default: 5 },
            },
            required: ['q'],
            nullable: true,
          } as any,
        },
      },
    ],
  });
  const decl = body.tools[0].functionDeclarations[0];
  assert.deepStrictEqual(decl.parameters, {
    type: 'object',
    properties: {
      q: { type: 'string', minLength: 1 },
      n: { type: 'integer' },
    },
    required: ['q'],
  });
});

test('gemini: chatCompletion traduz resposta REST para OpenAI', async () => {
  const adapter = new GeminiAdapter(100000);
  const restore = mockFetch((url, init) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key='));
    const body = JSON.parse(init?.body as string || '{}');
    assert.strictEqual(body.systemInstruction.parts[0].text, 'Sistema');
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'resposta' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  try {
    const res = await adapter.chatCompletion(
      { model: 'gemini-2.0-flash', messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'oi' }] },
      makeProvider()
    );
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.object, 'chat.completion');
    assert.strictEqual(data.choices[0].message.content, 'resposta');
    assert.strictEqual(data.choices[0].finish_reason, 'stop');
    assert.strictEqual(data.usage.prompt_tokens, 3);
    assert.strictEqual(data.usage.total_tokens, 8);
  } finally {
    restore();
  }
});

test('gemini: streaming usa streamGenerateContent com alt=sse', async () => {
  const adapter = new GeminiAdapter(100000);
  const restore = mockFetch((url) => {
    assert.ok(url.includes(':streamGenerateContent?key=teste&alt=sse'));
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"olá"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });
  try {
    const res = await adapter.chatCompletion(
      { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'oi' }], stream: true },
      makeProvider()
    );
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');
    const text = await res.text();
    assert.ok(text.includes('olá'));
    assert.ok(text.includes('[DONE]'));
    assert.ok(text.includes('"prompt_tokens":1'));
  } finally {
    restore();
  }
});

test('gemini: normaliza prefixo "models/" no model antes de montar a URL', async () => {
  const adapter = new GeminiAdapter(100000);
  const restore = mockFetch((url) => {
    assert.ok(
      url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='),
      `URL deve usar id limpo, veio: ${url}`
    );
    assert.ok(!url.includes('/models/models/'), 'não pode duplicar o prefixo models/');
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }),
      { status: 200 }
    );
  });
  try {
    const res = await adapter.chatCompletion(
      { model: 'models/gemini-2.5-flash', messages: [{ role: 'user', content: 'oi' }] },
      makeProvider()
    );
    const data = await res.json();
    assert.strictEqual(data.model, 'gemini-2.5-flash', 'resposta deve ecoar o id limpo');
  } finally {
    restore();
  }
});

test('gemini: fetchModels filtra apenas modelos generateContent', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('/models?key=teste'));
    return new Response(
      JSON.stringify({
        models: [
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent', 'embedContent'] },
          { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
      { status: 200 }
    );
  });
  try {
    const adapter = new GeminiAdapter(100000);
    const models = await adapter.fetchModels(makeProvider());
    assert.deepStrictEqual(models!.map((m: any) => m.id), ['gemini-2.0-flash']);
  } finally {
    restore();
  }
});

test('gemini: fromGeminiResponse traduz functionCall para tool_calls', () => {
  const data = {
    candidates: [
      {
        content: { parts: [{ text: 'Vou chamar' }, { functionCall: { name: 'edit_file', args: { path: 'a.txt' } } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4, totalTokenCount: 6 },
  };
  const out = fromGeminiResponse(data, 'gemini-2.0-flash');
  assert.strictEqual(out.choices[0].message.content, 'Vou chamar');
  assert.strictEqual(out.choices[0].message.tool_calls[0].function.name, 'edit_file');
  assert.strictEqual(out.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(out.usage.total_tokens, 6);
});

test('gemini: fromGeminiResponse preserva thought_signature no tool_call', () => {
  const data = {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: 'edit_file', args: { path: 'a.txt' }, thoughtSignature: 'TS-abc-123' } }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {},
  };
  const out = fromGeminiResponse(data, 'gemini-2.5-flash');
  const tc = out.choices[0].message.tool_calls[0];
  assert.strictEqual(tc.thought_signature, 'TS-abc-123');
  assert.ok(tc.id.startsWith('call_ts_'), `id deve carregar a assinatura, veio: ${tc.id}`);
});

test('gemini: buildGeminiBody reenvia thoughtSignature no functionCall do histórico', () => {
  const body = buildGeminiBody({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'edi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_ts_VFMxMjM0NTY', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a.txt"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_ts_VFMxMjM0NTY', name: 'edit_file', content: 'ok' },
    ],
  });
  assert.deepStrictEqual(body.contents[1].parts[0].functionCall, {
    name: 'edit_file',
    args: { path: 'a.txt' },
    thoughtSignature: 'TS123456',
  });
  assert.deepStrictEqual(body.contents[2].parts[0].functionResponse, { name: 'edit_file', response: { result: 'ok' } });
});

test('gemini: buildGeminiBody usa campo thought_signature quando presente no tool_call', () => {
  const body = buildGeminiBody({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'edi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_x', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a"}' }, thought_signature: 'TS-direto' },
        ],
      },
    ],
  });
  assert.deepStrictEqual(body.contents[1].parts[0].functionCall, {
    name: 'edit_file',
    args: { path: 'a' },
    thoughtSignature: 'TS-direto',
  });
});

test('gemini: buildGeminiBody converte calls sem assinatura em texto em modelos 2.5', () => {
  const body = buildGeminiBody({
    model: 'gemini-2.5-pro',
    messages: [
      { role: 'user', content: 'edi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_legado', type: 'function', function: { name: 'default_api:Write', arguments: '{"path":"a.txt"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_legado', name: 'default_api:Write', content: 'arquivo criado' },
    ],
  });
  assert.strictEqual(body.contents.length, 2, 'assistant sem partes é descartado');
  assert.strictEqual(body.contents[0].role, 'user');
  assert.strictEqual(body.contents[0].parts[0].text, 'edi');
  assert.strictEqual(body.contents[1].role, 'user');
  assert.strictEqual(body.contents[1].parts[0].functionResponse, undefined, 'functionResponse sem functionCall não pode ir ao Gemini');
  assert.ok(body.contents[1].parts[0].text.includes('arquivo criado'), 'resultado da tool vira texto');
});

test('gemini: buildGeminiBody mantém functionResponse para modelos sem exigência de assinatura', () => {
  const body = buildGeminiBody({
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'user', content: 'edi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
  });
  assert.deepStrictEqual(body.contents[1].parts[0].functionCall, { name: 'edit_file', args: { path: 'a' } });
  assert.deepStrictEqual(body.contents[2].parts[0].functionResponse, { name: 'edit_file', response: { result: 'ok' } });
});

/* ------------------------- Anthropic ------------------------- */

test('anthropic: toAnthropicMessages extrai system e traduz roles', () => {
  const { system, messages } = toAnthropicMessages({
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'Sistema' },
      { role: 'user', content: 'Oi' },
      { role: 'assistant', content: 'Olá', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', name: 'edit_file', content: 'ok' },
      { role: 'user', content: 'obrigado' },
    ],
  });
  assert.strictEqual(system, 'Sistema');
  assert.strictEqual(messages[0].role, 'user');
  assert.deepStrictEqual(messages[0].content, [{ type: 'text', text: 'Oi' }]);
  assert.strictEqual(messages[1].role, 'assistant');
  assert.deepStrictEqual(messages[1].content[1], { type: 'tool_use', id: 'tc1', name: 'edit_file', input: { path: 'a' } });
  assert.strictEqual(messages[2].role, 'user');
  assert.strictEqual(messages[2].content[0].type, 'tool_result');
  assert.strictEqual(messages[2].content[0].tool_use_id, 'tc1');
  assert.deepStrictEqual(messages[2].content[1], { type: 'text', text: 'obrigado' });
});

test('anthropic: histórico iniciando por assistant ganha turno user', () => {
  const { messages } = toAnthropicMessages({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'assistant', content: 'Olá' }],
  });
  assert.strictEqual(messages[0].role, 'user');
  assert.strictEqual(messages[0].content[0].text, 'Continue.');
  assert.strictEqual(messages[1].role, 'assistant');
});

test('anthropic: chatCompletion envia x-api-key e traduz resposta', async () => {
  const adapter = new AnthropicAdapter();
  const restore = mockFetch((url, init) => {
    assert.strictEqual(url, 'https://api.anthropic.com/v1/messages');
    const headers = new Headers(init?.headers as HeadersInit);
    assert.strictEqual(headers.get('x-api-key'), 'sk-test');
    assert.strictEqual(headers.get('anthropic-version'), '2023-06-01');
    const body = JSON.parse(init?.body as string || '{}');
    assert.strictEqual(body.model, 'claude-sonnet-4-5');
    assert.strictEqual(body.system, 'Sistema');
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'oi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200 }
    );
  });
  try {
    const res = await adapter.chatCompletion(
      { model: 'claude-sonnet-4-5', messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'oi' }] },
      makeProvider({ type: 'anthropic', apiKey: 'sk-test' })
    );
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'oi');
    assert.strictEqual(data.choices[0].finish_reason, 'stop');
    assert.strictEqual(data.usage.total_tokens, 2);
  } finally {
    restore();
  }
});

test('anthropic: fromAnthropicResponse traduz tool_use para tool_calls', () => {
  const data = {
    content: [
      { type: 'text', text: 'Vou editar' },
      { type: 'tool_use', id: 'tu1', name: 'edit_file', input: { path: 'a.txt', content: 'x' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const out = fromAnthropicResponse(data, 'claude-sonnet-4-5');
  assert.strictEqual(out.choices[0].message.content, 'Vou editar');
  assert.strictEqual(out.choices[0].message.tool_calls[0].function.name, 'edit_file');
  assert.strictEqual(out.choices[0].message.tool_calls[0].function.arguments, '{"path":"a.txt","content":"x"}');
  assert.strictEqual(out.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(out.usage.prompt_tokens, 10);
});

/* ------------------------- Ollama ------------------------- */

test('ollama: fromOllamaResponse extrai <tool_call> do texto', () => {
  const data = {
    message: {
      content: 'preciso editar\n<tool_call>{"name":"edit_file","arguments":{"path":"a.txt","content":"x"}}</tool_call>',
    },
    done: true,
    prompt_eval_count: 4,
    eval_count: 6,
  };
  const out = fromOllamaResponse(data, 'llama3.2');
  assert.strictEqual(out.choices[0].message.content, 'preciso editar');
  assert.strictEqual(out.choices[0].message.tool_calls[0].function.name, 'edit_file');
  assert.strictEqual(out.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(out.usage.total_tokens, 10);
});

test('ollama: chatCompletion envia para /api/chat e traduz resposta', async () => {
  const adapter = new OllamaAdapter();
  const restore = mockFetch((url, init) => {
    assert.strictEqual(url, 'http://localhost:11434/api/chat');
    const body = JSON.parse(init?.body as string || '{}');
    assert.strictEqual(body.model, 'llama3.2');
    assert.strictEqual(body.messages[0].role, 'user');
    return new Response(
      JSON.stringify({ message: { content: 'resposta local' }, done: true, prompt_eval_count: 2, eval_count: 3 }),
      { status: 200 }
    );
  });
  try {
    const res = await adapter.chatCompletion(
      { model: 'llama3.2', messages: [{ role: 'user', content: 'oi' }] },
      makeProvider({ type: 'ollama' })
    );
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'resposta local');
    assert.strictEqual(data.usage.total_tokens, 5);
  } finally {
    restore();
  }
});

/* ------------------------- Erros de HTTP / quota ------------------------- */

test('base: adapterHttpErrorResponse devolve 429 JSON (non-stream) e SSE (stream)', async () => {
  const err = new HttpError(429, 'quota exceeded');

  const jsonRes = adapterHttpErrorResponse(err, 'Gemini', false);
  assert.strictEqual(jsonRes.status, 429);
  const data = await jsonRes.json();
  assert.ok(data.error.message.includes('quota exceeded'));

  const sseRes = adapterHttpErrorResponse(err, 'Gemini', true);
  assert.strictEqual(sseRes.status, 429);
  assert.strictEqual(sseRes.headers.get('Content-Type'), 'text/event-stream');
  const text = await sseRes.text();
  assert.ok(text.includes('quota exceeded'));
  assert.ok(text.includes('[DONE]'));
});

test('gemini: 429 de quota após retries vira erro OpenAI claro, não 500', async () => {
  const adapter = new GeminiAdapter(100000);
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }),
      { status: 429 }
    )
  );
  try {
    const res = await adapter.chatCompletion(
      { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'oi' }] },
      makeProvider()
    );
    assert.strictEqual(res.status, 429, 'deve devolver 429 ao cliente, não propagar exceção');
    const data = await res.json();
    assert.ok(data.error?.message.includes('Gemini'), 'mensagem deve indicar o provedor');
  } finally {
    restore();
  }
});

test('throttle: retry respeita retryDelay sugerido no body', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) {
      throw new HttpError(
        429,
        'Too Many',
        '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"0s"}]}}'
      );
    }
    return 'ok';
  };
  const result = await withRetry(fn, { retries: 2, baseDelayMs: 5000 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 2);
});

/* ------------------------- Throttle ------------------------- */

test('throttle: withRetry tenta novamente em 429 e propaga erro após esgotar', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) throw new HttpError(429, 'Too Many Requests');
    return 'ok';
  };
  const result = await withRetry(fn, { retries: 2, baseDelayMs: 5 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 2);
});

test('throttle: erro 4xx não é retried', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new HttpError(400, 'Bad Request');
  };
  await assert.rejects(withRetry(fn, { retries: 3, baseDelayMs: 5 }), /Bad Request/);
  assert.strictEqual(calls, 1);
});

test('throttle: erro genérico (rede) é retried e propagado no fim', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(withRetry(fn, { retries: 2, baseDelayMs: 5 }), /ECONNREFUSED/);
  assert.strictEqual(calls, 3);
});

test('throttle: RateLimiter espaça chamadas de 15 RPM', async () => {
  const limiter = new RateLimiter(600);
  const times: number[] = [];
  await Promise.all([1, 2, 3].map(() => limiter.run(async () => { times.push(Date.now()); })));
  assert.ok(times[1] - times[0] >= 100, `spacing esperado >= 100ms, got ${times[1] - times[0]}`);
  assert.ok(times[2] - times[0] >= 200, `spacing esperado >= 200ms, got ${times[2] - times[0]}`);
  assert.strictEqual(limiter.waiting, 0);
});
