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
 * Último recurso: quando todas as tentativas de parse falham, tenta extrair
 * via regex os campos típicos de uma chamada de tool (name / file_path /
 * content). Recupera o caso em que o modelo corrompeu o JSON além do reparo.
 */
function tryRecoverToolCall(jsonString: string): any | null {
  const nameMatch = jsonString.match(/"name"\s*:\s*"([^"]+)"/);
  const filePathMatch = jsonString.match(/"file_path"\s*:\s*"([^"]+)"/);
  const contentMatch = jsonString.match(/"content"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
  if (!contentMatch) return null;
  return {
    name: (nameMatch && nameMatch[1]) || 'unknown',
    arguments: {
      ...(filePathMatch ? { file_path: filePathMatch[1].replace(/\\/g, '\\\\') } : {}),
      content: contentMatch[1],
    },
  };
}

export function robustParseJSON(str: string): any {
  let sanitized = str.trim();

  // Remove markdown code blocks if present
  sanitized = sanitized.replace(/^```json\s*/, '').replace(/```$/, '').trim();

  // Corrige barras de caminho Windows antes de qualquer tentativa de parse.
  sanitized = sanitizeModelBackslashes(sanitized);

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
      const recovered = tryRecoverToolCall(cleaned || jsonPart);
      if (recovered) return recovered;
      throw e; // Throw original error if all fixes fail
    }
  }
}
