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
PORT=3000
```

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
2. modelo conhecido por um provedor habilitado (via `provider.model` ou pela
   lista `/models` do provedor) → esse provedor;
3. senão → provedor **principal**.

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
curl -X POST http://localhost:3000/v1/web/search \
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
curl -X POST http://localhost:3000/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model": "nomic-embed-text", "input": ["frase um", "frase dois"]}'
```

### SSE keep-alive

Os streams de chat (DeepSeek, Qwen e provedores locais) enviam um comentário
SSE (`: ping`) a cada 15s enquanto o modelo "pensa", evitando que proxies e
clientes com timeout cortem respostas longas no meio.

---

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
http://localhost:3000
```

### Dashboard (Interface Gráfica)

Ao executar `npm start`, o servidor também serve uma interface gráfica que abre automaticamente no navegador:

```txt
http://localhost:3000
```

O dashboard oferece:

- **Conexão** — status do servidor, Playwright, login na DeepSeek e API Key, além de instruções de conexão e endpoints.
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
