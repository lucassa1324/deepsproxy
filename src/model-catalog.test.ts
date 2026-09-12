/*
 * File: model-catalog.test.ts
 * Testes do catálogo unificado de modelos: prioridade da API oficial do
 * Gemini (com chave) sobre o gemini-web (navegador) para ids colidentes.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderRegistry } from './services/config.ts';
import { getModelCatalog, resolveModelEntry, resetModelCatalogCache } from './services/modelCatalog.ts';

const registry = {
  active: 'g',
  providers: [
    {
      id: 'g',
      name: 'Google AI',
      type: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKeys: [{ id: 'k1', label: 'k', key: 'AIzaSyTest', status: 'active', resetAt: null }],
      model: '',
      enabled: true,
    },
    {
      id: 'w',
      name: 'Gemini (Web)',
      type: 'gemini-web',
      baseUrl: '',
      apiKey: '',
      model: '',
      enabled: true,
    },
  ],
} as unknown as ProviderRegistry;

function mockGeminiModels() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.includes('/models?key=')) {
      return new Response(
        JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemma-4-27b-it', supportedGenerationMethods: ['generateContent'] },
          ],
        })
      );
    }
    return new Response('{}', { status: 404 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe('modelCatalog: prioridade da API oficial sobre o gemini-web', () => {
  beforeEach(() => resetModelCatalogCache());

  it('id colidindo (gemini-2.5-flash) resolve para o provedor oficial quando há chave', async () => {
    const restore = mockGeminiModels();
    try {
      const entry = await resolveModelEntry('gemini-2.5-flash', registry);
      assert.ok(entry);
      assert.equal(entry!.providerType, 'gemini');
    } finally {
      restore();
      resetModelCatalogCache();
    }
  });

  it('duplicados (id + providerType) coexistem; o web continua no catálogo', async () => {
    const restore = mockGeminiModels();
    try {
      const catalog = await getModelCatalog(registry);
      const sameId = catalog.filter((m) => m.id === 'gemini-2.5-flash');
      assert.ok(sameId.some((m) => m.providerType === 'gemini'), 'esperava entrada oficial');
      assert.ok(sameId.some((m) => m.providerType === 'gemini-web'), 'esperava entrada web');
    } finally {
      restore();
      resetModelCatalogCache();
    }
  });

  it('modelo sem conflito aponta para o provedor oficial que o expôs', async () => {
    const restore = mockGeminiModels();
    try {
      const entry = await resolveModelEntry('gemma-4-27b-it', registry);
      assert.ok(entry);
      assert.equal(entry!.providerType, 'gemini');
    } finally {
      restore();
      resetModelCatalogCache();
    }
  });
});