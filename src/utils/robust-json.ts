/*
 * File: robust-json.ts
 * Project: deepsproxy
 * Parser de JSON robusto para conteúdo gerado por LLM (streaming tool calls),
 * portado do qwenproxy (autor: Pedro Farias).
 */

/**
 * Corrige aspas NÃO escapadas dentro de strings JSON (erro comum de LLM, ex.:
 * `<html lang="pt-BR">` dentro de um valor). Regra: dentro de uma string, uma
 * `"` só FECHA a string se o próximo char NÃO-ESPAÇO for um delimitador
 * estrutural (`, } ] :` ou fim). Se vier mais texto, é aspa interna → escapa.
 *
 * O "ignora espaços" é essencial para HTML com vários atributos:
 * `class="destaque" data-id="1"` — a aspa após "destaque" vem seguida de espaço
 * seguido de "d..." (outro atributo), ou seja, NÃO é o fechamento da string
 * JSON; tratá-la como fechamento quebrava todo o parse. JSON válido passa
 * intacto (em JSON válido `"` interno sempre vem como `\"`, e o fechamento de
 * valor é sempre seguido de `, } ]` ou fim, ignorando espaços).
 */
export function repairUnescapedQuotes(str: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (inString) {
        let j = i + 1;
        while (j < str.length && /\s/.test(str[j])) j++;
        const next = str[j] ?? '';
        const isDelimiter = next === '' || next === ',' || next === '}' || next === ']' || next === ':';
        if (isDelimiter) {
          out += ch;
          inString = false;
        } else {
          out += '\\"';
        }
      } else {
        out += ch;
        inString = true;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Corrige barras de caminho Windows NÃO escapadas (ex.: `c:\Users` -> `c:\\Users`).
 * Preserva sequências de escape JSON válidas: `\"`, `\\`, `\/`, `\b`, `\f`,
 * `\n`, `\r`, `\t` e `\uXXXX`. Modelos com frequência copiam paths do Windows
 * com barra simples, e `\U`/`\L` são "Bad escaped character" para o JSON.parse.
 *
 * Lógica por RUN de barras: em uma run de comprimento PAR todas as barras
 * formam pares `\\` válidos (preserva); em uma run ÍMPAR, a última barra é
 * "solta" — se o próximo char não forma escape válido, dobra essa barra.
 */
export function sanitizeModelBackslashes(str: string): string {
  let out = '';
  let i = 0;
  const VALID_ESC = /["\\/bfnrt]/;
  while (i < str.length) {
    if (str[i] !== '\\') {
      out += str[i];
      i++;
      continue;
    }
    let runLen = 1;
    while (i + runLen < str.length && str[i + runLen] === '\\') runLen++;
    const next = str[i + runLen];
    const unicodeEscape = next === 'u' && /^[0-9a-fA-F]{4}/.test(str.slice(i + runLen + 1, i + runLen + 5));
    const validEscape = next !== undefined && (unicodeEscape || VALID_ESC.test(next));

    if (runLen % 2 === 0) {
      out += '\\'.repeat(runLen);
      i += runLen;
    } else if (validEscape) {
      out += '\\'.repeat(runLen) + next;
      i += runLen + 1;
    } else {
      out += '\\'.repeat(runLen + 1);
      i += runLen;
    }
  }
  return out;
}

/**
 * Desescapa sequências JSON comuns numa string extraída por regex (o inverso
 * do escape do JSON.stringify). Ordem importa: `\\n` (barra+barra+n) deve
 * virar `\n` literal (2 chars), não newline.
 */
function unescapeJsonString(s: string): string {
  return s
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\//g, '/');
}

/**
 * Último recurso: quando todas as tentativas de parse falham, tenta extrair
 * via regex os campos típicos de uma chamada de tool (name / file_path /
 * content). Recupera o caso em que o modelo corrompeu o JSON além do reparo —
 * ex.: conteúdo de arquivo com aspas internas não escapadas (CMD ["npm", "start"]).
 *
 * Ao contrário do JSON.parse, trata `content` como texto livre: a extração
 * usa o marcador `"content": "` e encerra na PRIMEIRA aspa seguida de
 * `, "campo_conhecido": "` (início do próximo campo) ou, na ausência desta,
 * no `"}` final. Assim o conteúdo pode vir em qualquer ordem (antes ou depois
 * de file_path) e com aspas soltas.
 */
function tryRecoverToolCall(jsonString: string): any | null {
  const str = jsonString.trim();

  // name — campo simples, sem aspas internas.
  const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(str);
  if (!nameMatch) return null;

  const args: Record<string, unknown> = {};

  // Campos simples (string sem aspas internas) — em qualquer ordem.
  const simpleFieldRe =
    /"(file_path|path|command|line|start|end|mode|id|url|query|branch|repo|message|description|pattern|target|source|destination|extension|language|output|format|command_line|working_directory)"\s*:\s*"([^"]*)"/g;
  let fm: RegExpExecArray | null;
  while ((fm = simpleFieldRe.exec(str)) !== null) {
    args[fm[1]] = unescapeJsonString(fm[2]);
  }

  // content — texto livre que PODE conter aspas não escapadas.
  const contentMarker = /"content"\s*:\s*"/.exec(str);
  if (contentMarker) {
    const bodyStart = contentMarker.index + contentMarker[0].length;
    const body = str.slice(bodyStart);
    const knownFields =
      '(?:file_path|path|command|line|start|end|mode|id|url|query|branch|repo|message|description|pattern|target|source|destination|extension|language|output|format|command_line|working_directory)';
    // Encontra a aspa que fecha o valor de content: a PRIMEIRA `"` seguida de
    // `, "campo_conhecido": "` (início do próximo campo) — exige `": "` para
    // não casar com conteúdo como `["npm", "start"]`. Sem isso, usa o `"}` final.
    const closeRe = new RegExp(`"\\s*,\\s*"${knownFields}"\\s*:\\s*"`, 'g');
    const cm = closeRe.exec(body);
    let closeIdx = cm ? cm.index : -1;
    if (closeIdx === -1) closeIdx = body.lastIndexOf('"}');
    if (closeIdx === -1) closeIdx = body.length;
    args.content = unescapeJsonString(body.slice(0, closeIdx));
  }

  return { name: nameMatch[1], arguments: args };
}

/**
 * Dobra a última barra de runs ÍMPARES de '\' DENTRO do valor CRU de uma
 * CHAVE DE CAMINHO, exceto quando a sequência é um escape JSON válido e
 * intencional ('\"', '\\', '\/').
 *
 * Por que: modelos escrevem paths do Windows com barra simples ('.\tests_stress',
 * 'src\arquivo.txt'). O JSON.parse decodifica '\t' → Tab REAL e "engole" a
 * letra 't' ('tests_stress' → 'ests_stress'); já sequências como '\s' são
 * fugas inválidas que quebram o parse. Dobrando a barra final de cada run
 * ímpar ('\t' → '\\t', '\s' → '\\s'), o parse conserva a barra REAL + letra
 * (depois o relay converte '\'→'/') e o caminho NUNCA vira Tabulação nem
 * quebra o JSON. Runs pares ('\\t' = barra literal escapada) e valores de
 * outras chaves (ex.: 'content' com '\n' intencionais) não são tocados.
 */
export function protectPathEscapesInJson(text: string): string {
  const pathKeys = '(?:path|file_path|filePath|target_file|absolute_path|directory)';
  const valueRe = new RegExp(`("(?:${pathKeys})"\\s*:\\s*")((?:[^"\\\\]|\\\\.)*)(")`, 'g');
  return text.replace(valueRe, (whole: string, head: string, value: string, tail: string) => {
    return head + doublePathEscapeBackslashes(value) + tail;
  });
}

/** Implementação da dobra de runs ímpares dentro do fragmento de valor. */
function doublePathEscapeBackslashes(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    let run = 1;
    while (i + run < value.length && value[i + run] === '\\') run++;
    const next = value[i + run] ?? '';
    // Run ímpar seguido de escape JSON inválido/'control' em caminho: dobra a
    // barra final para o parse produzir '\'+letra (barra real) em vez de
    // quebrar ("Bad escaped character") ou virar Tab/CR/LF control.
    if (run % 2 === 1 && next !== '' && !/["\\/]/.test(next)) {
      out += '\\'.repeat(run + 1);
    } else {
      out += '\\'.repeat(run);
    }
    i += run;
  }
  return out;
}

export function robustParseJSON(str: string): any {
  let sanitized = (str || '').replace(/\u0000/g, '').trim();

  // Remove markdown code blocks if present
  sanitized = sanitized.replace(/^```json\s*/, '').replace(/```$/, '').trim();

  // Corrige barras de caminho Windows antes de qualquer tentativa de parse.
  sanitized = sanitizeModelBackslashes(sanitized);

  // Protege barras de CAMINHOS contra a decodificação de '\t'→Tab (que
  // comeriam a letra de '.\tests_stress' → 'ests_stress'). Só chaves de
  // caminho; `content` com escapes legítimos permanece intacto.
  sanitized = protectPathEscapesInJson(sanitized);

  // Try to find the first '{'
  const firstBrace = sanitized.indexOf('{');
  if (firstBrace === -1) return null;

  let jsonPart = sanitized.substring(firstBrace);

  // Try parsing directly first (com aspas internas corrigidas)
  try {
    return JSON.parse(repairUnescapedQuotes(jsonPart));
  } catch (e) {
    // If it fails, let's try to fix common issues
  }

  // 1. Clean trailing noise from the end of the string
  let cleaned = jsonPart.trim();
  while (cleaned.length > 0 && !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])) {
    cleaned = cleaned.slice(0, -1).trim();
  }
  cleaned = repairUnescapedQuotes(cleaned);

  // 2. Pre-process to escape control characters in strings and count braces
  let fixedJson = '';
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  let lastBalancedIndex = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escaped) {
      fixedJson += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      fixedJson += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      fixedJson += char;
      continue;
    }

    if (inString) {
      // Escape literal control characters that are invalid in JSON strings
      if (char === '\n') fixedJson += '\\n';
      else if (char === '\r') fixedJson += '\\r';
      else if (char === '\t') fixedJson += '\\t';
      else if (char.charCodeAt(0) < 32) {
        fixedJson += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
      }
      else fixedJson += char;
    } else {
      fixedJson += char;
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
      if (char === '[') openBrackets++;
      if (char === ']') openBrackets--;

      if (openBraces === 0 && openBrackets === 0 && i > 0) {
        lastBalancedIndex = fixedJson.length - 1;
      }
    }
  }

  let tempJson = fixedJson;

  // If we found a point where it was balanced and there is trailing noise or it didn't stay balanced
  if (lastBalancedIndex !== -1 && (openBraces !== 0 || openBrackets !== 0 || fixedJson.length > lastBalancedIndex + 1)) {
    tempJson = fixedJson.substring(0, lastBalancedIndex + 1);
  } else if (openBraces > 0 || openBrackets > 0) {
    // If it never balanced, attempt to close everything that is open
    if (openBrackets > 0) tempJson += ']'.repeat(openBrackets);
    if (openBraces > 0) tempJson += '}'.repeat(openBraces);
  }

  try {
    return JSON.parse(tempJson);
  } catch (e) {
    // Still fails, try one more aggressive approach: remove trailing comma before closing
    let aggressive = fixedJson.trim();
    if (aggressive.endsWith(',')) aggressive = aggressive.slice(0, -1);

    // Recount for the aggressive version
    let ob = 0, bk = 0, is = false, esc = false;
    let aggFixed = '';
    for (let i = 0; i < aggressive.length; i++) {
      const char = aggressive[i];
      if (esc) { aggFixed += char; esc = false; continue; }
      if (char === '\\') { aggFixed += char; esc = true; continue; }
      if (char === '"') { is = !is; aggFixed += char; continue; }

      if (is) {
        if (char === '\n') aggFixed += '\\n';
        else if (char === '\r') aggFixed += '\\r';
        else if (char === '\t') aggFixed += '\\t';
        else aggFixed += char;
      } else {
        aggFixed += char;
        if (char === '{') ob++;
        if (char === '}') ob--;
        if (char === '[') bk++;
        if (char === ']') bk--;
      }
    }

    if (bk > 0) aggFixed += ']'.repeat(bk);
    if (ob > 0) aggFixed += '}'.repeat(ob);

    try {
      return JSON.parse(aggFixed);
    } catch (e2) {
      // Último recurso: extração via regex dos campos de uma tool call.
      // Usa o JSON CRU (jsonPart), não `cleaned` — o repairUnescapedQuotes
      // corrompe as aspas do conteúdo (ex.: `", "file_path"` vira `\", \"file_path\"`)
      // e quebra a extração por regex.
      const recovered = tryRecoverToolCall(jsonPart);
      if (recovered) return recovered;
      throw e; // Throw original error if all fixes fail
    }
  }
}