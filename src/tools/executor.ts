/*
 * File: executor.ts
 * Project: deepsproxy
 * Execution loop for tool calling - agentic loop that handles
 * send -> tool calls -> execute -> re-send until completion
 */

import { v4 as uuidv4 } from 'uuid';
import type { ParsedToolCall, ToolCallResult, ToolContext } from './types.ts';
import { SchemaValidationError } from './schema.ts';
import { registry } from './registry.ts';
import { robustParseJSON } from '../utils/robust-json.ts';
import { normalizeToolCallArgs } from '../services/path-normalizer.ts';

export interface ExecutionLoopConfig {
  maxTurns?: number;
  debug?: boolean;
  /**
   * Booster de modelo fraco (opt-in): quando ativo, injeta mensagens
   * corretivas quando um tool_call falha ou vem num formato inválido, dando
   * uma nova chance ao modelo em vez de devolver o texto "narrado".
   */
  booster?: boolean;
}

export interface LoopTurnResult {
  toolCalls: ParsedToolCall[];
  toolResults: ToolCallResult[];
  content: string | null;
  finishReason: string | null;
  turn: number;
}

export type LLMSendFunction = (
  messages: unknown[],
  tools: unknown[] | undefined,
  model: string
) => Promise<LLMResponse>;

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

/** Mensagem corretiva injetada quando um tool_call falha (booster). */
export function buildCorrectionMessage(failures: string): string {
  return (
    `[CORREÇÃO AUTOMÁTICA] Um ou mais tool_calls falharam:\n${failures}\n\n` +
    `Isto NÃO é uma resposta final. Reenvie o(s) tool_call(s) corrigidos (confira os nomes e os argumentos no formato exato do schema). ` +
    `NUNCA invente o resultado de uma ferramenta — se você não chamou a ferramenta, não afirme que executou a ação.`
  );
}

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

      // Modelos costumam emitir aspas sem escape dentro de valores JSON (ex.:
      // charSet="UTF-8") e quebras de linha REAIS dentro de strings (HTML
      // multi-linha). robustParseJSON corrige aspas internas E escapa control
      // chars no fallback; JSON.parse direto quebraria nesses casos.
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

export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  context: ToolContext
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];

  // Extrai workspace root do contexto (se disponível)
  const workspaceRoot = (context as any).workspaceRoot;

  for (const tc of toolCalls) {
    try {
      if (!registry.has(tc.name)) {
        results.push({
          toolCallId: tc.id,
          name: tc.name,
          result: JSON.stringify({ error: `Unknown tool: '${tc.name}'` }),
          isError: true,
        });
        continue;
      }

      // Normaliza caminhos nos argumentos antes de executar
      const normalizedArgs = normalizeToolCallArgs(tc.name, tc.arguments, workspaceRoot);

      const result = await registry.execute(tc.name, normalizedArgs, context);
      
      // Tratamento de retorno nulo/vazio: injeta erro estruturado para a IA
      // não assumir que o arquivo está limpo ou a operação "passou"
      const isEmptyOrNull = result === null || result === undefined || 
        (typeof result === 'string' && result.trim() === '');
      
      const finalResult = isEmptyOrNull
        ? JSON.stringify({
            system_error: `A ferramenta "${tc.name}" retornou resultado vazio ou nulo. ` +
              `Isso geralmente indica: arquivo não encontrado, sem permissão de leitura, ` +
              `ou a operação não produziu saída. Verifique o caminho e parâmetros.`
          })
        : result;

      results.push({
        toolCallId: tc.id,
        name: tc.name,
        result: finalResult,
        isError: isEmptyOrNull, // marca como erro para o modelo tratar como falha
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isValidation = err instanceof SchemaValidationError;
      results.push({
        toolCallId: tc.id,
        name: tc.name,
        result: JSON.stringify({
          error: isValidation ? 'Schema validation failed' : 'Tool execution error',
          details: message,
          ...(isValidation ? { path: (err as SchemaValidationError).path } : {}),
        }),
        isError: true,
      });
    }
  }

  return results;
}

function buildToolMessage(result: ToolCallResult): Record<string, unknown> {
  return {
    role: 'tool',
    tool_call_id: result.toolCallId,
    content: result.result,
  };
}

function buildAssistantToolCallMessage(
  content: string | null,
  toolCalls: ParsedToolCall[]
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string'
          ? tc.arguments
          : JSON.stringify(tc.arguments),
      },
    })),
  };
}

export async function runExecutionLoop(
  sendToLLM: LLMSendFunction,
  messages: unknown[],
  model: string,
  config: ExecutionLoopConfig = {}
): Promise<string> {
  const maxTurns = config.maxTurns ?? 10;
  const debug = config.debug ?? false;

  const tools = registry.listNames().length > 0
    ? registry.toOpenAITools()
    : undefined;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (debug) {
      console.log(`[executor] Turn ${turn + 1}/${maxTurns}, messages: ${messages.length}`);
    }

    const response = await sendToLLM(messages, tools, model);

    const hasStructuredToolCalls = response.toolCalls && response.toolCalls.length > 0;
    let parsedFromContent: { textContent: string; toolCalls: ParsedToolCall[] } | null = null;

    if (!hasStructuredToolCalls && response.content) {
      parsedFromContent = parseToolCallsFromContent(response.content);
    }

    const effectiveToolCalls = hasStructuredToolCalls
      ? response.toolCalls
      : parsedFromContent?.toolCalls || [];

    const effectiveContent = parsedFromContent
      ? parsedFromContent.textContent
      : response.content;

    if (effectiveToolCalls.length === 0) {
      // Modelo fraco (booster): se o texto parece conter um tool_call quebrado
      // (tag aberta, "name" solto, menção a tool_call), não devolvemos o texto
      // como resposta — damos uma nova chance com uma correção.
      const broken = config.booster && effectiveContent && looksLikeBrokenToolCall(effectiveContent);
      if (!broken) {
        if (debug) {
          console.log('[executor] No tool calls, loop complete');
        }
        return effectiveContent || '';
      }
      messages.push({ role: 'assistant', content: effectiveContent });
      messages.push({
        role: 'user',
        content: buildCorrectionMessage(
          'O tool_call que você emitiu estava num formato inválido e não pôde ser executado. ' +
            'Use o formato exato: <tool_call>{"name": "nome_da_tool", "arguments": {...}}</tool_call> e nada mais.'
        ),
      });
      continue;
    }

    const context: ToolContext = {
      messages,
      turn,
      model,
      workspaceRoot: (messages[0] as any)?.workspaceRoot || process.cwd(),
    };

    if (debug) {
      console.log(
        `[executor] Executing ${effectiveToolCalls.length} tool calls:`,
        effectiveToolCalls.map((tc) => tc.name)
      );
    }

    const toolResults = await executeToolCalls(effectiveToolCalls, context);

    messages.push(buildAssistantToolCallMessage(effectiveContent, effectiveToolCalls));

    for (const result of toolResults) {
      messages.push(buildToolMessage(result));
    }

    // Booster: quando uma tool falhou (desconhecida, validação ou erro de
    // execução), injeta um aviso corretivo para o modelo fraco aprender e
    // corrigir na próxima volta, em vez de só seguir adiante.
    const failures = toolResults.filter((r) => r.isError);
    if (config.booster && failures.length > 0) {
      const detail = failures
        .map((r) => `${r.name}: ${String(r.result).slice(0, 300)}`)
        .join('\n');
      messages.push({ role: 'user', content: buildCorrectionMessage(detail) });
    }

    if (debug) {
      console.log(
        `[executor] Tool results:`,
        toolResults.map((r) => ({ name: r.name, isError: r.isError }))
      );
    }
  }

  throw new Error(
    `Execution loop exceeded maximum turns (${maxTurns}). The agent may be stuck in a cycle.`
  );
}
