import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import {
  computeTextDelta,
  createGeminiWebStream,
  consumeGeminiWebStream,
  FakeGeminiPage,
  geminiSetPromptScript,
  smartTruncateHistory,
  buildGeminiWebPrompt,
  GEMINI_SCRIPT_SET_PROMPT,
  GEMINI_SCRIPT_CLICK_SEND,
  GEMINI_SCRIPT_READ_RESPONSE,
  GEMINI_SCRIPT_READ_COMPOSER,
  FALLBACK_TOOLS_CONTRACT,
  setMockGeminiPage,
} from './services/gemini-web.ts';
import { buildFullHistoryPrompt, buildToolsInstructions } from './utils/prompt.ts';
import { repairUnescapedQuotes, robustParseJSON, sanitizeModelBackslashes } from './utils/robust-json.ts';
import { parseToolCallsFromContent } from './tools/executor.ts';
import { StreamingToolParser } from './tools/stream-parser.ts';
import {
  resetToolLoopBreaker,
  isToolLoopTripped,
  ANTI_LAZY_RETRY_MESSAGE,
} from './middlewares/anti-lazy.ts';
import { toolCallSignature } from './services/relay-path.ts';
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
  assert.ok(GEMINI_SCRIPT_READ_COMPOSER.includes('__GEMINI_READ_COMPOSER__'));
  // Regressão: esbuild/tsx injeta __name() em funções nomeadas — o script tem
  // que ser string pura, sem referência ao helper do Node (quebra no browser).
  assert.ok(!GEMINI_SCRIPT_SET_PROMPT.includes('__name'));
  // Regressão: Playwright não liga `arg` a strings no evaluate (isFunction=false
  // → eval() puro). O prompt NÃO pode referenciar `arg`; vai embutido no script.
  assert.ok(!GEMINI_SCRIPT_SET_PROMPT.includes('const prompt = arg'));
});

test('gemini-web: geminiSetPromptScript embute o prompt no script sem token residual', () => {
  const prompt = 'olá "mundo" \\ e {novo}\nsegunda linha';
  const script = geminiSetPromptScript(prompt);

  assert.ok(script.includes('__GEMINI_SET_PROMPT__'), 'marker deve continuar presente');
  assert.ok(!script.includes('__GEMINI_PROMPT_ARG__'), 'placeholder deve ser substituído');
  assert.ok(script.includes(JSON.stringify(prompt)), 'JSON do prompt deve estar no script');
  // O que o fake extrai via regex deve devolver o prompt exato.
  const m = script.match(/const prompt = ("[\s\S]*?");/);
  assert.ok(m, 'deve casar a linha const prompt');
  assert.strictEqual(JSON.parse(m[1]), prompt);
});

test('gemini-web: geminiSetPromptScript NÃO corrompe prompt com padrões $ (SyntaxError fix)', () => {
  // `$&` e `$'` dentro do prompt ativam a substituição de padrões do
  // String.replace — o bug antigo (`replace(marker, json)`) injetava o resto do
  // script DENTRO do literal e o fade quebrava com "Invalid or unexpected token".
  const prompt = "use $& aqui e $' acolá com ${bar} e \"aspas\", crase ` e C:\\tmp\\rel";
  const script = geminiSetPromptScript(prompt);

  assert.ok(!script.includes('__GEMINI_PROMPT_ARG__'), 'placeholder deve ser substituído');
  // Script resultante tem que continuar 100% parseável como JS.
  assert.doesNotThrow(() => new Function(script), 'script deve continuar válido');
  // Round-trip do fake: o JSON embutido deve recuparar o prompt EXATO.
  const m = script.match(/const prompt = ("[\s\S]*?");/);
  assert.ok(m, 'deve casar a linha const prompt');
  assert.strictEqual(JSON.parse(m[1]), prompt);
});

test('gemini-web: geminiSetPromptScript escapa U+2028/U+2029 no prompt', () => {
  const prompt = 'linha um\u2028linha dois\u2029fim';
  const script = geminiSetPromptScript(prompt);
  assert.doesNotThrow(() => new Function(script), 'script não pode ter separador de linha cru');
  const m = script.match(/const prompt = ("[\s\S]*?");/);
  assert.ok(m, 'deve casar a linha const prompt');
  assert.strictEqual(JSON.parse(m[1]), prompt);
});

/* ------------------------- Teto de segurança ------------------------- */

test('gemini-web: smartTruncateHistory mantém system + turno atual e corta o miolo', () => {
  const big = 'x'.repeat(2000);
  const messages: any[] = [
    { role: 'system', content: 'INSTRUCOES DA IDE - formato de diff obrigatorio' },
  ];
  for (let i = 0; i < 45; i++) {
    messages.push({ role: 'user', content: `msg ${i}: ` + big });
    messages.push({ role: 'assistant', content: `resp ${i}` });
  }
  const body = { model: 'gemini-3-flash', messages, stream: false } as any;

  const out = smartTruncateHistory(body, 80000);
  const prompt = buildFullHistoryPrompt(out);

  assert.ok(out.messages.length < messages.length, 'deve ter cortado o histórico');
  assert.strictEqual(out.messages[0].role, 'system', 'system prompt preservado no início');
  assert.strictEqual(out.messages[0].content, messages[0].content, 'conteúdo do system intacto');
  const lastMsg = out.messages[out.messages.length - 1];
  assert.strictEqual(lastMsg.content, messages[messages.length - 1].content, 'turno atual preservado');
  assert.ok(prompt.length <= 80000, `prompt deve caber no teto (${prompt.length} chars)`);
});

test('gemini-web: smartTruncateHistory devolve o body inalterado quando já cabe', () => {
  const body = {
    model: 'gemini-3-flash',
    messages: [
      { role: 'system', content: 'oi' },
      { role: 'user', content: 'tudo bem?' },
    ],
  } as any;
  const out = smartTruncateHistory(body, 80000);
  assert.strictEqual(out, body, 'sem cópia quando não há corte');
  assert.strictEqual(out.messages.length, 2);
});

test('gemini-web: smartTruncateHistory preserva a última pergunta do usuário mesmo com tool depois', () => {
  const big = 'y'.repeat(4000);
  const messages: any[] = [{ role: 'system', content: 'INSTRUCOES DA IDE' }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: `msg ${i}: ` + big });
    messages.push({ role: 'assistant', content: `resp ${i}` });
  }
  messages.push({ role: 'user', content: 'Você pode me responder em português?' });
  messages.push({ role: 'tool', tool_call_id: 'tc', name: 'read_file', content: big + big });

  const out = smartTruncateHistory({ model: 'x', messages } as any, 80000);
  const prompt = buildFullHistoryPrompt(out);

  assert.ok(out.messages.length < messages.length, 'deve ter cortado o histórico');
  assert.ok(prompt.includes('Você pode me responder em português?'), 'pergunta do usuário preservada');
  const idxQuestion = prompt.lastIndexOf('Você pode me responder em português?');
  const idxTool = prompt.lastIndexOf('Tool Response (read_file)');
  assert.ok(idxQuestion >= 0 && idxQuestion < idxTool, 'pergunta vem antes do tool result');
  assert.strictEqual(out.messages[0].role, 'system', 'system preservado');
});

test('gemini-web: smartTruncateHistory trunca conteúdo (não descarta) quando a última mensagem é gigante', () => {
  const huge = 'z'.repeat(200_000);
  const messages: any[] = [
    { role: 'system', content: 'INSTRUCOES DA IDE' },
    { role: 'user', content: 'Você pode me responder em português?\n' + huge },
  ];
  const out = smartTruncateHistory({ model: 'x', messages } as any, 80000);
  const prompt = buildFullHistoryPrompt(out);

  assert.ok(prompt.includes('Você pode me responder em português?'), 'instrução visível preservada');
  assert.ok(prompt.includes('truncado'), 'conteúdo foi truncado internamente');
  assert.ok(prompt.length < 200_000, `não pode reenviar os 200k chars (${prompt.length})`);
  assert.strictEqual(out.messages.length, 2, 'as duas mensagens permanecem (system + user)');
});

/* ------------------------- Teto real do composer ------------------------- */

test('gemini-web: buildGeminiWebPrompt mantém o prompt intacto quando cabe no teto', () => {
  const body = {
    model: 'gemini-3-pro',
    messages: [
      { role: 'system', content: 'INSTRUCOES DA IDE' },
      { role: 'user', content: 'primeiro' },
      { role: 'assistant', content: 'anterior' },
      { role: 'user', content: 'você pode gerar um exemplo de js?' },
    ],
  } as any;

  const prompt = buildGeminiWebPrompt(body, 30000);

  // Sem tools do cliente, o contrato fallback entra para o modelo não narrar
  // ("Criei o arquivo...") sem criar o arquivo de fato.
  assert.ok(prompt.includes('# TOOLS AVAILABLE'), 'contrato fallback presente sem tools do cliente');
  assert.ok(prompt.includes('você pode gerar um exemplo de js?'), 'pergunta no prompt');
  assert.ok(prompt.length < 30000);
});

test('gemini-web: buildGeminiWebPrompt capa o system gigante e preserva a pergunta do usuário no fim', () => {
  const hugeSystem = 'S'.repeat(70_000);
  const body = {
    model: 'gemini-3-pro',
    messages: [
      { role: 'system', content: hugeSystem },
      { role: 'user', content: 'voce tambem consegue gerar exemplo de js?' },
    ],
  } as any;

  const prompt = buildGeminiWebPrompt(body, 30000);

  assert.ok(prompt.length <= 30000, `prompt ${prompt.length} chars deve caber no composer`);
  assert.ok(prompt.endsWith('voce tambem consegue gerar exemplo de js?'), 'pergunta no FIM do prompt');
  assert.ok(prompt.startsWith('S'), 'cabeça do system prompt preservada (persona)');
  assert.ok(!prompt.includes(hugeSystem), 'system não pode estar inteiro (70k > 30k)');
});

test('gemini-web: buildGeminiWebPrompt prioriza a cauda da conversa sobre o miolo', () => {
  const big = 'H'.repeat(3000);
  const messages: any[] = [
    { role: 'system', content: 'INSTRUCOES DA IDE' },
    { role: 'user', content: 'msg inicial antiga: ' + big },
    { role: 'assistant', content: 'resposta antiga' },
  ];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `turno ${i}: ${big}` });
    messages.push({ role: 'assistant', content: `resposta ${i}` });
  }
  messages.push({ role: 'user', content: 'ÚLTIMA PERGUNTA DO USUÁRIO' });

  const prompt = buildGeminiWebPrompt({ model: 'gemini-3-pro', messages } as any, 30000);

  assert.ok(prompt.length <= 30000, `prompt ${prompt.length} chars deve caber`);
  assert.ok(prompt.endsWith('ÚLTIMA PERGUNTA DO USUÁRIO'), 'pergunta atual preservada no fim');
  assert.ok(prompt.includes('INSTRUCOES DA IDE'), 'system head preservado');
  assert.ok(!prompt.includes('msg inicial antiga'), 'miolo antigo descartado');
});

test('gemini-web: buildGeminiWebPrompt entra com tools quando há orçamento', () => {
  const hugeSystem = 'S'.repeat(10_000);
  const body: any = {
    model: 'gemini-3-pro',
    messages: [{ role: 'system', content: hugeSystem }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Lê um arquivo',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ],
  };

  const prompt = buildGeminiWebPrompt(body, 30000);
  assert.ok(prompt.length <= 30000);
  assert.ok(prompt.includes('read_file'), 'ferramenta presente quando cabe');
  assert.ok(prompt.includes('# TOOLS AVAILABLE'));
});

test('gemini-web: truncamento de tools preserva o formato <tool_call> e os nomes', () => {
  // Muitas tools com schemas grandes forçam o corte do bloco de tools —
  // a CABEÇA (formato + regras + nomes) tem que sobreviver. Mesmo com a
  // minificação (descrições removidas), este volume estoura o orçamento.
  const tools: any[] = [];
  for (let i = 0; i < 30; i++) {
    const props: any = {};
    for (let j = 0; j < 30; j++) props[`prop${j}`] = { type: 'string', description: 'x'.repeat(80) };
    tools.push({
      type: 'function',
      function: { name: `Tool${i}`, description: 'y'.repeat(120), parameters: { type: 'object', properties: props } },
    });
  }
  const body: any = {
    model: 'gemini-3-pro',
    messages: [
      { role: 'system', content: 'INSTRUCOES DA IDE' },
      { role: 'user', content: 'faça um arquivo de exemplo html' },
    ],
    tools,
  };

  const prompt = buildGeminiWebPrompt(body, 30000);
  assert.ok(prompt.length <= 30000, `prompt ${prompt.length} chars deve caber`);
  assert.ok(
    prompt.includes('<tool_call>') && prompt.includes('</tool_call>'),
    'formato de chamada preservado mesmo com tools truncadas'
  );
  assert.ok(prompt.includes('- Tool0'), 'nomes das tools visíveis');
  assert.ok(prompt.includes('…(schemas de mais ferramentas omitidos)'), 'marcador de truncamento presente');
  assert.ok(prompt.endsWith('faça um arquivo de exemplo html'), 'pergunta preservada no fim');
});

test('utils: buildToolsInstructions coloca formato <tool_call> ANTES dos schemas', () => {
  const body: any = {
    messages: [],
    tools: [
      {
        type: 'function',
        function: { name: 'Write', description: 'cria arquivo', parameters: { type: 'object' } },
      },
    ],
  };
  const block = buildToolsInstructions(body);
  const formatIdx = block.indexOf('<tool_call>');
  const schemasIdx = block.indexOf('Detailed schemas');
  assert.ok(formatIdx > 0, 'formato presente');
  assert.ok(schemasIdx > 0, 'seção de schemas presente');
  assert.ok(formatIdx < schemasIdx, 'formato vem ANTES dos schemas (sobrevive ao corte)');
  assert.ok(block.includes('- Write'));
  assert.ok(
    block.toLowerCase().includes('same language as the user'),
    'instrução de idioma presente (evita respostas em inglês quando o usuário fala português)'
  );
});

test('utils: FALLBACK_TOOLS_CONTRACT instrui responder no idioma do usuário', () => {
  const contract = FALLBACK_TOOLS_CONTRACT;
  assert.ok(
    contract.toLowerCase().includes('same language as the user'),
    'contrato fallback também instrui responder no idioma do usuário'
  );
});

test('utils: StreamingToolParser flush descarta tool call truncada sem argumentos', () => {
  // Reprodução do log real: o Gemini Web parou no meio de um <tool_call> do Read
  // (sem fechar `}`). Não deve vazar o <tool_call> cru como texto nem emitir a
  // ferramenta com argumentos vazios (Read com file_path "").
  const parser = new StreamingToolParser();
  parser.feed('<tool_call>\n{"name": "Read", "arguments": {"file_path":');
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 0, 'tool call truncada não vira tool_calls');
  assert.strictEqual(flushed.text, '', 'fragmento quebrado não vaza como texto');
});

test('utils: buildToolsInstructions reordena tools por criticidade e minifica schemas', () => {
  const body: any = {
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'NotifyUser',
          description: 'notifica o usuário',
          parameters: { type: 'object', properties: { msg: { type: 'string', description: 'mensagem' } } },
        },
      },
      {
        type: 'function',
        function: {
          name: 'Write',
          description: 'cria arquivo',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'caminho do arquivo' },
              content: { type: 'string', description: 'conteúdo' },
            },
            required: ['file_path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'WebSearch',
          description: 'busca na web',
          parameters: { type: 'object', properties: { q: { type: 'string', description: 'consulta' } } },
        },
      },
    ],
  };
  const block = buildToolsInstructions(body);
  assert.ok(block.indexOf('- Write') < block.indexOf('- NotifyUser'), 'Write antes de NotifyUser');
  assert.ok(block.indexOf('- Write') < block.indexOf('- WebSearch'), 'Write antes de WebSearch');
  assert.ok(!block.includes('caminho do arquivo'), 'descrição de propriedade removida (minificação)');
  assert.ok(block.includes('"file_path"') && block.includes('"content"'), 'tipos/campos obrigatórios preservados');
  assert.ok(block.includes('escape the inner double quotes'), 'regra de escape presente');
});

test('gemini-web: tool call com HTML grande e aspas internas é parseado (non-streaming)', async () => {
  const fake = new FakeGeminiPage();
  const html = [
    '<!DOCTYPE html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="UTF-8"/>',
    '<title>Exemplo</title>',
    '</head>',
    '<body>',
    '<p class="destaque" data-id="1">Olá</p>',
    '</body>',
    '</html>',
  ].join('\n');
  fake.responseFrames = [`<tool_call>{"name": "Write", "arguments": {"file_path": "exemplo.html", "content": "${html}"}}</tool_call>`];
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
        messages: [{ role: 'user', content: 'faça um arquivo de exemplo html' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(data.choices[0].message.tool_calls.length, 1);
    assert.strictEqual(data.choices[0].message.tool_calls[0].function.name, 'Write');
    const args = JSON.parse(data.choices[0].message.tool_calls[0].function.arguments);
    assert.strictEqual(args.file_path, 'exemplo.html');
    assert.strictEqual(args.content, html, 'HTML com múltiplas aspas internas preservado');
  } finally {
    setMockGeminiPage(null);
    restore();
  }
});

test('utils: StreamingToolParser extrai tool call com aspas internas não escapadas', () => {
  const parser = new StreamingToolParser();
  const html = '<html lang="pt-BR"><head><meta charSet="UTF-8"/></head><body></body></html>';
  const call = `<tool_call>{"name": "Write", "arguments": {"file_path": "exemplo.html", "content": "${html}"}}</tool_call>`;
  const chunk1 = call.slice(0, 40);
  const chunk2 = call.slice(40);

  const first = parser.feed(chunk1);
  const second = parser.feed(chunk2);
  const flushed = parser.flush();

  const all = [...first.toolCalls, ...second.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(all.length, 1, 'tool call extraída mesmo com aspas internas não escapadas');
  assert.strictEqual(all[0].name, 'Write');
  assert.strictEqual(all[0].arguments.file_path, 'exemplo.html');
  assert.strictEqual(all[0].arguments.content, html);
});

test('utils: sanitizeModelBackslashes corrige path do Windows preservando escapes válidos', () => {
  const raw = '{"file_path": "c:\\Users\\Lucas\\exemplo.html", "content": "a\\nb\\"c\\"\\u00e9\\n"}';
  const out = sanitizeModelBackslashes(raw);
  assert.strictEqual(out.includes('c:\\\\Users\\\\Lucas\\\\exemplo.html'), true, 'barras do path dobradas');
  assert.strictEqual(out.includes('a\\nb'), true, '\\n preservado');
  assert.strictEqual(out.includes('b\\"c\\"'), true, '\\" preservado');
  assert.strictEqual(out.includes('\\u00e9'), true, '\\uXXXX preservado');
});

test('utils: robustParseJSON lida com o payload real do log (path Windows + HTML com aspas sem escape)', () => {
  // Reprodução fiel do que o Gemini emitiu: file_path com \U, \L, \D, \p sem
  // escape + content com aspas de atributos HTML sem escape e \n literais.
  const raw =
    '{"name": "Write", "arguments": {"file_path": "c:\\Users\\Lucas sá\\Documents\\Programação\\deepsproxy\\deepsproxy\\exemplo.html", ' +
    '"content": "\\n<html lang="pt-BR">\\n\\n    <meta charset="UTF-8">\\n    <div class="card">\\n' +
    '        <button id="meuBotao">Clique em mim\\n    \\n    \\n\\n"}}';

  const parsed = robustParseJSON(raw);
  assert.ok(parsed, 'deve parsear');
  assert.strictEqual(parsed.name, 'Write');
  assert.strictEqual(parsed.arguments.file_path, 'c:\\Users\\Lucas sá\\Documents\\Programação\\deepsproxy\\deepsproxy\\exemplo.html');
  assert.ok(parsed.arguments.content.includes('<html lang="pt-BR">'), 'HTML preservado');
  assert.ok(parsed.arguments.content.includes('id="meuBotao"'), 'aspas internas preservadas');
  assert.ok(parsed.arguments.content.includes('\n'), '\\n do modelo virou quebra real após o parse');
});

test('utils: robustParseJSON recupera tool call com Dockerfile e aspas internas em content antes de file_path', () => {
  // Reprodução do log real: o Gemini emitiu o Write com o conteúdo do Dockerfile
  // contendo `CMD ["npm", "start"]` com aspas NÃO escapadas e content ANTES de
  // file_path — caso em que repairUnescapedQuotes não desambigua e a recuperação
  // por regex precisa extrair content como texto livre.
  const dockerfile =
    'FROM mcr.microsoft.com/playwright:v1.40.0-jammy\n' +
    '\n' +
    'WORKDIR /app\n' +
    '\n' +
    'COPY package*.json ./\n' +
    'RUN npm install\n' +
    '\n' +
    'COPY . .\n' +
    '\n' +
    'EXPOSE 7860\n' +
    '\n' +
    'ENV PORT=7860\n' +
    'CMD ["npm", "start"]\n';
  const raw = `{"name": "Write", "arguments": {"content": "${dockerfile}", "file_path": "Dockerfile"}}`;

  const parsed = robustParseJSON(raw);
  assert.ok(parsed, 'deve recuperar a tool call via regex');
  assert.strictEqual(parsed.name, 'Write');
  assert.strictEqual(parsed.arguments.file_path, 'Dockerfile');
  assert.ok(
    parsed.arguments.content.includes('CMD ["npm", "start"]'),
    'conteúdo com aspas internas preservado'
  );
  assert.ok(
    parsed.arguments.content.includes('FROM mcr.microsoft.com/playwright'),
    'conteúdo completo preservado'
  );
});

test('utils: robustParseJSON recupera tool call com content após file_path e aspas internas', () => {
  const html = '<div class="card"><button id="btn">OK</button></div>';
  const raw = `{"name": "Write", "arguments": {"file_path": "index.html", "content": "${html}"}}`;

  const parsed = robustParseJSON(raw);
  assert.ok(parsed, 'deve recuperar a tool call');
  assert.strictEqual(parsed.name, 'Write');
  assert.strictEqual(parsed.arguments.file_path, 'index.html');
  assert.strictEqual(parsed.arguments.content, html, 'HTML com aspas internas preservado');
});

test('utils: sanitizeModelBackslashes não corrompe escapes duplos válidos (JSON válido passa intacto)', () => {
  // `\\U` é `\` escapado + U literal — JSON VÁLIDO. O sanitize não pode
  // transformar em `\\\U` (regressão: regex simples quebrava isso).
  const raw = '{"name": "Write", "arguments": {"file_path": "c:\\\\Users\\\\x\\\\a.html", "content": "oi"}}';
  const parsed = robustParseJSON(raw);
  assert.ok(parsed);
  assert.strictEqual(parsed.name, 'Write');
  assert.strictEqual(parsed.arguments.file_path, 'c:\\Users\\x\\a.html');
  assert.strictEqual(parsed.arguments.content, 'oi');
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
        const m = String(src).match(/const prompt = ("[\s\S]*?");/);
        prompt = m ? JSON.parse(m[1]) : String(arg ?? '');
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

test('gemini-web: composer incompleto (fim do prompt não registrado) é detectado e o turno segue', async () => {
  const customPage = {
    evaluate: async (fn: Function, arg?: unknown) => {
      const src = String(fn);
      if (src.includes('__GEMINI_GO_NEW_CHAT__')) return 'https://gemini.google.com/app';
      if (src.includes('__GEMINI_DISMISS_ONBOARDING__')) return true;
      if (src.includes('__GEMINI_SET_PROMPT__')) return true;
      if (src.includes('__GEMINI_READ_COMPOSER__')) return { length: 80, tail: '...pergunta do usuário (CORTADA)' };
      if (src.includes('__GEMINI_CLICK_SEND__')) return true;
      if (src.includes('__GEMINI_READ_RESPONSE__')) return { text: 'resposta do gemini', hasStop: false };
      return undefined;
    },
    waitForTimeout: async () => {},
    isClosed: () => false,
  };

  const stream = await createGeminiWebStream(customPage as any, 'pergunta longa que deveria caber inteira'.repeat(10), {
    pollIntervalMs: 1,
    stablePolls: 2,
  });
  const { text } = await consumeGeminiWebStream(stream);
  assert.strictEqual(text, 'resposta do gemini');
});

test('gemini-web: composer completo (length === prompt) não dispara o caminho de incompleto', async () => {
  const prompt = 'quem é você?';
  const customPage = {
    evaluate: async (fn: Function, arg?: unknown) => {
      const src = String(fn);
      if (src.includes('__GEMINI_GO_NEW_CHAT__')) return 'https://gemini.google.com/app';
      if (src.includes('__GEMINI_DISMISS_ONBOARDING__')) return true;
      if (src.includes('__GEMINI_SET_PROMPT__')) return true;
      if (src.includes('__GEMINI_READ_COMPOSER__')) return { length: prompt.length, tail: prompt };
      if (src.includes('__GEMINI_CLICK_SEND__')) return true;
      if (src.includes('__GEMINI_READ_RESPONSE__')) return { text: 'oi!', hasStop: false };
      return undefined;
    },
    waitForTimeout: async () => {},
    isClosed: () => false,
  };

  const stream = await createGeminiWebStream(customPage as any, prompt, { pollIntervalMs: 1, stablePolls: 2 });
  const { text } = await consumeGeminiWebStream(stream);
  assert.strictEqual(text, 'oi!');
});

test('gemini-web: pausa longa no meio de resposta grande não trunca (estabilidade adaptativa)', async () => {
  const part1 = 'A'.repeat(4000);
  const part2 = 'B'.repeat(3000);
  const phase = { text: part1, readCount: 0 };

  const customPage = {
    evaluate: async (fn: Function, arg?: unknown) => {
      const src = String(fn);
      if (src.includes('__GEMINI_GO_NEW_CHAT__')) return 'https://gemini.google.com/app';
      if (src.includes('__GEMINI_DISMISS_ONBOARDING__')) return true;
      if (src.includes('__GEMINI_SET_PROMPT__')) return true;
      if (src.includes('__GEMINI_CLICK_SEND__')) return true;
      if (src.includes('__GEMINI_READ_RESPONSE__')) {
        phase.readCount++;
        // 8 polls de pausa (~400ms a 50ms/poll), abaixo do teto de ~12 polls
        // exigido para 4k chars. Com o teto fixo antigo (4 polls) a resposta
        // seria cortada aqui; com o adaptativo ela segue e recebe a parte 2.
        if (phase.readCount > 8) phase.text = part1 + part2;
        return { text: phase.text, hasStop: false };
      }
      return undefined;
    },
    waitForTimeout: async () => {},
    isClosed: () => false,
  };

  const stream = await createGeminiWebStream(customPage as any, 'gere 3 artes longas', { pollIntervalMs: 50 });
  const { text } = await consumeGeminiWebStream(stream);
  assert.strictEqual(text, part1 + part2);
});

/* ------------------------- Cancelamento (cliente pausou) ------------------------- */

test('gemini-web: abortSignal já abortado encerra o turno sem digitar nem enviar', async () => {
  const fake = new FakeGeminiPage();
  const controller = new AbortController();
  controller.abort();

  const stream = await createGeminiWebStream(fake, 'oi', { pollIntervalMs: 1, abortSignal: controller.signal });
  const { text, error } = await consumeGeminiWebStream(stream);

  assert.strictEqual(text, '');
  assert.strictEqual(error, undefined);
  assert.strictEqual(fake.prompts.length, 0, 'não deve digitar o prompt');
  assert.strictEqual(fake.sendClicked, false, 'não deve clicar em enviar');
});

test('gemini-web: abort no meio do turno encerra o polling imediatamente', async () => {
  const controller = new AbortController();
  const customPage = {
    evaluate: async (fn: Function, arg?: unknown) => {
      const src = String(fn);
      if (src.includes('__GEMINI_GO_NEW_CHAT__')) return 'https://gemini.google.com/app';
      if (src.includes('__GEMINI_DISMISS_ONBOARDING__')) return true;
      if (src.includes('__GEMINI_SET_PROMPT__')) return true;
      if (src.includes('__GEMINI_CLICK_SEND__')) return true;
      if (src.includes('__GEMINI_READ_RESPONSE__')) return { text: 'resposta', hasStop: false };
      return undefined;
    },
    waitForTimeout: async () => new Promise((r) => setTimeout(r, 15)),
    isClosed: () => false,
  };

  const stream = await createGeminiWebStream(customPage as any, 'oi', {
    pollIntervalMs: 1,
    stablePolls: 50,
    abortSignal: controller.signal,
  });
  const startedAt = Date.now();
  const consumePromise = consumeGeminiWebStream(stream);

  setTimeout(() => controller.abort(), 20);
  const { error } = await consumePromise;

  const elapsed = Date.now() - startedAt;
  assert.strictEqual(error, undefined);
  // Sem abort, o turno rodaria ~750ms (50 polls × 15ms); com o abort ele
  // encerra em poucas dezenas de ms.
  assert.ok(elapsed < 300, `turno deve encerrar logo após o abort (levou ${elapsed}ms)`);
});

test('gemini-web: tool call no texto vira tool_calls no JSON (non-streaming)', async () => {
  const fake = new FakeGeminiPage();
  const html = `<meta charSet="UTF-8"/>`;
  fake.responseFrames = [`<tool_call>{"name": "Write", "arguments": {"content": "${html}"}}</tool_call>`];
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
        messages: [{ role: 'user', content: 'crie um arquivo html' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(data.choices[0].message.content, null, 'sem texto fora do bloco de tool');
    assert.strictEqual(data.choices[0].message.tool_calls.length, 1);
    assert.strictEqual(data.choices[0].message.tool_calls[0].function.name, 'Write');
    const args = JSON.parse(data.choices[0].message.tool_calls[0].function.arguments);
    assert.strictEqual(args.content, html, 'conteúdo com aspas internas preservado');
  } finally {
    setMockGeminiPage(null);
    restore();
  }
});

test('gemini-web: tool call no texto vira tool_calls no SSE (streaming)', async () => {
  const fake = new FakeGeminiPage();
  fake.responseFrames = [
    'vou criar o arquivo\n',
    `<tool_call>{"name": "Write", "arguments": {"content": "<meta charSet="UTF-8"/>"}}</tool_call>`,
    'pronto',
  ];
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
        messages: [{ role: 'user', content: 'crie um arquivo html' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const body = await res.text();

    const contents: string[] = [];
    const toolNames: string[] = [];
    let finishReason: string | null = null;
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (payload === '[DONE]') continue;
      const chunk = JSON.parse(payload);
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (!d) continue;
      if (typeof d.content === 'string' && d.content) contents.push(d.content);
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          if (tc.function && tc.function.name) toolNames.push(tc.function.name);
        }
      }
      if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    // Texto após a tool call é descartado pelo parser streaming (regra
    // "não emita texto depois de <tool_call>") — o "pronto" não chega.
    assert.strictEqual(contents.join(''), 'vou criar o arquivo\n');
    assert.deepStrictEqual(toolNames, ['Write']);
    assert.strictEqual(finishReason, 'tool_calls');
  } finally {
    setMockGeminiPage(null);
    restore();
  }
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

test('gemini-web: parseToolCallsFromContent lida com aspas sem escape (charSet="UTF-8")', () => {
  const html = `<meta charSet="UTF-8"/>`;
  const raw = `<tool_call>{"name": "Write", "arguments": {"content": "${html}"}}</tool_call>`;

  const { textContent, toolCalls } = parseToolCallsFromContent(raw);

  assert.strictEqual(toolCalls.length, 1, 'tool call deve ser extraída apesar das aspas internas');
  assert.strictEqual(toolCalls[0].name, 'Write');
  const args = toolCalls[0].arguments as any;
  assert.strictEqual(args.content, html, 'conteúdo preservado com as aspas literais');
  assert.strictEqual(textContent, '', 'sem texto fora do bloco');
});

test('gemini-web: repairUnescapedQuotes deixa JSON válido intacto e escapa só o necessário', () => {
  assert.strictEqual(repairUnescapedQuotes('{"a": "b"}'), '{"a": "b"}', 'JSON válido não muda');
  assert.strictEqual(repairUnescapedQuotes('{"a": "x" }'), '{"a": "x" }', 'fecha com espaço não muda');
  const repaired = repairUnescapedQuotes('{"content": "<meta charSet="UTF-8"/> d"}');
  assert.deepStrictEqual(JSON.parse(repaired), { content: '<meta charSet="UTF-8"/> d' });
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

test('gemini-web: circuito anti-loop suprime o retry oculto quando a mesma tool call repete 3x', async () => {
  resetToolLoopBreaker();
  const fake = new FakeGeminiPage();
  // 1ª resposta = preguiçosa (sem tool_call, texto curto) → breaker decide
  // NÃO re-enviar a mensagem oculta.
  fake.responseFrames = ['Aqui está o resumo.'];
  setMockGeminiPage(fake);

  const messages: any[] = [];
  for (let i = 0; i < 3; i++) {
    messages.push({
      role: 'assistant',
      tool_calls: [
        {
          id: `call_${i}`,
          type: 'function',
          function: { name: 'DeleteFile', arguments: JSON.stringify({ path: 'a.ts' }) },
        },
      ],
    });
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: 'Failed to move to the recycle bin (Failed to parse path)',
    });
  }
  messages.push({ role: 'user', content: 'apague a.ts' });

  try {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-workspace-root': 'C:/Users/Lucas/projeto',
      },
      body: JSON.stringify({ model: 'gemini-3-flash', stream: true, messages }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.text();

    assert.strictEqual(
      fake.prompts.length,
      1,
      'breaker deve pular o retry oculto (apenas o prompt original é enviado)'
    );
    assert.ok(!body.includes(ANTI_LAZY_RETRY_MESSAGE), 'não pode conter a mensagem oculta do retry');
    assert.ok(body.includes('Aqui está o resumo.'), 'a resposta preguiçosa é entregue ao usuário');
    const expectedSig = toolCallSignature('DeleteFile', JSON.stringify({ path: 'a.ts' }));
    assert.ok(
      isToolLoopTripped(expectedSig),
      `assinatura da tool call repetida deve estar com o circuito aberto (${expectedSig})`
    );
  } finally {
    setMockGeminiPage(null);
    resetToolLoopBreaker();
  }
});
