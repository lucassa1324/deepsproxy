# deepsproxy — Visão geral (para continuidade entre modelos/sessões)

Este arquivo descreve **o que é o deepsproxy**, como ele funciona e seus objetivos. Use como contexto ao trocar de modelo, depurar ou evoluir o projeto.

## O que é
**deepsproxy** é um proxy/gateway **compatível com a API OpenAI** (`/v1/chat/completions`, `/v1/models`, etc.) que fica entre clientes/IDEs/apps e múltiplos provedores de LLM. Ele normaliza requisições, roteia modelos, aplica diretivas/sanitização, pode injetar *skills*, e oferece painel web para configuração, métricas e debug.

## Portas e modos (importante)
- **3005 — Porta direta**: uso “direto”. O cliente envia o `model` e o proxy resolve/encaminha conforme o catálogo/provedores configurados. Skills com escopo `3005`/`both` se aplicam.
- **3006 — Gateway (AI Gateway)**: uso via **Apps** (aba Apps) com **chave virtual**. O middleware valida a chave virtual e carrega a aplicação (`gatewayAppEntry`). **O modelo configurado no app pode sobrescrever** o `model` enviado pelo cliente; parâmetros como `temperature/top_p/max_tokens/systemPromptOverride` do app podem ser aplicados. Autenticação típica: `Authorization: Bearer <chave_virtual_do_app>` (não confundir com a chave do provedor). Skills com escopo `3006`/`both` se aplicam.

**Roteamento, filtros e rotação são lógica compartilhada** (serviços comuns) e funcionam para ambas as portas; a diferença principal é *quem determina o modelo final* e a autenticação no gateway.

## Conceitos principais
### Provedores e múltiplas chaves (rotação/failover)
- Cada provedor pode ter **múltiplas contas/chaves de API** (UI: Conexão → provedor → “Adicionar chave/Conta”). Ao salvar, o rascunho digitado é consolidado para não perder chaves.
- O backend mantém **rotação** e pode fazer **failover** quando uma chave falha por **cota/rate-limit/auth** (conforme implementação em `services/config.ts`, `services/rotation.ts`, `services/local.ts` e fluxos de encaminhamento). Objetivo: se uma conta acabar tokens/cota, tentar a próxima.

### Catálogo de modelos e resolução
- O proxy mantém um **catálogo unificado** (model_id → provider/baseUrl/apiKey/tipo). A resolução de provedor é automática pelo modelo (quando aplicável ao modo).
- Modelos especiais: **`auto`** e **`auto-free`** são resolvidos pelo **Auto Router** para um modelo real encaminhável (nunca devolvidos como destino).

### Auto Router (Smart Router)
- Decide o modelo com base em mensagens/tarefa, capacidades, custo/política e disponibilidade. Evita modelos fora do ar.
- **Filtro de não-chat**: modelos de TTS, transcrição/ASR, música/lyria, geração de imagem/vídeo (imagen, dall-e, veo), deep-research, computer-use, embedding/rerank etc. são excluídos do roteamento de chat (ver `services/auto-router/model-selector.ts`).
- Pode registrar diagnósticos e transições; “orquestrador” só aparece se o fluxo/configuração o utilizar (nem todo modo usa orquestrador).

### Pipeline de requisição (visão simplificada)
- Normaliza `model`, guarda telemetria do modelo solicitado, aplica configurações (economia de tokens etc.).
- Sanitiza/injeta diretivas (ex.: anti-lazy, fallback MCP/filesystem, limpeza de tool output) conforme middlewares/handlers.
- Injeta **skills ativas da Loja** (escopo 3005/3006) como instruções `system` marcadas `[DEEPSPROXY_SKILLS]`.
- Roteia (incluindo `auto/auto-free`), encaminha ao provedor/adapter, trata streaming, valida/anti-lazy retry quando aplicável, e registra métricas.

### Skills & MCP (Loja)
- **Custom/Comunidade (preparado)**: usuários podem criar skills/MCPs próprios via UI/API; armazenamento com `StorageBackend` (JSON local hoje) pronto para migrar para **BD** e futura **comunidade** (fonte `custom`/`community`, metadados autor/repo). Catálogo embutido inclui skills de programação, direção de arte, segurança, produto etc., e MCPs populares (filesystem, git, GitHub, Postgres/SQLite, Brave/Fetch, Playwright/Puppeteer, Slack, Notion, Docker, Redis, Supabase, Context7, entre outros) com configs/placeholders.
- **Skills**: módulos de instrução (programação, debug, code review, direção de arte, segurança, operação do proxy etc.) que podem ser **instaladas/ativadas** e aplicadas nas requisições. Armazenadas em `~/.deepsproxy/skills-store.json` (ou `DEEPSPROXY_CONFIG_DIR`).
- **MCP**: catálogo de configurações de servidores MCP para o **cliente/IDE** copiar/usar. O proxy não executa necessariamente esses MCPs; ele gerencia o catálogo/configs salvas.
- “Configurar com IA”: gera um prompt para pedir recomendações de ativação/escopo/ajustes com base no catálogo e uso.

### Debug Session
- Aba **Debug Session** (e APIs `/api/debug/*`): grava eventos **em memória** enquanto ativa (play/stop). Captura início/fim de requisição, decisões do roteador (modelo solicitado→escolhido, motivo/estratégia), e pode ser estendida para provedor/chave/tentativas. Gera relatório texto + JSON copiável para análise. Útil para distinguir: erro do roteador, erro do provedor/upstream, rotação, ou erro do app cliente (baseURL/auth/model/stream/formato).

### Uso & Métricas
- Registra uso (modelos, apps, tokens/consumo conforme instrumentação). Ajuda a ver distribuição e custo.

## Objetivos do projeto
1. **Compatibilidade OpenAI** para plugar em IDEs/apps sem mudar o cliente (além de baseURL/key).
2. **Roteamento inteligente e resiliente**: escolher modelos adequados, filtrar não-chat, suportar `auto/auto-free`, e sobreviver a falhas com **rotação/failover de chaves**.
3. **Operação multi-provedor e multi-conta**: várias chaves por provedor, gateway com apps/chaves virtuais (3006).
4. **Observabilidade e diagnóstico**: métricas e **Debug Session** para entender “o que o proxy fez” e onde falhou.
5. **Extensibilidade de comportamento**: **Skills** injetáveis e catálogo **MCP** para padronizar fluxos (dev, arte, segurança etc.), com espaço para configuração assistida por IA.
6. **Segurança/robustez pragmática**: sanitização de payloads, evitar expor segredos, não executar ações destrutivas implícitas; falhas devem ser reportadas com clareza.

## Dicas rápidas de troubleshooting
- **App dá erro usando proxy como provedor**: conferir base URL (`.../v1`), porta correta (3005 direta vs 3006 gateway), auth (na 3006 = chave virtual do app), `model` (teste `auto`), `stream` on/off, e formato de resposta. Compare com log do deepsproxy e rode **Debug Session**.
- **Roteou modelo estranho/não-chat**: verificar filtro em `model-selector.ts` e o que está no catálogo.
- **Cota estourou numa conta**: adicionar mais chaves no provedor; confirmar rotação/failover ativo.
- **Mudança não refletiu**: reiniciar o proxy para recarregar código/config conforme o caso.

---
_Atualize este documento quando adicionar fluxos relevantes (novos adapters, orquestrador, formatos de auth, etc.)._
