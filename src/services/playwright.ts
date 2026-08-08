/*
 * File: playwright.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};
let loginFlowActive = false;

export function isLoginFlowActive(): boolean {
  return loginFlowActive;
}

/**
 * Diretório do perfil persistente do navegador.
 * Usa DEEPSEEK_PROFILE_DIR quando definido (no Docker aponta para o volume
 * persistente em /app/deepseek_profile); caso contrário usa o default local.
 */
export function getProfileDir(): string {
  return process.env.DEEPSEEK_PROFILE_DIR || path.resolve('deepseek_profile');
}

export function isProfileWritable(): boolean {
  try {
    const dir = getProfileDir();
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function getPlaywrightState() {
  return {
    initialized: context !== null,
    hasActivePage: activePage !== null,
  };
}

export async function getLoginStatus(): Promise<{ loggedIn: boolean; cookieCount: number }> {
  let cookieCount = 0;
  if (context) {
    try {
      cookieCount = (await context.cookies('https://chat.deepseek.com')).length;
    } catch {
      cookieCount = 0;
    }
  }

  // A sessão da DeepSeek web fica no localStorage (chave `userToken`), não em
  // cookie. Se a página já estiver em chat.deepseek.com, lemos direto (rápido,
  // sem navegar); caso contrário cai no check funcional via navegação.
  let loggedIn = false;
  if (activePage) {
    const url = activePage.url();
    if (url.startsWith('https://chat.deepseek.com')) {
      try {
        const token = await activePage.evaluate(() => localStorage.getItem('userToken'));
        loggedIn = !!token;
      } catch {
        loggedIn = false;
      }
    } else {
      loggedIn = await checkLogin();
    }
  }
  return { loggedIn, cookieCount };
}

export async function checkLogin(): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;
  if (!activePage) return false;
  try {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await activePage.waitForSelector('textarea', { timeout: 10000 }).then(() => true).catch(() => false);
      if (ok) return true;
      // O SPA pode demorar no primeiro carregamento; dá uma segunda chance.
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  } catch {
    return false;
  }
}

export async function startLoginFlow(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (loginFlowActive) {
    // Já existe uma janela visível aberta para login; não reinicia o fluxo.
    return;
  }
  loginFlowActive = true;
  await closePlaywright();
  await initPlaywright(false); // visível para o usuário logar
  if (activePage) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }
}

export async function finishLoginFlow(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  loginFlowActive = false;
  await closePlaywright();
  await initPlaywright(true); // volta para headless
}

export async function initPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = getProfileDir();
  fs.mkdirSync(profilePath, { recursive: true });

  // Remove locks obsoletos de encerramentos abruptos (comum quando o perfil
  // fica em um volume montado e o container antigo é derrubado sem aviso).
  try {
    for (const f of fs.readdirSync(profilePath)) {
      if (f.startsWith('Singleton')) {
        fs.unlinkSync(path.join(profilePath, f));
      }
    }
  } catch {
    // perfil inexistente ou sem permissão — o launch abaixo vai falhar se não der
  }

  console.log(`[playwright] Profile dir: ${profilePath} | writable: ${isProfileWritable()}`);

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });

  // Keep an active page to fetch PoW headers on demand
  activePage = await context.newPage();
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    try {
      await context.close();
    } catch {
      // contexto já fechado
    }
    context = null;
    activePage = null;
  }
}

/**
 * Garante uma página da DeepSeek utilizável. Se o contexto/página foi fechado
 * (ex.: o usuário fechou a janela de login sem concluir), volta para headless
 * e reabre. Também limpa um fluxo de login órfão. Sem contexto inicializado
 * não abre browser novo — os chamadores devem tratar 'Playwright not initialized'.
 */
export async function ensurePage(): Promise<Page> {
  if (!context) {
    throw new Error('Playwright not initialized');
  }
  let pageClosed = false;
  if (activePage) {
    try {
      pageClosed = activePage.isClosed();
    } catch {
      pageClosed = true;
    }
  } else {
    pageClosed = true;
  }
  if (pageClosed) {
    if (loginFlowActive) {
      console.warn('[login] Janela de login fechada sem concluir; voltando para headless.');
      loginFlowActive = false;
    }
    await closePlaywright();
    await initPlaywright(true);
  }
  return activePage!;
}

export interface DeepSeekImageInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Faz upload de imagens usando o próprio fluxo do app do chat.deepseek.com
 * (input de arquivo do composer) e captura o ref_file_id de cada upload.
 *
 * A DeepSeek web enxerga imagens via ref_file_ids no payload de completion —
 * sem isso o modelo só recebe texto. Como o endpoint de upload não é
 * documentado, aproveitamos o input nativo da página logada e lemos o id da
 * resposta de rede. Uploads que falharem ou demorarem são ignorados: a
 * requisição segue sem imagem (o prompt cai para o marcador [imagem anexada]).
 */
export async function uploadDeepSeekImages(images: DeepSeekImageInput[]): Promise<string[]> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    if (process.env.TEST_MOCK_UPLOAD === '1' && images.length) return ['mock-file-1'];
    return [];
  }
  if (!activePage) throw new Error('Playwright not initialized');

  const ids: string[] = [];
  for (const image of images) {
    try {
      const id = await uploadSingleImage(activePage, image);
      if (id) ids.push(id);
    } catch {
      // segue sem o id — a DeepSeek responde sem enxergar a imagem
    }
  }
  return ids;
}

async function uploadSingleImage(page: Page, image: DeepSeekImageInput): Promise<string | null> {
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  console.log(`[upload] ${count} input(s) de arquivo na página`);
  if (!count) return null;

  for (let i = 0; i < count; i++) {
    try {
      const id = await uploadViaInput(page, inputs.nth(i), image);
      if (id) return id;
    } catch (err: any) {
      console.warn(`[upload] input ${i} falhou:`, err?.message || err);
    }
  }
  return null;
}

async function uploadViaInput(
  page: Page,
  input: import('playwright').Locator,
  image: DeepSeekImageInput
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (id: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.removeListener('response', onResponse);
      resolve(id);
    };
    const timer = setTimeout(() => {
      console.warn('[upload] timeout aguardando ref_file_id');
      finish(null);
    }, 20000);

    const onResponse = (res: import('playwright').Response) => {
      try {
        const req = res.request();
        const url = res.url();
        if (!url.includes('chat.deepseek.com')) return;
        if (!/POST|PUT/i.test(req.method())) return;
        if (!/(file|upload|attachment|image|ref|resource)/i.test(url)) return;
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        res
          .json()
          .then((body) => {
            const id = findRefFileId(body);
            console.log(`[upload] ${req.method()} ${url} -> ${JSON.stringify(body)}`);
            if (id) finish(id);
          })
          .catch(() => {});
      } catch {
        // ignora
      }
    };

    page.on('response', onResponse);
    input
      .setInputFiles({ name: image.filename, mimeType: image.mimeType, buffer: image.buffer })
      .then(() => console.log('[upload] setInputFiles ok; aguardando ref_file_id...'))
      .catch((err: any) => {
        console.warn('[upload] setInputFiles erro:', err?.message || err);
        finish(null);
      });
  });
}

function findRefFileId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/file[_-]?id|ref[_-]?file/i.test(key) && typeof value === 'string') return value;
    if (/^(id|uuid|file_uuid)$/i.test(key) && typeof value === 'string' && value.length > 8) return value;
    const nested = findRefFileId(value);
    if (nested) return nested;
  }
  return null;
}

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api/v0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Chama um endpoint da API v0 da DeepSeek usando os headers/PoW capturados do
 * app (a página já resolveu o challenge, então os headers são válidos).
 */
async function dsApi(
  path: string,
  headers: Record<string, string>,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  try {
    return await fetch(DEEPSEEK_API_BASE + path, {
      method: options.method ?? 'GET',
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://chat.deepseek.com',
        'authorization': headers['authorization'],
        'x-ds-pow-response': headers['x-ds-pow-response'],
        'x-hif-dliq': headers['x-hif-dliq'],
        'x-hif-leim': headers['x-hif-leim'],
        'cookie': headers['cookie'],
        'x-client-bundle-id': headers['x-client-bundle-id'],
        'x-client-locale': headers['x-client-locale'],
        'x-client-platform': headers['x-client-platform'],
        'x-client-version': headers['x-client-version'],
        'x-client-timezone-offset': headers['x-client-timezone-offset'],
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * O modo de visão da DeepSeek é uma sessão com `model_type: "vision"`.
 *
 * O upload simples devolve um arquivo que o modelo normal não consegue ler
 * (status CONTENT_EMPTY). O app resolve isso "forkando" o arquivo para o
 * model_kind VISION (`fork_file_task`), aguardando o parse (SUCCESS) e então
 * criando uma sessão nova (`chat_session/create`).
 *
 * Este helper replica exatamente esse fluxo via API, reusando os headers/PoW
 * capturados da página logada. Retorna os ids forked prontos para o completion
 * e a session id da sessão de visão recém-criada.
 */
export interface DeepSeekVisionFiles {
  refFileIds: string[];
  chatSessionId: string;
}

export async function prepareDeepSeekVisionFiles(fileIds: string[]): Promise<DeepSeekVisionFiles | null> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    if (process.env.TEST_MOCK_UPLOAD === '1' && fileIds.length) {
      return { refFileIds: ['mock-vision-file-1'], chatSessionId: 'mock-vision-session' };
    }
    return null;
  }

  const { headers } = await getDeepSeekHeaders();
  if (!headers['authorization']) return null;

  const forkedIds: string[] = [];
  for (const fileId of fileIds) {
    try {
      const res = await dsApi('/file/fork_file_task', headers, {
        method: 'POST',
        body: { file_id: fileId, to_model_type: 'vision' },
      });
      if (!res.ok) {
        console.warn(`[vision] fork_file_task HTTP ${res.status} para ${fileId}`);
        continue;
      }
      const json: any = await res.json();
      const biz = json?.data?.biz_data;
      const forkedId = biz?.id || biz?.file?.id;
      if (forkedId) {
        console.log(`[vision] forked ${fileId} -> ${forkedId} (model_kind=${biz?.model_kind})`);
        forkedIds.push(forkedId);
      } else {
        console.warn(`[vision] fork_file_task sem id novo para ${fileId}: ${JSON.stringify(json).slice(0, 300)}`);
        forkedIds.push(fileId);
      }
    } catch (err: any) {
      console.warn(`[vision] fork_file_task erro para ${fileId}:`, err?.message || err);
      forkedIds.push(fileId);
    }
  }

  if (!forkedIds.length) return null;

  // Aguarda o parse dos arquivos vision (status SUCCESS) antes de enviar.
  const deadline = Date.now() + 60000;
  for (;;) {
    const res = await dsApi(`/file/fetch_files?file_ids=${forkedIds.join(',')}`, headers, { timeoutMs: 15000 });
    let allSuccess = false;
    try {
      const json: any = await res.json();
      const files: any[] = json?.data?.biz_data?.files ?? [];
      const byId = new Map(files.map((f) => [f.id, f]));
      allSuccess = forkedIds.every((id) => byId.get(id)?.status === 'SUCCESS');
      const pending = forkedIds.map((id) => byId.get(id)?.status).join(',');
      if (allSuccess) {
        console.log(`[vision] arquivos prontos (SUCCESS): ${pending}`);
        break;
      }
      console.log(`[vision] aguardando parse: ${pending}`);
    } catch {
      // continua tentando
    }
    if (allSuccess) break;
    if (Date.now() > deadline) {
      console.warn(`[vision] timeout aguardando parse dos arquivos: ${forkedIds.join(',')}`);
      break;
    }
    await sleep(1500);
  }

  // Cria a sessão de visão.
  let chatSessionId = '';
  try {
    const res = await dsApi('/chat_session/create', headers, { method: 'POST', body: {} });
    const json: any = await res.json();
    const biz = json?.data?.biz_data;
    chatSessionId = biz?.chat_session?.id || biz?.id || '';
    if (!chatSessionId) {
      console.warn(`[vision] chat_session/create sem id: ${JSON.stringify(json).slice(0, 300)}`);
    } else {
      console.log(`[vision] sessão criada: ${chatSessionId}`);
    }
  } catch (err: any) {
    console.warn('[vision] chat_session/create erro:', err?.message || err);
  }

  if (!chatSessionId) return null;
  return { refFileIds: forkedIds, chatSessionId };
}

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getDeepSeekHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: number | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    // Generate a unique session ID if requested for testing isolation
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return { headers: { authorization: 'Bearer MOCK' }, chatSessionId: mockSessionId, parentMessageId: null };
  }

  if (loginFlowActive) {
    throw new Error('Login da DeepSeek em andamento. Conclua o login no dashboard antes de usar o chat.');
  }

  const page = await ensurePage();
  if (!page) {
    throw new Error('Playwright not initialized');
  }

  // Ensure the page reflects the current conversation before reading state.
  // For multi-turn requests the page must be reloaded: server-side fetches add
  // messages to the conversation that the already-loaded page doesn't know,
  // and a stale parent_message_id makes DeepSeek return the previous cached
  // answer instead of answering the new prompt.
  if (forceNew) {
    if (!page.url().startsWith('https://chat.deepseek.com/')) {
      await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
    }
  } else {
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }

  // Wait for the textarea
  await page.waitForSelector('textarea', { timeout: 30000 }).catch(() => {
    throw new Error('Timeout waiting for chat input. Are you logged in?');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for PoW headers')), 30000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: number | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_session_id) {
            uiSessionId = payload.chat_session_id;
          }
          if (payload.parent_message_id !== undefined) {
            uiParentMessageId = payload.parent_message_id;
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      const extractedHeaders = {
        'x-ds-pow-response': reqHeaders['x-ds-pow-response'] || '',
        'x-hif-dliq': reqHeaders['x-hif-dliq'] || '',
        'x-hif-leim': reqHeaders['x-hif-leim'] || '',
        'authorization': reqHeaders['authorization'] || '',
        'cookie': reqHeaders['cookie'] || '',
        'x-client-bundle-id': reqHeaders['x-client-bundle-id'] || '',
        'x-client-locale': reqHeaders['x-client-locale'] || '',
        'x-client-platform': reqHeaders['x-client-platform'] || '',
        'x-client-version': reqHeaders['x-client-version'] || '',
        'x-client-timezone-offset': reqHeaders['x-client-timezone-offset'] || ''
      };

      currentHeaders = extractedHeaders;

      // Abort to prevent polluting chat history
      await route.abort('aborted');
      
      // Cleanup route
      await activePage!.unroute('**/api/v0/chat/completion', routeHandler);

      resolve({ headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
    };

    activePage!.route('**/api/v0/chat/completion', routeHandler).then(() => {
      // Trigger PoW generation by typing and hitting enter
      activePage!.fill('textarea', 'a').then(() => {
        activePage!.keyboard.press('Enter');
      });
    });
  });
}
