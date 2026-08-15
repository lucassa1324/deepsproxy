# DeepsProxy

Local proxy server that interfaces with DeepSeek using browser automation via Playwright.  
Provides a REST API for chat interactions and tool execution.

---

## Features

- REST API endpoints for chat completion
- Tool execution support
- Persistent browser session with login state
- Local model support via Ollama / LM Studio (OpenAI-compatible backend)
- Built with Hono and TypeScript

---

## Prerequisites

- Node.js v20 or later
- Playwright browsers

---

## Installation

```bash
npm install
npx playwright install
```

---

## Configuration

Create a `.env` file in the project root:

```env
PORT=3005
```

O servidor sobe **duas portas** ao mesmo tempo: a porta **direta** (`PORT`,
padrão `3005`) e a porta do **AI Gateway** (`GATEWAY_PORT`, padrão `3006`) —
veja a seção [AI Gateway](#ai-gateway-duas-portas-direta-e-gateway) abaixo.

---

## Using a local model (Ollama / LM Studio)

Instead of DeepSeek via Playwright, you can point the proxy at a local
OpenAI-compatible server such as [Ollama](https://ollama.com) or
[LM Studio](https://lmstudio.ai). The `/v1/chat/completions` endpoint is then
forwarded to the local server and streaming (SSE), tool calls and model
listing work natively.

```env
PROVIDER=local
# Ollama: http://localhost:11434/v1  |  LM Studio: http://localhost:1234/v1
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=
LLM_MODEL=
```

With `PROVIDER=local`, Playwright is not initialized and no DeepSeek login is
required. The model sent by the client is respected as-is; the provider `model`
only serves as fallback when the client does not send a model.

> **Configuração pela interface:** abra o dashboard (aba **Conexão**) para
> cadastrar provedores, informar a Base URL, carregar e selecionar o modelo e
> testar a conexão — sem precisar editar o `.env`. As alterações valem para o
> servidor em execução.

### Vários provedores ao mesmo tempo (multi-provider)

O DeepsProxy funciona como um hub de provedores OpenAI-compatíveis. Pela aba
**Conexão** você pode cadastrar vários provedores (Ollama, LM Studio, OpenAI,
Groq...) e **ativar vários ao mesmo tempo**:

- **Ativo** — cada provedor tem um toggle liga/desliga. Desligar remove seus
  modelos dos seletores e do roteamento, sem afetar os demais.
- **Principal** — o provedor destacado com ★ é o fallback quando nenhum
  provedor reconhece o modelo requisitado.
- Os provedores ficam salvos no cookie `deepsproxy_providers` (JSON
  `{ active, providers[] }`) e também na memória do servidor.

O roteamento do `/v1/chat/completions` é feito **pelo nome do modelo**:

1. modelo `deepseek-thinking` / `deepseek-no-thinking` → backend DeepSeek (se
   habilitado);
2. modelo `gemini-2.5-flash` / `gemini-2.5-pro` / `gemini-3-flash` /
   `gemini-3-pro` → Gemini Web (se habilitado);
3. modelo conhecido por um provedor habilitado (via `provider.model` ou pela
   lista `/models` do provedor) → esse provedor;
4. senão → provedor **principal**.

O modelo enviado pelo cliente é sempre respeitado (não é sobrescrito); o campo
`model` do provedor é usado apenas quando o cliente não envia modelo.

Example with Ollama:

```bash
ollama serve                # start Ollama
ollama pull llama3.2        # pull a model
npm start                   # PROVIDER=local already set in .env
curl http://localhost:3005/v1/models
```

### Agentic tools em modelos locais

Modelos locais sem suporte nativo a function-calling (editar arquivos, buscar
na web, etc.) usam o mesmo mecanismo do backend DeepSeek: as ferramentas são
injetadas no system prompt e o modelo responde com blocos `<tool_call>` que o
proxy converte em `tool_calls` no formato OpenAI. Ou seja, um agente que já usa
o DeepsProxy com DeepSeek funciona igual apontando para o Ollama/LM Studio.

### Web search (busca na web)

Tool nativa `web_search` registrada no registry do proxy, com backend
DuckDuckGo HTML (gratuito, sem API key). Também exposta como endpoint REST:

```bash
curl -X POST http://localhost:3005/v1/web/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "preço do dólar hoje", "max_results": 5}'
```

Resposta: `{ "query": ..., "results": [{ "title", "url", "snippet" }] }`.

### Embeddings

Endpoint OpenAI-compatível `POST /v1/embeddings` que roteia pelo nome do modelo
para um provedor habilitado que suporte embeddings (OpenAI-compatível, Ollama
via `/v1/embeddings` e Gemini via `:embedContent`). DeepSeek, Qwen e Anthropic
não oferecem embeddings e respondem 501 com mensagem.

```bash
curl -X POST http://localhost:3005/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model": "nomic-embed-text", "input": ["frase um", "frase dois"]}'
```

### Gemini Web (sem API key)

Além da API key, o Gemini pode ser usado pela web (gemini.google.com) por
automação de UI, igual à DeepSeek/Qwen. No dashboard (aba **Conexão**), escolha
o subtipo **gemini-web**, salve e clique em **Login Gemini** para autenticar o
Google num perfil Playwright persistente (`gemini_profile/`). O status do
login aparece no painel.

- Modelos do catálogo: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash`,
  `gemini-3-pro`.
- Cada requisição abre uma conversa nova no Gemini (o histórico completo é
  reenviado no prompt).
- Envs: `GEMINI_POOL_SIZE` (abas simultâneas por conversa, padrão 2),
  `GEMINI_PROFILE_DIR` (pasta do perfil, padrão `gemini_profile/`).

### SSE keep-alive

Os streams de chat (DeepSeek, Qwen e provedores locais) enviam um comentário
SSE (`: ping`) a cada 15s enquanto o modelo "pensa", evitando que proxies e
clientes com timeout cortem respostas longas no meio.

---

## AI Gateway: duas portas (direta e gateway)

O servidor sobe **duas portas** ao mesmo tempo, cada uma com um papel:

| Porta | Modo | Controle do modelo | Uso típico |
| --- | --- | --- | --- |
| **3005** (`PORT`) | Direto | A ferramenta escolhe o modelo | Desenvolvimento, teste, uso pessoal |
| **3006** (`GATEWAY_PORT`) | Gateway | O painel escolhe o modelo | Vários clientes/apps com controle central |

- **Porta direta (3005):** mantém o comportamento atual. Cada cliente envia o
  modelo que quiser e o proxy roteia pelo nome do modelo, resolvendo o provedor
  automaticamente pelo **catálogo de modelos** (fixos + lista `/models` dos
  provedores habilitados, em cache).
- **Porta gateway (3006):** feita para compartilhar o proxy com várias
  ferramentas (Trae, Cursor, VS Code, N8N, scripts...) sem que cada uma escolha
  o modelo. Na porta 3006:
  - `/v1/*` (chat, models, embeddings, web search) **exige** uma **chave
    virtual** — sem chave ou com chave inválida, responde `401`;
  - cada aplicação cadastrada no painel tem a própria chave e **modelo** — o
    provedor é resolvido automaticamente a partir do modelo escolhido;
  - o modelo enviado pelo cliente é **ignorado**; o proxy usa o modelo
    definido na aba **Apps (Gateway)** do dashboard;
  - desligar uma aplicação revoga o acesso dela na hora (`403`).

### Configuração

```env
PORT=3005
GATEWAY_PORT=3006
# ENABLE_GATEWAY=false   # desliga a porta do gateway (opcional)
```

### Tutorial: como um cliente se conecta ao gateway

1. **Inicie o servidor**: `npm start` (as duas portas sobem juntas).
2. Abra o dashboard em `http://localhost:3005` → aba **Apps (Gateway)**.
3. **Crie uma aplicação**: dê um nome (ex.: "Trae Work") e escolha o **modelo**
   que a ferramenta deve usar (o provedor é resolvido automaticamente pelo
   catálogo). Clique em **Criar chave**.
4. **Copie a chave virtual** exibida — ela aparece apenas uma vez.
5. Configure a ferramenta/IDE com:
   - **Base URL:** `http://localhost:3006/v1`
   - **API Key:** a chave virtual copiada
   - **Modelo:** qualquer valor (ex.: `default`) — o gateway usa o modelo
     definido no painel

Exemplo com `curl`:

```bash
curl http://localhost:3006/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer app_meu-app_abc123' \
  -d '{"model": "default", "messages": [{"role": "user", "content": "oi"}]}'
```

O `model` enviado é ignorado; o proxy usa o modelo configurado na aplicação.

6. **Para mudar o modelo** de uma ferramenta sem tocar nela: abra o dashboard,
   aba **Apps**, altere o modelo da aplicação e salve. Vale para as
   próximas requisições.

> **Segurança:** na porta 3005, se houver `API_KEY` no `.env`, todas as rotas
> (exceto as públicas do dashboard) exigem a API Key mestre. Na porta 3006 o
> dashboard usa essa mesma proteção; as rotas `/v1/*` usam apenas as chaves
> virtuais.

## Usage

### Login and Save Session

```bash
npm run login
```

### Start the Server

```bash
npm start
```

The server runs by default at:

```txt
http://localhost:3005   (porta direta)
http://localhost:3006   (AI Gateway — chaves virtuais)
```

### Dashboard (Interface Gráfica)

Ao executar `npm start`, o servidor também serve uma interface gráfica que abre automaticamente no navegador:

```txt
http://localhost:3005
```

O dashboard oferece:

- **Conexão** — status do servidor, Playwright, login na DeepSeek/Qwen/Gemini e API Key, além de instruções de conexão e endpoints.
- **Chat** — chat estilo ChatGPT com streaming, raciocínio (thinking) colapsável, markdown, multi-turno, atalho Enter/Shift+Enter e **imagens** (colar Ctrl+V, anexar ou arrastar/soltar; enviadas como `image_url` para modelos de visão e por upload `ref_file_ids` para a DeepSeek web).
- **Testar API** — console para enviar mensagens e ver a resposta em streaming (incluindo raciocínio).
- **Exemplos** — códigos prontos para consumir a API (curl, Python, Node.js e OpenAI SDK).
- **Logs** — logs do servidor em tempo real (SSE), com filtros por nível.

Para desativar a abertura automática do navegador, defina `OPEN_UI=false` no `.env`.

---

## Testing

```bash
npm test
```

---

## API Endpoints

### `POST /chat`

Send a chat message.

#### Request Body

```json
{
  "message": "Hello, DeepSeek!",
  "tools": []
}
```

#### Response

```json
{
  "response": "...",
  "toolCalls": []
}
```

---

## Development

```bash
npm run test
npx tsx src/index.ts
```

---

## Project Structure

```txt
.
├── src/
│   ├── index.ts           # Server entry
│   ├── routes/            # API routes
│   ├── services/          # DeepSeek & Playwright services
│   ├── tools/             # Tool execution
│   └── utils/             # Utilities
├── dist/                  # Compiled output
└── deepseek_profile/      # Browser profile storage
```

---

## License

ISC

---

# Disclaimer

This project is provided strictly for educational and research purposes.

The authors do not encourage or endorse:

- Misuse
- Unauthorized automation
- Abuse of third-party services
- Violations of platform Terms of Service

Users are solely responsible for how they use this software, including compliance with applicable laws, regulations, and service agreements.

This repository is intended to demonstrate concepts related to:

- Browser automation
- Session management
- OpenAI-compatible runtime architectures

Use at your own risk.
