import test from 'node:test';
import assert from 'node:assert';

process.env.PROVIDER = 'local';
process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

import { app } from './index.ts';

function setupLocalFetchMock(handler: (url: string, init?: RequestInit) => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (/^http:\/\/localhost:\d+/.test(urlStr)) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
];

test('local agentic: streaming parses <tool_call> into tool_calls chunks', async () => {
  let capturedBody: any = null;
  const restore = setupLocalFetchMock((url, init) => {
    capturedBody = JSON.parse(init?.body as string || '{}');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{"role":"assistant","content":"<tool_call>"},"finish_reason":null}]}\n\n'));
        c.enqueue(encoder.encode('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{"content":"{\\"name\\": \\"edit_file\\", \\"arguments\\": {\\"path\\": \\"a.txt\\", \\"content\\": \\"oi\\"}}"},"finish_reason":null}]}\n\n'));
        c.enqueue(encoder.encode('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{"content":"</tool_call>"},"finish_reason":null}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'edite o arquivo' }], tools: TOOLS, stream: true })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');
    const text = await res.text();

    // Upstream payload: tools injected into the prompt, stream on
    assert.strictEqual(capturedBody.stream, true);
    assert.ok(!('tools' in capturedBody), 'tools must be removed (injected in the prompt)');
    const upstreamMsg = capturedBody.messages[0].content;
    assert.ok(upstreamMsg.includes('# TOOLS AVAILABLE'));
    assert.ok(upstreamMsg.includes('edit_file'));
    assert.ok(upstreamMsg.includes('User: edite o arquivo'));

    // Output: parsed tool_calls chunk + finish_reason tool_calls
    assert.ok(text.includes('"tool_calls"'), 'must emit tool_calls chunk');
    assert.ok(text.includes('edit_file'));
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
    assert.ok(text.includes('[DONE]'));
  } finally {
    restore();
  }
});

test('local agentic: non-streaming returns message.tool_calls', async () => {
  const restore = setupLocalFetchMock((url, init) => {
    const body = JSON.parse(init?.body as string || '{}');
    assert.strictEqual(body.stream, false);
    return new Response(
      JSON.stringify({
        id: 'c1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Vou editar.\n<tool_call>\n{"name": "edit_file", "arguments": {"path": "a.txt", "content": "oi"}}\n</tool_call>' },
            finish_reason: 'stop',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'edite' }], tools: TOOLS, stream: false })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const msg = data.choices[0].message;
    assert.strictEqual(msg.content, 'Vou editar.');
    assert.ok(msg.tool_calls, 'must include tool_calls');
    assert.strictEqual(msg.tool_calls[0].function.name, 'edit_file');
    assert.strictEqual(msg.tool_calls[0].function.arguments, '{"path":"a.txt","content":"oi"}');
    assert.strictEqual(data.choices[0].finish_reason, 'tool_calls');
  } finally {
    restore();
  }
});

test('local agentic: no <tool_call> means finish_reason stop with plain content', async () => {
  const restore = setupLocalFetchMock((url) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{"role":"assistant","content":"Olá"},"finish_reason":null}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'oi' }], tools: TOOLS, stream: true })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.ok(text.includes('"content":"Olá"'));
    assert.ok(text.includes('"finish_reason":"stop"'));
    assert.ok(!text.includes('"tool_calls"'));
  } finally {
    restore();
  }
});

test('config: POST /api/providers updates the registry and persists via cookie', async () => {
  const restore = setupLocalFetchMock((url) => {
    assert.ok(url.endsWith('/models'), 'upstream /models must be hit after config change');
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'qwen2', object: 'model', owned_by: 'local' }] }),
      { status: 200 }
    );
  });

  try {
    const postReq = new Request('http://localhost/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active: 'p1',
        providers: [
          {
            id: 'p1',
            name: 'Ollama',
            type: 'openai-compatible',
            baseUrl: 'http://localhost:1234/v1',
            model: 'qwen2',
            apiKey: 'sekret',
          },
        ],
      }),
    });
    const postRes = await app.fetch(postReq);
    assert.strictEqual(postRes.status, 200);
    const setCookie = postRes.headers.get('Set-Cookie') || '';
    assert.ok(setCookie.includes('deepsproxy_providers='), 'must set the providers cookie');
    const cfg = await postRes.json();
    assert.strictEqual(cfg.ok, true);
    assert.strictEqual(cfg.active, 'p1');
    assert.strictEqual(cfg.providers[0].baseUrl, 'http://localhost:1234/v1');
    assert.strictEqual(cfg.providers[0].model, 'qwen2');

    // Sem cookie (cliente CLI): o registro em memória cobre a última config salva.
    const modelsRes = await app.fetch(new Request('http://localhost/v1/models'));
    const modelsData = await modelsRes.json();
    assert.ok(modelsData.data.some((m: any) => m.id === 'qwen2'));
  } finally {
    restore();
  }
});
