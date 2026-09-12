/*
 * File: booster.test.ts
 * Project: deepsproxy
 * Testes do Modo Booster (suporte a modelos fracos):
 *  - config por modelo (gateway-booster.json);
 *  - reforço de prompt (regras + few-shot com tool real);
 *  - detecção de tool_call quebrado.
 *
 * O loop corretivo Turn 1..10 (runExecutionLoop) foi removido no refator do
 * Gateway HTTP Puro — a execução local de ferramentas não existe mais.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resetBoosterCache,
  getBoosterSettings,
  updateBoosterSettings,
  toggleModelBooster,
  isModelBoosted,
  DEFAULT_BOOSTER,
} from './services/booster.ts';
import { buildToolsInstructions } from './utils/prompt.ts';
import { looksLikeBrokenToolCall, buildCorrectionMessage } from './tools/executor.ts';

const TEST_BOOSTER_FILE = join(tmpdir(), 'deepsproxy-booster-test.json');

function useTempBoosterFile(): void {
  process.env.BOOSTER_FILE = TEST_BOOSTER_FILE;
  resetBoosterCache();
}

function cleanupTempBoosterFile(): void {
  try {
    if (existsSync(TEST_BOOSTER_FILE)) unlinkSync(TEST_BOOSTER_FILE);
  } catch {
    // ignore
  }
  delete process.env.BOOSTER_FILE;
  resetBoosterCache();
}

test.beforeEach(() => {
  useTempBoosterFile();
});

test.afterEach(() => {
  cleanupTempBoosterFile();
});

test('booster: por padrão nenhum modelo é afetado (opt-in)', () => {
  assert.equal(isModelBoosted('deepseek-thinking'), false);
  assert.equal(isModelBoosted('gemini-3-pro'), false);
  const s = getBoosterSettings();
  assert.equal(s.enabled, DEFAULT_BOOSTER.enabled);
  assert.deepEqual(s.models, []);
});

test('booster: adicionar um modelo ativa só para ele (case-insensitive)', () => {
  toggleModelBooster('qwen2.5-coder:3b', true);
  assert.equal(isModelBoosted('qwen2.5-coder:3b'), true);
  assert.equal(isModelBoosted('QWEN2.5-coder:3b'), true, 'compara ignorando maiúsculas');
  assert.equal(isModelBoosted('qwen2.5:7b'), false, 'outros modelos não são afetados');
  assert.equal(isModelBoosted('deepseek-thinking'), false);
});

test('booster: curinga "*" ativa para todos; remover volta ao normal', () => {
  toggleModelBooster('*', true);
  assert.equal(isModelBoosted('qualquer-coisa'), true);
  assert.equal(isModelBoosted('deepseek-thinking'), true);
  toggleModelBooster('*', false);
  assert.equal(isModelBoosted('qualquer-coisa'), false);
});

test('booster: master off desliga tudo mesmo com modelos cadastrados', () => {
  toggleModelBooster('meu-modelo-fraco', true);
  updateBoosterSettings({ enabled: false });
  assert.equal(isModelBoosted('meu-modelo-fraco'), false);
  assert.equal(getBoosterSettings().models.includes('meu-modelo-fraco'), true, 'lista preservada');
});

test('booster: updateBoosterSettings persiste e devolve cópia', () => {
  const s = updateBoosterSettings({ promptReinforcement: false, correctiveLoop: false, tolerantParser: false });
  assert.equal(s.promptReinforcement, false);
  assert.equal(s.correctiveLoop, false);
  assert.equal(s.tolerantParser, false);
  const reloaded = getBoosterSettings();
  assert.equal(reloaded.promptReinforcement, false);
});

test('booster: buildToolsInstructions sem booster não muda (modelos fortes intactos)', () => {
  const body: any = {
    model: 'gemini-3-pro',
    messages: [],
    tools: [
      {
        type: 'function',
        function: { name: 'Write', description: 'cria arquivo', parameters: { type: 'object' } },
      },
    ],
  };
  const block = buildToolsInstructions(body);
  assert.ok(!block.includes('WEAK MODEL REINFORCEMENT'), 'sem reforço quando booster off');
  assert.ok(block.includes('<tool_call>'));
  assert.ok(block.includes('Detailed schemas'));
  assert.ok(block.includes('GOLDEN RULE FOR Edit/SearchReplace'), 'regra de ouro no contrato de tools');
  assert.ok(block.includes('BYTE FOR BYTE'), 'byte-match explícito');
});

test('booster: buildToolsInstructions com booster injeta reforço + exemplo com tool real', () => {
  const body: any = {
    model: 'qwen2.5-coder:3b',
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'Write',
          description: 'cria arquivo',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['file_path', 'content'],
          },
        },
      },
    ],
  };
  const block = buildToolsInstructions(body, { booster: true });
  assert.ok(block.includes('WEAK MODEL REINFORCEMENT'), 'seção de reforço presente');
  assert.ok(block.includes('"name": "Write"'), 'exemplo usa a tool REAL da requisição');
  assert.ok(block.includes('NEVER claim you performed an action'), 'regra anti-narração');
  assert.ok(block.includes('<tool_call>'), 'exemplo no formato de tags');
  assert.ok(block.includes('"file_path"'), 'argumentos de exemplo seguem o schema');
});

test('booster: looksLikeBrokenToolCall detecta tag aberta e name solto', () => {
  assert.equal(looksLikeBrokenToolCall('<tool_call>{"name": "Write"'), true);
  assert.equal(looksLikeBrokenToolCall('vou criar o arquivo <tool_call> agora'), true);
  assert.equal(looksLikeBrokenToolCall('{"name": "Write", "arguments": {}}'), true);
  assert.equal(looksLikeBrokenToolCall('resposta normal do modelo'), false);
  assert.equal(looksLikeBrokenToolCall(''), false);
});

test('booster: buildCorrectionMessage é explícito sobre não inventar resultado', () => {
  const msg = buildCorrectionMessage('tool_inexistente: Unknown tool');
  assert.ok(msg.includes('tool_inexistente'));
  assert.ok(msg.includes('NUNCA invente o resultado'));
});