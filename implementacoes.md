# Registro de Implementações

Log cumulativo das implementações do deepsproxy. Cada entrada descreve o que
foi feito e para que serve. Novas implementações são adicionadas no topo.

---

## Implementação 7 — Provedor Gemini Web (UI automation, sem API key)

**Data:** 2026-08-15

**O que serve para:**
- Provedor `gemini-web`: usa o Gemini (gemini.google.com) logado num perfil
  **Playwright persistente**, sem precisar de API key.
- O chat é feito por automação de UI: preenche o composer, clica em enviar e lê
  o texto da resposta (`.model-response-text`) via polling de deltas.
- Cada request abre uma conversa nova (o histórico completo é reenviado).
- Modelos disponíveis (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash`,
  `gemini-3-pro`) são listados pelo catálogo — não há API para listar.

**Como ativar:**
- No painel (Conexão), selecione o subtipo **gemini-web**, salve e clique em
  **Login Gemini** para abrir o login do Google no perfil persistente
  (`gemini_profile/`). O status aparece no painel.
- A rota `/api/gemini/login/start|finish` só inicia o fluxo no perfil; a janela
  visível nunca é navegada (login manual na janela que abrir).
- Envs: `GEMINI_POOL_SIZE` (abas por conversa, padrão 2), `GEMINI_PROFILE_DIR`
  (pasta do perfil, padrão `gemini_profile/`).

**Arquivos:**
- `src/services/gemini-web.ts` (novo): scripts de DOM (com markers
  `__GEMINI_*__`), `computeTextDelta`, `createGeminiWebStream`, `FakeGeminiPage`.
- `src/services/gemini-playwright.ts` (novo): perfil/login/pool de abas.
- `src/routes/gemini.ts` (novo): `geminiChatCompletions` (SSE/JSON).
- `src/gemini-web.test.ts` (novo): testes unitários + e2e.
- `src/services/config.ts`, `src/services/modelCatalog.ts`,
  `src/services/local.ts`, `src/routes/chat.ts`, `src/index.ts`,
  `src/ui/dashboard.ts`, `src/ui/index.html`, `.gitignore`.

**Verificação:** build limpo; suíte 98 testes (97 pass, 0 fail, 1 skip).

---

## Implementação 6 — Modo Agente nativo (execução de tools server-side)

**Data:** 2026-08-15

**O que serve para:**
- Permite o proxy executar tools **sozinho**, num loop agêntico, sem depender da
  IDE (Trae/Cursor) para rodar as ferramentas.
- A tool nativa `web_search` (busca no DuckDuckGo, sem API key) agora é usada
  de verdade: o modelo chama, o proxy executa a busca e devolve o resultado ao
  modelo, que responde a pergunta final com base no que encontrou.
- Para provedores HTTP (Gemini, Anthropic, Ollama, OpenAI-compatível). Provedores
  "browser" (DeepSeek/Qwen/Gemini web) respondem 400 no modo agente.

**Como ativar:**
- Adicione `"agent": true` no corpo do `POST /v1/chat/completions`.
- O proxy roda o loop: envia → modelo pede tool → executa → re-envia com o
  resultado → repete até resposta final (máx. 6 turnos por padrão).
- `GET /v1/tools` lista as tools de servidor disponíveis.
- A resposta traz `agent: { turns, tools }` (JSON) para inspeção.

**Arquivos:**
- `src/services/agent.ts` (novo): loop agêntico (reusa `runExecutionLoop`),
  suporte por tipo de provedor, resposta JSON/SSE.
- `src/routes/chat.ts`: branch `agent: true` antes do cache de respostas.
- `src/index.ts`: rota `GET /v1/tools` + entrada no `GATEWAY_PATHS`.
- `src/utils/types.ts`: campo `agent?` no `OpenAIRequest`.
- `src/agent.test.ts` (novo) + teste e2e em `src/gateway.test.ts`.

**Verificação:** build limpo; suíte 89 testes (88 pass, 0 fail, 1 skip).

---

## Implementação 5 — Modo Economia de Tokens

**Data:** 2026-08-15

**O que serve para:**
- Reduzir o consumo de tokens (e custo) das chamadas a qualquer provedor, com
  configuração global pelo painel (aba Apps → "Modo Economia de Tokens").
- 7 otimizações independentes: cache de prefixo (Anthropic `cache_control`),
  truncar histórico, resumir histórico (via LLM ou digest), remover raciocínio,
  limitar saída de tools, cache de respostas idênticas e estimativa de tokens.
- Configuração persistida em `gateway-economy.json` (ou env `ECONOMY_FILE`).

**Arquivos:** `src/services/token-economy.ts` (novo), `src/routes/chat.ts`,
`src/services/adapters/anthropic.ts`, `src/ui/dashboard.ts`,
`src/ui/index.html`, `src/token-economy.test.ts` (novo), `.gitignore`.

---

## Implementação 4 — Fix Gemini no Trae (erro `additionalProperties`)

**Data:** 2026-08-15

**O que serve para:**
- O Trae quebrava com Gemini: a API rejeita campos fora da whitelist (ex.:
  `additionalProperties`) em `function_declarations[].parameters`.
- `sanitizeGeminiSchema` remove recursivamente keywords não suportadas antes de
  montar a declaração de tools para o Gemini.

**Arquivos:** `src/services/adapters/gemini.ts`, teste em
`src/services/adapters/adapters.test.ts`.

---

## Implementação 3 — Roteamento por catálogo + AI Gateway (portas 3005/3006)

**Data:** 2026-08-15

**O que serve para:**
- Provedor é resolvido AUTOMATICAMENTE pelo modelo pedido (catálogo unificado
  de modelos: fixos + `/models` de cada provedor), sem depender do provedor
  ativo.
- Porta 3005 (direta): o modelo do cliente decide o provedor.
- Porta 3006 (gateway): exige chave virtual de app e injeta o modelo configurado
  no painel (a IDE não controla o modelo).

**Arquivos:** `src/services/modelCatalog.ts` (novo), `src/services/local.ts`,
`src/routes/chat.ts`, `src/gateway.test.ts`, `README.md`.

---

## Implementação 2 — AI Gateway com apps e chaves virtuais (porta 3006)

**Data:** 2026-08-15

**O que serve para:**
- Segunda porta (`GATEWAY_PORT`, padrão 3006) que só responde `/v1/*` com uma
  chave virtual de aplicação (`app_<slug>_<random>`).
- O modelo de cada app é controlado pelo painel; a IDE não consegue trocar.

**Arquivos:** `src/services/gateway.ts` (novo), `src/ui/dashboard.ts`,
`src/index.ts`.

---

## Implementação 1 — Painel (dashboard) com provedores e apps

**Data:** 2026-08-15

**O que serve para:**
- Interface em `src/ui/` para configurar provedores (Conexão), apps do gateway
  (3006) e modelos, com login DeepSeek/Qwen e logs em tempo real.

**Arquivos:** `src/ui/dashboard.ts`, `src/ui/index.html`, `src/ui/logger.ts`.
