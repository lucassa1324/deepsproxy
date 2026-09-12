# Template: Debug de Bug Intermitente

Cole este texto no início da conversa e complete os campos entre chaves.
Usa quando o problema aparece "de vez em quando" e ninguém sabe a causa.

---

DEBUG DE BUG INTERMITENTE. NÃO tente adivinhar a causa. Siga o processo:

## 1. REPRODUZIR (mínimo possível)
- Me pergunte o passo exato que faz o bug aparecer.
- Crie uma reprodução reduzida se possível (menos arquivos, menos estados).

## 2. RASTREAR (use instrumentação, não teorias)
- Adicione logs com contexto. O log é o PRIMEIRO indício, não a resposta.
- Liste as variáveis que mudam entre o caso que funciona e o caso que falha.
- Diga qual hipótese cada observação descarta.

## 3. ISOLAR (uma variável por vez)
- Mude UMA coisa por tentativa.
- Depois de cada tentativa, me diga: o que mudou? o que NÃO mudou?

## 4. TROCA DE OPINIÃO
- Ao propor uma causa, cite a evidência exata (log, valor, comparação).
- Se eu discordar, trate como dado novo, não como conflito de opinião.

## 5. CORREÇÃO
- Mínima: só o que explica o sintoma observado.
- Toda correção vem acompanhada de 1 teste que falhava antes e passou depois.