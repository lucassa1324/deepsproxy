# Template: Refactor Seguro com Reversão

Cole este texto no início da conversa e complete os campos entre chaves.
Usa para reorganizar código existente SEM quebrar comportamento.

---

REFACTOR SEGURO com reversão garantida. Trabalhe em ATÉ 3 MILESTONES independentes.
Cada milestone tem: um comportamento observável de antes/depois, um passo de validação
que prova que nada quebrou, e precisa poder ser revertido sozinho (git revert ou restore).

MILESTONE 1 {nome do milestone}: comportamento {o que deve continuar idêntico}.
MILESTONE 2 {nome do milestone}: comportamento {o que deve continuar idêntico}.
MILESTONE 3 {nome do milestone}: comportamento {o que deve continuar idêntico}.

## SEQUÊNCIA DE EXECUÇÃO
1. Antes de qualquer edição, descreva o estado atual da região (1 parágrafo).
2. Execute o MILESTONE 1, rode a validação dele e me mostre o resultado.
3. Só depois do meu "ok", avance para o MILESTONE 2.
4. Se algo falhar no meio: reverta até o último estado válido e me explique o que aconteceu antes de tentar de novo.

## SELO DE SEGURANÇA (responda ao final de cada milestone)
- [OK] Todos os testes relevantes passam.
- [OK] Nenhum comportamento não-relacionado mudou.
- [OK] O diff deste milestone é mínimo e revisável.
- [OK] O milestone reverte sozinho sem afetar os outros.