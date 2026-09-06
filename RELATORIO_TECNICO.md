# RELATÓRIO TÉCNICO: Proxy DeepSeek (deepsproxy) - Problema de Leitura de Arquivos pela IA

---

## 1. OBJETIVO DO PROJETO

Desenvolver um **proxy HTTP (deepsproxy)** que intercepta requisições OpenAI-compatíveis (`/v1/chat/completions`) e:

1. **Roteia automaticamente** para o melhor modelo (DeepSeek, Qwen, Gemini, Ollama, etc.) via **Auto Router**
2. **Normaliza caminhos de arquivos** em `tool_calls` (read_file, write_file, edit_file, glob, grep, ls) usando um **WORKSPACE MAP** gerado dinamicamente
3. Permite que IAs (como a do Trae/Cursor) **leiam, editem e busquem arquivos** no projeto do usuário de forma transparente

---

## 2. ARQUITETURA DO PROXY

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Cliente (Trae, │────▶│  deepsproxy      │────▶│  Providers          │
│  Cursor, etc.)  │     │  :3005           │     │  (DeepSeek, Qwen,   │
└─────────────────┘     │                  │     │   Gemini, Ollama)   │
                        │  - Auto Router   │     └─────────────────────┘
                        │  - Path Normalizer│
                        │  - Workspace Map │
                        └──────────────────┘
```

**Fluxo de normalização de caminhos:**
1. IA envia `tool_call: { name: "read_file", arguments: { path: "use-resize.ts" } }`
2. Proxy intercepta no `executor.ts` → `normalizeToolCallArgs()`
3. `path-normalizer.ts` consulta `WORKSPACE_MAP` (gerado por `workspace.ts`)
4. Retorna caminho normalizado: `src/hooks/use-resize.ts`
5. Executa ferramenta real no filesystem

---

## 3. PROBLEMA PRINCIPAL

**A IA não consegue ler/editar/buscar arquivos no projeto de teste.**

### Sintomas:
```
Read 1 file
Failed to read
use-resize.ts

Glob search: /use-resize.ts → "No results found"
```

### Causa Raiz Identificada:
O **WORKSPACE_MAP** é gerado a partir do **diretório onde o proxy roda** (`deepsproxy/`), não do **projeto do usuário** (`editor_de_arte_V2/github-edit-view/`).

O `workspace.ts` faz busca ascendente a partir de `process.cwd()` procurando marcadores (`package.json`, `src/`, `front_end/`, etc.). Como o proxy roda em `C:\Users\Lucas\Documents\Programação\deepsproxy\deepsproxy`, ele indexa apenas arquivos do **próprio proxy**, não do projeto de teste.

---

## 4. TENTATIVAS REALIZADAS

### 4.1 Correção do `.env` (Typo no nome do arquivo)
**Problema:** Arquivo era `.env.loocal` (dois 'o')  
**Correção:** Renomeado para `.env`  
**Status:** ✅ Corrigido

### 4.2 Configuração do `USER_WORKSPACE_PATH`
**Problema:** Proxy não sabia qual projeto indexar  
**Tentativa:** Adicionado no `.env`:
```env
USER_WORKSPACE_PATH=C:\Users\Lucas sá\Documents\Programação\editor_de_arte_V2\github-edit-view
```
**Status:** ⚠️ Configurado, mas **precisa reiniciar o proxy** para aplicar

### 4.3 Criação do arquivo de teste `use-resize.ts`
**Ação:** Criado `src/hooks/use-resize.ts` em **ambos** os workspaces:
- `deepsproxy/src/hooks/use-resize.ts` (proxy)
- `editor_de_arte_V2/github-edit-view/src/hooks/use-resize.ts` (projeto teste)

**Status:** ✅ Arquivo existe nos dois locais

### 4.4 Verificação do Path Normalizer
**Arquivo:** `src/services/path-normalizer.ts`
- Usa `getWorkspaceMap(workspaceRoot)` do `workspace.ts`
- `getResolvedWorkspaceRoot()` prioriza:
  1. `TARGET_WORKSPACE_PATH` (env)
  2. `USER_WORKSPACE_PATH` (env) ← **NOSO CASO**
  3. `explicitPath` (body da requisição)
  4. Busca ascendente de `process.cwd()` (fallback)

**Status:** Lógica correta, depende da variável de ambiente

---

## 5. OUTRAS MELHORIAS IMPLEMENTADAS (Paralelo)

### 5.1 Auto Router - Evitar Truncamento em Tarefas Criativas
**Problema:** Modelos de raciocínio (`deepseek-thinking`, `o1`, `r1`) truncam respostas longas de arte/criativo.

**Correções em `src/services/auto-router/`:**

| Arquivo | Alteração |
|---------|-----------|
| `types.ts` | Adicionado `creative: number` em `ModelCapabilities` |
| `model-metadata.ts` | Campo `creative` em todos modelos (0-10); `writing` reduzido em modelos reasoning |
| `task-classifier.ts` | Nova categoria `creative` (peso 1.2) com keywords: arte, desenho, ilustração, design, concept art, anime, midjourney, dall-e, stable diffusion |
| `inferCapabilities()` | Modelos com "thinking/reasoning/r1/o1" → `creative: 3`, `writing ≤ 5` |
| `auto-router.test.ts` | Testes atualizados com campo `creative` |

**Resultado:** Auto-free agora deve escolher Gemini Flash / Claude Haiku (tag `creative`) para geração de arte.

---

## 6. COMO REPRODUZIR O TESTE

### Passo 1: Iniciar o Proxy (com variável correta)
```bash
cd C:\Users\Lucas sá\Documents\Programação\deepsproxy\deepsproxy
# Verificar se .env tem USER_WORKSPACE_PATH correto
npm start
```

### Passo 2: No projeto de teste (editor_de_arte_V2/github-edit-view)
```bash
cd C:\Users\Lucas sá\Documents\Programação\editor_de_arte_V2\github-edit-view
npm run dev
```

### Passo 3: Configurar cliente (Trae/Cursor) para usar o proxy
- Base URL: `http://localhost:3005/v1`
- Model: `auto-free` ou `auto`

### Passo 4: Pedir para a IA ler arquivo
```
"Leia o arquivo src/hooks/use-resize.ts"
```

### Resultado Esperado:
- IA consegue ler o arquivo
- Logs mostram: `[PATH NORMALIZER] use-resize.ts -> src/hooks/use-resize.ts (basename match)`

### Resultado Atual (Erro):
- `Failed to read use-resize.ts`
- Glob não encontra

---

## 7. LOGS RELEVANTES DO PROXY

Quando funciona, aparecem:
```
[PROXY WORKSPACE]: Usando USER_WORKSPACE_PATH: C:\Users\Lucas sá\Documents\Programação\editor_de_arte_V2\github-edit-view
[auto-router] modelo=gemini-2.5-flash score=0.825 tarefa="Tarefa intermediária — Programação + Visão/Imagem + Escrita"
[PATH NORMALIZER] use-resize.ts -> src/hooks/use-resize.ts (basename match)
```

Quando falha (workspace errado):
```
[PROXY WORKSPACE]: Fallback para busca ascendente a partir de C:\Users\Lucas sá\Documents\Programação\deepsproxy\deepsproxy
[PROXY WORKSPACE]: Raiz resolvida em: C:\Users\Lucas sá\Documents\Programação\deepsproxy\deepsproxy (mais profunda)
```

---

## 8. PONTOS DE ATENÇÃO / DEBUG

### 8.1 Verificar se proxy reiniciou após mudança no `.env`
O `dotenv.config()` carrega apenas no startup. **Reiniciar obrigatório.**

### 8.2 Verificar WORKSPACE_MAP gerado
Adicionar log temporário em `workspace.ts:generateWorkspaceMap()`:
```typescript
console.log('[WORKSPACE MAP GENERATED]', header + lines.join('\n'));
```

### 8.3 Verificar normalização no executor
Em `executor.ts:166-174`, o `interceptToolResult` usa `indexedFiles` do `pathIndex`. Confirmar se contém `src/hooks/use-resize.ts`.

### 8.4 Caminhos Windows vs Unix
O `path-normalizer.ts` normaliza `\\` para `/` (linha 224), mas o `WORKSPACE_MAP` usa separador nativo. Verificar consistência.

---

## 9. ARQUIVOS CHAVE PARA INVESTIGAÇÃO

| Arquivo | Função |
|---------|--------|
| `src/services/workspace.ts` | Gera WORKSPACE_MAP, resolve raiz do projeto |
| `src/services/path-normalizer.ts` | Normaliza caminhos usando índice do workspace |
| `src/tools/executor.ts` | Intercepta tool_calls, normaliza args, executa ferramentas |
| `src/routes/chat.ts:1402` | Normaliza tool_calls no streaming (chat handler) |
| `src/index.ts:48` | `dotenv.config()` - carrega .env |
| `.env` | **DEVE CONTER** `USER_WORKSPACE_PATH` correto |

---

## 10. PRÓXIMOS PASSOS SUGERIDOS

1. **Reiniciar proxy** após confirmar `.env` correto
2. **Adicionar logs de debug** no `workspace.ts` e `path-normalizer.ts` para ver o mapa gerado
3. **Testar com `workspacePath` no body da requisição** (override direto):
   ```json
   { "model": "auto-free", "messages": [...], "workspacePath": "C:/Users/.../github-edit-view" }
   ```
4. **Verificar se o cliente (Trae) envia `workspacePath`** automaticamente ou se precisa configurar
5. **Validar se `glob`/`grep`/`ls`** também normalizam caminhos (usam `normalizeToolCallArgs`)

---

## 11. RESUMO EXECUTIVO

| Item | Status |
|------|--------|
| Proxy compila (TypeScript) | ✅ |
| Auto Router melhorado (creative) | ✅ |
| Path Normalizer implementado | ✅ |
| WORKSPACE_MAP logic implementada | ✅ |
| **USER_WORKSPACE_PATH configurado** | ⚠️ **Precisa reiniciar proxy** |
| **IA lê arquivos no projeto teste** | ❌ **Falha - workspace errado** |

**Ação crítica:** Reiniciar o proxy (`npm start` no deepsproxy) após confirmar que `.env` tem:
```env
USER_WORKSPACE_PATH=C:\Users\Lucas sá\Documents\Programação\editor_de_arte_V2\github-edit-view
```

---

*Relatório gerado em 30/08/2026 - Para solicitação de ajuda técnica*