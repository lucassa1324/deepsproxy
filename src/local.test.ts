import test from 'node:test';
import assert from 'node:assert';

process.env.PROVIDER = 'local';
process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
process.env.LLM_MODEL = 'llama3.2';

import { app } from './index.ts';

function setupLocalFetchMock(handler: (url: string, init?: RequestInit) => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.startsWith(process.env.LLM_BASE_URL!)) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('local provider: relays streaming SSE from upstream and respects requested model', async () => {
  let capturedBody: any = null;
  const restore = setupLocalFetchMock((url, init) => {
    capturedBody = JSON.parse(init?.body as string || '{}');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama3.2","choices":[{"index":0,"delta":{"role":"assistant","content":"olá"},"finish_reason":null}]}\n\n'));
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
      body: JSON.stringify({ model: 'minha-modelo', messages: [{ role: 'user', content: 'oi' }], stream: true })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const text = await res.text();
    assert.ok(text.includes('olá'));
    assert.ok(text.includes('[DONE]'));

    assert.strictEqual(capturedBody.model, 'minha-modelo', 'requested model must be respected (no override)');
    assert.strictEqual(capturedBody.stream, true);
  } finally {
    restore();
  }
});

test('local provider: non-streaming passthrough JSON', async () => {
  const restore = setupLocalFetchMock((url, init) => {
    const body = JSON.parse(init?.body as string || '{}');
    assert.strictEqual(body.stream, false);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'resposta' }, finish_reason: 'stop' }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', messages: [{ role: 'user', content: 'oi' }], stream: false })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'resposta');
  } finally {
    restore();
  }
});

test('local provider: /v1/models proxies upstream list', async () => {
  const restore = setupLocalFetchMock((url) => {
    assert.ok(url.endsWith('/models'));
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'llama3.2', object: 'model', owned_by: 'local' }] }),
      { status: 200 }
    );
  });

  try {
    const req = new Request('http://localhost/v1/models');
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.data.some((m: any) => m.id === 'llama3.2'));
  } finally {
    restore();
  }
});

test('local provider: upstream error surfaces as 502', async () => {
  const restore = setupLocalFetchMock(() => {
    return new Response('model not found', { status: 404 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'oi' }] })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 502);
    const data = await res.json();
    assert.ok(data.error.message.includes('Upstream'));
  } finally {
    restore();
  }
});

test('local provider: passthrough preserves image_url content parts (vision)', async () => {
  let capturedBody: any = null;
  const restore = setupLocalFetchMock((url, init) => {
    capturedBody = JSON.parse(init?.body as string || '{}');
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Vejo a imagem.' }, finish_reason: 'stop' }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  try {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'o que tem nessa imagem?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
    ];
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llava', messages, stream: false })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'Vejo a imagem.');

    assert.ok(Array.isArray(capturedBody.messages[0].content), 'content must stay an array');
    assert.strictEqual(capturedBody.messages[0].content[1].type, 'image_url');
    assert.strictEqual(capturedBody.messages[0].content[1].image_url.url, 'data:image/png;base64,iVBORw0KGgo=');
    assert.ok(!('tools' in capturedBody));
  } finally {
    restore();
  }
});

test('local agentic: image parts preserved when tools are present (vision + tools)', async () => {
  let capturedBody: any = null;
  const restore = setupLocalFetchMock((url, init) => {
    capturedBody = JSON.parse(init?.body as string || '{}');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"llava","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  const TOOLS = [
    {
      type: 'function',
      function: { name: 'edit_file', description: 'Edit', parameters: { type: 'object', properties: {} } },
    },
  ];

  try {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'descreva e edite o arquivo' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
    ];
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llava', messages, tools: TOOLS, stream: true })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    await res.text();

    assert.ok(!('tools' in capturedBody), 'tools must be injected as system prompt');
    assert.ok(capturedBody.messages[0].role === 'system', 'first message must be system with tools');
    assert.ok(capturedBody.messages[0].content.includes('# TOOLS AVAILABLE'));
    const userMsg = capturedBody.messages.find((m: any) => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content), 'user content must remain an array with the image');
    assert.strictEqual(userMsg.content.find((p: any) => p.type === 'image_url').image_url.url, 'data:image/png;base64,iVBORw0KGgo=');
  } finally {
    restore();
  }
});
