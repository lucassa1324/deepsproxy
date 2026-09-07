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
import { robustParseJSON, protectPathEscapesInJson } from './utils/robust-json.ts';
import {
  getWorkspaceRootFromContext,
  sanitizePathValue,
  sanitizeToolCallArguments,
  sanitizeToolOutput,
  applyToolOutputSanitization,
  extractWorkspaceRootFromMessages,
  clearWorkspaceRootCache,
  toolCallSignature,
  DEFAULT_MCP_SERVER_NAME,
  extractMcpServerNamesFromTools,
  applyMcpNativeFilesystemFallback,
  MCP_ACCESS_DENIED_RE,
  MCP_NATIVE_FS_FALLBACK_DIRECTIVE,
  extractKnownRelativePaths,
  stripControlChars,
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

  it('purga "../" (path traversal) NUNCA sobe acima do workspaceRoot', () => {
    // '././../x.ts' → loop de purga remove '././../' → NUNCA resolve para
    // 'C:\Users\Lucas\x.ts' fora do projeto (defesa contra path traversal).
    assert.equal(sanitizePathValue('././../x.ts', ROOT), 'C:\\Users\\Lucas\\projeto\\x.ts');
    assert.equal(sanitizePathValue('../x.ts', ROOT), 'C:\\Users\\Lucas\\projeto\\x.ts');
    assert.equal(sanitizePathValue('..\\x.ts', ROOT), 'C:\\Users\\Lucas\\projeto\\x.ts');
    assert.equal(
      sanitizePathValue('././.././../x.ts', ROOT),
      'C:\\Users\\Lucas\\projeto\\x.ts'
    );
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

  it('SearchReplace: MESMO sanitizeSinglePath do Write/Read (purga "\\." + barras)', () => {
    const args = { file_path: '.\\src\\tests_stress\\logic.ts', old_string: 'a', new_string: 'b' };
    const out = sanitizeToolCallArguments('SearchReplace', args, ROOT) as any;
    assert.equal(out.file_path, 'C:\\Users\\Lucas\\projeto\\src\\tests_stress\\logic.ts');
    assert.ok(!out.file_path.includes('\t'), 'não pode conter Tab');
    assert.ok(out.file_path.includes('tests_stress'), 'letra t preservada');
    assert.equal(out.old_string, 'a', 'old_string não é tocado');
    assert.equal(out.new_string, 'b', 'new_string não é tocado');
  });

  it('Edit: purga ".\\" e normaliza target_file; conteúdo de busca/replace intacto', () => {
    const out = sanitizeToolCallArguments(
      'Edit',
      { target_file: '.\\src\\main.ts', old_string: 'foo \\ bar', new_string: 'baz\\qux' },
      ROOT
    ) as any;
    assert.equal(out.target_file, 'C:\\Users\\Lucas\\projeto\\src\\main.ts');
    assert.ok(!out.target_file.includes('//'), out.target_file);
    assert.equal(out.old_string, 'foo \\ bar', 'old_string preserva texto literal');
    assert.equal(out.new_string, 'baz\\qux', 'new_string preserva texto literal');
  });

  it('SearchReplace em string JSON: file_path limpo, old/new intactos', () => {
    const json = JSON.stringify({ file_path: '.\\src\\tests_stress\\a.ts', old_string: 'x', new_string: 'y' });
    const out = sanitizeToolCallArguments('SearchReplace', json, ROOT) as string;
    const parsed = JSON.parse(out);
    assert.equal(parsed.file_path, 'C:\\Users\\Lucas\\projeto\\src\\tests_stress\\a.ts');
    assert.ok(!parsed.file_path.includes('\t'));
    assert.equal(parsed.old_string, 'x');
    assert.equal(parsed.new_string, 'y');
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
    // Para um Tab JÁ decodificado (a letra 't' foi engolida no JSON.parse), o
    // máximo que dá para fazer é restaurar o separador sem deixar Tab no valor.
    // A PREVENÇÃO do 'tests_stress'→'ests_stress' acontece ANTES, no boundary
    // de parse (robustParseJSON / string-args do relay) — ver testes abaixo.
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

describe('relay-path: pipeline rígido — \\tests_stress NUNCA vira ests_stress', () => {
  const ROOT = 'C:/Users/Lucas sá/Documents/Programação/Projeto';

  it('Read: .\\src\\tests_stress resolve limpo SEM Tabulação e mantém "tests_stress"', () => {
    const out = sanitizeToolCallArguments('Read', { file_path: '.\\src\\tests_stress' }, ROOT) as any;
    assert.equal(out.file_path, 'C:\\Users\\Lucas sá\\Documents\\Programação\\Projeto\\src\\tests_stress');
    assert.ok(!out.file_path.includes('\t'), 'não pode conter Tab');
    assert.ok(out.file_path.includes('tests_stress'), `deve manter 'tests_stress': ${out.file_path}`);
    assert.ok(!out.file_path.includes('ests_stress,'), 'não pode ter comido a letra t');
  });

  it('DeleteFile: mesmo pipeline para .\\src\\tests_stress', () => {
    const out = sanitizeToolCallArguments('DeleteFile', { path: '.\\src\\tests_stress' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas sá\\Documents\\Programação\\Projeto\\src\\tests_stress');
    assert.ok(!out.path.includes('\t'));
    assert.ok(out.path.includes('tests_stress'));
  });

  it('purga "\" raiz único antes da resolução ("\\src\\file" → root\\src\\file)', () => {
    const out = sanitizeToolCallArguments('Read', { path: '\\src\\tests_stress' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas sá\\Documents\\Programação\\Projeto\\src\\tests_stress');
  });

  it('.\src\tests_stress sem raiz: limpo e "tests_stress" intacto', () => {
    const out = String(sanitizePathValue('.\\tests_stress', null));
    assert.equal(out, 'tests_stress');
    assert.ok(!out.includes('\t'));
  });

  it('mantém UNC \\\\server\\share intacto (não purga a barra dupla)', () => {
    const out = sanitizeToolCallArguments('Read', { path: '\\\\server\\share\\file.ts' }, ROOT) as any;
    assert.equal(out.path, '\\\\server\\share\\file.ts');
  });
});

describe('relay-path: caminhos absolutos nunca duplicam o workspaceRoot', () => {
  const ROOT = 'C:/Users/Lucas sá/projeto';

  it('C:\\... absoluto já com o root: só normaliza, sem concatenação', () => {
    const out = sanitizeToolCallArguments(
      'DeleteFile',
      { path: 'C:\\Users\\Lucas sá\\projeto\\src\\tests_stress' },
      ROOT
    ) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas sá\\projeto\\src\\tests_stress');
    assert.ok(!out.path.includes('projeto\\projeto'), 'root duplicado: ' + out.path);
  });

  it('C:/... com barras normais vira nativo \\\\ via win32.normalize (sem duplicar)', () => {
    const out = sanitizeToolCallArguments('Read', { path: 'C:/Users/Lucas sá/projeto/src/x.ts' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas sá\\projeto\\src\\x.ts');
  });

  it('drive minúsculo c:\\ também não duplica root', () => {
    const out = sanitizeToolCallArguments('Read', { path: 'c:\\Users\\Lucas sá\\projeto\\src\\x.ts' }, ROOT) as any;
    assert.equal(out.path, 'c:\\Users\\Lucas sá\\projeto\\src\\x.ts');
  });

  it('absolute + "./" misturado limpa e mantém absoluto único', () => {
    const out = sanitizeToolCallArguments('Read', { file_path: 'C:\\Users\\Lucas sá\\projeto\\.\\src\\a.ts' }, ROOT) as any;
    assert.equal(out.file_path, 'C:\\Users\\Lucas sá\\projeto\\src\\a.ts');
  });

  it('lista multi-arquivo com absoluto não duplica (e continua absoluto)', () => {
    const out = sanitizeToolCallArguments(
      'Read',
      { file_path: '.\\.\\src\\m1.ts, C:\\Users\\Lucas sá\\projeto\\src\\m2.ts' },
      ROOT
    ) as any;
    assert.equal(
      out.file_path,
      'C:\\Users\\Lucas sá\\projeto\\src\\m1.ts,C:\\Users\\Lucas sá\\projeto\\src\\m2.ts'
    );
  });
});

describe('relay-path: tags XML/HTML acidentais são removidas do caminho', () => {
  const ROOT = 'C:/Users/Lucas sá/projeto';

  it('prefixo <\\toolcall_error_message> é limpo antes do resolve', () => {
    const out = sanitizeToolCallArguments(
      'Read',
      { path: '<\\toolcall_error_message>C:\\Users\\Lucas sá\\projeto\\src\\a.ts' },
      ROOT
    ) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas sá\\projeto\\src\\a.ts');
    assert.ok(!out.path.includes('<'), 'tag deve sumir: ' + out.path);
  });

  it('tag <error> embutida é removida', () => {
    const out = sanitizeToolCallArguments('Read', { path: '.\\src\\<x>novo.txt' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas sá\\projeto\\src\\novo.txt');
  });
});

describe('relay-path: Read/DeleteFile com espaços no caminho ("Lucas sá")', () => {
  const ROOT = 'C:/Users/Lucas sá/Documents/Programação/Projeto';

  it('Read em arquivo com espaços dentro do workspace', () => {
    const out = sanitizeToolCallArguments(
      'Read',
      { file_path: '.\\config\\config Lucas sá.ts' },
      ROOT
    ) as any;
    assert.equal(out.file_path, 'C:\\Users\\Lucas sá\\Documents\\Programação\\Projeto\\config\\config Lucas sá.ts');
  });

  it('DeleteFile com espaços e acentos no nome', () => {
    const out = sanitizeToolCallArguments(
      'DeleteFile',
      { path: '.\\docs\\arquivo de teste é ç.txt' },
      ROOT
    ) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas sá\\Documents\\Programação\\Projeto\\docs\\arquivo de teste é ç.txt');
  });
});

describe('relay-path: "\tests_stress" preservado na string JSON crua (parse boundary)', () => {
  const ROOT = 'C:/Users/Lucas sá/projeto';

  it('protectPathEscapesInJson dobra "\\t" de path sem tocar content', () => {
    const raw = '{"path": ".\\tests_stress", "content": "a\\nb"}';
    const protectedRaw = protectPathEscapesInJson(raw);
    assert.ok(protectedRaw.includes('.\\\\tests_stress'), protectedRaw);
    assert.ok(protectedRaw.includes('a\\nb'), 'content deve ficar intocado: ' + protectedRaw);
  });

  it('sanitizeToolCallArguments com string JSON crua mantém "tests_stress"', () => {
    const out = sanitizeToolCallArguments('Read', '{"path": ".\\src\\tests_stress"}', ROOT) as string;
    const parsed = JSON.parse(out);
    assert.equal(parsed.path, 'C:\\Users\\Lucas sá\\projeto\\src\\tests_stress');
    assert.ok(!parsed.path.includes('\t'));
  });

  it('robustParseJSON end-to-end: .\\tests_stress não vira Tabulação', () => {
    const parsed = robustParseJSON('{"name":"Read","arguments":{"path": ".\\tests_stress"}}');
    assert.equal(parsed.arguments.path, '.\\tests_stress');
    assert.ok(!parsed.arguments.path.includes('\t'), 'não pode decodificar para Tab');
    assert.ok(parsed.arguments.path.includes('tests_stress'), 'letra t preservada');
  });

  it('robustParseJSON: content com "\\n" intencional continua newline real', () => {
    const parsed = robustParseJSON('{"name":"Write","arguments":{"path":"x.txt","content":"linha1\\nlinha2"}}');
    assert.ok(parsed.arguments.content.includes('\n'), 'content deve ter newline real');
    assert.ok(!parsed.arguments.content.includes('\\n'), 'não deve ficar literal');
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

describe('relay-path: ferramentas de terminal (RunCommand) — barras sempre para "/"', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('RunCommand: TODAS as "\\" viram "/" no comando (\\t → /t, sem Tabulação)', () => {
    const args = {
      command: 'cd src\\tests_stress && node "C:\\test folder\\run.js" --flag "um arquivo com espaço"',
      cwd: './app',
    };
    const out = sanitizeToolCallArguments('RunCommand', args, ROOT) as any;
    assert.equal(
      out.command,
      'cd src/tests_stress && node "C:/test folder/run.js" --flag "um arquivo com espaço"'
    );
    assert.ok(!out.command.includes('\\'), 'nenhuma barra invertida no comando');
    assert.ok(!out.command.includes('\t'), 'nenhum Tab — "tests_stress" intacto');
    assert.ok(out.command.includes('tests_stress'), 'letra t preservada');
    assert.equal(out.cwd, './app');
  });

  it('rmdir /s /q com src\\tests_stress vira node -e (fs.rmSync recursivo) — "tests_stress" intacto', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'rmdir /s /q "src\\tests_stress"' }, ROOT) as any;
    assert.equal(
      out.command,
      'node -e "const fs=require(\'fs\');fs.rmSync(\'src/tests_stress\',{recursive:true,force:true})"'
    );
    assert.ok(!out.command.includes('\t'));
    assert.ok(out.command.includes('tests_stress'), 'deve manter "tests_stress": ' + out.command);
    assert.ok(!out.command.includes('ets_stress'), 'não pode ter comido a letra t');
  });

  it('CheckCommandStatus: sem barras, payload intacto (timeout preservado)', () => {
    const args = { command: 'npm test -- --runInBand', timeout: 30000 };
    const out = sanitizeToolCallArguments('CheckCommandStatus', args, ROOT) as any;
    assert.deepStrictEqual(out, args);
  });

  it('RunCommand em string JSON: valores re-serializados com "/"', () => {
    const json = JSON.stringify({ command: 'dir src\\tests_stress', cwd: '.\\app' });
    const out = sanitizeToolCallArguments('RunCommand', json, ROOT) as string;
    const parsed = JSON.parse(out);
    assert.equal(parsed.command, 'dir src/tests_stress');
    assert.equal(parsed.cwd, './app');
    assert.ok(!parsed.command.includes('\t'));
    assert.ok(parsed.command.includes('tests_stress'));
  });

  it('RunCommand com string crua não-JSON: barras para "/"', () => {
    const out = sanitizeToolCallArguments('RunCommand', 'node run.js src\\tests_stress', ROOT) as string;
    assert.equal(out, 'node run.js src/tests_stress');
  });

  it('barra invertida REAL não virou Tabulação (mkdir "sub\\tests_stress" → node -e mkdirSync)', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'mkdir "sub\\tests_stress"' }, ROOT) as any;
    assert.ok(!out.command.includes('\t'), JSON.stringify(out.command));
    assert.ok(out.command.includes('/tests_stress'), out.command);
    assert.ok(out.command.startsWith('node -e '), 'deve ir para node -e: ' + out.command);
  });
});

describe('relay-path: terminal — lote Windows vira UMA chamada node -e e Unix-isms são removidos', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('mkdir -p (com espaço no nome) vira node -e com mkdirSync recursivo', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'mkdir -p "C:/Users/Lucas sá/Projeto temp"' }, ROOT) as any;
    assert.equal(
      out.command,
      'node -e "const fs=require(\'fs\');fs.mkdirSync(\'C:/Users/Lucas sá/Projeto temp\',{recursive:true})"'
    );
  });

  it('lote em concurrency (mkdir && move && del) vira UMA chamada node -e', () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'mkdir "src\\tmp" && move "src\\tmp\\a.txt" "src\\a.txt" && del "src\\tmp\\b.log"' },
      ROOT
    ) as any;
    assert.equal(
      out.command,
      'node -e "const fs=require(\'fs\');' +
        'fs.mkdirSync(\'src/tmp\',{recursive:false});' +
        'fs.renameSync(\'src/tmp/a.txt\',\'src/a.txt\');' +
        'fs.rmSync(\'src/tmp/b.log\',{force:true})"'
    );
  });

  it('rmdir /s /q traduz para fs.rmSync recursivo+force', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'rmdir /s /q "src\\old"' }, ROOT) as any;
    assert.equal(
      out.command,
      'node -e "const fs=require(\'fs\');fs.rmSync(\'src/old\',{recursive:true,force:true})"'
    );
  });

  it('comando com builtin não-lote (npm test) NÃO é traduzido', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'npm test -- --runInBand' }, ROOT) as any;
    assert.equal(out.command, 'npm test -- --runInBand');
  });

  it('"|| true" (no-op Unix) é removido sem quebrar o resto', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'npm run build || true && node server.js' }, ROOT) as any;
    assert.equal(out.command, 'npm run build && node server.js');
  });

  it('"2>nul" é removido (redirecionamento que quebra o parse do terminal)', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'node run.js 2>nul' }, ROOT) as any;
    assert.equal(out.command, 'node run.js');
  });

  it('multilinha de lote não vira bloco PowerShell InvalidEndOfLine (vira node -e)', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'mkdir a\nmkdir b && mkdir c' }, ROOT) as any;
    assert.equal(
      out.command,
      'node -e "const fs=require(\'fs\');' +
        'fs.mkdirSync(\'a\',{recursive:false});' +
        'fs.mkdirSync(\'b\',{recursive:false});' +
        'fs.mkdirSync(\'c\',{recursive:false})"'
    );
  });

  it('flag desconhecida em statement de lote aborta a tradução (repassa intacto)', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'del /weird src/file.ts' }, ROOT) as any;
    assert.equal(out.command, 'del /weird src/file.ts');
  });
});

describe('relay-path: DeleteFile multi com prefixos relativos', () => {
  const ROOT = 'C:/Users/Lucas sá/Documents/Projeto';

  it('DeleteFile: prefixo ".\\" é purgado ANTES do payload (objeto E string JSON)', () => {
    const obj = sanitizeToolCallArguments('DeleteFile', { file_path: '.\\src\\tests_stress\\tmp.ts' }, ROOT) as any;
    assert.equal(obj.file_path, 'C:\\Users\\Lucas sá\\Documents\\Projeto\\src\\tests_stress\\tmp.ts');
    assert.ok(!obj.file_path.includes('./') && !obj.file_path.includes('.\\'), 'nenhum prefixo relativo');
    assert.ok(!obj.file_path.includes('\t'));

    const jsonOut = sanitizeToolCallArguments(
      'DeleteFile',
      JSON.stringify({ path: '.\\src\\tests_stress\\tmp.ts' }),
      ROOT
    ) as string;
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.path, 'C:\\Users\\Lucas sá\\Documents\\Projeto\\src\\tests_stress\\tmp.ts');
    assert.ok(!parsed.path.includes('./') && !parsed.path.includes('.\\'));
    assert.ok(!parsed.path.includes('\t'));
  });

  it('limpa "./" antes do resolve (exemplo do requisito)', () => {
    const out = sanitizeToolCallArguments('DeleteFile', { path: './src/tests_stress/math.ts' }, ROOT) as any;
    assert.strictEqual(
      out.path,
      'C:\\Users\\Lucas sá\\Documents\\Projeto\\src\\tests_stress\\math.ts'
    );
    assert.ok(!out.path.includes('./'), 'não pode sobrar "./" no item resolvido');
  });

  it('múltiplos arquivos com prefixos relativos mistos ("./", ".\\", ok)', () => {
    const out = sanitizeToolCallArguments(
      'DeleteFile',
      { path: '././src/a.ts,.\\tests\\b.ts,plain.ts,' },
      ROOT
    ) as any;
    assert.strictEqual(
      out.path,
      'C:\\Users\\Lucas sá\\Documents\\Projeto\\src\\a.ts,' +
        'C:\\Users\\Lucas sá\\Documents\\Projeto\\tests\\b.ts,' +
        'C:\\Users\\Lucas sá\\Documents\\Projeto\\plain.ts'
    );
    assert.ok(!out.path.includes('./'), 'nenhum item pode manter "./"');
  });

  it('cada item recebe win32.resolve com string limpa (sem "./")', () => {
    const out = String(
      sanitizeToolCallArguments('DeleteFile', { path: './src/tests_stress/math.ts' }, ROOT)
    );
    assert.ok(!out.includes('./'), 'relativo pré-resolvido nunca aparece no output JSON');
  });
});

describe('relay-path: toolCallSignature (circuit breaker)', () => {
  it('iguala objetos com ordem de chaves diferente', () => {
    const a = toolCallSignature('DeleteFile', { path: 'a.ts', content: 'x' });
    const b = toolCallSignature('DeleteFile', { content: 'x', path: 'a.ts' });
    assert.strictEqual(a, b);
  });

  it('distingue argumentos diferentes (uma tool, caminhos diferentes)', () => {
    assert.notStrictEqual(
      toolCallSignature('DeleteFile', { path: 'a.ts' }),
      toolCallSignature('DeleteFile', { path: 'b.ts' })
    );
  });

  it('ignora caixa e espaços no nome da ferramenta', () => {
    assert.strictEqual(
      toolCallSignature('DeleteFile', { path: 'x' }),
      toolCallSignature(' deletefile ', { path: 'x' })
    );
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

describe('relay-path: run_mcp (injeção de server_name)', () => {
  it('injeta server_name padrão quando ausente (objeto)', () => {
    const out = sanitizeToolCallArguments(
      'run_mcp',
      { tool_name: 'read_text_file', arguments: { path: 'README.md' } },
      null
    ) as any;
    assert.strictEqual(out.server_name, DEFAULT_MCP_SERVER_NAME);
    assert.strictEqual(out.tool_name, 'read_text_file');
    assert.deepStrictEqual(out.arguments, { path: 'README.md' });
  });

  it('injeta server_name também quando os args vêm como string JSON', () => {
    const raw = JSON.stringify({ tool_name: 'write_text_file', arguments: { path: 'a.txt', content: 'hi' } });
    const out = sanitizeToolCallArguments('run_mcp', raw, null) as string;
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.server_name, DEFAULT_MCP_SERVER_NAME);
    assert.strictEqual(parsed.tool_name, 'write_text_file');
  });

  it('preserva server_name já informado pelo modelo', () => {
    const out = sanitizeToolCallArguments(
      'run_mcp',
      { server_name: 'github', tool_name: 'x', arguments: {} },
      null
    ) as any;
    assert.strictEqual(out.server_name, 'github');
  });

  it('não toca mais nada além do server_name (pass-through)', () => {
    const out = sanitizeToolCallArguments(
      'run_mcp',
      { tool_name: 'list', arguments: { pattern: '**/*' }, extra: ['a', { b: 1 }] },
      null
    ) as any;
    assert.deepStrictEqual(out, {
      server_name: DEFAULT_MCP_SERVER_NAME,
      tool_name: 'list',
      arguments: { pattern: '**/*' },
      extra: ['a', { b: 1 }],
    });
  });

  it('server_name em branco é substituído', () => {
    const out = sanitizeToolCallArguments('run_mcp', { server_name: '  ', tool_name: 'x' }, null) as any;
    assert.strictEqual(out.server_name, DEFAULT_MCP_SERVER_NAME);
  });

  it('prefere o padrão quando anunciado no schema', () => {
    const servers = extractMcpServerNamesFromTools([
      {
        type: 'function',
        function: {
          name: 'run_mcp',
          parameters: {
            type: 'object',
            properties: {
              server_name: { type: 'string', enum: ['filesystem', 'database'] },
              tool_name: { type: 'string' },
            },
          },
        },
      },
    ]);
    assert.deepStrictEqual(servers, ['filesystem', 'database']);
    const out = sanitizeToolCallArguments('run_mcp', { tool_name: 'x', arguments: {} }, null, servers) as any;
    assert.strictEqual(out.server_name, DEFAULT_MCP_SERVER_NAME);
  });

  it('usa o 1º servidor do schema quando o padrão não está anunciado', () => {
    const out = sanitizeToolCallArguments('run_mcp', { tool_name: 'x' }, null, ['github']) as any;
    assert.strictEqual(out.server_name, 'github');
  });

  it('extractMcpServerNamesFromTools suporta const/default e ignora outras tools', () => {
    const servers = extractMcpServerNamesFromTools([
      {
        name: 'run_mcp',
        parameters: { properties: { server_name: { const: 'myfs' }, tool_name: { type: 'string' } } },
      },
      { name: 'read_file' },
      JSON.parse(
        JSON.stringify({
          function: { name: 'run_mcp', parameters: { properties: { serverName: { default: 'alt' } } } },
        })
      ),
    ]);
    assert.deepStrictEqual(servers, ['myfs', 'alt']);
    assert.deepStrictEqual(extractMcpServerNamesFromTools([{ name: 'read_file' }]), []);
    assert.deepStrictEqual(extractMcpServerNamesFromTools(null), []);
    assert.deepStrictEqual(extractMcpServerNamesFromTools(undefined), []);
  });
});

describe('relay-path: fallback nativo quando MCP bloqueado (Access denied)', () => {
  const denied = 'Error: Access denied - path outside allowed directories. Rejeitado.';
  const directive = MCP_NATIVE_FS_FALLBACK_DIRECTIVE.trim();

  it('reconhece o bloqueio via regex', () => {
    assert.ok(MCP_ACCESS_DENIED_RE.test(denied));
    assert.ok(MCP_ACCESS_DENIED_RE.test('access denied - path outside allowed directories'));
    assert.ok(!MCP_ACCESS_DENIED_RE.test('ok: arquivo lido com sucesso'));
  });

  it('anexa a diretiva à tool message com string e preserva o erro original', () => {
    const body: any = {
      model: 'x',
      messages: [
        { role: 'user', content: 'leia o arquivo' },
        { role: 'tool', tool_call_id: 'c1', content: denied },
      ],
    };
    const out = applyMcpNativeFilesystemFallback(body);
    const toolMsg = out.messages[1];
    assert.ok((toolMsg.content as string).startsWith(denied), 'erro original preservado no início');
    assert.ok((toolMsg.content as string).includes(directive), 'diretiva de fallback anexada');
    assert.ok((toolMsg.content as string).includes('Write'));
  });

  it('idempotente: não anexa 2x (marcador)', () => {
    const body: any = { model: 'x', messages: [{ role: 'tool', content: denied }] };
    const once = applyMcpNativeFilesystemFallback(body);
    const twice = applyMcpNativeFilesystemFallback(once);
    assert.strictEqual(twice.messages[0].content, once.messages[0].content);
  });

  it('suporta content em array de partes (OpenAI multimodal)', () => {
    const body: any = { model: 'x', messages: [{ role: 'tool', content: [{ type: 'text', text: denied }] }] };
    const out = applyMcpNativeFilesystemFallback(body);
    const parts = out.messages[0].content as any[];
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[0].text, denied);
    assert.ok(parts[1].text.includes('Write'));
  });

  it('role function também recebe o fallback', () => {
    const body: any = { model: 'x', messages: [{ role: 'function', name: 'run_mcp', content: denied }] };
    const out = applyMcpNativeFilesystemFallback(body);
    assert.ok((out.messages[0].content as string).includes(directive));
  });

  it('sem bloqueio: corpo retornado intacto (mesma referência)', () => {
    const body: any = {
      model: 'x',
      messages: [
        { role: 'user', content: 'oi' },
        { role: 'tool', content: 'ok: pronto' },
      ],
    };
    assert.strictEqual(applyMcpNativeFilesystemFallback(body), body);
  });

  it('corpo sem messages: intacto', () => {
    const body: any = { model: 'x' };
    assert.strictEqual(applyMcpNativeFilesystemFallback(body), body);
  });
});

describe('relay-path: escudo defensivo — colapso de barras duplas', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it("'\/src//*.ts' (glob de busca) colapsa para '\/src/*.ts'", () => {
    assert.equal(sanitizePathValue('src//*.ts', ROOT), 'C:\\Users\\Lucas\\projeto\\src\\*.ts');
    const out = sanitizeToolCallArguments('GlobSearch', { query: '/src//*.ts', pattern: 'src//*.ts' }, ROOT) as any;
    assert.equal(out.query, '/src/*.ts');
    assert.equal(out.pattern, 'src/*.ts');
  });

  it("glob '/\/src//*.ts' com raiz Windows resolve como relativo ao projeto", () => {
    assert.equal(sanitizePathValue('/src//*.ts', ROOT), 'C:\\Users\\Lucas\\projeto\\src\\*.ts');
  });

  it('UNC ("//server/share") preserva o prefixo duplo; "C://Users" colapsa', () => {
    assert.equal(sanitizePathValue('//server/share/file.ts', ROOT), '\\\\server\\share\\file.ts');
    assert.equal(sanitizePathValue('C://Users/Lucas/x.ts', ROOT), 'C:\\Users\\Lucas\\x.ts');
  });

  it('POSIX (sys-root) intacto com raiz Windows; barra única acidental é relativa', () => {
    assert.equal(sanitizePathValue('/home/dev/app/x.ts', ROOT), '/home/dev/app/x.ts');
  });
});

describe('relay-path: escudo defensivo — leitura por nome simples (basename)', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it("extractKnownRelativePaths varre textos e tool_calls para 'anti-lazy.ts'", () => {
    const body: any = {
      messages: [
        { role: 'user', content: 'Veja src/middlewares/anti-lazy.ts e o src/routes/chat.ts' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({ file_path: './src/utils/robust-json.ts' }),
              },
            },
          ],
        },
      ],
    };
    const known = extractKnownRelativePaths(body.messages);
    assert.ok(known.includes('src/middlewares/anti-lazy.ts'), known.join(', '));
    assert.ok(known.includes('src/routes/chat.ts'), known.join(', '));
    assert.ok(known.includes('src/utils/robust-json.ts'), known.join(', '));
  });

  it("Read 'anti-lazy.ts' resolve no subdiretório conhecido (não na raiz)", () => {
    const knownPaths = ['src/middlewares/anti-lazy.ts'];
    const out = sanitizeToolCallArguments('Read', { file_path: 'anti-lazy.ts' }, ROOT, undefined, knownPaths) as any;
    assert.equal(out.file_path, 'C:\\Users\\Lucas\\projeto\\src\\middlewares\\anti-lazy.ts');
  });

  it('Read de basename SEM pista conhecida mantém a raiz (comportamento padrão)', () => {
    const out = sanitizeToolCallArguments('Read', { path: 'anti-lazy.ts' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\anti-lazy.ts');
  });

  it('Escrita (não Read-like) de basename NÃO usa resolução inteligente', () => {
    const knownPaths = ['src/middlewares/anti-lazy.ts'];
    const out = sanitizeToolCallArguments('Write', { path: 'anti-lazy.ts' }, ROOT, undefined, knownPaths) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\anti-lazy.ts');
  });
});

describe('relay-path: escudo defensivo — terminal com espaços/acentos/parenteses', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it("RunCommand 'cd C:/Users/Lucas sá/Documents/Programação/Projeto' cita o caminho", () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'cd C:/Users/Lucas sá/Documents/Programação/Projeto' },
      ROOT
    ) as any;
    assert.equal(out.command, 'cd "C:/Users/Lucas sá/Documents/Programação/Projeto"');
  });

  it('openCode (parênteses no nome) é citado', () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'cd C:/Users/Lucas sá/Documents/Programacao/openCode(1)/app' },
      ROOT
    ) as any;
    assert.equal(out.command, 'cd "C:/Users/Lucas sá/Documents/Programacao/openCode(1)/app"');
  });

  it('tokens comuns e flags continuam SEM aspas (semântica preservada)', () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'node run.js src/tests_stress --flag valor' },
      ROOT
    ) as any;
    assert.equal(out.command, 'node run.js src/tests_stress --flag valor');
  });

  it('tokens JÁ entre aspas são preservados intactos', () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'node run.js "src/a b.ts" --out "dist/x.js"' },
      ROOT
    ) as any;
    assert.equal(out.command, 'node run.js "src/a b.ts" --out "dist/x.js"');
  });

  it('cwd com espaços recebe aspas envolventes', () => {
    const out = sanitizeToolCallArguments('RunCommand', { command: 'echo oi', cwd: 'C:/Users/Lucas sá/projeto' }, ROOT) as any;
    assert.equal(out.cwd, '"C:/Users/Lucas sá/projeto"');
  });
});

describe('relay-path: escudo defensivo — integridade byte-a-byte do conteúdo', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('SearchReplace (string JSON crua): file_path limpo, old/new byte-a-byte intactos', () => {
    const json = '{"file_path": ".\\\\src\\\\logic.ts", "old_string": "cdn\\\\src\\\\app.js", "new_string": "lib   \\"x\\" \\\\ \\n tab\\t"}';
    const out = sanitizeToolCallArguments('SearchReplace', json, ROOT) as string;
    const parsed = JSON.parse(out);
    assert.equal(parsed.file_path, 'C:\\Users\\Lucas\\projeto\\src\\logic.ts');
    assert.equal(parsed.old_string, 'cdn\\src\\app.js');
    assert.equal(parsed.new_string, 'lib   "x" \\ \n tab\t');
  });

  it('Edit: content/code com escapes e crases NÃO é tocado pela sanitização', () => {
    const content = 'const x = `C:\\Users\\x`;  // comentário "aspas"\nlinha2';
    const out = sanitizeToolCallArguments('Edit', { target_file: './src/main.ts', content }, ROOT) as any;
    assert.equal(out.target_file, 'C:\\Users\\Lucas\\projeto\\src\\main.ts');
    assert.equal(out.content, content);
  });

  it('tag acidental no VALOR do path é removida; crase/aspas do content intactas', () => {
    const out = sanitizeToolCallArguments('Write', { path: './src/x<br>.ts', content: '`backtick` "aspas"' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\src\\x.ts');
    assert.equal(out.content, '`backtick` "aspas"');
  });
});

describe('relay-path: escudo defensivo — drive letter e caracteres de controle', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it("'C:' sola preserva a letra do drive (raiz do drive, nunca '/Users/...')", () => {
    assert.equal(sanitizePathValue('C:', ROOT), 'C:\\');
    assert.equal(sanitizePathValue('c:', ROOT), 'c:\\');
    const out = sanitizeToolCallArguments('Read', { path: 'C:' }, ROOT) as any;
    assert.equal(out.path, 'C:\\');
  });

  it('drive com caminho continua absoluto (nunca concatena o root)', () => {
    assert.equal(sanitizePathValue('C:', ROOT), 'C:\\');
    assert.equal(sanitizePathValue('c:/Users/Lucas/x.ts', ROOT), 'c:\\Users\\Lucas\\x.ts');
  });

  it('NUL bytes e control chars não quebram o path (viram separador/removidos)', () => {
    const out = sanitizeToolCallArguments('Read', { path: 'src\x00\u0001/x.ts' }, ROOT) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\src\\x.ts');
    assert.ok(!out.path.includes('\u0000'));
    assert.ok(!out.path.includes('\u0001'));
  });

  it('stripControlChars preserva \\t \\n \\r e remove o resto', () => {
    assert.equal(stripControlChars('a\x00b\x0Ac\x09d\x0De\u007F'), 'ab\nc\td\re');
  });

  it('robustParseJSON descarta NUL sem quebrar', () => {
    const parsed = robustParseJSON('{"name":"Read","arguments":{"path":"src/x.ts\u0000y"}}') as any;
    assert.equal(parsed.name, 'Read');
    assert.equal(parsed.arguments.path, 'src/x.tsy');
  });
});

describe('relay-path: sanitizeToolOutput — limpeza estrita de tags de erro da IDE', () => {
  it('remove bloco fechado <toolcall_error_message> e expõe "Error: ..."', () => {
    const raw = '<toolcall_error_message>File not found: src/x.ts</toolcall_error_message>';
    assert.equal(sanitizeToolOutput(raw), 'Error: File not found: src/x.ts');
  });

  it('remove tag de fechamento solta </toolcall_error_message> e self-closed', () => {
    assert.equal(sanitizeToolOutput('texto</toolcall_error_message>'), 'texto');
    assert.equal(sanitizeToolOutput('<toolcall_error_message/>texto'), 'texto');
  });

  it('bloco SEM fechamento: abertura vira "Error: " e o texto não é perdido', () => {
    assert.equal(sanitizeToolOutput('<toolcall_error_message>acesso negado'), 'Error: acesso negado');
  });

  it('tags de result/status viram só o texto interno (sem markup)', () => {
    const raw = '<toolcall_result>{"type":"text","output":"ok"}</toolcall_result> <toolcall_status>done</toolcall_status>';
    assert.equal(sanitizeToolOutput(raw), '{"type":"text","output":"ok"} done');
  });

  it('idempotente: rodar 2x não degrada o texto', () => {
    const raw = '<toolcall_error_message>boom</toolcall_error_message>';
    const once = sanitizeToolOutput(raw) as string;
    assert.equal(sanitizeToolOutput(once), once);
  });

  it('suporta content em array de partes OpenAI (texto limpo, resto intacto)', () => {
    const parts: any[] = [
      { type: 'text', text: '<toolcall_error_message>erro</toolcall_error_message>' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ];
    const out = sanitizeToolOutput(parts) as any[];
    assert.equal(out[0].text, 'Error: erro');
    assert.strictEqual(out[1], parts[1]);
  });

  it('applyToolOutputSanitization limpa TODAS as mensagens do corpo', () => {
    const body: any = {
      model: 'x',
      messages: [
        { role: 'user', content: 'ok antes' },
        { role: 'tool', content: '<toolcall_error_message>acesso negado</toolcall_error_message>' },
        { role: 'assistant', content: [{ type: 'text', text: '<toolcall_status>done</toolcall_status> fim' }] },
      ],
    };
    const out = applyToolOutputSanitization(body);
    assert.equal(out.messages[0].content, 'ok antes');
    assert.equal(out.messages[1].content, 'Error: acesso negado');
    assert.equal((out.messages[2].content as any[])[0].text, 'done fim');
  });

  it('sem tags: corpo intacto (mesma referência)', () => {
    const body: any = { model: 'x', messages: [{ role: 'tool', content: 'resultado simples' }] };
    assert.strictEqual(applyToolOutputSanitization(body), body);
  });

  it('normaliza erro cru de parâmetro de terminal para mensagem amigável', () => {
    const out = sanitizeToolOutput('invalid params: deserialize params error: missing field command') as string;
    assert.ok(out.startsWith('Error:'), out);
    assert.ok(out.includes('comando de terminal'), out);
    assert.ok(!out.includes('deserialize'), 'não pode vazar o erro cru: ' + out);
  });

  it('normaliza InvalidEndOfLine / invalid end of line', () => {
    const a = sanitizeToolOutput('InvalidEndOfLine when parsing this param') as string;
    const b = sanitizeToolOutput('invalid end of line at char 5') as string;
    assert.ok(a.startsWith('Error:'), a);
    assert.ok(b.startsWith('Error:'), b);
    assert.ok(!a.includes('InvalidEndOfLine'), 'não pode vazar o erro cru: ' + a);
  });

  it('erro de terminal amigável é idempotente', () => {
    const raw = 'invalid params: deserialize params error: missing field command';
    const once = sanitizeToolOutput(raw) as string;
    assert.equal(sanitizeToolOutput(once), once);
  });

  it('mensagem de tool com erro de terminal em array de partes também é normalizada', () => {
    const parts: any[] = [
      { type: 'text', text: 'invalid params: deserialize params error: missing field command' },
    ];
    const out = sanitizeToolOutput(parts) as any[];
    assert.ok((out[0].text as string).startsWith('Error:'), out[0].text);
    assert.ok(!out[0].text.includes('deserialize'));
  });

  it('ENOENT com fd.exe ausente (Glob/LS/SearchCodebase) vira fallback de busca por protocolo', () => {
    const raw = '<toolcall_error_message>Error: ENOENT: no such file or directory, spawn \'C:\\tools\\fd.exe\'</toolcall_error_message>';
    const out = sanitizeToolOutput(raw) as string;
    assert.ok(out.includes('[PROXY SEARCH FALLBACK]'), out);
    assert.ok(out.includes('NÃO repita buscas que dependam de "fd.exe"'), out);
    assert.ok(!out.includes('ENOENT'), 'não pode vazar o erro cru: ' + out);
    assert.ok(!out.includes('spawn'), 'não pode vazar o erro cru: ' + out);
  });

  it('ripgrep/rg.exe ausente também é normalizado (busca por binário externo)', () => {
    const a = sanitizeToolOutput("Error: spawn ripgrep ENOENT: no such file or directory") as string;
    const b = sanitizeToolOutput("Error: spawn 'rg.exe' ENOENT") as string;
    assert.ok(a.includes('[PROXY SEARCH FALLBACK]'), a);
    assert.ok(b.includes('[PROXY SEARCH FALLBACK]'), b);
    assert.ok(!a.includes('spawn'), a);
  });

  it('ENOENT de ARQUIVO não encontrado (Read) NÃO é tratado como binário ausente', () => {
    const raw = "Error: ENOENT: no such file or directory, open 'C:\\Users\\Lucas\\projeto\\src\\nao-existe.ts'";
    assert.equal(sanitizeToolOutput(raw), raw);
  });

  it('erro de shell sem binário de busca (spawn sh) NÃO é desviado para fallback de busca', () => {
    const raw = 'Error: spawn sh ENOENT';
    assert.equal(sanitizeToolOutput(raw), raw);
  });

  it('fallback de busca é idempotente (não re-dispara na próxima passada)', () => {
    const raw = "Error: ENOENT: no such file or directory, spawn 'fd.exe'";
    const once = sanitizeToolOutput(raw) as string;
    assert.ok(once.includes('[PROXY SEARCH FALLBACK]'), once);
    assert.equal(sanitizeToolOutput(once), once);
  });
});

describe('relay-path: leitura de arquivos de RAÍZ (package.json etc.) resolve no workspaceRoot', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it("Read com 'package.json' resolve direto no workspaceRoot (sem retries)", () => {
    const out = sanitizeToolCallArguments('Read', { file_path: 'package.json' }, ROOT) as any;
    assert.equal(out.file_path, 'C:\\Users\\Lucas\\projeto\\package.json');
  });

  it("'package.json' ganha da resolução inteligente de subdiretórios conhecidos", () => {
    const knownPaths = ['src/config/package.json', 'src/middlewares/anti-lazy.ts'];
    const out = sanitizeToolCallArguments('Read', { path: 'package.json' }, ROOT, undefined, knownPaths) as any;
    assert.equal(out.path, 'C:\\Users\\Lucas\\projeto\\package.json');
  });

  it("outros arquivos de raiz também resolvem no workspaceRoot ('.env', 'tsconfig.json')", () => {
    assert.equal(
      (sanitizeToolCallArguments('Read', { path: '.env' }, ROOT) as any).path,
      'C:\\Users\\Lucas\\projeto\\.env'
    );
    assert.equal(
      (sanitizeToolCallArguments('Read', { path: 'tsconfig.json' }, ROOT) as any).path,
      'C:\\Users\\Lucas\\projeto\\tsconfig.json'
    );
  });

  it("basename comum (fora da lista de raiz) continua usando subdiretórios conhecidos", () => {
    const knownPaths = ['src/middlewares/anti-lazy.ts'];
    const out = sanitizeToolCallArguments('Read', { file_path: 'anti-lazy.ts' }, ROOT, undefined, knownPaths) as any;
    assert.equal(out.file_path, 'C:\\Users\\Lucas\\projeto\\src\\middlewares\\anti-lazy.ts');
  });
});

describe('relay-path: RunCommand com caracteres especiais do shell NÃO é duplamente quotado', () => {
  const ROOT = 'C:/Users/Lucas/projeto';

  it('pipe "|" e operadores permanecem SEM aspas; só o caminho com espaço é quotado', () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'Get-Content C:/Users/Lucas sá/log.txt | Select-Object -First 5' },
      ROOT
    ) as any;
    assert.equal(out.command, 'Get-Content "C:/Users/Lucas sá/log.txt" | Select-Object -First 5');
  });

  it('"&&", ">", ";" não recebem aspas (sintaxe de shell preservada)', () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'npm run build && node server.js' },
      ROOT
    ) as any;
    assert.equal(out.command, 'npm run build && node server.js');
    const redir = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'echo oi > out.txt ; echo fim' },
      ROOT
    ) as any;
    assert.equal(redir.command, 'echo oi > out.txt ; echo fim');
  });

  it('snippet JÁ entre aspas com pipe interno é preservado (sem escape duplo)', () => {
    const out = sanitizeToolCallArguments(
      'RunCommand',
      { command: 'powershell -Command "Get-ChildItem | Select-Object Name"' },
      ROOT
    ) as any;
    assert.equal(out.command, 'powershell -Command "Get-ChildItem | Select-Object Name"');
  });
});