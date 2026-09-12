/*
 * File: anti-lazy-guard.test.ts
 * Testes dos detectores de resposta passiva/preguiçosa:
 *  - isPassiveResponse (services/validation-guard.ts)
 *  - isLazyCompletion  (middlewares/anti-lazy.ts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPassiveResponse } from './services/validation-guard.ts';
import { isLazyCompletion, isTaskRefusal } from './middlewares/anti-lazy.ts';

const DEFAULT_REFUSAL =
  'Aguardando a instrução/tarefa do usuário (a última mensagem do usuário não continha ' +
  'uma solicitação específica de alteração ou funcionalidade, apenas o contexto e as ' +
  'diretrizes do proxy). Por favor, informe qual alteração, correção ou nova ' +
  'funcionalidade você deseja implementar neste projeto de agendamentos.';

const SECOND_REFUSAL =
  'O usuário esqueceu de incluir a tarefa na última mensagem ou a mensagem está vazia. ' +
  'Como o projeto é um "Sistema de Agendamentos" simples em Bun/SQLite com frontend ' +
  'estático, preciso saber o que o usuário quer fazer (ex: adicionar uma nova ' +
  'funcionalidade, corrigir um bug, etc.). ' +
  'Vou perguntar diretamente ao usuário qual é a tarefa desejada para este projeto.';

describe('anti-lazy guard: resposta passiva de recusa', () => {
  it('"Aguardando a instrução/tarefa do usuário" é passiva (sem tool_calls)', () => {
    assert.equal(isPassiveResponse(DEFAULT_REFUSAL, undefined), true);
    assert.equal(isLazyCompletion(DEFAULT_REFUSAL, undefined), true);
    assert.equal(isLazyCompletion(DEFAULT_REFUSAL, []), true);
  });

  it('"esqueceu de incluir a tarefa... vou perguntar qual é a tarefa" é passiva', () => {
    assert.equal(isPassiveResponse(SECOND_REFUSAL, undefined), true);
    assert.equal(isLazyCompletion(SECOND_REFUSAL, undefined), true);
    assert.equal(isTaskRefusal(SECOND_REFUSAL), true);
  });

  it('"informe qual alteração você deseja" é passiva', () => {
    const t = 'Por favor, informe qual alteração, correção ou nova funcionalidade você deseja implementar.';
    assert.equal(isPassiveResponse(t, undefined), true);
    assert.equal(isLazyCompletion(t, undefined), true);
  });

  it('recusa NÃO é passiva quando há tool_calls', () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] as any;
    assert.equal(isPassiveResponse(DEFAULT_REFUSAL, toolCalls), false);
    assert.equal(isLazyCompletion(DEFAULT_REFUSAL, toolCalls), false);
  });

  it('resposta genuína com alteração implementada NÃO é passiva', () => {
    const done = 'Apliquei as alterações em package.json e o servidor subiu com bun dev.';
    assert.equal(isPassiveResponse(done, undefined), false);
    assert.equal(isLazyCompletion(done, undefined), false);
    assert.equal(isTaskRefusal(done), false);
  });

  it('resposta que pergunta e menciona tarefa (regra estrutural) é passiva', () => {
    const rewording =
      'Antes de seguir, me diga: qual é exatamente a mudança que você espera na estrutura de agendamentos?';
    assert.equal(isTaskRefusal(rewording), true);
    assert.equal(isLazyCompletion(rewording, undefined), true);
  });
});