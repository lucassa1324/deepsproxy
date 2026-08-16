/*
 * File: gemini-playwright.ts
 * Project: deepsproxy
 * Playwright dedicado ao Gemini Web (gemini.google.com). Mantém perfil e
 * sessão separados do playwright da DeepSeek e do Qwen para os backends
 * funcionarem juntos. Segue o mesmo padrão do qwen-playwright.ts.
 *
 * Diferente do Qwen (que intercepta a API privada), o Gemini Web é dirigido
 * pela UI: o chat digita o prompt no composer, clica em enviar e lê a resposta
 * do DOM (.model-response-text). Isso evita o protocolo RPC interno
 * (BardFrontendService), que muda com frequência.
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { GEMINI_SCRIPT_HAS_COMPOSER } from './gemini-web.ts';

const GEMINI_HOME = 'https://gemini.google.com';

let context: BrowserContext | null = null;
/** Página de controle (login, checks). Não serve streams. */
export let activeGeminiPage: Page | null = null;

let loginFlowActive = false;

export function isGeminiLoginFlowActive(): boolean {
  return loginFlowActive;
}

/** Escuta crash/erro JS/console para diagnosticar páginas quebradas. */
function attachGeminiDebugListeners(page: Page) {
  page.on('crash', () => console.error('[gemini-playwright] RENDERER CRASHED! (aba do Gemini)'));
  page.on('pageerror', (err) => console.error('[gemini-playwright] JS error na aba:', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[gemini-console]', msg.text());
  });
}

/* --------------------------------------------------------------------------
 * Pool de abas para streams de chat concorrentes.
 *
 * As abas compartilham o MESMO contexto/perfil (cookies da sessão do Google),
 * então cada aba consegue conversar sem relogin. Cada conversa ocupa uma aba;
 * quando todas estão ocupadas, as próximas requisições ficam na fila (waiting).
 * ------------------------------------------------------------------------ */
let geminiStreamPages: Page[] = [];
const geminiStreamPagesBusy = new Set<Page>();
let geminiStreamWaiters: Array<{ resolve: (page: Page) => void; reject: (err: Error) => void }> = [];

export function getGeminiPoolSize(): number {
  // O Gemini processa várias respostas em paralelo na mesma sessão; o tamanho
  // do pool é configurável (GEMINI_POOL_SIZE, padrão 2) para balancear
  // concorrência e uso de memória do Chromium.
  const raw = parseInt(process.env.GEMINI_POOL_SIZE || '2', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

export function getGeminiPoolState(): { capacity: number; active: number; waiting: number } {
  return {
    capacity: geminiStreamPages.length,
    active: geminiStreamPagesBusy.size,
    waiting: geminiStreamWaiters.length,
  };
}

/** Cria as abas do pool (capacidade - já existentes), todas no chat do Gemini. */
async function ensurePoolPages(): Promise<void> {
  if (!context) return;
  const needed = getGeminiPoolSize();
  for (let i = geminiStreamPages.length; i < needed; i++) {
    try {
      const page = await context.newPage();
      attachGeminiDebugListeners(page);
      await page
        .goto(`${GEMINI_HOME}/app`, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
      geminiStreamPages.push(page);
    } catch (e: any) {
      console.warn('[gemini-playwright] Falha ao criar aba do pool:', e.message);
      break;
    }
  }
}

/** Pega uma aba livre para um stream de chat; espera se todas estiverem ocupadas.
 *  Quando `signal` aborta (cliente pausou), remove o waiter da fila e rejeita —
 *  o request cancelado não deve segurar uma aba nem furar a fila depois. */
export function acquireGeminiStreamPage(signal?: AbortSignal): Promise<Page> {
  if (!context) return Promise.reject(new Error('Playwright not initialized'));
  if (signal?.aborted) return Promise.reject(new Error('Requisição cancelada'));

  const ready = geminiStreamPages.find((p) => !geminiStreamPagesBusy.has(p) && !p.isClosed());
  if (ready) {
    geminiStreamPagesBusy.add(ready);
    return Promise.resolve(ready);
  }

  // Recria abas que fecharam (ex.: navegação/exceção) para não perder capacidade.
  const closedCount = geminiStreamPages.filter((p) => p.isClosed()).length;
  if (closedCount > 0) {
    geminiStreamPages = geminiStreamPages.filter((p) => !p.isClosed());
    for (const p of geminiStreamPages) geminiStreamPagesBusy.delete(p);
    return ensurePoolPages().then(() => acquireGeminiStreamPage(signal));
  }

  // Pool vazio (ex.: contexto reaberto depois do login concluído): recria o
  // pool em vez de deixar o request esperando para sempre com capacidade 0.
  if (geminiStreamPages.length === 0 && !loginFlowActive) {
    return ensurePoolPages().then(() => acquireGeminiStreamPage(signal));
  }

  return new Promise<Page>((resolve, reject) => {
    let waiter: { resolve: (p: Page) => void, reject: (e: Error) => void };
    const removeWaiter = () => {
      const i = geminiStreamWaiters.indexOf(waiter);
      if (i >= 0) geminiStreamWaiters.splice(i, 1);
    };
    const timer = setTimeout(() => {
      removeWaiter();
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Timeout esperando aba livre do Gemini (fila lotada ou login em andamento)'));
    }, 120000);
    const onAbort = () => {
      clearTimeout(timer);
      removeWaiter();
      reject(new Error('Requisição cancelada'));
    };
    waiter = {
      resolve: (page) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        geminiStreamPagesBusy.add(page);
        resolve(page);
      },
      reject: (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    geminiStreamWaiters.push(waiter);
  });
}

/** Devolve uma aba ao pool, repassando para o primeiro da fila. */
export function releaseGeminiStreamPage(page: Page) {
  geminiStreamPagesBusy.delete(page);
  const w = geminiStreamWaiters.shift();
  if (w) {
    if (!page.isClosed()) {
      w.resolve(page);
    } else {
      acquireGeminiStreamPage().then(w.resolve, w.reject);
    }
  }
}

/**
 * Diretório do perfil persistente do navegador Gemini.
 * Usa GEMINI_PROFILE_DIR quando definido; caso contrário usa o default local.
 */
export function getGeminiProfileDir(): string {
  return process.env.GEMINI_PROFILE_DIR || path.resolve('gemini_profile');
}

export function isGeminiProfileWritable(): boolean {
  try {
    const dir = getGeminiProfileDir();
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function getGeminiPlaywrightState() {
  return {
    initialized: context !== null,
    hasActivePage: activeGeminiPage !== null,
    pool: getGeminiPoolState(),
  };
}

/** Cookies de autenticação do Google presentes no contexto (domínio .google.com). */
const AUTH_COOKIE_RE = /PSID|SID|HSID|SSID|SAPISID|APISID|SIDCC|NID/i;

async function geminiAuthCookies(): Promise<string[]> {
  if (!context) return [];
  try {
    const cookies = await context.cookies(GEMINI_HOME);
    return cookies.map((c) => c.name).filter((n) => AUTH_COOKIE_RE.test(n));
  } catch {
    return [];
  }
}

export async function getGeminiLoginStatus(): Promise<{ loggedIn: boolean; cookieCount: number }> {
  const auth = await geminiAuthCookies();
  const cookieCount = auth.length;

  // Durante o fluxo de login NÃO navega a janela visível (o poll do dashboard
  // não pode tirar o usuário da tela de autenticação).
  if (loginFlowActive) {
    return { loggedIn: false, cookieCount };
  }

  let loggedIn = false;
  if (context) {
    let url = '';
    try {
      url = activeGeminiPage?.url() || '';
    } catch {
      // página/contexto fechado; não derruba o /api/status
    }
    if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) {
      // Google redireciona usuários deslogados para a tela de login.
      loggedIn = false;
    } else if (url.includes('gemini.google.com')) {
      // O app do Gemini só é exibido para usuários logados.
      loggedIn = true;
    } else if (cookieCount > 0) {
      loggedIn = true;
    } else {
      // Página ainda não navegada (ex.: contexto headless recém-aberto):
      // faz a checagem funcional real.
      loggedIn = await checkGeminiLogin();
    }
  }
  return { loggedIn, cookieCount };
}

export async function checkGeminiLogin(): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;
  if (!context || !activeGeminiPage) return false;
  try {
    await activeGeminiPage.goto(GEMINI_HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = activeGeminiPage.url() || '';
    if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) return false;
    const auth = await geminiAuthCookies();
    if (auth.length > 0) return true;
    // Sinal funcional: o composer só existe na página quando há sessão.
    const hasComposer = Boolean(await activeGeminiPage.evaluate(GEMINI_SCRIPT_HAS_COMPOSER).catch(() => false));
    return hasComposer;
  } catch {
    return false;
  }
}

export async function startGeminiLoginFlow(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (loginFlowActive) {
    // Já existe uma janela visível aberta para login; não reinicia o fluxo.
    return;
  }
  loginFlowActive = true;
  await reopenGeminiForLogin();
}

/**
 * Reabre o browser do Gemini em modo visível e navega para a tela de login.
 * Usado pelo início do fluxo de login e quando a janela de login morre no
 * meio do processo (para o usuário conseguir concluir).
 */
async function reopenGeminiForLogin(): Promise<Page> {
  await closeGeminiPlaywright();
  // Espera o Chrome liberar o perfil antes de reabrir (evita "profile in use"
  // / contexto que fecha imediatamente no Windows).
  await new Promise((r) => setTimeout(r, 800));
  await initGeminiPlaywright(false); // visível para o usuário logar
  if (activeGeminiPage) {
    await activeGeminiPage
      .goto(GEMINI_HOME, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
  }
  return activeGeminiPage!;
}

export async function finishGeminiLoginFlow(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  loginFlowActive = false;

  // Espera o Google concluir o redirect de volta ao Gemini (e gravar os
  // cookies de sessão no perfil) antes de fechar a janela visível. Se a
  // autenticação falhou/travou (interrupt/challenge), não espera 15s.
  if (activeGeminiPage) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      let url = '';
      try {
        url = activeGeminiPage.url();
      } catch {
        break; // página fechada
      }
      if (url.includes('gemini.google.com') && !url.includes('accounts.google.com')) break;
      if (/accounts\.google\.com\/(interrupt|challenge|ServiceLogin|signin|Error)/.test(url)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  await closeGeminiPlaywright();
  await new Promise((r) => setTimeout(r, 800));
  await initGeminiPlaywright(true); // volta para headless
}

/**
 * Garante uma página Gemini utilizável. Se o contexto/página foi fechado
 * (ex.: o usuário fechou a janela de login sem clicar em "Concluir login"),
 * volta para headless e reabre. Também limpa um fluxo de login órfão. Sem
 * contexto inicializado não abre browser novo — os chamadores devem tratar
 * 'Playwright not initialized'.
 */
export async function ensureGeminiPage(): Promise<Page> {
  if (!context) {
    throw new Error('Playwright not initialized');
  }
  let pageClosed = false;
  if (activeGeminiPage) {
    try {
      pageClosed = activeGeminiPage.isClosed();
    } catch {
      pageClosed = true;
    }
  } else {
    pageClosed = true;
  }
  if (pageClosed) {
    if (loginFlowActive) {
      console.warn('[gemini] Janela de login fechada; reabrindo visível para concluir o login.');
      return reopenGeminiForLogin();
    }
    await closeGeminiPlaywright();
    await initGeminiPlaywright(true);
  }
  if (geminiStreamPages.length === 0 && !loginFlowActive) {
    await ensurePoolPages();
  }
  return activeGeminiPage!;
}

export async function initGeminiPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = getGeminiProfileDir();
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

  console.log(`[gemini-playwright] Profile dir: ${profilePath} | writable: ${isGeminiProfileWritable()}`);

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1280,720',
    ],
  });

  // Keep an active page for login checks.
  activeGeminiPage = await context.newPage();
  attachGeminiDebugListeners(activeGeminiPage);
  // Não cria abas do pool durante o fluxo de login: o chat fica bloqueado
  // enquanto o login estiver em andamento e as abas extras só atrapalham
  // a navegação da janela visível de login.
  if (!loginFlowActive) {
    await ensurePoolPages();
    console.log(
      `[gemini-playwright] Pool: ${geminiStreamPages.length} aba(s) para chat concorrente (GEMINI_POOL_SIZE).`
    );
  }
}

export async function closeGeminiPlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    try {
      await context.close();
    } catch {
      // contexto já fechado
    }
    context = null;
    activeGeminiPage = null;
  }
  // Remove locks obsoletos do perfil (Chrome/Windows) para permitir reabrir o
  // browser imediatamente sem erro de "profile in use" ou contexto que morre.
  try {
    for (const f of fs.readdirSync(getGeminiProfileDir())) {
      if (f.startsWith('Singleton')) {
        fs.unlinkSync(path.join(getGeminiProfileDir(), f));
      }
    }
  } catch {
    // perfil inexistente ou sem permissão
  }
  const waiters = geminiStreamWaiters;
  geminiStreamWaiters = [];
  for (const w of waiters) w.reject(new Error('Gemini Playwright fechado'));
  geminiStreamPages = [];
  geminiStreamPagesBusy.clear();
}
