/*
 * File: executor.ts
 * Project: deepsproxy
 * Parsing de tool calls para o Gateway HTTP Puro.
 *
 * Em modo pass-through o proxy NUNCA executa ferramentas localmente (loop
 * agêntico Turn 1..10 removido). Este módulo ficou responsável apenas pela
 * conversão TRANSPARENTE do formato textual <tool_call> que os backends web
 * (Gemini/DeepSeek/Qwen) emitem para o formato OpenAI/Gemini de `tool_calls`
 * que a IDE espera receber no HTTP/SSE. A execução local (fs, shell, registry)
 * foi removida por design.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ParsedToolCall } from './types.ts';
import { robustParseJSON } from '../utils/robust-json.ts';

export interface LLMResponse {
  content: string | null;
  toolCalls: ParsedToolCall[];
  finishReason: string;
}

const TOOL_START_TAG = '<' + 'tool_call>';
const TOOL_END_TAG = '</' + 'tool_call>';

/** Heurística: o texto parece conter um tool_call quebrado/parcial. */
export function looksLikeBrokenToolCall(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.includes(TOOL_START_TAG) || t.includes('tool_call')) return true;
  return /^\{?\s*"name"\s*:\s*"/.test(t) || /\{"name"\s*:\s*"/.test(t);
}

/** Mensagem corretiva usada historicamente no booster (mantida p/ testes). */
export function buildCorrectionMessage(failures: string): string {
  return (
    `[CORREÇÃO AUTOMÁTICA] Um ou mais tool_calls falharam:\n${failures}\n\n` +
    `Isto NÃO é uma resposta final. Reenvie o(s) tool_call(s) corrigidos (confira os nomes e os argumentos no formato exato do schema). ` +
    `NUNCA invente o resultado de uma ferramenta — se você não chamou a ferramenta, não afirme que executou a ação.`
  );
}

/**
 * Extrai os blocos <tool_call>{"name": ..., "arguments": ...}</tool_call> do
 * texto gerado pelo modelo e os devolve em formato estruturado. O texto fora
 * dos blocos vira `textContent`. Este parse é a ÚNICA transformação aplicada
 * sobre a resposta no gateway puro — os tool_calls são repassados de forma
 * transparente para a IDE, sem reescrita de caminhos nem execução local.
 */
export function parseToolCallsFromContent(content: string): {
  textContent: string;
  toolCalls: ParsedToolCall[];
} {
  const toolCalls: ParsedToolCall[] = [];
  let remaining = content;
  let textContent = '';

  while (true) {
    const startIdx = remaining.indexOf(TOOL_START_TAG);
    if (startIdx === -1) {
      textContent += remaining;
      break;
    }

    textContent += remaining.substring(0, startIdx);

    const endIdx = remaining.indexOf(TOOL_END_TAG, startIdx + TOOL_START_TAG.length);
    if (endIdx === -1) {
      textContent += remaining.substring(startIdx);
      break;
    }

    const jsonStr = remaining
      .substring(startIdx + TOOL_START_TAG.length, endIdx)
      .trim();

    try {
      let sanitized = jsonStr.replace(/```json/g, '').replace(/```/g, '').trim();
      const braceStart = sanitized.indexOf('{');
      const braceEnd = sanitized.lastIndexOf('}');
      if (braceStart !== -1 && braceEnd !== -1 && braceEnd >= braceStart) {
        sanitized = sanitized.substring(braceStart, braceEnd + 1);
      }

      const parsed = robustParseJSON(sanitized);
      if (parsed) {
        toolCalls.push({
          id: 'call_' + uuidv4(),
          name: parsed.name || '',
          arguments: typeof parsed.arguments === 'string'
            ? (robustParseJSON(parsed.arguments) ?? {})
            : (parsed.arguments || {}),
        });
      } else {
        textContent += TOOL_START_TAG + jsonStr + TOOL_END_TAG;
      }
    } catch (e) {
      textContent += TOOL_START_TAG + jsonStr + TOOL_END_TAG;
    }

    remaining = remaining.substring(endIdx + TOOL_END_TAG.length);
  }

  return { textContent: textContent.trim(), toolCalls };
}