/*
 * File: test-orchestrator.ts
 * Project: deepsproxy
 * Script de verificação do Orquestrador (Auto Router):
 *   1. Seleção Manual  — modelo fixo no payload respeitado, exclusivamente.
 *   2. Modo Automático — "auto"/sem modelo → melhor modelo entre ATIVOS.
 *   3. Provedor desativado — requisição ao modelo de um provedor `enabled:false`
 *      é recusada/redirecionada; NUNCA chega ao provedor inativo.
 *   4. Fallback — falha 429 no 1º modelo ativo tenta o próximo.
 *
 * Execução: npx tsx scripts/debug/test-orchestrator.ts
 * Os logs [Orchestrator]/[auto-router] do servidor aparecem no stdout.
 */

import { join } from 'path';
import { existsSync, rmSync } from 'fs';

process.env.PROVIDERS_FILE = join(process.cwd(), '.test-orchestrator-providers.json');
if (existsSync(process.env.PROVIDERS_FILE)) rmSync(process.env.PROVIDERS_FILE);

// Importe APÓS definir PROVIDERS_FILE (leitura lazy do env).
const { app } = await import('../../src/index.ts');
const { resetModelCatalogCache } = await import('../../src/services/modelCatalog.ts');
const { clearModelsCache } = await import('../../src/services/local.ts');
const router = await import('../../src/services/auto-router/router.ts');

function cookieFor(registry: unknown): string {
  return 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));
}

// Mock de fetch: só intercepta os upstreams locais (http://localhost:PORT).
const originalFetch = globalThis.fetch;
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (/^http:\/\/localhost:\d+/.test(urlStr)) return handler(urlStr, init);
    return originalFetch(input, init);
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function okResponse(model: string, label: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-' + label,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: label }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// Dois provedores mock: "ativo" (enabled:true) e "inativo" (enabled:false).
const PORT_ACTIVE = 9502;
const PORT_INACTIVE = 9503;
const hitUpstream: string[] = []; // registra (porta + modelo) de cada chamada

function setupUpstreams() {
  setupFetchMock((url, init) => {
    if (url.endsWith('/models') || url.endsWith('/v1/models')) {
      const port = url.includes(':' + PORT_ACTIVE) ? PORT_ACTIVE : PORT_INACTIVE;
      const ids = port === PORT_ACTIVE ? ['ativo-model-a', 'ativo-model-b'] : ['inativo-model-x'];
      return new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse((init?.body as string) || '{}');
      hitUpstream.push(`${url.includes(':' + PORT_ACTIVE) ? 'ATIVO' : 'INATIVO'}:${body.model}`);
      return okResponse(body.model, 'ok');
    }
    return new Response('{}', { status: 404 });
  });
}

async function postToProxy(model: any, routingMode: 'auto' | 'manual', msg = 'escreva uma função'): Promise<Response> {
  const registry = {
    active: 'ativo',
    providers: [
      {
        id: 'ativo',
        name: 'Provedor Ativo',
        type: 'openai-compatible',
        baseUrl: `http://localhost:${PORT_ACTIVE}/v1`,
        apiKey: 'sk-ativo',
        model: 'ativo-model-a',
        enabled: true,
      },
      {
        id: 'inativo',
        name: 'Provedor Inativo',
        type: 'openai-compatible',
        baseUrl: `http://localhost:${PORT_INACTIVE}/v1`,
        apiKey: 'sk-inativo',
        model: 'inativo-model-x',
        enabled: false,
      },
    ],
    routing: { mode: routingMode, costPolicy: 'balanced' },
  };
  return app.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieFor(registry),
        'X-Request-Id': 'orch-' + Math.random().toString(36).slice(2, 8),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: msg }], stream: false }),
    })
  );
}

function resetState() {
  resetModelCatalogCache();
  clearModelsCache();
  router.clearDecisionCache();
  router.clearConversationMemory();
  hitUpstream.length = 0;
}

async function main() {
  console.log('\n================ ORCHESTRATOR VERIFICATION ================\n');
  setupUpstreams();

  // ── 1. SELEÇÃO MANUAL: modelo fixo 'ativo-model-a' ──────────────────
  resetState();
  console.log('--- [1] Manual: modelo fixo ativo-model-a (modo manual) ---');
  let res = await postToProxy('ativo-model-a', 'manual', 'tarefa manual 1');
  let data = await res.json();
  console.log(`    → HTTP ${res.status} | upstream: ${JSON.stringify(hitUpstream)}`);
  console.log(`    → Resposta: model=${res.headers.get('X-Routed-Via') ?? '(passthrough)'} content="${data.choices?.[0]?.message?.content}"`);
  if (hitUpstream.length !== 1 || !hitUpstream[0].includes('ativo-model-a') || hitUpstream[0].startsWith('INATIVO')) {
    console.log('    ✗ FALHOU: modelo fixo deveria bater exclusivamente no provedor ativo');
    process.exitCode = 1;
  } else {
    console.log('    ✓ OK: modelo fixo encaminhado exclusivamente ao provedor ativo');
  }

  // ── 2. MODO AUTOMÁTICO: model="auto" ────────────────────────────────
  resetState();
  console.log('\n--- [2] Auto: model="auto" com provedor inativo no registro ---');
  res = await postToProxy('auto', 'auto', 'tarefa auto 2');
  data = await res.json();
  console.log(`    → HTTP ${res.status} | headers: Model=${res.headers.get('X-AutoRouter-Model')} Mode=${res.headers.get('X-Routing-Mode')}`);
  console.log(`    → upstream: ${JSON.stringify(hitUpstream)}`);
  if (res.status !== 200 || hitUpstream.some((h) => h.startsWith('INATIVO'))) {
    console.log('    ✗ FALHOU: auto deve escolher entre somente provedores ativos');
    process.exitCode = 1;
  } else {
    console.log('    ✓ OK: auto roteou para modelo de provedor ativo apenas');
  }

  // ── 3. PROVEDOR DESATIVADO: modelo do inativo ───────────────────────
  resetState();
  console.log('\n--- [3] Auto: model="inativo-model-x" (provedor enabled:false) ---');
  res = await postToProxy('inativo-model-x', 'auto', 'tarefa inativo 3');
  data = await res.json();
  console.log(`    → HTTP ${res.status} | upstream: ${JSON.stringify(hitUpstream)}`);
  if (data.choices?.[0]?.message?.content && (res.headers.get('X-AutoRouter-Model') || hitUpstream[0])?.includes('inativo-model-x')) {
    console.log('    ✗ FALHOU: provedor desativado não deveria atender');
    process.exitCode = 1;
  } else {
    console.log(
      `    ✓ OK: requisição recusada/redirecionada (X-AutoRouter-Model=${res.headers.get('X-AutoRouter-Model')}, FinalModel=${res.headers.get('X-AutoRouter-FinalModel')})`
    );
  }

  // ── 3b. Provedor desativado em MODO MANUAL ──────────────────────────
  resetState();
  console.log('\n--- [3b] Manual: model="inativo-model-x" (modo manual) ---');
  res = await postToProxy('inativo-model-x', 'manual', 'tarefa inativo manual 3b');
  data = await res.json();
  console.log(`    → HTTP ${res.status} | upstream: ${JSON.stringify(hitUpstream)}`);
  if (hitUpstream.some((h) => h.startsWith('INATIVO'))) {
    console.log('    ✗ FALHOU: modo manual também não pode encaminhar ao inativo');
    process.exitCode = 1;
  } else {
    console.log('    ✓ OK: requisition não atingiu o provedor desativado (fell back ao principal)');
  }

  // ── 4. FALLBACK: 429 no 1º modelo ativo, 2º succeeds ────────────────
  resetState();
  console.log('\n--- [4] Fallback: 1º modelo 429 → tentar próximo ativo ---');
  let call = 0;
  restoreFetch();
  setupFetchMock((url, init) => {
    if (url.endsWith('/models')) return new Response(
      JSON.stringify({ object: 'list', data: ['ativo-model-a', 'ativo-model-b'].map((id) => ({ id, object: 'model' })) }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse((init?.body as string) || '{}');
      hitUpstream.push(`ATIVO:${body.model}`);
      call++;
      if (call === 1) return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
      return okResponse(body.model, 'fallback-ok');
    }
    return new Response('{}', { status: 404 });
  });
  res = await postToProxy('auto', 'auto', 'tarefa fallback 4');
  data = await res.json();
  console.log(`    → HTTP ${res.status} | attempts=${res.headers.get('X-AutoRouter-Attempts')} failover=${res.headers.get('X-AutoRouter-Failover')}`);
  console.log(`    -> upstream: ${JSON.stringify(hitUpstream)}`);
  if (res.status === 200 && (res.headers.get('X-AutoRouter-Failover') || '') === '1') {
    console.log('    ✓ OK: fallback automático concluiu com o próximo modelo');
  } else {
    console.log('    ✗ (checar logs) fallback não confirmado nos headers');
    process.exitCode = 1;
  }

  restoreFetch();
  rmSync(process.env.PROVIDERS_FILE!, { force: true });
  console.log('\n============================================================\n');
}

main();
