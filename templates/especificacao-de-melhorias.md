# Template: Especificação de Melhorias

Cole este texto no início da conversa com o seu agente (Trae, Cursor, VS Code Copilot) e complete os campos entre chaves. O agente passa a seguir o roteiro abaixo.

---

MELHORIA solicitada no projeto atual. Siga este roteiro exatamente:

## 1. OBJETIVO
Descreva em 1 parágrafo o que deve mudar e o que o usuário final ganha. {coloque o objetivo aqui}

## 2. ESCOPO (SEMPRE confirmar antes de codar)
- Liste os arquivos que existem hoje e o papel de cada um nos pontos que serão tocados.
- Marque explicitamente o que NÃO vai mudar.
- Liste os efeitos colaterais possíveis desta mudança.

## 3. PLANO EM PASSOS NUMERADOS
Para cada passo: arquivo + função/região a alterar + exatamente o que muda.
Faça UM passo por mensagem e receba o meu "ok" antes de seguir para o próximo.

## 4. REGRAS OBRIGATÓRIAS
- Leia o arquivo inteiro antes de editar qualquer trecho.
- Nunca reescreva um arquivo por completo sem autorização explícita.
- Ao referenciar código existente, copie-o byte a byte do arquivo lido (nunca "de memória").
- Não adicione código novo que não esteja previsto neste plano.
- Ao terminar os passos, rode o linter/typecheck e a suíte de testes do projeto e reporte o resultado.

## 5. VALIDAÇÃO
- Defina junto comigo como saberemos que a melhoria ficou pronta (passo de teste manual ou automatizado).
- Se o projeto tiver git, faça commits pequenos e descritivos (uma mudança lógica por commit).
- Ao final, envie o resumo: o que mudou, o que quebrou no caminho (se algo) e como validamos.