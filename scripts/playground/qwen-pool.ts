process.env.QWEN_POOL_SIZE = '2';

import { initQwenPlaywright, getQwenPoolState, getQwenLoginStatus, closeQwenPlaywright } from '../../src/services/qwen-playwright.ts';
import { createQwenStream } from '../../src/services/qwen.ts';

async function consume(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return out;
}

async function main() {
  console.log('[pool-test] inicializando...');
  await initQwenPlaywright(true);
  console.log('[pool-test] login:', JSON.stringify(await getQwenLoginStatus()));
  console.log('[pool-test] pool inicial:', JSON.stringify(getQwenPoolState()));

  const sampler = setInterval(() => {
    console.log('[pool-test] pool agora:', JSON.stringify(getQwenPoolState()));
  }, 2000);

  const chat = async (id: number) => {
    const started = Date.now();
    const result = await createQwenStream(
      `Responda apenas com o número ${id}, nada mais.`,
      false,
      'qwen3.8-max-no-thinking',
      null
    );
    const acquiredAt = Date.now() - started;
    const text = await consume(result.stream);
    const total = Date.now() - started;
    return { id, acquiredAt, total, session: result.uiSessionId?.slice(0, 8), text: text.slice(0, 160) };
  };

  const started = Date.now();
  const results = await Promise.all([1, 2, 3].map(chat));
  const elapsed = Date.now() - started;
  clearInterval(sampler);
  console.log('[pool-test] pool final:', JSON.stringify(getQwenPoolState()));
  for (const r of results) {
    console.log(`[pool-test] req#${r.id}: sessao=${r.session} adquiriu em ${r.acquiredAt}ms, total ${r.total}ms, amostra="${(r.text || '').replace(/\s+/g, ' ')}"`);
  }
  console.log(`[pool-test] 3 concorrentes (sessão própria) com 2 abas: ${elapsed}ms total`);
  await closeQwenPlaywright();
  console.log('[pool-test] finalizado');
}

main().catch((e) => {
  console.error('[pool-test] FAIL:', e.message);
  process.exit(1);
});
