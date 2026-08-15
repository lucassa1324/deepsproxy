import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import {
  computeTextDelta,
  createGeminiWebStream,
  consumeGeminiWebStream,
  FakeGeminiPage,
  GEMINI_SCRIPT_SET_PROMPT,
  GEMINI_SCRIPT_CLICK_SEND,
  GEMINI_SCRIPT_READ_RESPONSE,
  setMockGeminiPage,
} from './services/gemini-web.ts';
import { app } from './index.ts';
import type { Provider } from './services/config.ts';

/* ------------------------- Delta de texto ------------------------- */

test('gemini-web: computeTextDelta emite só o sufixo novo', () => {
  assert.strictEqual(computeTextDelta('', 'Olá'), 'Olá');
  assert.strictEqual(computeTextDelta('Olá', 'Olá'), '');
  assert.strictEqual(computeTextDelta('Ol', 'Olá!'), 'á!');
  assert.strictEqual(computeTextDelta('Olá mundo', 'Olá mundo feliz'), ' feliz');
  // Regressão (UI editou o texto): sai a partir do prefixo comum, sem repetir.
  assert.strictEqual(computeTextDelta('abcXYZ', 'abcQW'), 'QW');
});

/* ------------------------- Scripts marcados ------------------------- */

test('gemini-web: scripts de DOM carregam o marker __GEMINI_*__', () => {
  assert.ok(GEMINI_SCRIPT_SET_PROMPT.includes('__GEMINI_SET_PROMPT__'));
  assert.ok(GEMINI_SCRIPT_CLICK_SEND.includes('__GEMINI_CLICK_SEND__'));
  assert.ok(GEMINI_SCRIPT_READ_RESPONSE.includes('__GEMINI_READ_RESPONSE__'));
  // Regressão: esbuild/tsx injeta __name() em funções nomeadas — o script tem
  // que ser string pura, sem referência ao helper do Node (quebra no browser).
  assert.ok(!GEMINI_SCRIPT_SET_PROMPT.includes('__name'));
});

/* ------------------------- Stream com página fake ------------------------- */

test('gemini-web: createGeminiWebStream emite deltas até a resposta parar', async () => {
  const fake = new FakeGeminiPage();
  fake.responseFrames = ['Ol', 'Olá', 'Olá!'];

  const stream = await createGeminiWebStream(fake, 'quem é você?', {
    pollIntervalMs: 1,
    stablePolls: 2,
  });
  const { text, events, error } = await consumeGeminiWebStream(stream);

  assert.strictEqual(error, undefined);
  assert.strictEqual(text, 'Olá!');
  assert.ok(fake.sendClicked, 'deve ter clicado em enviar');
  assert.strictEqual(fake.prompts[0], 'quem é você?');
  assert.strictEqual(fake.dismissClicks, 1, 'deve ter dispensado onboards');
  const deltas = events.filter((e) => e.type === 'content').map((e: any) => e.text);
  assert.deepStrictEqual(deltas, ['Ol', 'á', '!']);
});

test('gemini-web: falha quando o composer não é encontrado', async () => {
  const fake = new FakeGeminiPage();
  fake.setPromptResult = false;

  const stream = await createGeminiWebStream(fake, 'oi', { pollIntervalMs: 1 });
  const { error } = await consumeGeminiWebStream(stream);
  assert.ok(error && error.toLowerCase().includes('campo de digitação'));
});

test('gemini-web: avisa quando a página está na tela de login do Google', async () => {
  const fake = new FakeGeminiPage();
  fake.setPromptResult = false;
  fake.pageState = { url: 'https://accounts.google.com/signin', onLoginScreen: true, composerFound: false, composerSelectors: {} };

  const stream = await createGeminiWebStream(fake, 'oi', { pollIntervalMs: 1 });
  const { error } = await consumeGeminiWebStream(stream);
  assert.ok(error && error.toLowerCase().includes('login'));
});

test('gemini-web: página fake custom (page-like) é aceita pelo seam', async () => {
  let prompt = '';
  const customPage = {
    evaluate: async (fn: Function, arg?: unknown) => {
      const src = String(fn);
      if (src.includes('__GEMINI_GO_NEW_CHAT__')) return 'https://gemini.google.com/app';
      if (src.includes('__GEMINI_DISMISS_ONBOARDING__')) return true;
      if (src.includes('__GEMINI_SET_PROMPT__')) {
        prompt = String(arg ?? '');
        return true;
      }
      if (src.includes('__GEMINI_CLICK_SEND__')) return true;
      if (src.includes('__GEMINI_READ_RESPONSE__')) return { text: prompt ? 'resposta do gemini' : '', hasStop: false };
      return undefined;
    },
    waitForTimeout: async () => {},
    isClosed: () => false,
  };

  const stream = await createGeminiWebStream(customPage as any, 'teste', { pollIntervalMs: 1, stablePolls: 2 });
  const { text } = await consumeGeminiWebStream(stream);
  assert.strictEqual(text, 'resposta do gemini');
});

/* ------------------------- Config (sanitização do tipo) ------------------------- */

test('gemini-web: sanitizeType aceita gemini-web e cai para openai-compatible em inválido', async () => {
  const { sanitizeType, isBrowserType } = await import('./services/config.ts');
  assert.strictEqual(sanitizeType('gemini-web'), 'gemini-web');
  assert.strictEqual(sanitizeType('coisa-qualquer'), 'openai-compatible');
  assert.ok(isBrowserType('gemini-web'), 'gemini-web deve ser tratado como browser (Playwright)');
});

test('gemini-web: findProviderForModel prefere o Web (navegador) para modelos conhecidos', async () => {
  const { findProviderForModel } = await import('./services/local.ts');
  const api: Provider = { id: 'api', name: 'Gemini (API)', type: 'gemini', baseUrl: '', apiKey: 'k', model: '', enabled: true };
  const web: Provider = { id: 'web', name: 'Gemini (Web)', type: 'gemini-web', baseUrl: '', apiKey: '', model: '', enabled: true };
  // Mesmo com a API antes no registro, o modelo conhecido do Web vence (a API
  // marca gemini-2.5/3.x como deprecated/404 para usuários novos).
  const ownerKnown = await findProviderForModel([api, web], 'gemini-3-flash');
  assert.strictEqual(ownerKnown?.id, 'web');
  const ownerOther = await findProviderForModel([api, web], 'gemini-3.1-flash');
  assert.strictEqual(ownerOther?.id, 'api');
});

/* ------------------------- E2E pelo roteador ------------------------- */

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response) {
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

test('gemini-web: /v1/chat/completions (stream:false) responde JSON pela UI fake', async () => {
  const fake = new FakeGeminiPage();
  fake.responseFrames = ['Ol', 'Olá!'];
  setMockGeminiPage(fake);

  const restore = setupFetchMock(() => {
    throw new Error('gemini-web não deve chamar upstream HTTP');
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3-flash',
        messages: [
          { role: 'user', content: 'primeiro' },
          { role: 'assistant', content: 'anterior' },
          { role: 'user', content: 'quem é você?' },
        ],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.object, 'chat.completion');
    assert.strictEqual(data.model, 'gemini-3-flash');
    assert.strictEqual(data.choices[0].message.content, 'Olá!');
    assert.strictEqual(data.choices[0].finish_reason, 'stop');
    // buildAgentPrompt achata TODO o histórico no prompt enviado ao Gemini.
    assert.ok(fake.prompts[0].includes('primeiro'), 'histórico completo deve ir no prompt');
    assert.ok(fake.prompts[0].includes('anterior'), 'respostas anteriores devem ir no prompt');
  } finally {
    setMockGeminiPage(null);
    restore();
  }
});

test('gemini-web: /v1/chat/completions (stream:true) responde SSE por deltas', async () => {
  const fake = new FakeGeminiPage();
  fake.responseFrames = ['Ol', 'Olá', 'Olá!'];
  setMockGeminiPage(fake);

  const restore = setupFetchMock(() => {
    throw new Error('gemini-web não deve chamar upstream HTTP');
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'oi' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('Content-Type') || '').includes('text/event-stream'));
    const body = await res.text();

    const contents = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (payload === '[DONE]') continue;
      const chunk = JSON.parse(payload);
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && typeof d.content === 'string' && d.content) contents.push(d.content);
    }
    assert.strictEqual(contents.join(''), 'Olá!');
    assert.ok(body.includes('"finish_reason":"stop"'));
    assert.ok(body.includes('data: [DONE]'));
  } finally {
    setMockGeminiPage(null);
    restore();
  }
});

test('gemini-web: erro no fluxo vira 500 com mensagem', async () => {
  const fake = new FakeGeminiPage();
  fake.setPromptResult = false;
  setMockGeminiPage(fake);

  const restore = setupFetchMock(() => {
    throw new Error('sem upstream HTTP');
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'oi' }],
        stream: false,
      }),
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 500);
    const data = await res.json();
    assert.ok(data.error && data.error.message);
  } finally {
    setMockGeminiPage(null);
    restore();
  }
});
