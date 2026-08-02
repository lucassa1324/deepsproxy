# ChatComponent

Widget de chat responsivo e reutilizável, sem dependências. Consome uma API
compatível com OpenAI (`POST /v1/chat/completions`) com streaming SSE.

- Arquivo: `src/ui/components/chat-component.js`
- Exemplo funcional: `src/ui/components/example.html` (servido em `/chat-example`)
- Rota do componente: `/components/chat-component.js`

## Uso

```html
<div id="chatMount" style="height: 600px;"></div>

<script type="module">
  import { ChatComponent } from "/components/chat-component.js";

  const chat = new ChatComponent({
    el: "#chatMount",
    models: ["deepseek-thinking", "deepseek-no-thinking"],
    apiKey: () => localStorage.getItem("deepsproxy_api_key") || "",
    placeholder: "Envie uma mensagem...",
    greeting: "Olá! Como posso ajudar?",
  }).init();

  chat.sendMessage("Olá");
  chat.setModel("deepseek-thinking");
  chat.clearChat();
</script>
```

## Props

| Prop | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `el` | `string \| Element` | obrigatório | Seletor ou elemento de montagem |
| `baseUrl` | `string` | `""` | Base da API. Se vazio, usa `/v1/chat/completions` relativo |
| `apiUrl` | `string` | `null` | URL completa do endpoint (prioridade sobre `baseUrl`) |
| `apiKey` | `string \| () => string` | `""` | Chave de autenticação (envia `Authorization: Bearer`) |
| `models` | `(string \| {id,label})[]` | `["deepseek-thinking", "deepseek-no-thinking"]` | Modelos do seletor |
| `placeholder` | `string` | ... | Placeholder do textarea |
| `greeting` | `string` | `""` | Mensagem de boas-vindas (markdown); `""` desativa |
| `showHeader` | `boolean` | `true` | Mostra cabeçalho interno com o modelo ativo |
| `showSidebar` | `boolean` | `true` | Menu lateral com botão "Nova conversa" |
| `sidebarTitle` | `string` | `"Conversas"` | Título do menu lateral |
| `ariaLabel` | `string` | `"Mensagens do chat"` | `aria-label` da região de mensagens |
| `autofocus` | `boolean` | `false` | Foca o input no `init()` |
| `onMessageSent` | `(detail) => void` | `null` | Callback ao enviar mensagem (`{ text }`) |
| `renderMarkdown` | `(markdown) => string` | interno | Renderizador de markdown (lazy) |
| `debounceMs` | `number` | `120` | Debounce do auto-grow do input |
| `overscan` | `number` | `3` | Linhas extras renderizadas no virtual scroll |
| `virtualThreshold` | `number` | `40` | Nº de mensagens para ativar virtual scrolling |

## Métodos públicos

| Método | Retorno | Descrição |
| --- | --- | --- |
| `init()` | `this` | Renderiza o componente e liga os eventos |
| `sendMessage(text)` | `boolean` | Envia mensagem programaticamente (`false` se vazio/ocupado) |
| `clearChat()` | `this` | Limpa histórico (aborta geração em andamento) |
| `setModel(modelName)` | `this` | Altera o modelo ativo |
| `getModel()` | `string` | Modelo ativo |
| `isBusy()` | `boolean` | Há uma geração em andamento |
| `destroy()` | `void` | Remove listeners, aborta fetch e limpa o DOM |

## Eventos customizados

Disparados no elemento raiz (`bubbles: true`):

| Evento | `detail` |
| --- | --- |
| `chat:message-sent` | `{ text }` |
| `chat:message-received` | `{ content, reasoning, usage }` |
| `chat:cleared` | `{}` |
| `chat:error` | `{ message }` |

```js
host.addEventListener("chat:message-received", (e) => {
  console.log("Resposta:", e.detail.content);
});
```

## Acessibilidade

- `role="log"` + `aria-live="polite"` na área de mensagens.
- `aria-label` no input, no seletor de modelo, no botão enviar e na região de log.
- Live region oculta anuncia o recebimento de respostas.
- Navegação por teclado: `Enter` envia, `Shift+Enter` quebra linha, e o botão
  vira "Parar" durante a geração.

## Performance

- **Virtual scrolling**: acima de `virtualThreshold` mensagens, apenas a
  janela visível é renderizada (com medição de altura por linha).
- **Debounce** no auto-grow do input e batelada de atualizações via
  `requestAnimationFrame` durante o streaming.
- **Markdown lazy**: o renderizador só é invocado ao renderizar conteúdo, e
  pode ser substituído via `renderMarkdown`.
