/* =============================================================================
 * ChatComponent — widget de chat responsivo e reutilizável.
 *
 * Fonte de dados: API compatível com OpenAI (/v1/chat/completions), com
 * streaming SSE. Estilos são injetados de forma escopada (prefixo `ds-chat-`),
 * sem dependências externas.
 *
 * Uso básico:
 *
 *   import { ChatComponent } from "/components/chat-component.js";
 *
 *   const chat = new ChatComponent({
 *     el: "#chatMount",                         // seletor ou elemento
 *     models: ["deepseek-thinking", "deepseek-no-thinking"],
 *     apiKey: () => localStorage.getItem("key") || "",
 *     placeholder: "Envie uma mensagem...",
 *   }).init();
 *
 *   chat.sendMessage("Olá");
 *   chat.setModel("deepseek-thinking");
 *   chat.clearChat();
 *   chat.destroy();
 *
 * Eventos customizados (disparados no elemento raiz):
 *   chat:message-sent      detail { text }
 *   chat:message-received  detail { content, reasoning, usage }
 *   chat:cleared           detail {}
 *   chat:error             detail { message }
 *
 * Documentação completa em: src/ui/components/README.md
 * ========================================================================== */

"use strict";

const DEFAULTS = {
  baseUrl: "",                       // base da API (ex.: "http://localhost:3005")
  apiUrl: null,                      // URL completa do endpoint (prioridade sobre baseUrl)
  apiKey: "",                        // string ou função que retorna a chave
  models: ["deepseek-thinking", "deepseek-no-thinking"],
  placeholder: "Envie uma mensagem... (Enter envia, Shift+Enter quebra linha)",
  greeting: "",                      // mensagem de boas-vindas (markdown); "" desativa
  showHeader: true,                  // mostra o cabeçalho interno (modelo ativo)
  showSidebar: true,                 // menu lateral com o botão "Nova conversa"
  sidebarTitle: "Conversas",
  ariaLabel: "Mensagens do chat",
  autofocus: false,                  // foca o input no init()
  onMessageSent: null,               // callback ({ text }) após enviar
  renderMarkdown: null,              // lazy: (markdown) => html; default = renderizador interno
  debounceMs: 120,                   // debounce do auto-grow do input
  overscan: 3,                       // linhas extra renderizadas acima/abaixo da viewport
  virtualThreshold: 40,              // nº de mensagens para ativar virtual scrolling
};

const SEND_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 11.5 21 3l-8.5 18-2.5-7.5L3 11.5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const STOP_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

/* ----------------------------- Utilitários ------------------------------- */

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function uid() {
  return "m-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* --------------------- Renderizador de markdown -------------------------- */

function inlineMd(t) {
  let r = t;
  r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
  r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  r = r.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, "$1<em>$2</em>");
  r = r.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  r = r.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return r;
}

function mdToHtml(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let listType = null;
  let listBuf = [];

  const isSpecial = (ln) =>
    /^\s*$/.test(ln) ||
    /^#{1,4}\s/.test(ln) ||
    /^```/.test(ln) ||
    /^\s*>\s?/.test(ln) ||
    /^\s*([-*+])\s/.test(ln) ||
    /^\s*\d+\.\s/.test(ln) ||
    /^\s*([-*_])\1{2,}\s*$/.test(ln);

  const closeList = () => {
    if (listType) {
      html += "<" + listType + ">" + listBuf.join("") + "</" + listType + ">";
      listType = null;
      listBuf = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      if (inCode) {
        html += "<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>";
        inCode = false;
        codeBuf = [];
      } else {
        closeList();
        inCode = true;
        codeBuf = [];
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      closeList();
      html += "<h" + h[1].length + ">" + inlineMd(escapeHtml(h[2])) + "</h" + h[1].length + ">";
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      html += "<hr>";
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const q = [line.replace(/^\s*>\s?/, "")];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
        i++;
        q.push(lines[i].replace(/^\s*>\s?/, ""));
      }
      html += "<blockquote>" + inlineMd(escapeHtml(q.join("\n"))).replace(/\n/g, "<br>") + "</blockquote>";
      i++;
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
      }
      listBuf.push("<li>" + inlineMd(escapeHtml(ul[1])) + "</li>");
      i++;
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
      }
      listBuf.push("<li>" + inlineMd(escapeHtml(ol[1])) + "</li>");
      i++;
      continue;
    }

    closeList();
    let para = line;
    while (i + 1 < lines.length && !isSpecial(lines[i + 1])) {
      i++;
      para += "\n" + lines[i];
    }
    html += "<p>" + inlineMd(escapeHtml(para)).replace(/\n/g, "<br>") + "</p>";
    i++;
  }

  if (inCode) html += "<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>";
  closeList();
  return html;
}

/* ------------------------------- CSS scoped ------------------------------- */

const CSS = `
.ds-chat {
  --ds-accent: #4f8cff;
  --ds-bg: #0f1522;
  --ds-panel: #121826;
  --ds-panel-2: #0f1522;
  --ds-border: #1f2a3d;
  --ds-text: #dce3f0;
  --ds-muted: #7b8aa5;
  --ds-purple: #a78bfa;
  --ds-red: #f2645f;

  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--ds-bg);
  border: 1px solid var(--ds-border);
  border-radius: 12px;
  overflow: hidden;
  font-family: inherit;
  color: var(--ds-text);
}
.ds-chat * { box-sizing: border-box; }

.ds-chat__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ds-border);
  background: var(--ds-panel);
}
.ds-chat__header-model {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.ds-chat__header-model i { color: var(--ds-accent); font-size: 13px; }
.ds-chat__header-model-name { color: var(--ds-accent); }

.ds-chat__body-wrap {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
}

/* Sidebar */
.ds-chat__sidebar {
  width: 190px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-right: 1px solid var(--ds-border);
  background: var(--ds-panel-2);
  overflow-y: auto;
}
.ds-chat__sidebar-title {
  font-size: 11px;
  color: var(--ds-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
  padding: 0 4px;
}
.ds-chat__sidebar .ds-chat__new-btn {
  width: 100%;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--ds-border);
  background: var(--ds-panel);
  color: var(--ds-text);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.ds-chat__sidebar .ds-chat__new-btn:hover { border-color: var(--ds-accent); color: var(--ds-accent); }

.ds-chat__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* Área de mensagens (virtual scrolling) */
.ds-chat__thread {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0;
  scrollbar-width: thin;
  scrollbar-color: #2b3b56 transparent;
}
.ds-chat__thread::-webkit-scrollbar { width: 10px; }
.ds-chat__thread::-webkit-scrollbar-thumb { background: #2b3b56; border-radius: 6px; }
.ds-chat__thread::-webkit-scrollbar-thumb:hover { background: #38507a; }
.ds-chat__spacer { position: relative; }
.ds-chat__row {
  position: absolute;
  left: 0;
  right: 0;
  padding: 12px 14px 16px;
}

.ds-chat__msg { display: flex; gap: 12px; align-items: flex-start; }
.ds-chat__msg--user { justify-content: flex-end; }
.ds-chat__msg--user .ds-chat__bubble {
  max-width: 78%;
  background: #1d3a5f;
  border: 1px solid #2b4d78;
  color: #e8f0ff;
  padding: 10px 14px;
  border-radius: 16px;
  border-bottom-right-radius: 5px;
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.ds-chat__avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  margin-top: 2px;
  background: linear-gradient(135deg, #4f8cff, #a78bfa);
}
.ds-chat__body { flex: 1; min-width: 0; }
.ds-chat__md { font-size: 14px; line-height: 1.6; color: var(--ds-text); overflow-wrap: break-word; }
.ds-chat__md p { margin: 0 0 10px; }
.ds-chat__md p:last-child { margin-bottom: 0; }
.ds-chat__md h1, .ds-chat__md h2, .ds-chat__md h3, .ds-chat__md h4 { margin: 14px 0 8px; line-height: 1.3; }
.ds-chat__md h1 { font-size: 19px; } .ds-chat__md h2 { font-size: 17px; }
.ds-chat__md h3 { font-size: 15.5px; } .ds-chat__md h4 { font-size: 14.5px; }
.ds-chat__md ul, .ds-chat__md ol { margin: 0 0 10px; padding-left: 22px; }
.ds-chat__md li { margin: 3px 0; }
.ds-chat__md blockquote {
  border-left: 3px solid var(--ds-accent);
  margin: 8px 0;
  padding: 2px 12px;
  color: var(--ds-muted);
  background: #0d1420;
  border-radius: 0 8px 8px 0;
}
.ds-chat__md code {
  font-family: "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
  background: #0d1420;
  border: 1px solid var(--ds-border);
  border-radius: 5px;
  padding: 1px 5px;
}
.ds-chat__md pre {
  background: #070a11;
  border: 1px solid var(--ds-border);
  border-radius: 10px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 10px 0;
}
.ds-chat__md pre code { background: none; border: none; padding: 0; display: block; line-height: 1.55; }
.ds-chat__md a { color: var(--ds-accent); }
.ds-chat__md hr { border: none; border-top: 1px solid var(--ds-border); margin: 14px 0; }

.ds-chat__thinking {
  background: rgba(167, 139, 250, 0.06);
  border: 1px solid rgba(167, 139, 250, 0.25);
  border-radius: 10px;
  margin-bottom: 10px;
  overflow: hidden;
}
.ds-chat__thinking summary {
  cursor: pointer;
  padding: 7px 12px;
  color: var(--ds-purple);
  font-size: 12.5px;
  user-select: none;
  font-weight: 600;
}
.ds-chat__thinking summary::marker { color: var(--ds-purple); }
.ds-chat__thinking-body {
  padding: 4px 12px 10px;
  color: #b8a6f7;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "Cascadia Code", Consolas, monospace;
}

.ds-chat__meta {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 6px;
  font-size: 12px;
  color: var(--ds-muted);
}
.ds-chat__meta button {
  background: none;
  border: none;
  color: var(--ds-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  font-family: inherit;
}
.ds-chat__meta button:hover { color: var(--ds-text); }

.ds-chat__composer {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  padding: 12px 14px;
  border-top: 1px solid var(--ds-border);
  background: var(--ds-panel);
}
.ds-chat__select {
  width: auto;
  min-width: 185px;
  background: var(--ds-panel-2);
  border: 1px solid var(--ds-border);
  color: var(--ds-accent);
  border-radius: 12px;
  padding: 13px 12px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 600;
}
.ds-chat__input {
  flex: 1;
  min-height: 56px;
  max-height: 200px;
  resize: none;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--ds-panel-2);
  border: 1px solid var(--ds-border);
  color: var(--ds-text);
  font-family: inherit;
}
.ds-chat__input:focus { outline: none; border-color: var(--ds-accent); }
.ds-chat__send {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ds-accent);
  border: none;
  cursor: pointer;
  color: #fff;
}
.ds-chat__send:hover { filter: brightness(1.1); }
.ds-chat__send--stop { background: var(--ds-red); }
.ds-chat__send:disabled { opacity: 0.45; cursor: not-allowed; }

.ds-chat__caret {
  display: inline-block;
  width: 8px;
  height: 15px;
  background: var(--ds-accent);
  vertical-align: text-bottom;
  animation: ds-chat-blinkc 1s step-start infinite;
  border-radius: 1px;
}
@keyframes ds-chat-blinkc { 50% { opacity: 0; } }

.ds-chat__typing { display: inline-flex; gap: 5px; padding: 12px 4px; }
.ds-chat__typing span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ds-accent);
  animation: ds-chat-blink 1.2s infinite;
}
.ds-chat__typing span:nth-child(2) { animation-delay: 0.2s; }
.ds-chat__typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes ds-chat-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

.ds-chat__empty { color: var(--ds-muted); margin: 0; }

.ds-chat__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* ------------------------------- Responsivo ------------------------------ */

/* Tablet: 481px - 768px */
@media (min-width: 481px) and (max-width: 768px) {
  .ds-chat__select { min-width: 150px; }
  .ds-chat__thread .ds-chat__row { padding: 10px 12px 16px; }
  .ds-chat__sidebar { width: 165px; }
}

/* Mobile: <= 480px */
@media (max-width: 480px) {
  .ds-chat { border-radius: 8px; }
  .ds-chat__header { flex-direction: column; align-items: flex-start; padding: 8px 12px; }
  .ds-chat__header-model { font-size: 13px; }
  .ds-chat__composer { flex-direction: column; gap: 8px; padding: 10px 10px 12px; }
  .ds-chat__select { width: 100%; min-width: 0; }
  .ds-chat__send { width: 100%; height: 48px; }
  .ds-chat__body-wrap { flex-direction: column; }
  .ds-chat__sidebar {
    width: 100%;
    flex-direction: row;
    align-items: center;
    border-right: none;
    border-bottom: 1px solid var(--ds-border);
  }
  .ds-chat__sidebar .ds-chat__new-btn { width: auto; }
  .ds-chat__row { padding: 8px 10px 14px; }
  .ds-chat__bubble,
  .ds-chat__md,
  .ds-chat__md code { font-size: 12.5px; }
  .ds-chat__md { line-height: 1.5; }
  .ds-chat__input { font-size: 15px; }
}
`;

/* ----------------------------- Componente -------------------------------- */

class ChatComponent {
  /**
   * @param {Object} options — veja DEFAULTS acima e o README.
   */
  constructor(options = {}) {
    this.options = Object.assign({}, DEFAULTS, options);
    this.messages = [];
    this._heights = [];
    this._rowEls = new Map();
    this._model = this._modelOptions()[0]?.id || "";
    this._busy = false;
    this._abort = null;
    this._initialized = false;
    this._listeners = [];
    this._raf = null;
    this._debounce = null;
    this._startTime = 0;
    this._stickToBottom = true;
    this._pendingStream = false;
  }

  /* ----------------------------- Público ------------------------------- */

  init() {
    if (this._initialized) return this;
    this._initialized = true;

    const host = this.options.el;
    this._root = typeof host === "string" ? document.querySelector(host) : host;
    if (!this._root) throw new Error("ChatComponent: elemento de destino não encontrado");

    this._injectStyles();
    this._buildDom();
    this._bindEvents();

    if (this.options.greeting) {
      this.messages.push({
        id: uid(),
        role: "assistant",
        content: this.options.greeting,
        done: true,
        greeting: true,
      });
    }

    this._render();
    this._scheduleStick();
    if (this.options.autofocus) this._focusInput();
    return this;
  }

  sendMessage(text) {
    if (this._busy) return false;
    const msg = String(text == null ? "" : text).trim();
    if (!msg) return false;
    this._send(msg);
    if (this._input && this._input.value.trim() === msg) {
      this._input.value = "";
      this._autoGrow();
    }
    return true;
  }

  clearChat() {
    if (this._abort) {
      try { this._abort.abort(); } catch (e) { /* ignore */ }
      this._abort = null;
    }
    this._busy = false;
    this._setBusyUi(false);
    this.messages = [];
    this._heights = [];
    for (const [, rowEl] of this._rowEls) rowEl.remove();
    this._rowEls.clear();

    if (this.options.greeting) {
      this.messages.push({
        id: uid(),
        role: "assistant",
        content: this.options.greeting,
        done: true,
        greeting: true,
      });
    }
    this._render();
    this._scheduleStick();
    this._emit("chat:cleared", {});
    return this;
  }

  setModel(modelName) {
    const ids = this._modelOptions().map((m) => m.id);
    if (ids.indexOf(modelName) === -1) return this;
    this._model = modelName;
    if (this._select) this._select.value = modelName;
    if (this._headerModel) this._headerModel.textContent = this._modelLabel(modelName);
    return this;
  }

  setModels(models) {
    this.options.models = models;
    if (this._select) {
      const prev = this._model;
      this._select.innerHTML = "";
      for (const m of this._modelOptions()) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.label;
        this._select.appendChild(o);
      }
      if (this._modelOptions().some((m) => m.id === prev)) this._model = prev;
      else this._model = this._modelOptions()[0]?.id || "";
      this._select.value = this._model;
      if (this._headerModel) this._headerModel.textContent = this._modelLabel(this._model);
    }
    return this;
  }

  destroy() {
    if (this._abort) {
      try { this._abort.abort(); } catch (e) { /* ignore */ }
      this._abort = null;
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._debounce) clearTimeout(this._debounce);

    for (const [target, type, fn] of this._listeners) {
      target.removeEventListener(type, fn);
    }
    this._listeners = [];

    if (this._styleEl && this._styleEl.parentNode) {
      this._styleEl.parentNode.removeChild(this._styleEl);
    }
    this._styleEl = null;

    if (this._root) this._root.innerHTML = "";
    this._thread = null;
    this._input = null;
    this._sendBtn = null;
    this._select = null;
    this._spacer = null;
    this._sr = null;
    this._initialized = false;
  }

  getModel() {
    return this._model;
  }

  isBusy() {
    return this._busy;
  }

  /* ----------------------------- Interno ------------------------------- */

  _modelOptions() {
    const list = Array.isArray(this.options.models) ? this.options.models : [];
    return list.map((m) =>
      typeof m === "string" ? { id: m, label: m } : { id: m.id, label: m.label || m.id }
    );
  }

  _modelLabel(id) {
    const found = this._modelOptions().find((m) => m.id === id);
    return found ? found.label : id;
  }

  _injectStyles() {
    if (document.getElementById("ds-chat-styles")) return;
    this._styleEl = el("style");
    this._styleEl.id = "ds-chat-styles";
    this._styleEl.textContent = CSS;
    document.head.appendChild(this._styleEl);
  }

  _buildDom() {
    const root = this._root;
    root.classList.add("ds-chat");
    root.innerHTML = "";

    if (this.options.showHeader) {
      const header = el("div", "ds-chat__header");
      const modelWrap = el("div", "ds-chat__header-model");
      modelWrap.innerHTML = '<i aria-hidden="true">◆</i>';
      const modelName = el("span", "ds-chat__header-model-name");
      modelName.textContent = this._modelLabel(this._model);
      modelWrap.appendChild(modelName);
      header.appendChild(modelWrap);
      this._headerModel = modelName;
      root.appendChild(header);
    }

    const bodyWrap = el("div", "ds-chat__body-wrap");

    if (this.options.showSidebar) {
      const sidebar = el("aside", "ds-chat__sidebar");
      sidebar.setAttribute("aria-label", "Conversas");
      const title = el("div", "ds-chat__sidebar-title");
      title.textContent = this.options.sidebarTitle;
      const newBtn = el("button", "ds-chat__new-btn");
      newBtn.type = "button";
      newBtn.innerHTML = '<span aria-hidden="true">+</span> Nova conversa';
      newBtn.addEventListener("click", () => this.clearChat());
      sidebar.appendChild(title);
      sidebar.appendChild(newBtn);
      bodyWrap.appendChild(sidebar);
      this._listeners.push([newBtn, "click", () => this.clearChat()]);
    }

    const main = el("div", "ds-chat__main");

    const thread = el("div", "ds-chat__thread");
    thread.setAttribute("role", "log");
    thread.setAttribute("aria-live", "polite");
    thread.setAttribute("aria-relevant", "additions");
    thread.setAttribute("aria-label", this.options.ariaLabel);
    const spacer = el("div", "ds-chat__spacer");
    thread.appendChild(spacer);
    this._thread = thread;
    this._spacer = spacer;
    main.appendChild(thread);

    const sr = el("span", "ds-chat__sr");
    sr.setAttribute("aria-live", "polite");
    sr.textContent = "";
    this._sr = sr;
    main.appendChild(sr);

    const composer = el("div", "ds-chat__composer");
    const select = el("select", "ds-chat__select");
    select.setAttribute("aria-label", "Modelo");
    for (const m of this._modelOptions()) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      select.appendChild(o);
    }
    select.value = this._model;
    this._select = select;

    const input = el("textarea", "ds-chat__input");
    input.rows = 1;
    input.placeholder = this.options.placeholder;
    input.setAttribute("aria-label", "Mensagem");
    this._input = input;

    const send = el("button", "ds-chat__send");
    send.type = "button";
    send.setAttribute("aria-label", "Enviar mensagem");
    send.innerHTML = SEND_ICON;
    this._sendBtn = send;

    composer.appendChild(select);
    composer.appendChild(input);
    composer.appendChild(send);
    main.appendChild(composer);

    bodyWrap.appendChild(main);
    root.appendChild(bodyWrap);
  }

  _bindEvents() {
    const on = (target, type, fn) => {
      target.addEventListener(type, fn);
      this._listeners.push([target, type, fn]);
    };

    const thread = this._thread;
    const input = this._input;
    const send = this._sendBtn;
    const select = this._select;

    on(thread, "scroll", () => {
      this._onScroll();
    });

    on(input, "input", () => {
      if (this._debounce) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._autoGrow(), this.options.debounceMs);
    });

    on(input, "keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendMessage(input.value);
      }
    });

    on(send, "click", () => {
      if (this._busy) {
        if (this._abort) this._abort.abort();
        return;
      }
      this.sendMessage(input.value);
    });

    on(select, "change", () => {
      this.setModel(select.value);
    });

    on(thread, "click", (e) => {
      const btn = e.target.closest('[data-action="copy"]');
      if (!btn) return;
      const row = btn.closest(".ds-chat__row");
      const textEl = row ? row.querySelector(".ds-chat__md") : null;
      if (!textEl) return;
      navigator.clipboard
        ?.writeText(textEl.innerText)
        .then(() => {
          const old = btn.textContent;
          btn.textContent = "Copiado!";
          setTimeout(() => (btn.textContent = old), 1500);
        })
        .catch(() => {});
    });

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = requestAnimationFrame(() => this._render());
      });
      ro.observe(thread);
      this._resizeObserver = ro;
    }
  }

  _onScroll() {
    const thread = this._thread;
    this._stickToBottom = thread.scrollTop + thread.clientHeight >= thread.scrollHeight - 40;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._render());
  }

  _emit(name, detail) {
    this._root.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, cancelable: false }));
  }

  _focusInput() {
    if (this._input) this._input.focus();
  }

  _autoGrow() {
    const input = this._input;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  _setBusyUi(busy) {
    const btn = this._sendBtn;
    if (!btn) return;
    if (busy) {
      btn.classList.add("ds-chat__send--stop");
      btn.setAttribute("aria-label", "Parar geração");
      btn.innerHTML = STOP_ICON;
    } else {
      btn.classList.remove("ds-chat__send--stop");
      btn.setAttribute("aria-label", "Enviar mensagem");
      btn.innerHTML = SEND_ICON;
    }
  }

  _scheduleStick() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._stickToBottom());
  }

  _stickToBottom() {
    if (!this._thread) return;
    if (this._stickToBottom) this._thread.scrollTop = this._thread.scrollHeight;
  }

  /* --------------------- Virtual scrolling ----------------------------- */

  _render() {
    if (!this._initialized || !this._thread) return;
    const thread = this._thread;
    const n = this.messages.length;
    const heights = this._heights;
    const avg = n ? heights.reduce((a, b) => a + b, 0) / n : 60;

    const offsets = new Array(n);
    let total = 0;
    for (let k = 0; k < n; k++) {
      offsets[k] = total;
      total += heights[k] || avg;
    }
    this._spacer.style.height = total + "px";

    const st = thread.scrollTop;
    const ch = thread.clientHeight || 300;
    const over = this.options.overscan * Math.max(avg, 40);

    const useVirtual = n >= this.options.virtualThreshold;
    let start = 0;
    let end = n;

    if (useVirtual) {
      for (let k = 0; k < n; k++) {
        if (offsets[k] + (heights[k] || avg) > st - over) { start = k; break; }
      }
      for (let k = start; k < n; k++) {
        if (offsets[k] > st + ch + over) { end = k; break; }
      }
    }

    for (const [idx, rowEl] of this._rowEls) {
      if (idx < start || idx >= end) {
        rowEl.remove();
        this._rowEls.delete(idx);
      }
    }

    let dirty = false;
    for (let k = start; k < end; k++) {
      let rowEl = this._rowEls.get(k);
      if (!rowEl) {
        rowEl = this._buildRow(this.messages[k], k);
        rowEl.style.top = offsets[k] + "px";
        thread.appendChild(rowEl);
        this._rowEls.set(k, rowEl);
        const h = rowEl.offsetHeight;
        if (h > 0 && this._heights[k] !== h) {
          this._heights[k] = h;
          dirty = true;
        }
      } else if (rowEl.style.top !== offsets[k] + "px") {
        rowEl.style.top = offsets[k] + "px";
      }
    }

    if (dirty) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => {
        this._render();
        this._stickToBottom();
      });
    }
  }

  _buildRow(msg, idx) {
    const rowEl = el("div", "ds-chat__row");
    rowEl.dataset.idx = idx;
    rowEl.appendChild(this._buildMsg(msg));
    return rowEl;
  }

  _buildMsg(msg) {
    const render = this.options.renderMarkdown || mdToHtml;
    const wrap = el("div", "ds-chat__msg ds-chat__msg--" + (msg.role === "user" ? "user" : "assistant"));

    if (msg.role === "user") {
      const bubble = el("div", "ds-chat__bubble");
      bubble.textContent = msg.content;
      wrap.appendChild(bubble);
      return wrap;
    }

    const avatar = el("div", "ds-chat__avatar");
    avatar.textContent = "DS";
    avatar.setAttribute("aria-hidden", "true");
    wrap.appendChild(avatar);

    const body = el("div", "ds-chat__body");
    const thinking = el("details", "ds-chat__thinking");
    thinking.hidden = true;
    const summary = document.createElement("summary");
    summary.textContent = "Raciocínio (thinking)";
    const tbody = el("div", "ds-chat__thinking-body");
    thinking.appendChild(summary);
    thinking.appendChild(tbody);

    const md = el("div", "ds-chat__md");
    const meta = el("div", "ds-chat__meta");
    meta.hidden = true;

    body.appendChild(thinking);
    body.appendChild(md);
    body.appendChild(meta);
    wrap.appendChild(body);

    // Preenchimento
    if (msg.reasoning) {
      thinking.hidden = false;
      tbody.textContent = msg.reasoning;
    }

    let bodyText = msg.content || "";
    if (msg.tools && msg.tools.length) {
      bodyText +=
        "\n\n" +
        msg.tools
          .filter((t) => t.name)
          .map((t) => "**" + t.name + "** `" + (t.arguments || "{}") + "`")
          .join("\n");
    }

    if (msg.done && !bodyText && !msg.reasoning) {
      md.innerHTML = '<p class="ds-chat__empty">*(resposta vazia)*</p>';
    } else {
      md.innerHTML = render(bodyText) + (msg.done ? "" : '<span class="ds-chat__caret"></span>');
    }

    if (msg.done && !msg.greeting) {
      meta.hidden = false;
      const elapsed = ((Date.now() - this._startTime) / 1000).toFixed(1);
      let m = "<span>" + elapsed + "s</span>";
      if (msg.usage) m += "<span>" + (msg.usage.total_tokens || 0) + " tokens</span>";
      m += '<button data-action="copy" aria-label="Copiar resposta">Copiar</button>';
      meta.innerHTML = m;
    }

    return wrap;
  }

  /* ------------------------ Envio / streaming --------------------------- */

  _buildPayload(text) {
    const msgs = this.messages
      .filter((m) => !m.greeting)
      .map((m) => {
        const o = { role: m.role, content: m.content || "" };
        if (m.role === "assistant" && m.reasoning) o.reasoning_content = m.reasoning;
        return o;
      });
    if (text) msgs.push({ role: "user", content: text });
    return { model: this._model, messages: msgs, stream: true };
  }

  _send(text) {
    const payload = this._buildPayload(text);

    const userMsg = { id: uid(), role: "user", content: text, done: true };
    const asstMsg = {
      id: uid(),
      role: "assistant",
      content: "",
      reasoning: "",
      tools: [],
      usage: null,
      done: false,
    };
    const asstIdx = this.messages.length + 1;
    this.messages.push(userMsg, asstMsg);
    this._render();
    this._scheduleStick();

    this._emit("chat:message-sent", { text });
    if (typeof this.options.onMessageSent === "function") {
      try { this.options.onMessageSent({ text }); } catch (e) { /* ignore */ }
    }

    this._busy = true;
    this._setBusyUi(true);
    this._startTime = Date.now();
    this._abort = new AbortController();

    this._fetchStream(payload, asstMsg, asstIdx)
      .catch((e) => {
        if (e && e.name !== "AbortError") {
          asstMsg.content = "Erro: " + (e.message || String(e));
          asstMsg.error = true;
          this._emit("chat:error", { message: e.message || String(e) });
        }
      })
      .finally(() => {
        asstMsg.done = true;
        this._busy = false;
        this._setBusyUi(false);
        this._updateRow(asstIdx, asstMsg);
        this._scheduleStick();
        this._focusInput();
      });
  }

  async _fetchStream(payload, asstMsg, asstIdx) {
    const headers = { "Content-Type": "application/json" };
    const key = typeof this.options.apiKey === "function" ? this.options.apiKey() : this.options.apiKey;
    if (key) headers["Authorization"] = "Bearer " + key;

    let url = "/v1/chat/completions";
    if (this.options.apiUrl) {
      url = this.options.apiUrl;
    } else if (this.options.baseUrl) {
      url = this.options.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: this._abort.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("HTTP " + res.status + ": " + errText.slice(0, 500));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data: ")) continue;
        const data = t.slice(6);
        if (data === "[DONE]") continue;

        let chunk;
        try { chunk = JSON.parse(data); } catch (e) { continue; }

        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.reasoning_content) asstMsg.reasoning += delta.reasoning_content;
        if (delta.content) asstMsg.content += delta.content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!asstMsg.tools[idx]) asstMsg.tools[idx] = { name: "", arguments: "" };
            if (tc.function?.name) asstMsg.tools[idx].name += tc.function.name;
            if (tc.function?.arguments) asstMsg.tools[idx].arguments += tc.function.arguments;
          }
        }
        if (chunk.usage) asstMsg.usage = chunk.usage;
        this._scheduleRowUpdate(asstIdx, asstMsg);
      }
    }

    this._emit("chat:message-received", {
      content: asstMsg.content,
      reasoning: asstMsg.reasoning,
      usage: asstMsg.usage,
    });
    if (this._sr) {
      this._sr.textContent = "Resposta recebida.";
    }
  }

  _scheduleRowUpdate(idx, msg) {
    if (this._pendingStream) return;
    this._pendingStream = true;
    requestAnimationFrame(() => {
      this._pendingStream = false;
      this._updateRow(idx, msg);
    });
  }

  _updateRow(idx, msg) {
    const rowEl = this._rowEls.get(idx);
    if (!rowEl) {
      this._render();
      return;
    }
    const old = rowEl.firstChild;
    if (old) rowEl.removeChild(old);
    rowEl.appendChild(this._buildMsg(msg));
    const h = rowEl.offsetHeight;
    if (h > 0) this._heights[idx] = h;
    this._render();
    this._stickToBottom();
  }
}

/**
 * Factory function para criar um ChatComponent.
 * @param {Object} options — mesmo contrato do construtor.
 */
function createChat(options) {
  return new ChatComponent(options);
}

if (typeof window !== "undefined") {
  window.ChatComponent = ChatComponent;
  window.createChat = createChat;
}

export { ChatComponent, createChat };
