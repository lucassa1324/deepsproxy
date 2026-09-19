/*
 * File: types.ts
 * Project: deepsproxy
 * Author: Lucas Sá
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Lucas Sá
 */

import type { JsonSchema, FunctionToolDefinition } from '../tools/types.ts';
export type { JsonSchema, FunctionToolDefinition };

/** Tool choice options */
export type ToolChoice = 'auto' | 'none' | 'required' | {
  type: 'function';
  function: { name: string };
};

// --- Message Types ---

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface MessageToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
  /**
   * Gemini: assinatura de pensamento do functionCall original. Preservada no
   * round-trip para que o histórico reenviado não seja rejeitado pela API
   * (400 "missing thought_signature").
   */
  thought_signature?: string;
}

/** Parte de texto no conteúdo multimodal (formato OpenAI) */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/** Parte de imagem no conteúdo multimodal (formato OpenAI) */
export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
  detail?: string;
}

export type ContentPart = TextContentPart | ImageContentPart;
export type MessageContent = string | null | ContentPart[];

export interface Message {
  role: string;
  content: MessageContent;
  /** Present on assistant messages that invoked tools */
  tool_calls?: MessageToolCall[];
  /** Present on tool/function response messages to link back to a call */
  tool_call_id?: string;
  /** Present on tool/function response messages */
  name?: string;
  /** Reasoning content for thinking models */
  reasoning_content?: string;
}

// --- Request Types ---

export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  /** List of tools available to the LLM */
  tools?: FunctionToolDefinition[];
  /** Control whether the LLM must/can call tools */
  tool_choice?: ToolChoice;
  /** Generation parameters (used by the HTTP adapters) */
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  /** Modo agente nativo: o proxy executa as tools de servidor (ex.: web_search) */
  agent?: boolean;
  /** Habilita prompt caching (Anthropic: cache_control; OpenAI: automático >1024 tokens). Default: true */
  enablePromptCache?: boolean;
  /** Headers extras para provedores específicos (ex.: anthropic-beta para prompt caching) */
  extraHeaders?: Record<string, string>;
}

// --- Response Types ---

export interface ToolCall {
  index: number;
  id?: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
  /** Gemini: thought_signature do functionCall original (ver MessageToolCall). */
  thought_signature?: string;
}

export interface ChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export interface Choice {
  index: number;
  delta?: ChoiceDelta;
  message?: ChoiceDelta;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}
