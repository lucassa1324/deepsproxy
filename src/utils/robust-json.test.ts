/*
 * File: robust-json.test.ts
 * Project: deepsproxy
 * Testes do pipeline de serialização de argumentos de tool calls: o payload
 * enviado à IDE/API NUNCA pode conter o literal 'undefined' — campos de string
 * obrigatórios (content/path/filePath/command) caem para '' quando vêm null,
 * undefined ou ausentes (criação de arquivo).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { robustParseJSON } from './robust-json.ts';
import { sanitizeToolCallArguments } from '../services/relay-path.ts';

describe('robust-json: serialização de arguments de tool calls', () => {
  it('criação de arquivo com conteúdo vazio/ausente NUNCA gera "undefined" no JSON', () => {
    const ROOT = 'C:/Users/Lucas/projeto';

    // 1) `content: null` vindo do JSON do modelo → ''.
    const viaNull = sanitizeToolCallArguments('Write', { path: 'src/novo.txt', content: null }, ROOT) as any;
    // 2) `content` literalmente undefined (objeto programático) → ''.
    const viaUndefined = sanitizeToolCallArguments('Write', { path: 'src/novo.txt', content: undefined }, ROOT) as any;
    // 3) Campo 'content' AUSENTE na criação de arquivo → '' injetado.
    const viaMissing = sanitizeToolCallArguments('Write', { path: 'src/sem-conteudo.txt' }, ROOT) as any;
    // 4) Pipeline real do gateway: robustParseJSON (stream) → sanitize → stringify.
    const parsed = robustParseJSON('{"path": "src/via-json.txt", "content": null}') as any;
    const viaJson = sanitizeToolCallArguments('Write', parsed, ROOT) as any;

    for (const args of [viaNull, viaUndefined, viaMissing, viaJson]) {
      const json = JSON.stringify(args);
      assert.ok(!json.includes('undefined'), `JSON não pode conter "undefined": ${json}`);
    }

    assert.equal(viaNull.content, '');
    assert.equal(viaUndefined.content, '');
    assert.equal(viaMissing.content, '');
    assert.equal(viaJson.content, '');
  });
});