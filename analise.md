=== DEBUG SESSION REPORT (deepsproxy) ===
Session: 9a217acb-bcf8-4de4-8478-3c8a152adde5
Iniciado: 2026-11-07T19:11:20.272Z
Parado: 2026-11-07T19:16:10.414Z
Duração: 290.1s

--- SUMÁRIO ---
Total de requisições: 14
Com erros/falhas: 0
Usou Orquestrador: 0 | Só roteador/decisão direta: 14
Modelos distintos: 5
Modelos (top): gemini-flash-lite-latest (6), qwen/qwen3.8-27b (3), gemini-3-pro (3), openai/gpt-oss-safeguard-20b (1), openai/gpt-oss-20b (1)
Provedores: desconhecido (14)

--- POR REQUISIÇÃO (timeline) ---
#1 [-] /v1/chat/completions | app:- | req:53da6cf8-5c2 | 847ms
  solicitado:auto -> escolhido:qwen/qwen3.8-27b | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#2 [-] /v1/chat/completions | app:- | req:0e92f6f3-ba7 | 386ms
  solicitado:auto -> escolhido:qwen/qwen3.8-27b | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#3 [-] /v1/chat/completions | app:- | req:33aab6fa-93e | 15ms
  solicitado:auto -> escolhido:qwen/qwen3.8-27b | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#4 [3006] /v1/chat/completions | app:trae 2 | req:510bb0fb-e47 | 299ms
  solicitado:auto -> escolhido:openai/gpt-oss-safeguard-20b | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#5 [3006] /v1/chat/completions | app:trae 2 | req:7b24fd36-33d | 19ms
  solicitado:auto -> escolhido:openai/gpt-oss-20b | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#6 [3006] /v1/chat/completions | app:trae 2 | req:de48b77f-cbb | 22ms
  solicitado:auto -> escolhido:gemini-flash-lite-latest | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#7 [3006] /v1/chat/completions | app:trae 2 | req:21854af0-64a | 21ms
  solicitado:auto -> escolhido:gemini-flash-lite-latest | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#8 [3006] /v1/chat/completions | app:trae 2 | req:aac60cac-4ba | 20ms
  solicitado:auto -> escolhido:gemini-flash-lite-latest | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#9 [3006] /v1/chat/completions | app:trae 2 | req:2a211eb9-a49 | 267ms
  solicitado:auto -> escolhido:gemini-flash-lite-latest | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#10 [3006] /v1/chat/completions | app:trae 2 | req:baba975b-be1 | 21ms
  solicitado:auto -> escolhido:gemini-flash-lite-latest | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#11 [3006] /v1/chat/completions | app:trae 2 | req:28e98e1a-4de | 20ms
  solicitado:auto -> escolhido:gemini-flash-lite-latest | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:capacidade mínima aceitável; custo zero/gratuito
  tentativas:1

#12 [-] /v1/chat/completions | app:- | req:49d755d3-5d0 | 12ms
  solicitado:auto-free -> escolhido:gemini-3-pro | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:excelente capacidade para a tarefa; custo zero/gratuito
  tentativas:1

#13 [-] /v1/chat/completions | app:- | req:a7c9b04b-4e6 | 292ms
  solicitado:auto-free -> escolhido:gemini-3-pro | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:boa capacidade para a tarefa; custo zero/gratuito
  tentativas:1

#14 [-] /v1/chat/completions | app:- | req:4f74f824-7f8 | 11ms
  solicitado:auto-free -> escolhido:gemini-3-pro | provedor:- | chave:- | status:-
  orquestrador:NAO | estratégia:auto-router | motivo:boa capacidade para a tarefa; custo zero/gratuito
  tentativas:1

--- ANÁLISE RÁPIDA (p/ eu revisar) ---
- Orquestrador NÃO apareceu nas decisões registradas. Pode estar desativado, ou as decisões não foram instrumentadas. Verificar config/orquestrador.
- Há variação entre modelos (5 distintos) — bom sinal de roteamento.
- Sem erros aparentes nas requisições registradas.

Cole TODO este texto + o JSON completo aqui que eu analiso detalhadamente: quais modelos foram pra quais atividades, se roteador/orquestrador está funcionando, falhas, tentativas e sugestões.