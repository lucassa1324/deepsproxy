import { initQwenPlaywright, closeQwenPlaywright, getQwenHeaders } from '../src/services/qwen-playwright.ts';

async function main() {
  await initQwenPlaywright(true);
  const { headers, chatSessionId, parentMessageId } = await getQwenHeaders();
  console.log('chatSessionId:', chatSessionId, 'parent:', parentMessageId);

  const timestamp = Math.floor(Date.now() / 1000);
  const model = 'qwen3.8-max';
  const payload: any = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatSessionId,
    chat_mode: 'normal',
    model,
    parent_id: parentMessageId,
    messages: [{
      fid: 'fid-' + timestamp,
      parentId: parentMessageId,
      childrenIds: [],
      role: 'user',
      content: 'Qual é a capital do Brasil? Responda em uma palavra.',
      user_action: 'chat',
      files: [],
      timestamp,
      models: [model],
      chat_type: 't2t',
      feature_config: {
        thinking_enabled: true,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: false,
        thinking_mode: 'Thinking',
        thinking_format: 'summary',
        auto_search: true
      },
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: parentMessageId
    }],
    timestamp: timestamp + 1
  };

  const res = await fetch(`https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatSessionId}`, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'cookie': headers['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': `https://chat.qwen.ai/c/${chatSessionId}`,
      'user-agent': headers['user-agent'],
      'x-request-id': 'req-' + timestamp,
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v']
    },
    body: JSON.stringify(payload)
  });
  console.log('HTTP status:', res.status, res.statusText);
  console.log('content-type:', res.headers.get('content-type'));
  const text = await res.text();
  console.log('BODY RAW:', JSON.stringify(text.slice(0, 1500)));
  await closeQwenPlaywright();
}

main().catch((e) => { console.error('RAW FAIL:', e.message); process.exit(1); });
