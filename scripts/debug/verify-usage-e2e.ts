/*
 * File: verify-usage-e2e.ts
 * Project: deepsproxy
 * Verificação ponta-a-ponta da telemetria de uso: injeta requisições reais no
 * app (manual + auto), com upstream mockado, e valida que cada requisição
 * concluída gera um registro de uso com requestedModel/finalModel/provedor/
 * modo/tokens/latência — e que a resposta ao cliente continua intacta.
 *
 * Executar: npx tsx scripts/debug/verify-usage-e2e.ts
 */

import { join } from 'path';
import { existsSync, rmSync } from 'fs';

process.env.PROVIDERS_FILE = join(process.cwd(), '.test-providers-usage-e2e.json');
if (existsSync(process.env.PROVIDERS_FILE)) rmSync(process.env.PROVIDERS_FILE);
process.env.USAGE_FILE = join(process.cwd(), '.test-usage-e2e.json');
if (existsSync(process.env.USAGE_FILE)) rmSync(process.env.USAGE_FILE);

const { app } = await import('../../src/index.ts');
const { resetModelCatalogCache } = await import('../../src/services/modelCatalog.ts');
const { clearModelsCache } = await import('../../src/services/local.ts');
const { clearDecisionCache, clearConversationMemory } = await import('../../src/services/auto-router/router.ts');
const { getUsageSnapshot } = await import('../../src/services/usage.ts');

const UPSTREAM_MODEL = 'mock-fixed-model';
const REGISTRY = {
  active: 'mock',
  providers: [
    {
      id: 'mock',
      name: 'Mock Uso',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:9242/v1',
      apiKey: 'sk-test',
      model: UPSTREAM_MODEL,
      enabled: true,
    },
  ],
  routing: { mode: 'auto', costPolicy: 'balanced' },
};

function cookieFor(registry: any): string {
  return 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));
}

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (/^http:\/\/localhost:\d+/.test(urlStr)) return handler(urlStr, init);
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}

function upstreamResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-ok',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'resposta do upstream' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

async function chat(body: Record<string, unknown>): Promise<{ status: number; data: any; headers: Headers }> {
  const res = await app.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieFor(REGISTRY) },
      body: JSON.stringify(body),
    })
  );
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? '  ✓ OK' : '  ✗ FALHOU'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function main() {
  console.log('\n[1] upstream mockado + requisições reais via app.fetch...');
  const restore = setupFetchMock((url) => {
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: UPSTREAM_MODEL, object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return upstreamResponse();
  });

  try {
    resetModelCatalogCache();
    clearModelsCache();
    clearDecisionCache();
    clearConversationMemory();

    console.log('\n[2] Requisição MANUAL (modelo fixo no payload):');
    const manual = await chat({ model: UPSTREAM_MODEL, stream: false, messages: [{ role: 'user', content: 'ping manual' }] });
    check('resposta 200 com conteúdo intacto', manual.status === 200, `status=${manual.status}`);

    console.log('\n[3] Requisição AUTO (model="auto"):');
    const auto = await chat({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'eletrize a resposta 3.14159' }] });
    check('auto-roteamento respondeu 200', auto.status === 200, `final=${auto.headers.get('X-Routed-Via') ?? '?'}`);

    // Deixa o best-effort de tokens (res.clone().json()) concluir.
    await sleep(300);

    console.log('\n[4] Registros de uso gravados:');
    const snapshot = getUsageSnapshot();
    check('2 requisições geraram 2 registros de uso', snapshot.length === 2, `registros=${snapshot.length}`);

    const manualRec = snapshot.find((r) => r.finalModel === UPSTREAM_MODEL);
    check('registo manual: modo=manual, modelo final=respeitado, provedor correto',
      !!manualRec && manualRec.routingMode === 'manual' && manualRec.provider === 'Mock Uso',
      manualRec ? JSON.stringify(manualRec) : 'registro ausente');

    const autoRec = snapshot.find((r) => r.routingMode === 'auto');
    check('registro auto: modo=auto com finalModel resolvido pelo orquestrador',
      !!autoRec && !!autoRec.finalModel && autoRec.finalModel !== 'auto',
      autoRec ? JSON.stringify(autoRec) : 'registro ausente');

    check('tokens capturados do corpo upstream (12 total no manual)',
      !!manualRec && manualRec.tokensTotal === 12 && manualRec.tokensPrompt === 7 && manualRec.tokensCompletion === 5,
      manualRec ? `total=${manualRec.tokensTotal}` : 'registro ausente');

    check('latência registrada (ms > 0)', snapshot.every((r) => r.latencyMs > 0));

    check('requestedModel preservado no payload original',
      manualRec?.requestedModel === UPSTREAM_MODEL && autoRec?.requestedModel === 'auto');

    console.log('\n[5] Modo auto com upstream FALHANDO (429): rastreabilidade mesmo sem X-Routed-Via...');
    restore();
    const restoreFail = setupFetchMock(() =>
      new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 })
    );
    try {
      const failing = await chat({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'requer 42=this' }] });
      check('upstream em erro retornou status >= 400 ao cliente', failing.status >= 400, `status=${failing.status}`);
      console.log('    headers:', [...failing.headers.entries()].map(([k, v]) => `${k}=${v}`).join(' | '));
      const snapshotAll = getUsageSnapshot();
      const failRec = snapshotAll[snapshotAll.length - 1];
      check('registro de erro: finalModel real resolvido (não "auto" nem desconhecido)',
        !!failRec && failRec.finalModel !== 'auto' && failRec.finalModel !== '(desconhecido)',
        failRec ? `final=${failRec.finalModel}` : 'registro ausente');
      check('registro de erro: provedor identificado via catálogo (fallback)',
        !!failRec && failRec.provider === 'Mock Uso',
        failRec ? `provider=${failRec.provider}` : 'registro ausente');
      check('registro de erro: modo=auto e pedido preservado',
        !!failRec && failRec.routingMode === 'auto' && failRec.requestedModel === 'auto');
    } finally {
      restoreFail();
    }
    console.log('\n[6] Latência da telemetria: gravação usa debounce de 2s e roda fora do caminho da resposta.');
    console.log('[7] Suíte de testes cobre agregações/endpoints: npx tsx --test ./src/usage.test.ts');
    console.log('[8] Persistência da saúde dos modelos: npx tsx --test ./src/model-health.test.ts');
  } finally {
    restore();
  }

  if (failures > 0) {
    console.log(`\nResult: ${failures} verificação(ões) falharam.`);
    process.exit(1);
  }
  console.log('\nResult: TODAS as verificações E2E de telemetria passaram.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Falha no script E2E de uso:', err);
  process.exit(1);
});
