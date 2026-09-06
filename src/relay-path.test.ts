/*
 * File: relay-path.test.ts
 * Project: deepsproxy
 * Testes da camada de saída (Relay de Tool Calls) — sanitização de caminhos
 * sem I/O local: limpeza de '././', relativo -> absoluto (win32/posix), root
 * via header, body e contexto de mensagens (fallback Trae), cache de fallback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';
import { FakeGeminiPage, setMockGeminiPage } from './services/gemini-web.ts';
import {
  getWorkspaceRootFromContext,
  sanitizePathValue,
  sanitizeToolCallArguments,
  extractWorkspaceRootFromMessages,
  clearWorkspaceRootCache,
} from './services/relay-path.ts';

function makeContextWithHeader(name: string, value: string | undefined) {
  return {
    req: {
      header: (h: string) => (h.toLowerCase() === name.toLowerCase() ? value : undefined),
    },
  } as any;
}

function noHeaderContext() {
  return makeContextWithHeader('x-workspace-root', undefined);
}

describe('relay-path: getWorkspaceRootFromContext', () => {
  it('lê raiz do header x-workspace-root', () => {
    clearWorkspaceRootCache();
    const root = getWorkspaceRootFromContext(
      makeContextWithHeader('x-workspace-root', 'C:\\Users\\Lucas\\projeto\\')
    );
    assert.equal(root, 'C:/Users/Lucas/projeto');
  });

  it('faz fallback para x-project-root e x-code-workspace-root', () => {
    clearWorkspaceRootCache();
    assert.equal(
      getWorkspaceRootFromContext(makeContextWithHeader('x-project-root', '/home/dev/app')),
      '/home/dev/app'
    );
    assert.equal(
      getWorkspaceRootFromContext(makeContextWithHeader('x-code-workspace-root', 'D:\\code\\ws')),
      'D:/code/ws'
    );
  });

  it('faz fallback para body.workspacePath e body.rootPath', () => {
    clearWorkspaceRootCache();
    assert.equal(
      getWorkspaceRootFromContext(makeContextWithHeader('anything', '') as any, {
        workspacePath: '/body/ws',
      }),
      '/body/ws'
    );
    assert.equal(
      getWorkspaceRootFromContext(makeContextWithHeader('anything', '') as any, {
        rootPath: 'E:\\body\\root',
      }),
      'E:/body/root'
    );
  });

  it('varre body.messages como fallback (Trae não envia header)', () => {
    clearWorkspaceRootCache();
    const root = getWorkspaceRootFromContext(noHeaderContext(), {
      messages: [
        { role: 'system', content: '<workspace>C:\\Users\\Lucas\\projeto</workspace>' },
        { role: 'user', content: 'edite no arquivo_teste.txt' },
      ],
    });
    assert.equal(root, 'C:/Users/Lucas/projeto');
  });

  it('usa o cache da última raiz quando não há header nem pattern', () => {
    clearWorkspaceRootCache();
    // primeira resolução com sucesso → guarda no cache
    getWorkspaceRootFromContext(noHeaderContext(), {
      messages: [{ role: 'system', content: 'workspacePath: "C:/workspace/cacheado"' }],
    });
    // requisição seguinte sem nada → fallback do cache
    assert.equal(getWorkspaceRootFromContext(noHeaderContext(), {}), 'C:/workspace/cacheado');
    clearWorkspaceRootCache();
    assert.equal(getWorkspaceRootFromContext(noHeaderContext(), {}), null);
  });

  it('retorna null quando nada é fornecido', () => {
    clearWorkspaceRootCache();
    assert.equal(getWorkspaceRootFromContext(noHeaderContext(), {}), null);
  });
});

describe('relay-path: limpeza de prefixos relativos repetidos', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('remove "././arquivo_teste.txt" sem raiz', () => {
    assert.equal(sanitizePathValue('././arquivo_teste.txt', null), 'arquivo_teste.txt');
  });

  it('remove "./arquivo_teste.txt" sem raiz', () => {
    assert.equal(sanitizePathValue('./arquivo_teste.txt', null), 'arquivo_teste.txt');
  });

  it('remove ".\\arquivo_teste.txt" (barra invertida) sem raiz', () => {
    assert.equal(sanitizePathValue('.\\arquivo_teste.txt', null), 'arquivo_teste.txt');
  });

  it('remove prefixos repetidos com raiz Windows', () => {
    assert.equal(sanitizePathValue('././arquivo_teste.txt', ROOT), 'C:\\Users\\Lucas\\projeto\\arquivo_teste.txt');
  });

  it('NUNCA produz resultado com "././"', () => {
    for (const input of ['././x.txt', './x.txt', 'x.txt', '.\\.\\x.txt']) {
      const out = String(sanitizePathValue(input, ROOT));
      assert.ok(!out.includes('././'), `entrada '${input}' gerou '././': ${out}`);
      assert.ok(!out.startsWith('./'), `entrada '${input}' ainda tem prefixo relativo '${out}'`);
    }
  });

  it('limpa "./" interno repetido e preserva "../" legítimo', () => {
    // '././../x.ts' → limpa '././' → '../x.ts' → uma subida a partir de 'projeto'.
    assert.equal(sanitizePathValue('././../x.ts', ROOT), 'C:\\Users\\Lucas\\x.ts');
    assert.equal(sanitizePathValue('../x.ts', ROOT), 'C:\\Users\\Lucas\\x.ts');
  });
});

describe('relay-path: sanitizePathValue', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('formatação rígida Windows: relativo -> absoluto com "\\" (win32.resolve)', () => {
    assert.equal(sanitizePathValue('teste_final.txt', ROOT), 'C:\\Users\\Lucas\\projeto\\teste_final.txt');
    assert.equal(sanitizePathValue('./arquivo_teste.txt', ROOT), 'C:\\Users\\Lucas\\projeto\\arquivo_teste.txt');
    assert.equal(sanitizePathValue('src/index.ts', ROOT), 'C:\\Users\\Lucas\\projeto\\src\\index.ts');
    assert.equal(sanitizePathValue('sub\\arquivo.txt', ROOT), 'C:\\Users\\Lucas\\projeto\\sub\\arquivo.txt');
  });

  it('maneja raiz Windows já com "/" (normaliza para "\\" via win32)', () => {
    assert.equal(sanitizePathValue('a\\b.txt', ROOT), 'C:\\Users\\Lucas\\projeto\\a\\b.txt');
  });

  it('mantém caminho já absoluto Windows (win32.normalize)', () => {
    assert.equal(
      sanitizePathValue('C:\\projeto\\dir\\arquivo.txt', ROOT),
      'C:\\projeto\\dir\\arquivo.txt'
    );
    assert.equal(
      sanitizePathValue('C:/projeto/dir/x.ts', ROOT),
      'C:\\projeto\\dir\\x.ts'
    );
  });

  it('repassa caminho POSIX absoluto intacto mesmo com raiz Windows', () => {
    assert.equal(sanitizePathValue('/home/dev/app/x.ts', ROOT), '/home/dev/app/x.ts');
  });

  it('raiz POSIX usa posix.join (barras "/")', () => {
    assert.equal(sanitizePathValue('./src/main.ts', '/home/dev/app'), '/home/dev/app/src/main.ts');
    assert.equal(sanitizePathValue('teste.txt', '/home/dev/app'), '/home/dev/app/teste.txt');
  });

  it('normaliza barra invertida para barra normal sem raiz', () => {
    assert.equal(sanitizePathValue('sub\\arquivo.txt', null), 'sub/arquivo.txt');
  });

  it('não altera valores não-string / vazios', () => {
    assert.equal(sanitizePathValue('', ROOT), '');
    assert.equal(sanitizePathValue(123, ROOT), 123);
    assert.equal(sanitizePathValue(undefined, ROOT), undefined);
  });
});

describe('relay-path: sanitizeToolCallArguments', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('reescreve path/filePath/file_path e deixa content intacto', () => {
    const args = {
      path: 'arquivo_teste.txt',
      content: 'oie \\ template',
      language: 'typescript',
    };
    const out = sanitizeToolCallArguments('Write', args, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\arquivo_teste.txt');
    assert.equal(out.content, 'oie \\ template');
    assert.equal(out.language, 'typescript');
  });

  it('sanitiza ferramentas Read/DeleteFile/SearchReplace', () => {
    for (const name of ['Read', 'DeleteFile', 'SearchReplace']) {
      const out = sanitizeToolCallArguments(name, { path: '././src/main.ts' }, ROOT) as any;
      assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\src\\main.ts', name);
    }
  });

  it('trata argumentos em string JSON', () => {
    const json = JSON.stringify({ path: 'novo_logic.lua', content: 'x' });
    const out = sanitizeToolCallArguments('Edit', json, ROOT) as string;
    const parsed = JSON.parse(out);
    assert.equal(parsed.path, 'C:\\Users\\Lucas\\projeto\\novo_logic.lua');
    assert.equal(parsed.content, 'x');
  });

  it('repassa string não-JSON intacta', () => {
    assert.equal(sanitizeToolCallArguments('Foo', 'não é json', ROOT), 'não é json');
  });

  it('sem raiz, limpa prefixo e normaliza barras', () => {
    const out = sanitizeToolCallArguments('Write', { path: './sub\\arquivo_teste.txt', content: 'y' }, null) as any;
    assert.equal(out.path, 'sub/arquivo_teste.txt');
  });
});

describe('relay-path: extractWorkspaceRootFromMessages', () => {
  it('extrai raiz da tag <workspace>PATH</workspace>', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'system', content: '<workspace>C:\\Users\\Lucas\\projeto\\</workspace>' },
      { role: 'user', content: 'crie o arquivo' },
    ]);
    assert.equal(root, 'C:/Users/Lucas/projeto');
  });

  it('extrai raiz de "workspacePath: PATH"', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'user', content: 'Faça no projeto\nworkspacePath: "/home/dev/proj-a"' },
    ]);
    assert.equal(root, '/home/dev/proj-a');
  });

  it('extrai raiz de "workspacePath = PATH" com aspas', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'system', content: 'workspacePath = "D:\\code\\meu-projeto"' },
    ]);
    assert.equal(root, 'D:/code/meu-projeto');
  });

  it('extrai caminho absoluto Windows de system reminder', () => {
    const root = extractWorkspaceRootFromMessages([
      {
        role: 'system',
        content:
          'System reminder: você está editando arquivos em C:\\Users\\Lucas\\Documents\\Programação\\projeto',
      },
      { role: 'user', content: 'vai' },
    ]);
    assert.equal(root, 'C:/Users/Lucas/Documents/Programação/projeto');
  });

  it('extrai caminho POSIX absoluto /home/... de system reminder', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'system', content: 'workspace: /home/dev/app/projeto-x' },
    ]);
    assert.equal(root, '/home/dev/app/projeto-x');
  });

  it('lê content como array de partes (formato OpenAI)', () => {
    const root = extractWorkspaceRootFromMessages([
      {
        role: 'system',
        content: [{ type: 'text', text: '<workspace>E:\\wss</workspace>' }],
      },
    ]);
    assert.equal(root, 'E:/wss');
  });

  it('tag <workspace> explícita vence caminho absoluto em mensagem posterior', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'system', content: '<workspace>C:\\dev\\proj</workspace>' },
      { role: 'user', content: 'apague C:\\tmp\\lixo.sql também' },
    ]);
    assert.equal(root, 'C:/dev/proj');
  });

  it('última tag <workspace> vence entre múltiplas', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'system', content: '<workspace>C:\\dev\\a</workspace>' },
      { role: 'system', content: '<workspace>D:\\dev\\b</workspace>' },
    ]);
    assert.equal(root, 'D:/dev/b');
  });

  it('retorna null sem mensagens ou sem padrões', () => {
    assert.equal(extractWorkspaceRootFromMessages([]), null);
    assert.equal(
      extractWorkspaceRootFromMessages([{ role: 'user', content: 'apenas texto comum' }]),
      null
    );
  });
});

describe('relay-path: aviso "current working directory is" (prioridade máxima)', () => {
  it('extrai raiz com espaços no nome do usuário até o fim da linha', () => {
    const root = extractWorkspaceRootFromMessages([
      {
        role: 'system',
        content:
          'System reminder: the current working directory is C:\\Users\\Lucas sá\\Documents\\Programação\\Projeto',
      },
      { role: 'user', content: 'edite os arquivos' },
    ]);
    assert.equal(root, 'C:/Users/Lucas sá/Documents/Programação/Projeto');
  });

  it('vence a tag <workspace> (prioridade máxima)', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'system', content: '<workspace>D:\\dev\\ws</workspace>' },
      {
        role: 'system',
        content: 'The current working directory is C:\\Users\\Lucas sá\\Projeto',
      },
    ]);
    assert.equal(root, 'C:/Users/Lucas sá/Projeto');
  });

  it('rejeita candidato incompleto (home do usuário) e usa o fallback correto', () => {
    const root = extractWorkspaceRootFromMessages([
      { role: 'system', content: 'current working directory is C:\\Users\\Lucas' },
      { role: 'system', content: '<workspace>D:\\dev\\ws</workspace>' },
    ]);
    assert.equal(root, 'D:/dev/ws');
  });

  it('rejeita home do usuário sozinho (sem outro fallback) → null', () => {
    assert.equal(
      extractWorkspaceRootFromMessages([
        { role: 'system', content: 'current working directory is C:\\Users\\Lucas' },
      ]),
      null
    );
    assert.equal(
      extractWorkspaceRootFromMessages([
        { role: 'system', content: 'current working directory is /home/lucas' },
      ]),
      null
    );
  });
});

describe('relay-path: caminhos com espaços e escapes (\t, \n)', () => {
  const ROOT = 'C:/Users/Lucas sá/Documents/Projeto';

  it('resolve caminhos relativos dentro de workspace com espaços', () => {
    assert.equal(sanitizePathValue('arquivo_teste.txt', ROOT), 'C:\\Users\\Lucas sá\\Documents\\Projeto\\arquivo_teste.txt');
  });

  it('extrai raiz genérica com espaços de system reminder (ponto final é ruído)', () => {
    const root = extractWorkspaceRootFromMessages([
      {
        role: 'system',
        content: 'trabalhe em C:\\Users\\Lucas sá\\Documents\\Projeto.',
      },
    ]);
    assert.equal(root, 'C:/Users/Lucas sá/Documents/Projeto');
  });

  it('sequência "\\tests" real (barra invertida) vira separador, sem comida de letra', () => {
    assert.equal(sanitizePathValue('src\\tests_stress', null), 'src/tests_stress');
    assert.equal(
      sanitizePathValue('src\\tests_stress', 'C:/Users/Lucas/projeto'),
      'C:\\Users\\Lucas\\projeto\\src\\tests_stress'
    );
  });

  it('escape misfired \\t (Tab) não vira espaço nem corta o caminho', () => {
    // Modelo emitiu '\src\tests_stress'; um parseador decodificou '\t'→Tab,
    // "engolindo" o 't': valor recebido é 'src<TAB>ests_stress'.
    const damaged = 'src' + '\t' + 'ests_stress';
    const out = String(sanitizePathValue(damaged, null));
    assert.ok(!out.includes('\t'), `não deve conter Tab: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(' '), `não deve conter espaço: ${JSON.stringify(out)}`);
    assert.equal(out, 'src/ests_stress');
    assert.equal(sanitizePathValue(damaged, 'C:/Users/Lucas/projeto'), 'C:\\Users\\Lucas\\projeto\\src\\ests_stress');
  });

  it('escape misfired \\n (quebra de linha) é restaurado como separador', () => {
    const damaged = 'sub' + '\n' + 'dir/arquivo.txt';
    const out = String(sanitizePathValue(damaged, null));
    assert.ok(!out.includes('\n'), `não deve conter quebra de linha: ${JSON.stringify(out)}`);
    assert.equal(out, 'sub/dir/arquivo.txt');
  });

  it('não quebra aspas/colchetes em barras; mantém conteúdo com espaço intacto', () => {
    const out = sanitizeToolCallArguments('Write', { path: 'um arquivo.txt', content: 'a\nb' }, 'C:/Users/Lucas/projeto') as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\um arquivo.txt');
    assert.equal(out.content, 'a\nb');
  });
});

describe('relay-path: sanitizeToolCallArguments com múltiplos arquivos', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('DeleteFile com "file1.ts,file2.ts" divide, sanitiza e reconstitui', () => {
    const out = sanitizeToolCallArguments('DeleteFile', { path: 'file1.ts,file2.ts' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\file1.ts,C:\\Users\\Lucas\\projeto\\file2.ts');
    assert.ok(
      !out.path.includes(' '),
      'reconstrução sem espaços (cada item já é absoluto e sem vírgula): ' + out.path
    );
  });

  it('Read com paths relativos + barra invertida, espaços entre vírgulas', () => {
    const out = sanitizeToolCallArguments(
      'Read',
      { file_path: 'docs\\manual.txt, src\\main.ts , ./README.md' },
      ROOT
    ) as any;
    assert.equal(
      out.file_path,
      'C:\\Users\\Lucas\\projeto\\docs\\manual.txt,C:\\Users\\Lucas\\projeto\\src\\main.ts,C:\\Users\\Lucas\\projeto\\README.md'
    );
  });

  it('candidato incompleto por item não bloqueia os demais; content não é listado', () => {
    const out = sanitizeToolCallArguments(
      'Read',
      { path: 'a.ts,,b.ts', content: 'x, y, z' },
      ROOT
    ) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\a.ts,C:\\Users\\Lucas\\projeto\\b.ts');
    assert.equal(out.content, 'x, y, z');
  });

  it('path único sem vírgula continua virando absoluto normal', () => {
    const out = sanitizeToolCallArguments('DeleteFile', { path: 'unico.txt' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\unico.txt');
  });

  it('multi-arquivo também funciona em string JSON', () => {
    const out = sanitizeToolCallArguments('DeleteFile', JSON.stringify({ path: 'x.ts, y.ts' }), ROOT) as string;
    const parsed = JSON.parse(out);
    assert.equal(parsed.path, 'C:\\Users\\Lucas\\projeto\\x.ts,C:\\Users\\Lucas\\projeto\\y.ts');
  });
});

describe('relay-path: integração via app (chat completions)', () => {
  it('sanciona tool_calls no non-streaming com header x-workspace-root', async () => {
    clearWorkspaceRootCache();
    const fake = new FakeGeminiPage();
    fake.responseFrames = [
      `<tool_call>{"name": "DeleteFile", "arguments": {"path": "./arquivo_teste.txt"}}</tool_call>`,
    ];
    setMockGeminiPage(fake);

    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workspace-root': 'C:\\Users\\Lucas\\projeto',
        },
        body: JSON.stringify({
          model: 'gemini-3-flash',
          stream: false,
          messages: [
            {
              role: 'user',
              content: 'Delete arquivo_teste.txt',
            },
          ],
        }),
      });
      assert.strictEqual(res.status, 200);
      const data: any = await res.json();
      const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
      assert.ok(toolCall, 'deve haver tool_call no non-streaming');
      assert.strictEqual(toolCall.function.name, 'DeleteFile');
      const args = JSON.parse(toolCall.function.arguments);
      assert.strictEqual(
        args.path,
        'C:\\Users\\Lucas\\projeto\\arquivo_teste.txt',
        'relativo deve virar absoluto Windows (win32.resolve) com x-workspace-root'
      );
    } finally {
      setMockGeminiPage(null);
      clearWorkspaceRootCache();
    }
  });

  it('sanciona tool_calls no non-streaming com fallback <workspace> nas mensagens (Trae)', async () => {
    clearWorkspaceRootCache();
    const fake = new FakeGeminiPage();
    fake.responseFrames = [
      `<tool_call>{"name": "Write", "arguments": {"path": "././novo_log.txt", "content": "x"}}</tool_call>`,
    ];
    setMockGeminiPage(fake);

    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-3-flash',
          stream: false,
          messages: [
            { role: 'system', content: '<workspace>C:\\Users\\Lucas\\projeto</workspace>' },
            { role: 'user', content: 'crie novo_log.txt' },
          ],
        }),
      });
      assert.strictEqual(res.status, 200);
      const data: any = await res.json();
      const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
      assert.ok(toolCall, 'deve haver tool_call no non-streaming (fallback mensagem)');
      const args = JSON.parse(toolCall.function.arguments);
      assert.strictEqual(
        args.path,
        'C:\\Users\\Lucas\\projeto\\novo_log.txt',
        'Trae: raiz via <workspace> nas mensagens e "././" limpo'
      );
    } finally {
      setMockGeminiPage(null);
      clearWorkspaceRootCache();
    }
  });

  it('sanciona tool_calls no streaming (SSE) com header x-workspace-root', async () => {
    clearWorkspaceRootCache();
    const fake = new FakeGeminiPage();
    // JSON real do modelo: "src\\novo.ts" (escape de barra invertida no JSON →
    // valor parseado "src\novo.ts" com UMA barra).
    fake.responseFrames = [
      `<tool_call>{"name": "Write", "arguments": {"path": "src\\\\novo.ts", "content": "x"}}</tool_call>`,
    ];
    setMockGeminiPage(fake);

    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workspace-root': 'C:/Users/Lucas/projeto',
        },
        body: JSON.stringify({
          model: 'gemini-3-flash',
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'escreva src/novo.ts',
            },
          ],
        }),
      });
      assert.strictEqual(res.status, 200);
      const bodyText = await res.text();

      const toolChunks = bodyText
        .split('\n\n')
        .filter((chunk) => chunk.includes('"tool_calls"'))
        .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
      assert.ok(toolChunks.length > 0, 'deve haver chunk com tool_calls');
      const tc = toolChunks[0].choices[0].delta.tool_calls[0];
      assert.strictEqual(tc.function.name, 'Write');
      const args = JSON.parse(tc.function.arguments);
      assert.strictEqual(
        args.path,
        'C:\\Users\\Lucas\\projeto\\src\\novo.ts',
        'SSE: win32.resolve com barra invertida e absoluto completo'
      );
    } finally {
      setMockGeminiPage(null);
      clearWorkspaceRootCache();
    }
  });
});