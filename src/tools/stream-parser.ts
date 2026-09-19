/*
 * File: stream-parser.ts
 * Project: deepsproxy
 * Parser streaming de tags <tool_call> </tool_call> para modelos agentic,
 * portado do qwenproxy.
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/robust-json.ts';

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParserResult {
  /** Text content that is NOT part of a tool call */
  text: string;
  /** Fully parsed tool calls */
  toolCalls: ParsedToolCall[];
}

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private TOOL_START = '<tool_call>';
  private TOOL_END = '</tool_call>';
  private emittedToolCallCount = 0;

  /**
   * Feeds a chunk of text into the parser and returns any extracted text and tool calls.
   */
  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = {
      text: '',
      toolCalls: [],
    };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const startIdx = this.buffer.indexOf(this.TOOL_START);
        if (startIdx !== -1) {
          // Found tool start. Everything before it is text (if no tools emitted yet)
          const textToEmit = this.buffer.substring(0, startIdx);
          if (textToEmit && this.emittedToolCallCount === 0) {
            result.text += textToEmit;
          }
          this.insideTool = true;
          this.buffer = this.buffer.substring(startIdx + this.TOOL_START.length);
        } else {
          // No full start tag. Check for partial match at the end to avoid emitting half a tag
          let flushIndex = this.buffer.length;
          for (let i = 1; i <= this.TOOL_START.length; i++) {
            if (this.buffer.endsWith(this.TOOL_START.substring(0, i))) {
              flushIndex = this.buffer.length - i;
              break;
            }
          }

          const textToEmit = this.buffer.substring(0, flushIndex);
          if (textToEmit && this.emittedToolCallCount === 0) {
            result.text += textToEmit;
          }
          this.buffer = this.buffer.substring(flushIndex);
          break; // Wait for more data
        }
      } else {
        // Inside tool
        const endIdx = this.buffer.indexOf(this.TOOL_END);
        if (endIdx !== -1) {
          const toolJsonStr = this.buffer.substring(0, endIdx).trim();
          try {
            const toolCallObj = robustParseJSON(toolJsonStr);
            if (toolCallObj) {
              const toolId = 'call_' + uuidv4();
              let toolName = toolCallObj.name || '';
              let toolArgs: Record<string, unknown> = {};

              if (toolCallObj.arguments) {
                toolArgs = typeof toolCallObj.arguments === 'string'
                  ? (robustParseJSON(toolCallObj.arguments) ?? {})
                  : toolCallObj.arguments;
              } else {
                const { name, ...rest } = toolCallObj;
                toolArgs = rest;
              }

              result.toolCalls.push({
                id: toolId,
                name: toolName,
                arguments: toolArgs,
              });
              this.emittedToolCallCount++;
            }
          } catch (e) {
            console.warn(`[StreamingToolParser] Parsing failed for: ${toolJsonStr}`, e);
          }

          this.insideTool = false;
          this.buffer = this.buffer.substring(endIdx + this.TOOL_END.length);
        } else {
          // Waiting for TOOL_END, buffer the content
          break;
        }
      }
    }

    return result;
  }

  /**
   * Finalizes the parsing, attempting to extract any remaining content.
   * O buffer é SEMPRE limpo no finally — uma stream abortada/timeout nunca
   * vaza um <tool_call> truncado para a execução seguinte.
   */
  flush(): ParserResult {
    const result: ParserResult = {
      text: '',
      toolCalls: [],
    };

    try {
      if (this.buffer.length > 0) {
        if (this.insideTool) {
          // Try to parse partial tool call
          try {
            const toolCallObj = robustParseJSON(this.buffer);
            if (toolCallObj) {
              const toolId = 'call_' + uuidv4();
              let toolName = toolCallObj.name || '';
              let toolArgs = toolCallObj.arguments || {};
              if (typeof toolArgs === 'string') toolArgs = robustParseJSON(toolArgs) ?? {};
              else if (!toolCallObj.arguments) {
                const { name, ...rest } = toolCallObj;
                toolArgs = rest;
              }

              // Tool call truncada no meio (sem fechar `}` e sem argumentos) é
              // descartada — emitir com args vazios faz o cliente executar a
              // ferramenta com valores inválidos (ex.: Read com file_path ""),
              // e vazar o <tool_call> cru como texto confunde o agente.
              const rawClosed = this.buffer.trim().endsWith('}');
              const hasArgs = Object.keys(toolArgs).length > 0;
              if (rawClosed || hasArgs) {
                result.toolCalls.push({
                  id: toolId,
                  name: toolName,
                  arguments: toolArgs,
                });
                this.emittedToolCallCount++;
              } else {
                console.warn(
                  '[StreamingToolParser] tool call truncada descartada (sem fechamento):',
                  this.buffer.slice(0, 120)
                );
              }
            }
          } catch {
            if (this.emittedToolCallCount === 0) {
              // Fallback defensivo: NUNCA vazar o markup cru de tool; só repassa
              // texto que pareça conteúdo limpo (tags removidas).
              const clean = this.buffer.replace(/<\/?tool_(?:call|result|error)>/g, '').trim();
              if (clean) result.text = clean;
            }
          }
        } else if (this.emittedToolCallCount === 0) {
          result.text = this.buffer;
        }
      }
    } finally {
      this.buffer = '';
    }
    return result;
  }

  /**
   * Reinicia o parser do ZERO (buffer, estado de dentro-de-tool e contador).
   * Chamado ANTES de re-executar após timeout/abort, para que um <tool_call>
   * parcial de uma stream morta não contamine a próxima execução (escudo
   * defensivo contra falhas em cascata).
   */
  reset(): void {
    this.buffer = '';
    this.insideTool = false;
    this.emittedToolCallCount = 0;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }
}
