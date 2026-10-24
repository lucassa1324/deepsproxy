# NOTAS — Auto Router "aprendiz" (handoff)

> Arquivo de continuidade: onde paramos, o que foi feito e o que vem depois.
> Atualizar SEMPRE que terminar uma sessão de trabalho no Auto Router.

**Última atualização:** 2026-10-10
**Branch:** `main` — último commit: `9bcda5e` ("Savepoint: estado atual antes de trazer melhorias do freellmapi")
**Estado do repo:** há MUITAS mudanças **NÃO commitadas** (ver seção Arquivos).

---

## 📍 AONDE PARAMOS (responder isso amanhã)

Terminamos de **turbinar o Auto Router** com aprendizado (Níveis 1+2+3),
inspirado no roteador do `freellmapi` — mas **sem SQLite** (estado em memória +
persistência JSON). Está **funcional, compilando e com a suíte toda verde**.

- **Build:** `npm run build` → limpo (sem erros).
- **Testes:** `npm test` → **428 pass / 0 fail / 1 skip** (429 no total).
- **NÃO commitamos** (o usuário não pediu). O próximo passo natural é revisar o
  `git diff` e commitar (sugestão de prefixo: `Savepoint: ...`).

**Próxima tarefa escolhida (a fazer amanhã):**
→ **Aprendizado POR CATEGORIA de tarefa** (modelo × coding/writing/math/reasoning)
  + **fechar a lacuna do DeepSeek streaming** (que hoje não reporta outcome/usage).
  Esses dois são os de maior ganho real. Detalhes na seção "Próximos passos".

---

## ✅ O QUE FOI FEITO HOJE (implementado e testado)

O roteador agora **aprende de verdade** — e persiste. Entregas:

1. **L1.1 Reliability no score** (`model-selector.ts`)
   - Taxa de sucesso por modelo com **suavização de Laplace** (`alpha=2`).
   - Só entra com **≥ 3 requests**; sem métrica = neutro (0.5) → mantém o
     scoring determinístico original (por isso a suíte antiga segue passando).
2. **L1.2 Exploração determinística**
   - Modelo pouco testado ganha bônus fixo `+0.02` (sem RNG → reproduzível).
3. **L1.3 Cota com auto-detecção** (novo `src/services/quota-tracker.ts`)
   - Janela deslizante (padrão 24h) por modelo; ao pegar 429/quota **aprende o
     teto** (uso no momento do erro) e põe o modelo em **cooldown** → headroom 0.
   - Roteador pretere modelo esgotado → **failover passa pro próximo** ("vai
     acabando os tokens de um, passa pro outro").
   - Tokens contados em best-effort.
4. **L2.4 Latência real no score** (`model-selector.ts`)
   - Usa `avgLatencyMs` medido (blend 50% com `speed` estático); neutro sem amostra.
5. **L2.5 Headroom de contexto**
   - Compara tokens estimados do prompt (`~chars/4`) com `contextLength`;
     descarta modelo que não cabe, penaliza quem está perto do limite.
6. **L2.6 Circuit breaker por PROVEDOR** (`model-metadata.ts`)
   - Abre após **3 falhas** consecutivas do provedor; fecha no sucesso.
7. **L3.7 Persistência JSON** (novo `src/services/auto-router/persistence.ts`)
   - Salva saúde (modelo+provedor), métricas, cota, rate tracking e memória de
     conversas em `router-state.json` (ou `ROUTER_STATE_FILE`).
   - **Carregado só no bootstrap** (`initRouterPersistence()` em `index.ts`),
     NÃO no import → não polui testes. Salva a cada 60s e no shutdown.
8. **L3.8 Classificação de falhas** (`classifyFailure`)
   - `quota` / `transient` / `fatal`; cooldown base por classe (cota = maior).
9. **Integração no `chat.ts`**
   - `reportAutoOutcome` agora alimenta métricas, breaker de modelo **e**
     provedor, cota (request + tokens) e dispara cooldown de cota.
10. **Status do roteador** — `getAutoRouterStatus()` expõe `downedProviders` e `quota`.

> Observação: a base disso tudo foi a portagem das features #1–#7 do freellmapi
> (`rate-tracker.ts`, `context-handoff.ts`, `compression.ts`, `fusion.ts`,
> `header-value.ts`, `token-economy.ts`, `rotation.ts`, `chat.ts`, `dashboard.ts`,
> `index.html`) — também **não commitada**.

---

## 📂 ARQUIVOS (todos não commitados)

**Novos:**
- `src/services/quota-tracker.ts` (novo módulo de cota/aprendizado de limite)
- `src/services/auto-router/persistence.ts` (persistência JSON)
- `src/services/auto-router/router-persistence.test.ts` (testes)
- (da portagem anterior) `src/services/rate-tracker.ts`, `context-handoff.ts`,
  `compression.ts`, `fusion.ts`, `src/utils/header-value.ts`

**Modificados (núcleo do router):**
- `src/services/auto-router/types.ts` (ModelScore ganhou `reliabilityScore`/
  `quotaHeadroom`; novo `ScoringContext`)
- `src/services/auto-router/model-selector.ts` (reliability/latência/exploração/
  contexto/cota)
- `src/services/auto-router/model-metadata.ts` (classifyFailure, breaker por
  provedor, snapshots)
- `src/services/auto-router/router.ts` (ScoringContext, filtro provedor-down,
  status)
- `src/services/auto-router/index.ts` (exports novos)
- `src/services/auto-router/auto-router.test.ts` (+ testes "Learned Scoring",
  "Provider Breaker & Failure Classification")
- `src/routes/chat.ts` (integração de cota/breaker de provedor)
- `src/index.ts` (bootstrap: `initRouterPersistence` + `stopRouterPersistence`)
- `src/services/rotation.ts`, `token-economy.ts`, `src/ui/dashboard.ts`,
  `src/ui/index.html` (da portagem anterior)
- `.gitignore` (`router-state.json` adicionado para não commitar estado de runtime)

---

## ⚙️ ENV VARS introduzidas / relevantes

- **Cota:** `QUOTA_TRACKING` (`false` desliga), `QUOTA_WINDOW_HOURS` (24),
  `QUOTA_HEADROOM` (0.15)
- **Rate tracking:** `RATE_LIMIT_TRACKING`, `RATE_LIMIT_RPM` (120),
  `RATE_LIMIT_TPM` (300000), `RATE_LIMIT_EST_TOKENS` (1000)
- **Persistência:** `ROUTER_PERSISTENCE` (`false` desliga), `ROUTER_STATE_FILE`,
  `ROUTER_SAVE_MS` (60000)
- **Handoff:** `DEEPSPROXY_CONTEXT_HANDOFF` / `FREELLMAPI_CONTEXT_HANDOFF`
- Chaves do `ScoringContext` só entram com **≥ 3 amostras**; sem dados = neutro.

---

## ⚠️ LIMITAÇÕES ATUAIS (o que ainda é "burro")

- Aprendizado é **global por modelo** — não por tipo de tarefa (média dilui).
- Exploração é bônus fixo — **não é bandit** (sem UCB/Thompson).
- Custo é **estático** (USD/1M); modelo desconhecido entra como `{0,0}` (viés "grátis").
- "Sucesso" = HTTP < 400; **não mede qualidade** (resposta vazia/retry/tool_call
  quebrado/usuário repetindo o pedido).
- Sem **decay temporal** (EWMA) — erro antigo pesa igual ao recente.
- **DeepSeek streaming NÃO reporta** outcome/usage (só `rememberSuccess` do
  handoff). Existe `usage` calculado em `chat.ts` (~linha 1539) para aproveitar.

---

## 🔜 PRÓXIMOS PASSOS (backlog priorizado)

1. **[ESCOLHIDO] Aprendizado por categoria** — métricas por (modelo × categoria de
   tarefa: coding/writing/math/reasoning/vision/general). Maior ganho de qualidade.
2. **[ESCOLHIDO] DeepSeek streaming** — chamar `reportAutoOutcome` no fim do
   stream + registrar `usage` (promptTokens/completionTokens) na cota.
3. **Custo real por tokens** — usar o uso real; corrigir viés `{0,0}` de modelos
   desconhecidos.
4. **Sinal de qualidade** — incorporar retries anti-lazy, resposta vazia,
   `tool_call` corrigido e "usuário refez o pedido" como feedback de falha.
5. **Bandit de verdade** — UCB/Thompson no lugar do bônus fixo, com RNG injetável
   (manter testes determinísticos).
6. **EWMA/decay** — recentes dominam.
7. **Dashboard** — visualizar e permitir **resetar/editar** o estado aprendido.

---

## 🧪 COMO RODAR / VERIFICAR

```powershell
# na raiz: C:\Users\Lucas sá\Documents\Programação\deepsproxy\deepsproxy
npm run build        # deve terminar limpo
npm test             # esperado: 428 pass, 0 fail, 1 skip
# rodar apenas o router:
npx tsx --test src/services/auto-router/auto-router.test.ts src/services/auto-router/router-persistence.test.ts
```

## 📌 COMEÇAR AMANHÃ

1. `git diff` para revisar e (se o usuário quiser) commitar ("Savepoint: ...").
2. Implementar **Próximos passos 1 e 2** (por categoria + DeepSeek streaming).
3. Rodar `npm run build` e `npm test`; manter verde.
