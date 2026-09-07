import test from 'node:test';
import assert from 'node:assert';
import { app, gatewayApp, isLocalDestinationHeaderValue, sanitizeDestinationHeadersFrom } from './index.ts';
import { initPlaywright, closePlaywright } from './services/playwright.ts';

test('Health check endpoint returns status ok', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('destination headers locais são removidos na entrada (localhost/loopback/porta)', async () => {
  const cases = ['localhost', 'LOCALHOST', 'localhost:3005', '127.0.0.1', '127.0.0.1:3005', '3005', '::1'];
  for (const bad of cases) {
    assert.equal(
      isLocalDestinationHeaderValue(bad),
      true,
      `"${bad}" deve ser tratado como destino local`
    );

    const clean = sanitizeDestinationHeadersFrom({
      'destination-addr': bad,
      'destination-domain': `${bad}.sandbox`,
      'x-custom': 'mantido',
    });
    assert.equal(clean.has('destination-addr'), false, `${bad} deve ter destination-addr removido`);
    assert.equal(clean.has('destination-domain'), false, `${bad} deve ter destination-domain removido`);
    assert.equal(clean.get('x-custom'), 'mantido');
  }
});

test('destination headers REMOTOS não são removidos', () => {
  assert.equal(isLocalDestinationHeaderValue('api.deepseek.com'), false);
  assert.equal(isLocalDestinationHeaderValue('https://example.com:443'), false);

  const clean = sanitizeDestinationHeadersFrom({
    'destination-addr': '142.250.74.110:443',
    'destination-domain': 'api.deepseek.com',
  });
  assert.equal(clean.get('destination-addr'), '142.250.74.110:443');
  assert.equal(clean.get('destination-domain'), 'api.deepseek.com');
});

test('sem destination headers: coleção intacta e middleware não quebra rota', async () => {
  const clean = sanitizeDestinationHeadersFrom({ 'x-custom': 'ok', authorization: 'Bearer abc' });
  assert.equal(clean.get('x-custom'), 'ok');
  assert.equal(clean.get('authorization'), 'Bearer abc');

  const res = await app.fetch(new Request('http://localhost/health', {
    headers: { 'destination-addr': '127.0.0.1:3005' },
  }));
  assert.strictEqual(res.status, 200);

  const gwRes = await gatewayApp.fetch(new Request('http://localhost/health', {
    headers: { 'destination-domain': 'localhost' },
  }));
  assert.strictEqual(gwRes.status, 200);
});

test('Models endpoint returns deepseek-thinking and deepseek-no-thinking', async () => {
  const req = new Request('http://localhost/v1/models');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-thinking'));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-no-thinking'));
});

test('Chat Completions endpoint with deepseek-thinking (thinking enabled)', { skip: !process.env.DEEPSEEK_LIVE_TEST }, async () => {
  // Initialize playwright for this test
  // NOTE: Headless mode can sometimes fail Cloudflare checks. We use headless=false for the test
  // to ensure it matches the logged-in browser state if needed, or you can switch it to true.
  await initPlaywright(false);

  try {
    const payload = {
      model: 'deepseek-thinking',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);
              
              if (data.choices && data.choices[0] && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.content) {
                hasContent = true;
              }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    await closePlaywright();
  }
});
