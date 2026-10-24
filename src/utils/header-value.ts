/*
 * File: header-value.ts
 * Project: deepsproxy
 * Sanitizador/encodador de valores de headers HTTP de diagnóstico
 * (X-Routed-Via), portado do freellmapi (lib/header-value.ts).
 *
 * O Node valida todo valor de header contra a gramática de field-value do
 * RFC 7230 e lança ERR_INVALID_CHAR em qualquer coisa fora dela. Nomes de
 * provedores/modelos dos catálogos podem conter caracteres não-ASCII ou
 * controles; sem sanitização, um `X-Routed-Via` com um id exótico mataria a
 * resposta DEPOIS da chamada upstream ter funcionado — e, dentro de loops de
 * failover, o throw era contabilizado como falha do provedor.
 *
 * Regras (deliberadamente estreitas):
 *  - SP e VCHAR (0x21-0x7E) passam direto (ids comuns ficam byte-idênticos);
 *  - todo o resto (controle, DEL, não-ASCII) vira percent-encoding UTF-8,
 *    decodificável com decodeURIComponent;
 *  - '%' literal vira '%25' para o decode ser inequívoco.
 * Saída com teto de tamanho para ids patológicos não estourarem o budget de
 * header de um proxy intermediário.
 */

const MAX_HEADER_VALUE_LENGTH = 256;

function percentEncode(char: string): string {
  try {
    return encodeURIComponent(char);
  } catch {
    // Lone surrogate — encodeURIComponent recusa. Entra o char de substituição
    // UTF-8 no lugar em vez de silenciosamente perder a posição.
    return '%EF%BF%BD';
  }
}

/** Coage uma string arbitrária para um valor de header HTTP válido. Nunca
 *  lança e nunca devolve um valor que o Node rejeite. */
export function safeHeaderValue(value: string, maxLength = MAX_HEADER_VALUE_LENGTH): string {
  if (value == null) return '';
  let out = '';
  // Itera por code point para que caracteres astrais (emoji em nome exibido)
  // sejam codificados como uma sequência UTF-8 única, não duas metades.
  for (const char of String(value)) {
    const code = char.codePointAt(0)!;
    const piece = code >= 0x20 && code <= 0x7e && char !== '%' ? char : percentEncode(char);
    if (out.length + piece.length > maxLength) break;
    out += piece;
  }
  return out;
}

/** `<plataforma>/<modelo>` para X-Routed-Via, sanitizado. */
export function routedViaValue(platform: string, modelId: string): string {
  return safeHeaderValue(`${platform}/${modelId}`);
}