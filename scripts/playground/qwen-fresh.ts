process.env.QWEN_POOL_SIZE = '2';

import { initQwenPlaywright, acquireQwenStreamPage, releaseQwenStreamPage, getQwenHeaders, closeQwenPlaywright } from '../../src/services/qwen-playwright.ts';
import { browserStreamFetch } from '../../src/services/stream-bridge.ts';
import { v4 as uuidv4 } from 'uuid';

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

function buildPayload(prompt: string, chatId: string | null): any {
  const ts = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model: 'qwen3.8-max',
    parent_id: null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: ts,
        models: ['qwen3.8-max'],
        chat_type: 't2t',
        feature_config: { thinking_enabled: false, output_schema: 'phase', research_mode: 'normal', auto_thinking: false, thinking_mode: 'Thinking', thinking_format: 'summary', auto_search: true },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: null,
      },
    ],
    timestamp: ts + 1,
  };
}

async function main() {
  console.log('[fresh-test] inicializando...');
  await initQwenPlaywright(true);
  const { headers, chatSessionId } = await getQwenHeaders(false);
  const tz = new Date().toString().split(' (')[0];
  if (!chatSessionId) {
    console.error('[fresh-test] Sem chat_id do handshake. A API atual do Qwen exige chat_id (RequestValidationError sem ele).');
    await closeQwenPlaywright();
    process.exit(1);
  }

  const chat = async (id: number) => {
    const started = Date.now();
    const page = await acquireQwenStreamPage();
    try {
      const payload = buildPayload(`Responda apenas com o número ${id}, nada mais.`, chatSessionId);
      const res = await browserStreamFetch(page, `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatSessionId}`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'timezone': tz,
          'version': '0.2.66',
          'x-accel-buffering': 'no',
          'x-request-id': uuidv4(),
          'bx-v': headers['bx-v'] || '',
          'bx-ua': headers['bx-ua'] || '',
          'bx-umidtoken': headers['bx-umidtoken'] || '',
          'source': 'web',
        },
        body: JSON.stringify(payload),
      });
      const isSse = res.contentType.includes('text/event-stream');
      const text = isSse ? await consume(res.stream) : (res.body || '');
      return { id, status: res.status, isSse, elapsed: Date.now() - started, text: text.slice(0, 200) };
    } finally {
      releaseQwenStreamPage(page);
    }
  };

  const started = Date.now();
  const results = await Promise.all([1, 2].map(chat));
  console.log(`[fresh-test] 2 concorrentes com chat_id=${chatSessionId.slice(0, 8)}...: ${Date.now() - started}ms`);
  for (const r of results) {
    console.log(`[fresh-test] req#${r.id}: status=${r.status} sse=${r.isSse} ${r.elapsed}ms amostra="${(r.text || '').replace(/\s+/g, ' ')}"`);
  }
  await closeQwenPlaywright();
  console.log('[fresh-test] finalizado');
}

main().catch((e) => {
  console.error('[fresh-test] FAIL:', e.message);
  process.exit(1);
});
