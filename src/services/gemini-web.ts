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
import { OpenAIRequest } from '../utils/types.ts';
import { buildFullHistoryPrompt, buildToolsInstructions, GOLDEN_EDIT_RULE } from '../utils/prompt.ts';
import { isModelBoosted } from './booster.ts';

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
 * de entrada (contenteditable ou textarea) E o texto completo foi registrado.
 * Roda como string (ver nota acima). O prompt chega como `arg` (Playwright).
 * Atravessa Shadow DOM.
 *
 * O editor rich-text do Gemini (Lexical) mantém o modelo de texto fora do DOM:
 * atribuir `textContent` direto mostra o texto na tela mas o estado interno
 * pode ficar vazio/parcial — o envio então vai sem o fim do prompt (e o Gemini
 * responde apenas o system prompt). Por isso a inserção é feita via
 * `execCommand('insertText')` em blocos (é O(n) no renderer: um único insert
 * de 80k chars congela a UI), com verificação final do comprimento.
 */
export const GEMINI_SCRIPT_SET_PROMPT = `(() => {
  const MARK = '__GEMINI_SET_PROMPT__';
  const prompt = __GEMINI_PROMPT_ARG__;
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
    let committed = 0;
    if (target.isContentEditable) {
      try {
        const sel2 = window.getSelection();
        if (sel2) sel2.selectAllChildren(target);
        const CHUNK = 4096;
        for (let i = 0; i < prompt.length; i += CHUNK) {
          document.execCommand('insertText', false, prompt.slice(i, i + CHUNK));
        }
        committed = (target.innerText || '').length;
      } catch (e) {
        committed = 0;
      }
      if (committed < prompt.length) {
        target.textContent = prompt;
        committed = (target.innerText || '').length;
      }
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      target.dispatchEvent(new InputEvent('change', { bubbles: true }));
    } else {
      target.value = prompt;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      committed = target.value.length;
    }
    return committed >= prompt.length;
  }
  return false;
})()`;

/**
 * Playwright NÃO liga `arg` a strings passadas no evaluate (isFunction=false →
 * só `eval(expression)`). O prompt precisa ir embutido no script. `__GEMINI_PROMPT_ARG__`
 * vira o JSON do prompt; o token some do script, então não há colisão.
 *
 * IMPORTANTE (SyntaxError: Invalid or unexpected token): NUNCA use
 * `.replace(marcador, JSON.stringify(prompt))` com a substituição em STRING —
 * o `String.replace` expande padrões `$&`, `$'`, `` $` `` e `$n` DENTRO do
 * valor produzido. Um prompt com código contendo `$&`/`$'` corrompe o script
 * (o resto do template é injetado dentro do literal do prompt) e a avaliação
 * no navegador quebra com "Invalid or unexpected token". A substituição por
 * FUNÇÃO usa o valor literal, sem expandir `$`. Os separadores de
 * linha/parágrafo (U+2028/U+2029) também são escapados: o JSON.stringify não
 * os escapa e, em engines antigas, quebram o parse do literal.
 */
export function geminiSetPromptScript(prompt: string): string {
  const payload = JSON.stringify(prompt)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return GEMINI_SCRIPT_SET_PROMPT.replace('__GEMINI_PROMPT_ARG__', () => payload);
}

/**
 * Teto de segurança HARDCODED do driver Gemini Web (não depende do dashboard):
 * o prompt enviado ao navegador nunca deve passar disso. Injetar centenas de
 * milhares de chars no contenteditable degrada o renderer do Gemini e faz a
 * IDE (Trae/Cursor) dar timeout antes da primeira palavra. Override opcional
 * via GEMINI_WEB_MAX_CHARS.
 */
export const MAX_GEMINI_WEB_CHARS = Number(process.env.GEMINI_WEB_MAX_CHARS) || 80000;

/**
 * Teto REAL do composer do Gemini: o editor rich-text (Lexical/GText) limita a
 * entrada a ~32.768 chars — um prompt maior entra só até o limite (empiricamente
 * 32.388) e o FIM do texto (onde fica a mensagem do usuário) é descartado, então
 * o Gemini responde apenas o system prompt (saudação "Hello! I am your AI
 * collaborator..."). Valor de segurança abaixo do limite observado. Override
 * opcional via GEMINI_WEB_COMPOSER_SAFE_CHARS.
 */
export const GEMINI_WEB_COMPOSER_SAFE_CHARS = Number(process.env.GEMINI_WEB_COMPOSER_SAFE_CHARS) || 30000;

/** Converte `content` (string | partes OpenAI | tool result) em texto plano. */
function messageText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) =>
        p && typeof p === 'object' && p.type === 'image_url' ? '[imagem]' : p?.text ?? JSON.stringify(p)
      )
      .join('\n');
  }
  return content ? String(content) : '';
}

/**
 * Trunca o CONTEÚDO interno de uma mensagem mantendo a cabeça e a cauda
 * (onde ficam a instrução visível e o pedido atual) com um marcador no meio.
 * Nunca descarta a mensagem inteira.
 */
function clipMessageContent(msg: any, budget: number): any {
  const text = messageText(msg.content);
  if (text.length <= budget) return msg;
  const headLen = Math.floor(budget * 0.6);
  const tailLen = Math.floor(budget * 0.3);
  const middle = text.length - headLen - tailLen;
  return {
    ...msg,
    content: `${text.slice(0, headLen)}\n…[truncado: ${middle} chars]\n${text.slice(text.length - tailLen)}`,
  };
}

/**
 * Corte inteligente para o Gemini Web com ÂNCORAS OBRIGATÓRIAS:
 *   1. TODAS as mensagens system (instruções da IDE — nunca se perdem);
 *   2. A ÚLTIMA mensagem (o turno atual do usuário);
 *   3. Se a última não for do usuário (Trae anexa tool/assistant depois), o
 *      último user real também vira âncora;
 *   4. Se as âncoras estouram o teto, a ÚLTIMA mensagem tem o conteúdo interno
 *      truncado (cabeça + cauda preservam a instrução), em vez de ser cortada;
 *   5. O orçamento restante é preenchido com o histórico intermediário, de
 *      trás para frente (descarta só o miolo antigo).
 * Retorna o body inalterado quando já cabe no teto.
 */
export function smartTruncateHistory(body: OpenAIRequest, maxChars: number = MAX_GEMINI_WEB_CHARS): OpenAIRequest {
  const messages = body.messages || [];
  if (messages.length === 0) return body;
  if (buildFullHistoryPrompt(body).length <= maxChars) return body;

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length === 0) return body;

  // Âncoras: última mensagem + (se preciso) último user real.
  const lastMsg = rest[rest.length - 1];
  const anchorTail: any[] = [lastMsg];
  if (lastMsg.role !== 'user') {
    for (let i = rest.length - 2; i >= 0; i--) {
      if (rest[i].role === 'user') {
        anchorTail.unshift(rest[i]);
        break;
      }
    }
  }
  const anchorIds = new Set(anchorTail);
  const intermediates = rest.filter((m) => !anchorIds.has(m));

  // Âncoras estouram o teto? Trunca o conteúdo da última mensagem em vez de
  // descartá-la (cabeça + cauda = instrução visível).
  let finalAnchors = anchorTail;
  const anchorsCost = buildFullHistoryPrompt({ ...body, messages: [...systemMsgs, ...anchorTail] }).length;
  if (anchorsCost > maxChars) {
    const systemCost = buildFullHistoryPrompt({ ...body, messages: systemMsgs }).length;
    const lastBudget = Math.max(1000, maxChars - systemCost - 50);
    const clippedLast = clipMessageContent(lastMsg, lastBudget);
    finalAnchors = [...anchorTail.filter((m) => m !== lastMsg), clippedLast];
  }

  // Preenche o orçamento restante com o histórico intermediário (de trás p/ frente).
  let keptLen = 0;
  for (let k = intermediates.length; k >= 1; k--) {
    const slice = intermediates.slice(intermediates.length - k);
    const candidate = [...systemMsgs, ...slice, ...finalAnchors];
    if (buildFullHistoryPrompt({ ...body, messages: candidate }).length <= maxChars) {
      keptLen = k;
      break;
    }
  }
  const kept = intermediates.slice(intermediates.length - keptLen);
  return { ...body, messages: [...systemMsgs, ...kept, ...finalAnchors] };
}

/** Converte uma mensagem não-system em texto no formato do prompt. */
function formatTurnForPrompt(msg: any): string {
  const contentStr = messageText(msg.content);
  if (msg.role === 'user') return `User: ${contentStr}`;
  if (msg.role === 'assistant') {
    let out = contentStr;
    if ((msg as any).reasoning_content) {
      out = `<think>\n${(msg as any).reasoning_content}\n</think>\n${out}`;
    }
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let args = tc.function?.arguments || '{}';
        if (typeof args !== 'string') args = JSON.stringify(args);
        out += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
      }
    }
    return `Assistant: ${out.trim()}`;
  }
  if (msg.role === 'tool' || msg.role === 'function') {
    return `Tool Response (${msg.name || 'tool'}): ${contentStr}`;
  }
  return '';
}

/**
 * Monta o prompt do Gemini Web respeitando o TETO REAL do composer
 * (GEMINI_WEB_COMPOSER_SAFE_CHARS). Quando o prompt completo não cabe,
 * prioriza:
 *   1. A CAUDA da conversa — termina na pergunta atual do usuário (se perdida,
 *      o Gemini responde só o system prompt);
 *   2. O bloco de TOOLS — contrato funcional do modelo (formato <tool_call> +
 *      nomes, que ficam na cabeça do bloco; schemas detalhados no fim);
 *   3. A CABEÇA do system prompt — persona + instruções iniciais da IDE.
 * Retorna o prompt completo quando já cabe no teto.
 */
/**
 * Contrato de ferramentas usado quando o cliente NÃO envia `tools` no
 * request. O Trae/IDE espera que o modelo emita `<tool_call>` para criar
 * arquivos, mas sem o contrato no prompt o Gemini Web só narra ("Criei o
 * arquivo...") e o arquivo nunca é criado. Os nomes/schemas seguem o padrão
 * dos agentes de IDE (Write/Edit/Read/Bash).
 */
export const FALLBACK_TOOLS_CONTRACT = `
# TOOLS AVAILABLE
You are a coding agent. To use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:

<tool_call>
{"name": "tool_name", "arguments": {"param_name": "value"}}
</tool_call>

Available tools:
- "Write": create or overwrite a file. arguments: {"file_path": "relative path", "content": "full file text"}
- "Edit": apply a text replacement in a file. arguments: {"file_path": "relative path", "old_string": "text to replace", "new_string": "replacement text"}
- "Read": read a file. arguments: {"file_path": "relative path"}
- "Bash": run a shell command. arguments: {"command": "command to run"}

RULES:
1. Call multiple tools by outputting multiple <tool_call> blocks consecutively.
2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.
3. The JSON must be valid and follow the tool's parameters exactly.
4. When passing code/HTML inside a JSON string value (ex.: <html lang="pt-BR">), escape the inner double quotes as \\" so the JSON stays valid.
5. Use forward slashes (/) in file_path values (ex.: "C:/Users/nome/arquivo.html"), NEVER backslashes — they break the JSON.
6. Always respond in the same language as the user's latest message (ex.: user writes in Portuguese -> reply in Portuguese, not English).

${GOLDEN_EDIT_RULE}
`;

/** Bloco de tools para o prompt: schema do cliente ou contrato fallback. */
function webToolsBlock(body: OpenAIRequest): string {
  const fromClient = buildToolsInstructions(body, { booster: isModelBoosted(body.model) });
  if (fromClient) return fromClient;
  return FALLBACK_TOOLS_CONTRACT;
}

export function buildGeminiWebPrompt(body: OpenAIRequest, maxChars: number = GEMINI_WEB_COMPOSER_SAFE_CHARS): string {
  const messages = body.messages || [];
  let system = '';
  const turns: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += messageText(msg.content) + '\n\n';
      continue;
    }
    const text = formatTurnForPrompt(msg);
    if (text) turns.push(text);
  }
  const conversation = turns.join('\n\n');
  const tools = webToolsBlock(body);

  const assemble = (...parts: string[]) => parts.filter((s) => s && s.trim()).join('\n');
  const full = assemble(system, tools, conversation);
  if (full.length <= maxChars) return full;

  const toolsBudget = Math.floor(maxChars * 0.3);
  let keepTools = '';
  if (tools.length > 0) {
    if (tools.length <= toolsBudget) {
      keepTools = tools;
    } else {
      // O formato + regras + nomes estão na CABEÇA do bloco (ver
      // buildToolsInstructions): o corte preserva o contrato de chamada.
      keepTools = tools.slice(0, toolsBudget).replace(/\s+$/, '') + '\n…(schemas de mais ferramentas omitidos)\n';
    }
  }

  const convLen = conversation.length;
  const convBudget = Math.min(convLen, Math.floor((maxChars - keepTools.length - 64) * 0.55));
  const sysBudget = Math.max(0, maxChars - keepTools.length - convBudget - 64);

  const keepSys = sysBudget > 0 ? system.slice(0, sysBudget).replace(/\s+$/, '') : '';
  let keepConv = convBudget > 0 ? conversation.slice(-convBudget) : '';
  // Evita começar no meio de uma palavra: corta no início da primeira
  // "User:"/"Assistant:"/"Tool Response" visível após o ponto de corte.
  const boundary = keepConv.search(/\n\n(?=User:|Assistant:|Tool Response)/);
  if (boundary > 0) keepConv = keepConv.slice(boundary + 2);

  return assemble(keepSys, keepTools, keepConv);
}

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
    const visible = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      } catch {
        return false;
      }
    };
    const nodes = all.filter((el) => el.matches('.model-response-text') && visible(el));
    const last = nodes[nodes.length - 1];
    const text = last ? last.innerText || '' : '';
    const stopVisible = all
      .filter((el) => el.matches('button'))
      .some((b) => {
        if (b.offsetParent === null) return false;
        const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
        if (/(stop|parar)/i.test(label)) return true;
        const icon = b.querySelector('mat-icon');
        return !!icon && /(stop|parar)/i.test((icon.textContent || '').trim());
      });
    return { text: text, hasStop: stopVisible };
  } catch (e) {
    return { text: '', hasStop: false };
  }
})()`;

/** Lê o texto efetivamente registrado no composer (para verificar se o prompt
 *  completo entrou — o editor rich-text do Gemini pode ignorar o fim do texto). */
export const GEMINI_SCRIPT_READ_COMPOSER = `(() => {
  const MARK = '__GEMINI_READ_COMPOSER__';
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
      const el = all.find((x) => x.matches(sel));
      if (!el) continue;
      const text = el.isContentEditable ? el.innerText || '' : el.value || '';
      return { length: text.length, tail: text.slice(-300) };
    }
    return { length: 0, tail: '' };
  } catch (e) {
    return { length: 0, tail: '' };
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
  /** Quando aborta (ex.: cliente Trae/Cursor pausou o request), o turno
   *  termina o quanto antes para devolver a aba ao pool. */
  abortSignal?: AbortSignal;
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
      hasStop = await page
        .locator('button[aria-label*="stop" i], button[aria-label*="parar" i], button[title*="stop" i], button[title*="parar" i]')
        .first()
        .isVisible();
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

/** Polls de silêncio necessários para declarar a resposta concluída.
 *  Escala com o tamanho da resposta: modelos de raciocínio pausam por
 *  segundos entre bursts ao gerar saídas longas (ex.: HTML). */
function stablePollsForLength(charCount: number, pollIntervalMs: number, basePolls: number): number {
  const baseMs = basePolls * pollIntervalMs;
  const extraMs = Math.min(4200, Math.floor(Math.max(0, charCount - 2000) / 2000) * 400);
  return Math.max(basePolls, Math.ceil((baseMs + extraMs) / pollIntervalMs));
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
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const stablePolls = opts.stablePolls ?? 4;
  const abortSignal = opts.abortSignal;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (ev: GeminiStreamEvent) => {
        try {
          controller.enqueue(encodeEvent(ev));
        } catch {
          // controller já fechado
        }
      };

      // Cliente (Trae/Cursor) pausou o request: encerra o turno e devolve a
      // aba ao pool sem esperar a resposta acabar.
      const bailIfAborted = (): boolean => {
        if (abortSignal?.aborted) {
          push({ type: 'done' });
          controller.close();
          return true;
        }
        return false;
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
        // Deixa a SPA do Gemini montar o composer antes de digitar. Em vez de
        // um sleep fixo, faz polling de prontidão (HAS_COMPOSER): se o composer
        // montar antes do teto, segue sem esperar o tempo cheio; o teto mantém
        // o pior caso igual ao sleep antigo. Página fake que não implementa o
        // marker retorna undefined e segue direto (assume pronto).
        const composerReadyDeadline = Date.now() + 1500;
        while (Date.now() < composerReadyDeadline) {
          const hasComposer = await page.evaluate(GEMINI_SCRIPT_HAS_COMPOSER).catch(() => false);
          if (hasComposer === true || hasComposer === undefined) break;
          if (bailIfAborted()) return;
          await page.waitForTimeout(200);
        }
        if (bailIfAborted()) return;
        await page.evaluate(GEMINI_SCRIPT_DISMISS_ONBOARDING).catch(() => {});

        let setOk = await page.evaluate(geminiSetPromptScript(prompt)).catch((e: any) => {
          console.log('[gemini-web] setPrompt evaluate error:', e?.message);
          return false;
        });
        if (bailIfAborted()) return;
        if (!setOk) {
          // Shadow DOM: document.querySelector não atravessa shadowRoot; o
          // locator nativo do Playwright atravessa.
          setOk = await tryGeminiLocatorPrompt(page, prompt);
        }
        if (!setOk) {
          // Retry: hidratação lenta da SPA pode atrasar o composer.
          await page.waitForTimeout(2000);
          if (bailIfAborted()) return;
          setOk = await page.evaluate(geminiSetPromptScript(prompt)).catch((e: any) => {
            console.log('[gemini-web] setPrompt evaluate error (retry):', e?.message);
            return false;
          });
          if (bailIfAborted()) return;
          if (!setOk) setOk = await tryGeminiLocatorPrompt(page, prompt);
        }
        if (setOk) {
          console.log(`[gemini-web] composer preenchido chars=${prompt.length}`);
        }
        // Verifica se o texto COMPLETO entrou no composer. O editor rich-text do
        // Gemini (Lexical) às vezes registra só parte do texto (o fim do prompt,
        // onde fica a mensagem do usuário, fica de fora) e o Gemini então responde
        // apenas o system prompt — ex.: saudação "Hello! I am your AI collaborator".
        if (setOk) {
          const rb: any = await page.evaluate(GEMINI_SCRIPT_READ_COMPOSER).catch(() => null);
          if (rb && typeof rb.length === 'number' && rb.length < prompt.length) {
            console.warn(
              `[gemini-web] composer INCOMPLETO: ${rb.length}/${prompt.length} chars. Tail=${JSON.stringify(rb.tail)}. Re-tentando preenchimento...`
            );
            const reOk = await tryGeminiLocatorPrompt(page, prompt);
            if (reOk) {
              const rb2: any = await page.evaluate(GEMINI_SCRIPT_READ_COMPOSER).catch(() => null);
              console.log(
                `[gemini-web] composer re-preenchido via locator: ${
                  rb2 && typeof rb2.length === 'number' ? rb2.length + '/' + prompt.length + ' chars' : 'verificação indisponível'
                }`
              );
            } else {
              console.warn(`[gemini-web] re-preenchimento via locator falhou; continuando com ${rb.length} chars.`);
            }
          }
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
        if (bailIfAborted()) return;
        if (!sendOk) await tryGeminiLocatorSend(page);

        let lastText = '';
        let stableCount = 0;
        const startedAt = Date.now();

        const requiredStablePolls = () => {
          if (opts.stablePolls !== undefined) return opts.stablePolls;
          return stablePollsForLength(lastText.length, pollIntervalMs, stablePolls);
        };

        while (true) {
          if (bailIfAborted()) return;
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
            // texto para de crescer por alguns polls consecutivos. O teto é
            // adaptativo ao tamanho: respostas longas (modelos de raciocínio)
            // pausam por segundos entre bursts e não podem usar o padrão curto.
            if (stableCount >= requiredStablePolls()) break;
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
      const m = src.match(/const prompt = ("[\s\S]*?");/);
      const embedded = m ? JSON.parse(m[1]) : undefined;
      this.prompts.push(embedded !== undefined ? embedded : String(arg ?? ''));
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
