import { initQwenPlaywright, getQwenBasicHeaders, getQwenLoginStatus, closeQwenPlaywright, getQwenHeaders, acquireQwenStreamPage, releaseQwenStreamPage } from '../../src/services/qwen-playwright.ts';
import { browserStreamFetch } from '../../src/services/stream-bridge.ts';
import { v4 as uuidv4 } from 'uuid';

async function consume(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function classifyModel(id: string, meta?: any): string {
  const m = id.toLowerCase().replace('-no-thinking', '');
  if (m.includes('coder')) return 'programacao';
  if (m.includes('math')) return 'matematica';
  if (m.includes('vl') || m.includes('vision') || m.includes('omni')) return 'visao';
  if (meta) {
    const caps = meta.capabilities || {};
    if (caps.vision && (meta.modality || []).includes('image')) return 'multimodal (visão)';
    if (caps.vision) return 'multimodal (visão)';
  }
  if (m.includes('max') || m.includes('plus')) return 'chat';
  return 'chat';
}

function capabilities(id: string, meta?: any): string[] {
  const m = id.toLowerCase();
  const caps: string[] = [];
  if (m.includes('-no-thinking')) caps.push('no-thinking');
  else caps.push('thinking');
  if (meta) {
    const capsMeta = meta.capabilities || {};
    const modality = meta.modality || [];
    if (capsMeta.vision || modality.includes('image')) caps.push('imagem');
    if (capsMeta.video || modality.includes('video')) caps.push('video');
    if (capsMeta.audio || modality.includes('audio')) caps.push('audio');
    if (capsMeta.search) caps.push('busca');
  }
  if (classifyModel(id) === 'programacao') caps.push('codigo');
  return caps;
}

async function fetchRawModels(): Promise<any[]> {
  const { cookie, userAgent, bxV } = await getQwenBasicHeaders();
  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': uuidv4(),
      'bx-v': bxV,
      'timezone': new Date().toString(),
      'source': 'web',
    },
  });
  if (!response.ok) {
    throw new Error(`Falha ao buscar modelos: ${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  return Array.isArray(json.data) ? json.data : [];
}

async function main() {
  console.log('[classify] inicializando playwright do Qwen...');
  await initQwenPlaywright(true);
  const status = await getQwenLoginStatus();
  console.log('[classify] login:', JSON.stringify(status));
  if (!status.loggedIn) {
    console.error('[classify] NÃO há sessão logada no Qwen. Faça login primeiro (npm start + botão Fazer login).');
    await closeQwenPlaywright();
    process.exit(1);
  }

  console.log('[classify] buscando modelos da API (com info)...');
  const raw = await fetchRawModels();
  console.log(`[classify] ${raw.length} modelo(s) retornado(s):`);
  for (const m of raw) {
    console.log(JSON.stringify({ id: m.id, owned_by: m.owned_by, info: m.info }, null, 2));
  }

  const baseIds = raw.map((m: any) => m.id);
  const uniq = [...new Set(baseIds)];
  const metaById = new Map<string, any>();
  for (const m of raw) metaById.set(m.id, m.info?.meta);

  console.log('\n=== CLASSIFICAÇÃO ===');
  for (const id of uniq) {
    const meta = metaById.get(id);
    console.log(`  ${id.padEnd(30)} -> ${classifyModel(id, meta).padEnd(20)} [${capabilities(id, meta).join(', ')}]`);
  }
  console.log(`  ${'<qualquer>-no-thinking'.padEnd(30)} -> variante sem raciocínio do modelo base`);

  console.log('\n=== TESTE DE CHAT (resposta deve conter o número pedido) ===');
  const { headers, chatSessionId } = await getQwenHeaders();
  if (!chatSessionId) {
    console.error('[classify] Sem chat_id do handshake. Não é possível testar.');
    await closeQwenPlaywright();
    process.exit(1);
  }
  const tz = new Date().toString().split(' (')[0];

  /** Extrai reasoning + resposta final do SSE cru do Qwen. */
  function parseSse(text: string): { reasoning: string, answer: string } {
    let reasoning = '';
    let answer = '';
    let lastFull = '';
    let thoughtIdx = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const data = t.slice(6);
      if (data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.phase === 'thinking_summary') {
          const thoughts = delta.extra?.summary_thought?.content;
          if (Array.isArray(thoughts) && thoughts.length > thoughtIdx) {
            reasoning += thoughts.slice(thoughtIdx).join('\n');
            thoughtIdx = thoughts.length;
          }
        } else if (delta.phase === 'answer' && delta.content !== undefined) {
          const c = delta.content || '';
          if (c.startsWith(lastFull)) {
            answer += c.slice(lastFull.length);
            lastFull = c;
          } else {
            answer += c;
            lastFull = c;
          }
        }
      } catch {
        // ignora chunk parcial
      }
    }
    return { reasoning, answer };
  }

  const buildPayload = (model: string, enableThinking: boolean) => {
    const ts = Math.floor(Date.now() / 1000);
    const fid = uuidv4();
    return {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatSessionId,
      chat_mode: 'normal',
      model,
      parent_id: null,
      messages: [{
        fid,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: 'Responda apenas com o número 7, nada mais.',
        user_action: 'chat',
        files: [],
        timestamp: ts,
        models: [model],
        chat_type: 't2t',
        feature_config: { thinking_enabled: enableThinking, output_schema: 'phase', research_mode: 'normal', auto_thinking: false, thinking_mode: 'Thinking', thinking_format: 'summary', auto_search: false },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: null,
      }],
      timestamp: ts + 1,
    };
  };

  const sendOnce = async (id: string, hdrs: Record<string, string>, sessionId: string): Promise<{ status: number, contentType: string, reasoning: string, answer: string, rawBody: string }> => {
    const model = id.replace('-no-thinking', '');
    const enableThinking = !id.includes('-no-thinking');
    const page = await acquireQwenStreamPage();
    try {
      const res = await browserStreamFetch(page, `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${sessionId}`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'timezone': tz,
          'version': '0.2.66',
          'x-accel-buffering': 'no',
          'x-request-id': uuidv4(),
          'bx-v': hdrs['bx-v'] || '',
          'bx-ua': hdrs['bx-ua'] || '',
          'bx-umidtoken': hdrs['bx-umidtoken'] || '',
          'source': 'web',
        },
        body: JSON.stringify(buildPayload(model, enableThinking)),
      });
      if (res.contentType.includes('text/event-stream')) {
        const raw = await consume(res.stream);
        const { reasoning, answer } = parseSse(raw);
        return { status: res.status, contentType: res.contentType, reasoning, answer, rawBody: '' };
      }
      let body = res.body;
      if (res.stream) {
        const reader = res.stream.getReader();
        let out = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out += new TextDecoder().decode(value);
        }
        body = out;
      }
      return { status: res.status, contentType: res.contentType, reasoning: '', answer: '', rawBody: body.slice(0, 300) };
    } finally {
      releaseQwenStreamPage(page);
    }
  };

  const testModel = async (id: string): Promise<{ id: string, status: number, ok: boolean, hasThinking: boolean, answer: string, note?: string }> => {
    let result = await sendOnce(id, headers, chatSessionId).catch((e: any) => {
      return { status: 0, contentType: 'error', reasoning: '', answer: '', rawBody: e.message };
    });

    // Retry com headers/sessão novos quando vier erro de validação, "200 vazio" (WAF) ou desafio TMD.
    if (result.status === 0 || (result.status >= 200 && result.status < 300 && !result.contentType.includes('event-stream'))) {
      console.log(`    ${id}: resposta não-SSE (${JSON.stringify(result.rawBody.slice(0, 120))}), tentando com headers/sessão novos...`);
      await new Promise((r) => setTimeout(r, 1000));
      const { headers: fresh, chatSessionId: freshSession } = await getQwenHeaders(true);
      result = await sendOnce(id, fresh, freshSession).catch((e: any) => {
        return { status: 0, contentType: 'error', reasoning: '', answer: '', rawBody: e.message };
      });
    }

    const ok = result.contentType.includes('event-stream') && result.answer.trim().length > 0;
    return {
      id,
      status: result.status,
      ok,
      hasThinking: result.reasoning.trim().length > 0,
      answer: (result.answer || '').replace(/\s+/g, ' ').slice(0, 80),
      note: !ok && result.status === 0 ? `erro: ${result.rawBody}` : (!ok ? `body="${result.rawBody.slice(0, 80)}"` : undefined),
    };
  };

  // Testa uma vez cada modelo base (sem testar cada -no-thinking duplicado).
  const toTest = uniq.filter((id) => {
    const cleanId = id.replace('-no-thinking', '');
    return !(uniq.includes(cleanId) && cleanId !== id);
  });
  for (const fallback of ['qwen3.8-max', 'qwen3.6-plus']) {
    if (!uniq.includes(fallback)) toTest.push(fallback);
  }

  for (const id of toTest) {
    const r = await testModel(id);
    console.log(
      `  ${r.id.padEnd(30)} status=${String(r.status).padEnd(4)} ${r.ok ? 'OK  ' : 'FAIL'} thinking=${r.hasThinking ? 'sim' : 'nao '} resposta="${r.answer || '(vazia)'}"${r.note ? ' ' + r.note : ''}`
    );
  }

  await closeQwenPlaywright();
  console.log('[classify] finalizado');
}

main().catch((e) => {
  console.error('[classify] FAIL:', e.message);
  process.exit(1);
});
