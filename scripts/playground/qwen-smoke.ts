import { initQwenPlaywright, getQwenLoginStatus, closeQwenPlaywright } from '../src/services/qwen-playwright.ts';
import { app } from '../src/index.ts';

async function main() {
  console.log('[smoke] inicializando playwright do Qwen...');
  await initQwenPlaywright(true);

  const status = await getQwenLoginStatus();
  console.log('[smoke] login status:', JSON.stringify(status));

  for (const model of ['qwen3.8-max-no-thinking', 'qwen3.8-max']) {
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Qual é a capital do Brasil? Responda em uma palavra.' }],
          stream: false,
        }),
      })
    );
    const text = await res.text();
    console.log(`[smoke] chat status (${model}):`, res.status);
    console.log(`[smoke] chat body (${model}):`, text.slice(0, 1200));
  }

  await closeQwenPlaywright();
  console.log('[smoke] finalizado');
}

main().catch((e) => {
  console.error('[smoke] FAIL:', e.message);
  process.exit(1);
});
