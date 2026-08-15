/*
 * File: gemini-web.ts
 * Project: deepsproxy
 * Chat com o Gemini via gemini.google.com dirigido pela UI (composer + scrape
 * do DOM), em vez do protocolo RPC interno (BardFrontendService) que muda com
 * frequência.
 *
 * Fluxo de uma conversa:
 *   1. Navega para uma conversa nova (/app) — cada requisição usa uma aba do
 *      pool e uma conversa limpa (o histórico completo é reenviado no prompt);
 *   2. Preenche o composer (.ql-editor/rich-textarea/contenteditable);
 *   3. Clica no botão de enviar (aria-label "Send" / ícone send/arrow_upward)
 *      com fallback para Enter;
 *   4. Faz polling do último nó .model-response-text e emite os deltas de
 *      texto; conclui quando o texto estabiliza e o botão de parar some.
 *
 * As funções de DOM ficam como funções marcadas (// __GEMINI_*__) para serem
 * inspecionáveis: os testes trocam a página real por FakeGeminiPage.
 */

import type { Page } from 'playwright';
import path from 'path';

/** Modelos conhecidos do Gemini (usados no catálogo quando não há API). */
export const GEMINI_KNOWN_MODELS = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', label: 'Gemini 2.5 Flash', category_label: 'Web (proxy)' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', label: 'Gemini 2.5 Pro', category_label: 'Web (proxy)' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', label: 'Gemini 3 Flash', category_label: 'Web (proxy)' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', label: 'Gemini 3 Pro', category_label: 'Web (proxy)' },
];

/* --------------------------------------------------------------------------
 * Scripts de DOM (markers para testes: // __GEMINI_*__)
 * ------------------------------------------------------------------------ */

/** Dispensa onboards/cookies que poderiam bloquear o composer (best effort).
 *  IMPORTANTE: scripts rodam via page.evaluate(string) — passar função nomeada
 *  quebra porque o esbuild/tsx injeta o helper __name() dentro da função, que
 *  não existe no contexto do navegador. */
export const GEMINI_SCRIPT_DISMISS_ONBOARDING = `(() => {
  const MARK = '__GEMINI_DISMISS_ONBOARDING__';
  const clickIfVisible = (el) => {
    if (el && el.offsetParent !== null) {
      el.click();
      return true;
    }
    return false;
  };
  for (const b of Array.from(document.querySelectorAll('button'))) {
    const label = (b.getAttribute('aria-label') || '').toLowerCase();
    const text = (b.textContent || '').trim().toLowerCase();
    if (
      ['skip', 'dismiss', 'close'].some((k) => label.includes(k)) ||
      ['skip', 'dispensar', 'fechar', 'ok', 'got it', 'accept'].some((k) => text === k || text.startsWith(k + ' '))
    ) {
      clickIfVisible(b);
    }
  }
  return true;
})()`;

/**
 * Preenche o composer com o prompt. Retorna true quando encontrou um elemento
 * de entrada (contenteditable ou textarea). Roda como string (ver nota acima).
 * O prompt chega como `arg` (Playwright). Atravessa Shadow DOM.
 */
export const GEMINI_SCRIPT_SET_PROMPT = `(() => {
  const MARK = '__GEMINI_SET_PROMPT__';
  const prompt = arg;
  const isVisible = (el) =>
    !!el &&
    (el.getBoundingClientRect().width > 0 ||
      el.getBoundingClientRect().height > 0 ||
      el.offsetWidth > 0 ||
      el.tagName === 'TEXTAREA');
  const deepAll = (root) => {
    const out = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      out.push(el);
      if (el.shadowRoot) out.push(...deepAll(el.shadowRoot));
    }
    return out;
  };
  const all = deepAll(document);
  const selectors = [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    '[aria-label="Enter a prompt for Gemini"]',
    '[aria-label="Enter a prompt"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea',
  ];
  for (const sel of selectors) {
    const target = all.find((el) => el.matches(sel) && isVisible(el));
    if (!target) continue;
    target.focus();
    if (target.isContentEditable) {
      let ok = false;
      try {
        const sel2 = window.getSelection();
        if (sel2) sel2.selectAllChildren(target);
        ok = document.execCommand('insertText', false, prompt);
      } catch (e) {
        ok = false;
      }
      if (!ok || (target.innerText || '').length < prompt.length) {
        target.innerText = prompt;
      }
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      target.dispatchEvent(new InputEvent('change', { bubbles: true }));
    } else {
      target.value = prompt;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }
  return false;
})()`;

/**
 * Clica no botão de enviar (aria-label "Send"/ícone send/arrow_upward), com
 * fallback para Enter no composer. Retorna true se algo foi disparado.
 */
export const GEMINI_SCRIPT_CLICK_SEND = `(() => {
  const MARK = '__GEMINI_CLICK_SEND__';
  const visible = (el) => !!el && el.offsetParent !== null;
  const deepAll = (root) => {
    const out = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      out.push(el);
      if (el.shadowRoot) out.push(...deepAll(el.shadowRoot));
    }
    return out;
  };
  const buttons = deepAll(document).filter((el) => el.matches('button'));
  let btn = buttons.find((b) => visible(b) && /send/i.test(b.getAttribute('aria-label') || ''));
  if (!btn) {
    btn = buttons.find((b) => {
      if (!visible(b)) return false;
      const icon = b.querySelector('mat-icon');
      return !!icon && /^(send|arrow_upward)$/i.test((icon.textContent || '').trim());
    });
  }
  if (btn) {
    btn.click();
    return true;
  }
  const comp = document.activeElement;
  if (comp) {
    comp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    comp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }
  return false;
})()`;

/** Lê o texto da última resposta do modelo e se o botão de parar está visível. */
export const GEMINI_SCRIPT_READ_RESPONSE = `(() => {
  const MARK = '__GEMINI_READ_RESPONSE__';
  try {
    const deepAll = (root) => {
      const out = [];
      for (const el of Array.from(root.querySelectorAll('*'))) {
        out.push(el);
        if (el.shadowRoot) out.push(...deepAll(el.shadowRoot));
      }
      return out;
    };
    const all = deepAll(document);
    const nodes = all.filter((el) => el.matches('.model-response-text'));
    const last = nodes[nodes.length - 1];
    const text = last ? last.innerText || '' : '';
    const stopVisible = all
      .filter((el) => el.matches('button'))
      .some((b) => {
        if (b.offsetParent === null) return false;
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (/stop/i.test(label)) return true;
        const icon = b.querySelector('mat-icon');
        return !!icon && /stop/i.test((icon.textContent || '').trim());
      });
    return { text: text, hasStop: stopVisible };
  } catch (e) {
    return { text: '', hasStop: false };
  }
})()`;

/** Navega para uma conversa nova do Gemini (limpa o composer/histórico). */
export const GEMINI_SCRIPT_GO_NEW_CHAT = `(() => {
  const MARK = '__GEMINI_GO_NEW_CHAT__';
  return 'https://gemini.google.com/app';
})()`;

/** True se existe um campo de digitação utilizável no DOM (login ok). */
export const GEMINI_SCRIPT_HAS_COMPOSER = `(() => {
  const MARK = '__GEMINI_HAS_COMPOSER__';
  try {
    const visible = (el) =>
      !!el &&
      (el.getBoundingClientRect().width > 0 ||
        el.getBoundingClientRect().height > 0 ||
        el.offsetWidth > 0 ||
        el.tagName === 'TEXTAREA');
    const deepAll = (root) => {
      const out = [];
      for (const el of Array.from(root.querySelectorAll('*'))) {
        out.push(el);
        if (el.shadowRoot) out.push(...deepAll(el.shadowRoot));
      }
      return out;
    };
    const all = deepAll(document);
    const selectors = [
      'div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '[aria-label="Enter a prompt for Gemini"]',
      '[aria-label="Enter a prompt"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ];
    return selectors.some((sel) => all.some((el) => el.matches(sel) && visible(el)));
  } catch (e) {
    return false;
  }
})()`;

/**
 * Diagnóstico da página para mensagens de erro claras: URL atual, se está na
 * tela de autenticação do Google e o estado de cada seletor do composer.
 */
export const GEMINI_SCRIPT_PAGE_STATE = `(() => {
  const MARK = '__GEMINI_PAGE_STATE__';
  try {
    const visible = (el) =>
      !!el &&
      (el.getBoundingClientRect().width > 0 ||
        el.getBoundingClientRect().height > 0 ||
        el.offsetWidth > 0 ||
        el.tagName === 'TEXTAREA');
    const deepAll = (root) => {
      const out = [];
      for (const el of Array.from(root.querySelectorAll('*'))) {
        out.push(el);
        if (el.shadowRoot) out.push(...deepAll(el.shadowRoot));
      }
      return out;
    };
    const all = deepAll(document);
    const selectors = [
      'div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '[aria-label="Enter a prompt for Gemini"]',
      '[aria-label="Enter a prompt"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ];
    const counts = {};
    let composerFound = false;
    for (const sel of selectors) {
      const nodes = all.filter((el) => el.matches(sel));
      counts[sel] = nodes.length;
      if (!composerFound && nodes.some(visible)) composerFound = true;
    }
    return {
      url: location.href,
      onLoginScreen: /accounts\\.google\\.com|ServiceLogin/.test(location.href),
      composerFound: composerFound,
      composerSelectors: counts,
    };
  } catch (e) {
    return {
      url: location.href,
      onLoginScreen: /accounts\\.google\\.com|ServiceLogin/.test(location.href),
      composerFound: false,
      composerSelectors: {},
      error: String((e && e.message) || e),
    };
  }
})()`;

/* --------------------------------------------------------------------------
 * Delta de texto + turno de chat (polling)
 * ------------------------------------------------------------------------ */

export interface GeminiTurnOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  stablePolls?: number;
}

/** Interface mínima de página aceita pelo runGeminiTurn (testes usam fake).
 *  Os scripts de DOM são passados como STRING para evaluate (esbuild injeta
 *  o helper __name() em funções nomeadas, quebrando no navegador). */
export interface GeminiLocatorLike {
  first(): GeminiLocatorLike;
  last(): GeminiLocatorLike;
  isVisible(): Promise<boolean>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  dispatchEvent(type: string): Promise<void>;
  waitFor(opts?: Record<string, unknown>): Promise<void>;
  innerText(): Promise<string>;
}

export interface GeminiPageLike {
  evaluate(pageFunction: Function | string, arg?: unknown): Promise<any>;
  waitForTimeout(ms: number): Promise<void>;
  isClosed(): boolean;
  url?(): string;
  goto?(url: string, opts?: Record<string, unknown>): Promise<any>;
  locator?(selector: string): GeminiLocatorLike;
}

const GEMINI_HOME = 'https://gemini.google.com';

/**
 * Calcula o delta entre o texto antigo e o novo: só emite o sufixo novo a
 * partir do último prefixo comum, evitando repetir conteúdo já enviado.
 */
export function computeTextDelta(oldStr: string, newStr: string): string {
  if (!oldStr) return newStr;
  if (newStr === oldStr) return '';
  if (newStr.startsWith(oldStr)) return newStr.slice(oldStr.length);
  let i = 0;
  const max = Math.min(oldStr.length, newStr.length);
  while (i < max && oldStr[i] === newStr[i]) i++;
  return newStr.slice(i);
}

/** Linhas emitidas pelo stream interno do Gemini (JSON, uma por linha). */
export type GeminiStreamEvent =
  | { type: 'content'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

const encoder = new TextEncoder();

function encodeEvent(ev: GeminiStreamEvent): Uint8Array {
  return encoder.encode(JSON.stringify(ev) + '\n');
}

/** Fallback com locator nativo do Playwright: atravessa Shadow DOM aberto,
 *  que o evaluate com document.querySelector não enxerga. */
async function tryGeminiLocatorPrompt(page: GeminiPageLike, prompt: string): Promise<boolean> {
  if (!page.locator) return false;
  const selectors = [
    'rich-textarea div[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div.ql-editor[contenteditable="true"]',
    'textarea',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible()) {
        await loc.click().catch(() => {});
        await loc.fill(prompt);
        // O Gemini só habilita o botão de enviar após o evento de input.
        await loc.dispatchEvent('input').catch(() => {});
        console.log('[gemini-web] composer preenchido via locator (shadow DOM):', sel);
        return true;
      }
    } catch {
      // tenta o próximo seletor
    }
  }
  return false;
}

/** Fallback para o botão de enviar via locator nativo (Shadow DOM) com
 *  Enter como último recurso. */
async function tryGeminiLocatorSend(page: GeminiPageLike): Promise<boolean> {
  if (!page.locator) return false;
  try {
    const b = page.locator('button[aria-label="Send"], button[aria-label="Send message"]').first();
    if (await b.isVisible()) {
      await b.click();
      console.log('[gemini-web] send clicado via locator (shadow DOM)');
      return true;
    }
  } catch {
    // tenta Enter
  }
  try {
    const c = page.locator('rich-textarea div[contenteditable="true"], rich-textarea [contenteditable="true"]').first();
    if (await c.isVisible()) {
      await c.press('Enter');
      console.log('[gemini-web] envio via Enter (locator)');
      return true;
    }
  } catch {
    // sem composer visível
  }
  return false;
}

/** Lê a resposta via locator nativo (fallback quando a evaluate falha). */
async function readGeminiResponseLocator(page: GeminiPageLike): Promise<{ text: string; hasStop: boolean } | null> {
  if (!page.locator) return null;
  try {
    const text = await page.locator('.model-response-text').last().innerText();
    let hasStop = false;
    try {
      hasStop = await page.locator('button[aria-label*="stop" i]').first().isVisible();
    } catch {
      // sem botão de parar visível
    }
    return { text: text || '', hasStop };
  } catch {
    return null;
  }
}

/** Despeja evidências (html, screenshot, frames) quando o composer não aparece. */
async function dumpGeminiDiagnostics(page: GeminiPageLike): Promise<void> {
  const real = page as unknown as Page;
  try {
    const content = await real.content();
    console.log('[gemini-web] [debug] tamanho do HTML:', content.length);
  } catch (e: any) {
    console.log('[gemini-web] [debug] content() falhou:', e?.message);
  }
  try {
    const shot = await real.screenshot({ path: path.join(process.cwd(), `debug_gemini_${Date.now()}.png`), fullPage: true });
    console.log('[gemini-web] [debug] screenshot salva (bytes):', shot.length);
  } catch (e: any) {
    console.log('[gemini-web] [debug] screenshot falhou:', e?.message);
  }
  try {
    const frames = real.frames();
    console.log('[gemini-web] [debug] frames:', frames.length);
    for (const f of frames) console.log('[gemini-web] [debug]   frame:', f.url());
  } catch (e: any) {
    console.log('[gemini-web] [debug] frames() falhou:', e?.message);
  }
}

/**
 * Roda uma conversa completa no Gemini: navega para uma conversa nova,
 * digita o prompt, envia e faz polling da resposta emitindo os deltas de
 * texto como ReadableStream (eventos GeminiStreamEvent em JSON por linha).
 */
export async function createGeminiWebStream(
  page: GeminiPageLike,
  prompt: string,
  opts: GeminiTurnOptions = {}
): Promise<ReadableStream<Uint8Array>> {
  const pollIntervalMs = opts.pollIntervalMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const stablePolls = opts.stablePolls ?? 4;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (ev: GeminiStreamEvent) => {
        try {
          controller.enqueue(encodeEvent(ev));
        } catch {
          // controller já fechado
        }
      };

      try {
        const targetUrl = (await page.evaluate(GEMINI_SCRIPT_GO_NEW_CHAT)) || `${GEMINI_HOME}/app`;

        // Abre uma conversa nova no Gemini. Sem isso a aba acumula o histórico
        // da conversa anterior; se a aba estiver em about:blank/erro/login,
        // a navegação também a recupera.
        if (page.goto) {
          await page
            .goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(() => {});
        }
        // Deixa a SPA do Gemini montar o composer antes de digitar.
        await page.waitForTimeout(1500);
        await page.evaluate(GEMINI_SCRIPT_DISMISS_ONBOARDING).catch(() => {});

        let setOk = await page.evaluate(GEMINI_SCRIPT_SET_PROMPT, prompt).catch((e: any) => {
          console.log('[gemini-web] setPrompt evaluate error:', e?.message);
          return false;
        });
        if (!setOk) {
          // Shadow DOM: document.querySelector não atravessa shadowRoot; o
          // locator nativo do Playwright atravessa.
          setOk = await tryGeminiLocatorPrompt(page, prompt);
        }
        if (!setOk) {
          // Retry: hidratação lenta da SPA pode atrasar o composer.
          await page.waitForTimeout(2000);
          setOk = await page.evaluate(GEMINI_SCRIPT_SET_PROMPT, prompt).catch((e: any) => {
            console.log('[gemini-web] setPrompt evaluate error (retry):', e?.message);
            return false;
          });
          if (!setOk) setOk = await tryGeminiLocatorPrompt(page, prompt);
        }
        if (!setOk) {
          const state = await page.evaluate(GEMINI_SCRIPT_PAGE_STATE).catch((e: any) => {
            console.log('[gemini-web] pageState evaluate error:', e?.message);
            return null;
          });
          const rawUrl = page.url ? page.url() : '';
          console.log('[gemini-web] composer não encontrado; pageState=', JSON.stringify(state), 'pageUrl=', rawUrl);
          await dumpGeminiDiagnostics(page);
          let message = `Não encontrei o campo de digitação do Gemini (URL: ${rawUrl}). Verifique se está logado.`;
          if (state) {
            if (state.onLoginScreen) {
              message =
                'Gemini pede login (página de autenticação do Google). Clique em "Fazer login" no dashboard e conclua o login do Google.';
            } else if (state.composerFound) {
              message = 'Campo de digitação encontrado, mas o preenchimento falhou (UI do Gemini mudou?).';
            } else if (state.error) {
              message = `Falha ao inspecionar a página do Gemini (${state.error}). URL: ${state.url}. Verifique se está logado.`;
            } else {
              message = `Não encontrei o campo de digitação do Gemini (URL: ${state.url}). Verifique se está logado e se a página do Gemini carregou.`;
            }
          }
          push({ type: 'error', message });
          controller.close();
          return;
        }
        const sendOk = await page.evaluate(GEMINI_SCRIPT_CLICK_SEND).catch(() => false);
        if (!sendOk) await tryGeminiLocatorSend(page);

        let lastText = '';
        let stableCount = 0;
        const startedAt = Date.now();

        while (true) {
          if (page.isClosed()) {
            push({ type: 'error', message: 'A aba do Gemini foi fechada durante o chat.' });
            break;
          }
          if (Date.now() - startedAt > timeoutMs) {
            break;
          }
          await page.waitForTimeout(pollIntervalMs);

          const readResult = await page.evaluate(GEMINI_SCRIPT_READ_RESPONSE).catch(() => null);
          let text = '';
          let hasStop = false;
          if (readResult && typeof readResult.text === 'string') {
            text = readResult.text;
            hasStop = !!readResult.hasStop;
          } else {
            const locRead = await readGeminiResponseLocator(page);
            if (locRead) {
              text = locRead.text;
              hasStop = locRead.hasStop;
            }
          }
          const delta = computeTextDelta(lastText, text);
          if (delta) {
            lastText = text;
            stableCount = 0;
            push({ type: 'content', text: delta });
          } else if (lastText) {
            stableCount++;
          }

          if (!hasStop && lastText) {
            // Sem botão de parar: a resposta só termina de verdade quando o
            // texto para de crescer por alguns polls consecutivos.
            if (stableCount >= stablePolls) break;
          } else if (!hasStop && !lastText) {
            // Nada apareceu ainda e não há geração em andamento.
            if (stableCount >= 5) {
              push({ type: 'error', message: 'O Gemini não gerou nenhuma resposta.' });
              break;
            }
            stableCount++;
          }
        }

        push({ type: 'done' });
      } catch (err: any) {
        push({ type: 'error', message: err?.message || String(err) });
      }
      try {
        controller.close();
      } catch {
        // stream já encerrado
      }
    },
  });
}

/* --------------------------------------------------------------------------
 * Mock page (testes): processa os scripts marcados sem navegador real.
 * ------------------------------------------------------------------------ */

let mockGeminiPage: GeminiPageLike | null = null;

/** Injeta uma página fake usada quando TEST_MOCK_PLAYWRIGHT=true. */
export function setMockGeminiPage(page: GeminiPageLike | null): void {
  mockGeminiPage = page;
}

export function getMockGeminiPage(): GeminiPageLike | null {
  return mockGeminiPage;
}

/**
 * Página fake que simula o comportamento do Gemini: processa os scripts
 * marcados (__GEMINI_*__) e controla o texto da resposta. `responseFrames`
 * faz a resposta "crescer" a cada leitura até esvaziar (e aí o stop some).
 */
export class FakeGeminiPage implements GeminiPageLike {
  setPromptResult = true;
  sendClicked = false;
  dismissClicks = 0;
  responseText = '';
  hasStop = false;
  responseFrames: string[] | null = null;
  closed = false;
  prompts: string[] = [];
  evaluated: string[] = [];
  pageState = { url: 'https://gemini.google.com/app', onLoginScreen: false, composerFound: true, composerSelectors: {} };

  async evaluate(pageFunction: Function | string, arg?: unknown): Promise<any> {
    const src = typeof pageFunction === 'string' ? pageFunction : Function.prototype.toString.call(pageFunction);
    this.evaluated.push(src);
    if (src.includes('__GEMINI_GO_NEW_CHAT__')) return 'https://gemini.google.com/app';
    if (src.includes('__GEMINI_DISMISS_ONBOARDING__')) {
      this.dismissClicks++;
      return true;
    }
    if (src.includes('__GEMINI_SET_PROMPT__')) {
      this.prompts.push(String(arg ?? ''));
      return this.setPromptResult;
    }
    if (src.includes('__GEMINI_HAS_COMPOSER__')) {
      return true;
    }
    if (src.includes('__GEMINI_PAGE_STATE__')) {
      return this.pageState;
    }
    if (src.includes('__GEMINI_CLICK_SEND__')) {
      this.sendClicked = true;
      return true;
    }
    if (src.includes('__GEMINI_READ_RESPONSE__')) {
      if (this.responseFrames) {
        this.responseText = this.responseFrames.length ? this.responseFrames.shift()! : this.responseText;
        this.hasStop = this.responseFrames.length > 0;
      }
      return { text: this.responseText, hasStop: this.hasStop };
    }
    return undefined;
  }

  async waitForTimeout(): Promise<void> {
    // teste não espera de verdade
  }

  url(): string {
    return 'https://gemini.google.com/app';
  }

  async goto(): Promise<void> {
    // fake não navega de verdade
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Consome um stream de eventos e acumula o conteúdo — usado em testes.
 * Retorna o texto completo e a lista de eventos (para assertions de delta).
 */
export async function consumeGeminiWebStream(
  stream: ReadableStream<Uint8Array>
): Promise<{ text: string; events: GeminiStreamEvent[]; error?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const events: GeminiStreamEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as GeminiStreamEvent;
        events.push(ev);
        if (ev.type === 'content') text += ev.text;
        if (ev.type === 'error') return { text, events, error: ev.message };
      } catch {
        // linha parcial/inválida: ignora
      }
    }
  }
  return { text, events };
}

/** Mantém compatibilidade de tipo: aceita uma Page real do Playwright. */
export function toGeminiPageLike(page: Page | GeminiPageLike): GeminiPageLike {
  return page as GeminiPageLike;
}
