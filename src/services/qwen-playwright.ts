/*
 * File: qwen-playwright.ts
 * Project: deepsproxy
 * Playwright dedicado ao Qwen (chat.qwen.ai). Mantém perfil, sessão e headers
 * separados do playwright da DeepSeek para os dois backends funcionarem juntos.
 *
 * Portado do qwenproxy (autor: Pedro Farias), com naming qwen-específico.
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

let context: BrowserContext | null = null;
/** Página de controle (handshake de headers, login, checks). Não serve streams. */
export let activeQwenPage: Page | null = null;
let currentHeaders: Record<string, string> = {};
let cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null = null;
let lastHeadersTime = 0;
const HEADERS_TTL = 10 * 60 * 1000; // 10 minutes

let loginFlowActive = false;

export function isQwenLoginFlowActive(): boolean {
  return loginFlowActive;
}

/* --------------------------------------------------------------------------
 * Pool de abas para streams de chat concorrentes.
 *
 * As abas compartilham o MESMO contexto/perfil (cookies da sessão), então
 * cada aba consegue fazer o fetch de chat dentro do browser sem relogin.
 * Cada conversa ocupa uma aba; quando todas estão ocupadas, as próximas
 * requisições ficam na fila (waiting) até sobrar uma aba.
 * ------------------------------------------------------------------------ */
let qwenStreamPages: Page[] = [];
const qwenStreamPagesBusy = new Set<Page>();
let qwenStreamWaiters: Array<{ resolve: (page: Page) => void; reject: (err: Error) => void }> = [];

export function getQwenPoolSize(): number {
  // A API do Qwen processa UMA resposta por vez na mesma sessão do browser (a
  // 2ª completion concorrente volta 200 vazio/bloqueado pelo WAF). O pool fica
  // fixo em 1: a fila é garantida pelo acquire/wait e o chat roda serializado.
  return 1;
}

export function getQwenPoolState(): { capacity: number; active: number; waiting: number } {
  return {
    capacity: qwenStreamPages.length,
    active: qwenStreamPagesBusy.size,
    waiting: qwenStreamWaiters.length,
  };
}

/** Cria as abas do pool (capacidade - já existentes), todas na home do Qwen. */
async function ensurePoolPages(): Promise<void> {
  if (!context) return;
  const needed = getQwenPoolSize();
  for (let i = qwenStreamPages.length; i < needed; i++) {
    try {
      const page = await context.newPage();
      await page
        .goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
      qwenStreamPages.push(page);
    } catch (e: any) {
      console.warn('[qwen-playwright] Falha ao criar aba do pool:', e.message);
      break;
    }
  }
}

/** Pega uma aba livre para um stream de chat; espera se todas estiverem ocupadas. */
export function acquireQwenStreamPage(): Promise<Page> {
  if (!context) return Promise.reject(new Error('Playwright not initialized'));

  const ready = qwenStreamPages.find((p) => !qwenStreamPagesBusy.has(p) && !p.isClosed());
  if (ready) {
    qwenStreamPagesBusy.add(ready);
    return Promise.resolve(ready);
  }

  // Recria abas que fecharam (ex.: navegação/exceção) para não perder capacidade.
  const closedCount = qwenStreamPages.filter((p) => p.isClosed()).length;
  if (closedCount > 0) {
    qwenStreamPages = qwenStreamPages.filter((p) => !p.isClosed());
    for (const p of qwenStreamPages) qwenStreamPagesBusy.delete(p);
    return ensurePoolPages().then(() => acquireQwenStreamPage());
  }

  // Pool vazio (ex.: contexto reaberto depois do login concluído): recria o
  // pool em vez de deixar o request esperando para sempre com capacidade 0.
  if (qwenStreamPages.length === 0 && !loginFlowActive) {
    return ensurePoolPages().then(() => acquireQwenStreamPage());
  }

  return new Promise<Page>((resolve, reject) => {
    let waiter: { resolve: (p: Page) => void, reject: (e: Error) => void };
    // A fila nunca fica sem teto: se ninguém liberar a aba no prazo, falha com
    // erro claro em vez de pendurar a requisição para sempre.
    const timer = setTimeout(() => {
      const i = qwenStreamWaiters.indexOf(waiter);
      if (i >= 0) qwenStreamWaiters.splice(i, 1);
      reject(new Error('Timeout esperando aba livre do Qwen (fila lotada ou login em andamento)'));
    }, 90000);
    waiter = {
      resolve: (page) => {
        clearTimeout(timer);
        qwenStreamPagesBusy.add(page);
        resolve(page);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    qwenStreamWaiters.push(waiter);
  });
}

/** Devolve uma aba ao pool, repassando para o primeiro da fila. */
export function releaseQwenStreamPage(page: Page) {
  qwenStreamPagesBusy.delete(page);
  const w = qwenStreamWaiters.shift();
  if (w) {
    if (!page.isClosed()) {
      w.resolve(page);
    } else {
      acquireQwenStreamPage().then(w.resolve, w.reject);
    }
  }
}

/**
 * Diretório do perfil persistente do navegador Qwen.
 * Usa QWEN_PROFILE_DIR quando definido; caso contrário usa o default local.
 */
export function getQwenProfileDir(): string {
  return process.env.QWEN_PROFILE_DIR || path.resolve('qwen_profile');
}

export function isQwenProfileWritable(): boolean {
  try {
    const dir = getQwenProfileDir();
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function getQwenPlaywrightState() {
  return {
    initialized: context !== null,
    hasActivePage: activeQwenPage !== null,
    pool: getQwenPoolState(),
  };
}

export async function getQwenLoginStatus(): Promise<{ loggedIn: boolean; cookieCount: number }> {
  let cookieCount = 0;
  if (context) {
    try {
      cookieCount = (await context.cookies('https://chat.qwen.ai')).length;
    } catch {
      cookieCount = 0;
    }
  }

  // Durante o fluxo de login NÃO navega a janela visível (o poll do dashboard
  // não pode tirar o usuário da tela de autenticação).
  if (loginFlowActive) {
    return { loggedIn: false, cookieCount };
  }

  let loggedIn = false;
  if (activeQwenPage) {
    let url = '';
    try {
      url = activeQwenPage.url();
    } catch {
      // página/contexto fechado; não derruba o /api/status
    }
    if (url.startsWith('https://chat.qwen.ai')) {
      loggedIn = !(url.includes('auth') || url.includes('login')) && cookieCount > 0;
    } else {
      loggedIn = await checkQwenLogin();
    }
  }
  return { loggedIn, cookieCount };
}

export async function checkQwenLogin(): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;
  if (!activeQwenPage) return false;
  try {
    await activeQwenPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = activeQwenPage.url();
    return !(url.includes('auth') || url.includes('login'));
  } catch {
    return false;
  }
}

export async function startQwenLoginFlow(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (loginFlowActive) {
    // Já existe uma janela visível aberta para login; não reinicia o fluxo.
    return;
  }
  loginFlowActive = true;
  await reopenQwenForLogin();
}

/**
 * Reabre o browser do Qwen em modo visível e navega para a tela de login.
 * Usado pelo início do fluxo de login e quando a janela de login morre no
 * meio do processo (para o usuário conseguir concluir).
 */
async function reopenQwenForLogin(): Promise<Page> {
  await closeQwenPlaywright();
  // Espera o Chrome liberar o perfil antes de reabrir (evita "profile in use"
  // / contexto que fecha imediatamente no Windows).
  await new Promise((r) => setTimeout(r, 800));
  await initQwenPlaywright(false); // visível para o usuário logar
  if (activeQwenPage) {
    await activeQwenPage
      .goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' })
      .catch(() => {});
  }
  return activeQwenPage!;
}

export async function finishQwenLoginFlow(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  loginFlowActive = false;
  await closeQwenPlaywright();
  await new Promise((r) => setTimeout(r, 800));
  await initQwenPlaywright(true); // volta para headless
}

/**
 * Garante uma página Qwen utilizável. Se o contexto/página foi fechado
 * (ex.: o usuário fechou a janela de login sem clicar em "Concluir login"),
 * volta para headless e reabre. Também limpa um fluxo de login órfão. Sem
 * contexto inicializado não abre browser novo — os chamadores devem tratar
 * 'Playwright not initialized'.
 */
export async function ensureQwenPage(): Promise<Page> {
  if (!context) {
    throw new Error('Playwright not initialized');
  }
  let pageClosed = false;
  if (activeQwenPage) {
    try {
      pageClosed = activeQwenPage.isClosed();
    } catch {
      pageClosed = true;
    }
  } else {
    pageClosed = true;
  }
  if (pageClosed) {
    if (loginFlowActive) {
      // A janela de login morreu; reabre visível para o usuário concluir o
      // login em vez de voltar silenciosamente para headless.
      console.warn('[Qwen] Janela de login fechada; reabrindo visível para concluir o login.');
      return reopenQwenForLogin();
    }
    await closeQwenPlaywright();
    await initQwenPlaywright(true);
  }
  if (qwenStreamPages.length === 0 && !loginFlowActive) {
    await ensurePoolPages();
  }
  return activeQwenPage!;
}

export async function getQwenCookies(): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  if (!context) return '';
  const page = await ensureQwenPage();
  const cookies = await page.context().cookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export async function getQwenBasicHeaders(): Promise<{ cookie: string, userAgent: string, bxV: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock', bxV: '2.5.36' };
  if (!context) throw new Error('Playwright not initialized');
  const page = await ensureQwenPage();

  const cookie = await getQwenCookies();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const bxV = currentHeaders['bx-v'] || '2.5.36';

  return { cookie, userAgent, bxV };
}

export async function initQwenPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = getQwenProfileDir();
  fs.mkdirSync(profilePath, { recursive: true });

  // Remove locks obsoletos de encerramentos abruptos.
  try {
    for (const f of fs.readdirSync(profilePath)) {
      if (f.startsWith('Singleton')) {
        fs.unlinkSync(path.join(profilePath, f));
      }
    }
  } catch {
    // perfil inexistente ou sem permissão
  }

  console.log(`[qwen-playwright] Profile dir: ${profilePath} | writable: ${isQwenProfileWritable()}`);

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });

  // Keep an active page to fetch PoW headers on demand
  activeQwenPage = await context.newPage();
  // Não cria abas do pool durante o fluxo de login: o chat fica bloqueado
  // enquanto o login estiver em andamento e as abas extras só atrapalham
  // a navegação da janela visível de login.
  if (!loginFlowActive) {
    await ensurePoolPages();
    console.log(
      `[qwen-playwright] Pool: ${qwenStreamPages.length} aba(s) para chat concorrente (QWEN_POOL_SIZE).`
    );
  }
}

export async function closeQwenPlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    try {
      await context.close();
    } catch {
      // contexto já fechado
    }
    context = null;
    activeQwenPage = null;
    cachedQwenHeaders = null;
    lastHeadersTime = 0;
  }
  // Remove locks obsoletos do perfil (Chrome/Windows) para permitir reabrir o
  // browser imediatamente sem erro de "profile in use" ou contexto que morre.
  try {
    for (const f of fs.readdirSync(getQwenProfileDir())) {
      if (f.startsWith('Singleton')) {
        fs.unlinkSync(path.join(getQwenProfileDir(), f));
      }
    }
  } catch {
    // perfil inexistente ou sem permissão
  }
  const waiters = qwenStreamWaiters;
  qwenStreamWaiters = [];
  for (const w of waiters) w.reject(new Error('Qwen Playwright fechado'));
  qwenStreamPages = [];
  qwenStreamPagesBusy.clear();
}

export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!activeQwenPage) throw new Error('Playwright not initialized');

  console.log(`[Qwen] Attempting API login for ${email}...`);

  // Navigate to auth page to set up context/cookies
  await activeQwenPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'networkidle' });

  // Qwen expects SHA256 hashed password
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  const result = await activeQwenPage.evaluate(async ({ email, password }) => {
    try {
      const response = await fetch("https://chat.qwen.ai/api/v2/auths/signin", {
        method: "POST",
        headers: {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json",
          "source": "web",
          "timezone": new Date().toString().split(' (')[0],
          "x-request-id": crypto.randomUUID()
        },
        body: JSON.stringify({ email, password, login_type: "email" })
      });
      const data = await response.json();
      return { ok: response.ok, data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { email, password: hashedPassword });

  if (result.ok) {
    console.log('[Qwen] API login request successful.');
    // Navigate to home to confirm session
    await activeQwenPage.goto('https://chat.qwen.ai/', { waitUntil: 'networkidle' });
    const isLogged = !(activeQwenPage.url().includes('auth') || activeQwenPage.url().includes('login'));
    if (isLogged) {
      console.log('[Qwen] Login confirmed.');
      return true;
    }
  }

  console.error('[Qwen] Login failed:', result.data || result.error);
  return false;
}

// Lock to prevent concurrent UI interactions
let uiLock: Promise<void> = Promise.resolve();

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getQwenHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  // Use a lock to ensure only one request uses the UI at a time
  const release = await new Promise<() => void>(resolve => {
    uiLock = uiLock.then(() => new Promise<void>(innerResolve => {
      resolve(innerResolve);
    }));
  });

  try {
    return await _getQwenHeadersInternal(forceNew);
  } finally {
    release();
  }
}

async function _getQwenHeadersInternal(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return {
      headers: {
        'authorization': 'Bearer MOCK',
        'cookie': 'token=mock',
        'user-agent': 'mock',
        'bx-v': '2.5.36'
      },
      chatSessionId: mockSessionId,
      parentMessageId: null
    };
  }

  if (!forceNew && cachedQwenHeaders && (Date.now() - lastHeadersTime < HEADERS_TTL)) {
    return cachedQwenHeaders;
  }

  if (loginFlowActive) {
    throw new Error('Login do Qwen em andamento. Conclua o login no dashboard antes de usar o chat.');
  }

  const page = await ensureQwenPage();
  if (!page) {
    throw new Error('Playwright not initialized');
  }

  const currentUrl = page.url();
  const isOnQwen = currentUrl.includes('chat.qwen.ai');
  const isOnSpecificChat = isOnQwen && /\/c\//.test(currentUrl);

  if (!isOnQwen || forceNew || isOnSpecificChat) {
    console.log(`[Qwen] Navigating to Qwen home... (Current: ${currentUrl})`);
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
  }

  // Check if we are on a login page and perform automated login if credentials provided
  const isLoginPage = page.url().includes('login') || (await page.$('input[type="email"], input[placeholder*="Email"]'));
  if (isLoginPage) {
    const email = process.env.QWEN_EMAIL;
    const password = process.env.QWEN_PASSWORD;

    if (email && password) {
      console.log('[Qwen] Detected login page. Attempting automated login...');
      try {
        await page.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: 10000 });
        await page.fill('input[type="email"], input[placeholder*="Email"]', email);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
        await page.waitForSelector('input[type="password"]', { timeout: 10000 });
        await page.fill('input[type="password"]', password);
        await page.keyboard.press('Enter');
        await page.waitForSelector('textarea:visible', { timeout: 30000 });
        console.log('[Qwen] Automated login successful.');
      } catch (err: any) {
        console.error('[Qwen] Automated login failed:', err.message);
      }
    } else {
      console.warn('[Qwen] Detected login page but QWEN_EMAIL/PASSWORD not provided in .env');
    }
  }

  // Wait for the textarea
  console.log('[Qwen] Waiting for chat input...');
  const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
  await page.waitForSelector(inputSelector, { timeout: 30000 }).catch(() => {
    console.error('[Qwen] Chat input not found. Current URL:', page.url());
    throw new Error('Timeout waiting for chat input. Are you logged in?');
  });

  return new Promise((resolve, reject) => {
    const overallTimeout = setTimeout(() => {
      console.error('[Qwen] Timeout waiting for Qwen headers. Current URL:', activeQwenPage!.url());
      reject(new Error('Timeout waiting for Qwen headers'));
    }, 60000);

    const MAX_SKIPS = 3;
    let skips = 0;
    let requestSeen = false;
    let fallbackTimer: NodeJS.Timeout | null = null;
    let fallbackAttempts = 0;
    const MAX_FALLBACK_ATTEMPTS = 3;

    const triggerSend = async () => {
      requestSeen = false;
      console.log('[Qwen] Triggering request...');
      const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';

      await activeQwenPage!.focus(inputSelector).catch(() => {});
      await activeQwenPage!.fill(inputSelector, '').catch(() => {});
      await activeQwenPage!.type(inputSelector, 'a', { delay: 100 }).catch(() => {});
      console.log('[Qwen] Typed char, waiting for UI to update...');
      await activeQwenPage!.waitForTimeout(2000);

      // Improved Send Button detection & aggressive clicking
      const selectors = [
        '.message-input-right-button-send .send-button',
        '.chat-prompt-send-button',
        'button.send-button'
      ];

      let clicked = false;
      for (const selector of selectors) {
        try {
          const btn = await activeQwenPage!.$(selector);
          if (btn && await btn.isVisible()) {
            console.log(`[Qwen] Attempting click on: ${selector}`);

            await activeQwenPage!.evaluate((sel) => {
              const element = document.querySelector(sel) as HTMLElement;
              if (element) {
                element.focus();
                element.click();
              }
            }, selector);

            await btn.click({ force: true, delay: 50 }).catch(() => {});

            clicked = true;
            break;
          }
        } catch (e) {
          console.error(`[Qwen] Error clicking ${selector}:`, e);
        }
      }

      if (!clicked) {
        console.log('[Qwen] No send button found/clicked, fallback to Enter...');
        await activeQwenPage!.focus(inputSelector).catch(() => {});
        await activeQwenPage!.keyboard.press('Enter').catch(() => {});
      }

      armFallback();
    };

    const armFallback = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        if (requestSeen) return;
        fallbackAttempts++;
        if (fallbackAttempts > MAX_FALLBACK_ATTEMPTS) {
          console.error('[Qwen] Fallback attempts esgotados; aguardando timeout geral...');
          return;
        }
        console.log(`[Qwen] Nenhum request interceptado apos o envio (tentativa ${fallbackAttempts}/${MAX_FALLBACK_ATTEMPTS}); re-enviando...`);
        triggerSend().catch(() => {});
      }, 8000);
    };

    console.log('[Qwen] Setting up route interception...');
    const routeHandler = async (route: any, request: any) => {
      requestSeen = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: string | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_id) {
            uiSessionId = payload.chat_id;
          }
          if (payload.parent_id !== undefined) {
            uiParentMessageId = payload.parent_id;
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      const extractedHeaders = {
        'cookie': reqHeaders['cookie'] || '',
        'bx-ua': reqHeaders['bx-ua'] || '',
        'bx-umidtoken': reqHeaders['bx-umidtoken'] || '',
        'bx-v': reqHeaders['bx-v'] || '',
        'x-request-id': reqHeaders['x-request-id'] || '',
        'user-agent': reqHeaders['user-agent'] || ''
      };

      // Ensure we have at least cookies and bx-ua (which are critical)
      if (!extractedHeaders.cookie || !extractedHeaders['bx-ua']) {
        skips++;
        // Abort (instead of continue) so the message is not really sent to Qwen,
        // and re-trigger the send to retry the handshake.
        await route.abort('aborted').catch(() => {});
        if (skips <= MAX_SKIPS) {
          console.log(`[Qwen] Intercepted request missing critical headers (attempt ${skips}/${MAX_SKIPS}), re-triggering...`);
          setTimeout(() => { triggerSend().catch(() => {}); }, 1200);
        } else {
          console.error('[Qwen] Too many handshake retries without valid headers.');
        }
        return;
      }

      clearTimeout(overallTimeout);
      console.log('[Qwen] Successfully intercepted headers.');
      currentHeaders = extractedHeaders;
      cachedQwenHeaders = { headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId };
      lastHeadersTime = Date.now();

      // Trigger native tools disabling on first header interception
      import('./qwen.ts').then(m => m.disableNativeTools().catch(() => {}));

      // Abort to prevent polluting chat history
      await route.abort('aborted').catch(() => {});

      // Cleanup route
      await activeQwenPage!.unroute('**/api/v2/chat/completions*', routeHandler).catch(() => {});

      resolve(cachedQwenHeaders);
    };

    activeQwenPage!.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
      await triggerSend();
    });
  });
}
