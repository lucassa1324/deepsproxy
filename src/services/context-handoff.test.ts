/*
 * File: context-handoff.test.ts
 * Project: deepsproxy
 * Testes do Context Handoff: resumo de contexto injetado quando uma conversa
 * troca de modelo (sticky session / failover / troca de app no painel).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_MAX_TOKENS,
  _clearStoreForTesting,
  deriveSessionKey,
  getContextHandoffMode,
  getHandoffStoreSize,
  hasPriorModel,
  maybeInjectContextHandoff,
  recordIncomingMessages,
  recordSuccessfulModel,
} from './context-handoff.ts';

const MARKER = 'DeepsProxy context handoff:';

function handoffSystem(messages: any[]): any {
  return messages.find((m) => m?.role === 'system' && String(m.content).startsWith(MARKER));
}

// ── Modo (env) ──────────────────────────────────────────────────────────

test('getContextHandoffMode: padrão é on_model_switch e desliga só com valor explícito', () => {
  const prevDeep = process.env.DEEPSPROXY_CONTEXT_HANDOFF;
  const prevAlias = process.env.FREELLMAPI_CONTEXT_HANDOFF;
  try {
    delete process.env.DEEPSPROXY_CONTEXT_HANDOFF;
    delete process.env.FREELLMAPI_CONTEXT_HANDOFF;
    assert.equal(getContextHandoffMode(), 'on_model_switch');

    for (const off of ['off', '0', 'false', 'no', 'OFF']) {
      process.env.DEEPSPROXY_CONTEXT_HANDOFF = off;
      assert.equal(getContextHandoffMode(), 'off', `"${off}" deveria desligar`);
    }

    process.env.DEEPSPROXY_CONTEXT_HANDOFF = 'on_model_switch';
    assert.equal(getContextHandoffMode(), 'on_model_switch');

    // Alias FREELLMAPI_* continua aceito.
    delete process.env.DEEPSPROXY_CONTEXT_HANDOFF;
    process.env.FREELLMAPI_CONTEXT_HANDOFF = 'off';
    assert.equal(getContextHandoffMode(), 'off');
  } finally {
    if (prevDeep === undefined) delete process.env.DEEPSPROXY_CONTEXT_HANDOFF;
    else process.env.DEEPSPROXY_CONTEXT_HANDOFF = prevDeep;
    if (prevAlias === undefined) delete process.env.FREELLMAPI_CONTEXT_HANDOFF;
    else process.env.FREELLMAPI_CONTEXT_HANDOFF = prevAlias;
  }
});

// ── Chave de sessão ─────────────────────────────────────────────────────

test('deriveSessionKey: usa X-Session-ID quando presente; senão hash estável das mensagens', () => {
  assert.equal(deriveSessionKey('abc', []), 'header:abc');

  const msgs = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'oi' },
  ];
  const a = deriveSessionKey(null, msgs);
  const b = deriveSessionKey(undefined, msgs);
  assert.equal(a, b, 'mesma conversa => mesma chave');
  assert.match(a, /^hash:[0-9a-f]{64}$/);

  const other = deriveSessionKey(null, [{ role: 'user', content: 'outra conversa' }]);
  assert.notEqual(a, other, 'conversas diferentes => chaves diferentes');
});

// ── Injeção na troca de modelo ──────────────────────────────────────────

test('handoff: injeta resumo do histórico quando a sessão troca de modelo', () => {
  _clearStoreForTesting();
  const sessionKey = 'sess-switch';
  const messages = [
    { role: 'user', content: 'Implemente a feature X' },
    { role: 'assistant', content: 'Feito, criei o arquivo x.ts' },
    { role: 'user', content: 'Agora adicione testes' },
  ];

  recordIncomingMessages(sessionKey, messages);
  recordSuccessfulModel({ sessionKey, modelKey: 'provA/modelo-1' });
  assert.equal(hasPriorModel(sessionKey), true, 'deve haver modelo anterior registrado');

  const result = maybeInjectContextHandoff({
    mode: 'on_model_switch',
    sessionKey,
    messages,
    selectedModelKey: 'provB/modelo-2',
  });

  assert.equal(result.injected, true);
  assert.ok(result.injectedTokens > 0);
  assert.equal(result.messages.length, messages.length + 1, 'uma mensagem de system extra');

  const injected = handoffSystem(result.messages);
  assert.ok(injected, 'mensagem de handoff presente');
  assert.match(injected.content, /provA\/modelo-1 → provB\/modelo-2/);
  assert.ok(injected.content.includes('Implemente a feature X'), 'resumo traz os turnos recentes');
  assert.ok(injected.content.includes('Agora adicione testes'), 'inclui a última mensagem do usuário');
});

test('handoff: NÃO injeta quando o modelo é o mesmo da última resposta', () => {
  _clearStoreForTesting();
  const sessionKey = 'sess-same';
  const messages = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'olá' },
    { role: 'user', content: 'tudo bem?' },
  ];
  recordIncomingMessages(sessionKey, messages);
  recordSuccessfulModel({ sessionKey, modelKey: 'provA/modelo-1' });

  const result = maybeInjectContextHandoff({
    mode: 'on_model_switch',
    sessionKey,
    messages,
    selectedModelKey: 'provA/modelo-1',
  });
  assert.equal(result.injected, false);
  assert.equal(result.messages, messages, 'sem troca de modelo as mensagens são intocadas');
  assert.equal(result.injectedTokens, 0);
});

test('handoff: NÃO injeta quando o modo é off', () => {
  _clearStoreForTesting();
  const sessionKey = 'sess-off';
  const messages = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'olá' },
  ];
  recordIncomingMessages(sessionKey, messages);
  recordSuccessfulModel({ sessionKey, modelKey: 'provA/m1' });

  const result = maybeInjectContextHandoff({
    mode: 'off',
    sessionKey,
    messages,
    selectedModelKey: 'provB/m2',
  });
  assert.equal(result.injected, false);
  assert.equal(result.messages, messages);
});

test('handoff: NÃO injeta numa conversa nova (sem modelo anterior registrado)', () => {
  _clearStoreForTesting();
  const sessionKey = 'sess-fresh';
  const messages = [{ role: 'user', content: 'primeira mensagem' }];
  recordIncomingMessages(sessionKey, messages);

  const result = maybeInjectContextHandoff({
    mode: 'on_model_switch',
    sessionKey,
    messages,
    selectedModelKey: 'provA/m1',
  });
  assert.equal(result.injected, false);
});

test('handoff: é idempotente (não duplica o resumo já presente)', () => {
  _clearStoreForTesting();
  const sessionKey = 'sess-idem';
  const messages = [
    { role: 'user', content: 'tarefa antiga' },
    { role: 'assistant', content: 'resposta antiga' },
  ];
  recordIncomingMessages(sessionKey, messages);
  recordSuccessfulModel({ sessionKey, modelKey: 'provA/m1' });

  const first = maybeInjectContextHandoff({
    mode: 'on_model_switch',
    sessionKey,
    messages,
    selectedModelKey: 'provB/m2',
  });
  assert.equal(first.injected, true);

  const second = maybeInjectContextHandoff({
    mode: 'on_model_switch',
    sessionKey,
    messages: first.messages,
    selectedModelKey: 'provB/m2',
  });
  assert.equal(second.injected, false, 'handoff já presente não é re-injetado');
});

test('handoff: inserido após os system prompts de abertura, antes da conversa', () => {
  _clearStoreForTesting();
  const sessionKey = 'sess-pos';
  const messages = [
    { role: 'system', content: 'S1' },
    { role: 'system', content: 'S2' },
    { role: 'user', content: 'tarefa' },
    { role: 'assistant', content: 'resposta' },
  ];
  recordIncomingMessages(sessionKey, messages);
  recordSuccessfulModel({ sessionKey, modelKey: 'provA/m1' });

  const result = maybeInjectContextHandoff({
    mode: 'on_model_switch',
    sessionKey,
    messages,
    selectedModelKey: 'provB/m2',
  });

  assert.equal(result.injected, true);
  assert.equal(result.messages[0].content, 'S1');
  assert.equal(result.messages[1].content, 'S2');
  assert.ok(String(result.messages[2].content).startsWith(MARKER), 'handoff logo após os system');
  assert.equal(result.messages[3].content, 'tarefa');
});

test('handoff: conversa nova (sem assistant no histórico) limpa o modelo anterior', () => {
  _clearStoreForTesting();
  const sessionKey = 'sess-reset';
  recordSuccessfulModel({ sessionKey, modelKey: 'provA/m1' });
  assert.equal(hasPriorModel(sessionKey), true);

  // Novo request sem nenhum assistant => tratado como conversa nova.
  recordIncomingMessages(sessionKey, [{ role: 'user', content: 'começando do zero' }]);
  assert.equal(hasPriorModel(sessionKey), false);

  const result = maybeInjectContextHandoff({
    mode: 'on_model_switch',
    sessionKey,
    messages: [{ role: 'user', content: 'começando do zero' }],
    selectedModelKey: 'provB/m2',
  });
  assert.equal(result.injected, false, 'sem contexto anterior não há handoff');
});

// ── Store / utilitários ─────────────────────────────────────────────────

test('store: registra sessões, expõe tamanho e limpa para testes', () => {
  _clearStoreForTesting();
  assert.equal(getHandoffStoreSize(), 0);

  recordIncomingMessages('a', [{ role: 'user', content: 'oi' }]);
  recordSuccessfulModel({ sessionKey: 'b', modelKey: 'prov/m' });
  assert.equal(getHandoffStoreSize(), 2);

  _clearStoreForTesting();
  assert.equal(getHandoffStoreSize(), 0);
  assert.equal(hasPriorModel('b'), false);
});

test('HANDOFF_MAX_TOKENS é coerente com o teto de caracteres', () => {
  assert.ok(HANDOFF_MAX_TOKENS > 0);
  assert.ok(Number.isInteger(HANDOFF_MAX_TOKENS));
});
