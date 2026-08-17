# TODO — Otimizações de Performance e Eficiência

## Status: Fase 5 Concluída
## Última atualização: 2026-08-17

---

## Filosofia e Princípios

### Prioridade (em ordem decrescente)
1. **Acurácia e qualidade** — nunca sacrificar automaticamente
2. **Confiabilidade e consistência** — resultados previsíveis
3. **Eficiência no uso de recursos** — menos tokens, menos latência
4. **Velocidade** — respostas rápidas
5. **Otimizações adicionais** — melhorias extras

### Regras obrigatórias
- Otimizações que podem afetar acurácia devem ser **opcionais e desativadas por padrão**
- O sistema **nunca** deve tomar decisões silenciosas que prejudiquem resultados
- O usuário deve ter controle total sobre otimizações com impacto na qualidade
- Configurações perigosas devem ter explicação simples do impacto
- Usuários leigos não devem precisar configurar nada — tudo funciona bem por padrão
- Usuários avançados devem ter acesso a controles detalhados

### Sobre prompts repetidos
- **Detecção de duplicatas DESATIVADA por padrão**
- O sistema não deve bloquear, ignorar ou tratar prompts repetidos como duplicados
- Prompts repetidos são intencionais (testes contínuos, múltiplas iterações)
- Cache de respostas e prevenção de processamento duplicado devem ser controlados pelo usuário

---

## FASE 1 — Otimizações 100% Seguras ✅ CONCLUÍDA

Zero impacto na qualidade. Ativadas por padrão sem risco.
Valem para TODOS os modelos (local, web, API).

### 1.1 Reutilizar conexões HTTP (keep-alive pool)
- **O quê:** Manter pool de conexões aberto com provedores (Ollama, LM Studio, APIs)
- **Por quê:** Evita abrir nova TCP/TLS connection a cada request
- **Impacto:** reduz ~50-100ms de latência por request
- **Risco:** nenhum
- **Ativo por padrão:** sim
- **Toggle usuário:** não (infraestrutura invisível)

### 1.2 Pre-carregar e cache de system prompts
- **O quê:** Manter system prompt pré-parseado em memória, invalidar quando mudar
- **Por quê:** Evitar reconstruir o mesmo prompt a cada request
- **Impacto:** reduz overhead de processamento
- **Risco:** nenhum
- **Ativo por padrão:** sim
- **Toggle usuário:** não (infraestrutura invisível)

### 1.3 Remover metadata desnecessária do payload
- **O quê:** Tirar campos que o modelo não usa: `name`, `description`, `created_at`, `owned_by`, etc.
- **Por quê:** São tokens jogados fora — o modelo ignora完全
- **Impacto:** reduz tokens enviados (especialmente em listas de tools)
- **Risco:** nenhum
- **Ativo por padrão:** sim
- **Toggle usuário:** não (infraestrutura invisível)

### 1.4 Batch de requests para modelos locais
- **O quê:** Se múltiplos clientes pedirem ao mesmo modelo ao mesmo tempo, agrupar em um único request ao Ollama/LM Studio
- **Por quê:** Modelos locais processam um request por vez; fila é desperdício
- **Impacto:** reduz carga no hardware, throughput maior
- **Risco:** nenhum (cada cliente recebe sua resposta individual)
- **Ativo por padrão:** sim
- **Toggle usuário:** não (infraestrutura invisível)

### 1.5 Compressão conservadora de tool definitions
- **O quê:** Encurtar descrições de tools mantendo: nome + parâmetros + 1 frase de descrição
- **Por quê:** Descrições longas gastam tokens desnecessariamente
- **Regras:**
  - NUNCA remover nomes de tools
  - NUNCA remover nomes de parâmetros
  - NUNCA remover tipos de parâmetros
  - Só encurtar a descrição textual (mantendo o essencial)
- **Impacto:** reduz tokens de system prompt significativamente
- **Risco:** baixo (se a descrição ficar ambígua, modelo pode chamar tool errada)
- **Ativo por padrão:** sim (conservador)
- **Toggle usuário:** sim — "Comprimir tool definitions" na aba Configurações

---

## FASE 2 — Otimizações com Controle do Usuário ✅ CONCLUÍDA

Podem afetar acurácia em casos específicos. Desativadas por padrão.
Usuário decide se ativa.

### 2.1 Smart truncation (importância)
- **O quê:** Em vez de truncar pelas mensagens mais antigas, truncar as menos importantes
- **Critérios de prioridade:**
  1. System prompt (SEMPRE fica)
  2. Últimas 3-5 mensagens (SEMPRE ficam)
  3. Mensagens com tool calls/results (densas de informação)
  4. Mensagens com código, números ou dados específicos
  5. Mensagens longas (>200 chars)
  6. Mensagens curtas ("ok", "entendi", "obrigado") — descartadas primeiro
- **Impacto:** muito eficiente em contexto pequeno
- **Risco:** moderado — pode descartar mensagem que parecia irrelevante mas era crucial
- **Ativo por padrão:** NÃO
- **Toggle usuário:** sim — "Smart truncation (importância)" na aba Configurações
- **Classificação:** avançado

### 2.2 Cache de respostas por prompt hash
- **O quê:** Se o mesmo prompt exato for enviado 2x, retornar a resposta cacheada
- **Por quê:** Evita processamento redundante
- **Impacto:** zero latência em hits
- **Risco:** baixo — respostas idênticas para prompts idênticos
- **Ativo por padrão:** NÃO (usuário faz testes com prompts repetidos)
- **Toggle usuário:** sim — "Cache de respostas" na aba Configurações
- **Regra importante:** DEVE ficar desativado por padrão porque o usuário faz testes contínuos com os mesmos prompts

### 2.3 Deduplicação de mensagens consecutivas
- **O quê:** Remover mensagens idênticas que aparecem 2x seguidas (mesma role + mesmo conteúdo)
- **Por quê:** Geralmente é erro de digitação ou reenvio acidental
- **Impacto:** reduz tokens
- **Risco:** muito baixo (só remove cópias exatas consecutivas)
- **Ativo por padrão:** NÃO (para não interferir em testes)
- **Toggle usuário:** sim — "Limpar duplicatas consecutivas"

---

## FASE 3 — Presets e Configuração em Massa ✅ CONCLUÍDA

### 3.1 Sistema de presets
- **O quê:** Configurações salvas que podem ser aplicadas a vários modelos de uma vez
- **Como funciona:**
  - Usuário cria um preset (ex: "Código", "Criativo", "Rápido")
  - Define quais opções cada preset ativa
  - Aplica o preset pra qualquer modelo com 1 clique
- **Presets pré-configurados:**
  - **Padrão** — otimizações seguras ligadas, tudo mais desligado
  - **Código** — truncateToolOutput + stripReasoning ligados
  - **Criativo** — tudo desligado, contexto máximo
  - **Econômico** — tudo que economiza tokens ligado
- **Armazenamento:** localStorage

### 3.2 Aplicar preset em massa
- **O quê:** Selecionar múltiplos modelos e aplicar o mesmo preset de uma vez
- **Interface:** checkboxes ao lado de cada modelo no seletor

### 3.3 Importar/exportar presets
- **O quê:** Salvar presets como arquivo JSON e importar de outro navegador/máquina
- **Formato:** JSON com nome + configurações

---

## FASE 4 — Modelos Locais (Ollama/LM Studio) ✅ CONCLUÍDA

### 4.1 Auto-discovery
- **O quê:** Detectar automaticamente instâncias rodando em localhost
- **Portas:** Ollama (11434), LM Studio (1234)
- **Ação:** Listar modelos disponíveis sem configuração manual

### 4.2 Monitor de performance
- **O quê:** Mostrar tokens/segundo em tempo real para cada modelo local
- **Métricas:** latência, throughput, uso de VRAM (se disponível)

### 4.3 Health check
- **O quê:** Verificar se a instância local está respondendo
- **Interface:** indicador visual (verde/amarelo/vermelho)

### 4.4 Fallback automático
- **O quê:** Se o modelo local falhar ou ficar lento demais, fallback pro cloud
- **Controle:** usuário liga/desliga, define threshold de latência

---

## FASE 5 — Melhorias de Interface ✅ CONCLUÍDA

### 5.1 Toggle "Modo Avançado"
- Esconde/mostra opções avançadas na aba Configurações
- Usuário leigo vê só o essencial
- Usuário avançado ativa pra ver tudo

### 5.2 Indicador de impacto em tempo real
- Ao ligar/desligar uma opção, mostrar estimativa de:
  - Tokens economizados por request
  - Impacto na qualidade (nenhum/baixo/médio/alto)

### 5.3 Explicação simplificada
- Cada opção tem uma descrição curta (1 linha) pra leigos
- E uma descrição detalhada pra avançados

---

## Resumo: O que ativar por padrão

| Otimização | Padrão | Toggle |
|---|---|---|
| Reutilizar conexões | ✅ Ligado | Não (infra) |
| Pre-carregar prompts | ✅ Ligado | Não (infra) |
| Remover metadata | ✅ Ligado | Não (infra) |
| Batch de requests | ✅ Ligado | Não (infra) |
| Comprimir tools | ✅ Ligado | Sim |
| Smart truncation | ❌ Desligado | Sim |
| Cache de respostas | ❌ Desligado | Sim |
| Deduplicar msgs | ❌ Desligado | Sim |

---

## Ordem de implementação

1. **Fase 1** — Otimizações 100% seguras (1.1 a 1.5)
2. **Fase 2** — Controles do usuário (2.1 a 2.3)
3. **Fase 3** — Presets e configuração em massa
4. **Fase 4** — Modelos locais
5. **Fase 5** — Melhorias de interface
