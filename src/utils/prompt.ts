/*
 * File: prompt.ts
 * Project: deepsproxy
 * Shared prompt builder: converts an OpenAI-style request (messages + tools)
 * into the plain-text prompt used with the DeepSeek web backend and with local
 * models (Ollama / LM Studio) that lack native tool calling. This is the same
 * mechanism used for agentic tool use (edit files, etc.).
 */

import { OpenAIRequest } from './types.ts';

/**
 * Converte uma parte de conteúdo (formato OpenAI) em texto simples.
 * Partes de imagem viram um marcador: o backend DeepSeek (web) não recebe
 * imagens, então o modelo sabe que há uma imagem anexada mesmo sem vê-la.
 */
export function contentPartToText(c: any): string {
  if (!c || typeof c !== 'object') return String(c ?? '');
  if (c.type === 'image_url') {
    const url = typeof c.image_url?.url === 'string' ? c.image_url.url : '';
    if (url.startsWith('data:')) return '[imagem anexada]';
    return `[imagem: ${url}]`;
  }
  return c.text || JSON.stringify(c);
}

function messageContentToText(content: any): string {
  if (Array.isArray(content)) {
    return content.map(contentPartToText).join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return content || '';
}

/**
 * Monta apenas o bloco de instruções das ferramentas (usado no caminho
 * agentic). Retorna '' quando não há tools.
 */
export function buildToolsInstructions(body: OpenAIRequest): string {
  const bodyAny = body as any;
  if (!bodyAny.tools || !Array.isArray(bodyAny.tools) || bodyAny.tools.length === 0) {
    return '';
  }

  const formattedTools = bodyAny.tools.map((t: any) => {
    if (t.type === 'function') {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters,
      };
    }
    return t;
  });
  const toolsJson = JSON.stringify(formattedTools, null, 2);

  let instructions = `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n\n`;

  if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
    const forcedTool = bodyAny.tool_choice.function.name;
    instructions += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
  }

  return instructions;
}

export function buildAgentPrompt(body: OpenAIRequest): string {
  const messages = body.messages || [];
  let prompt = '';
  let systemPrompt = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const contentStr = messageContentToText(msg.content);

    if (msg.role === 'system') {
      systemPrompt += contentStr + '\n\n';
    } else if (i === messages.length - 1) {
      if (msg.role === 'user') {
        prompt += `User: ${contentStr}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr;
        if ((msg as any).reasoning_content) {
          assistantContent = `<think>\n${(msg as any).reasoning_content}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let args = tc.function?.arguments || '{}';
            if (typeof args !== 'string') args = JSON.stringify(args);
            assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
          }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        prompt += `Tool Response (${msg.name || 'tool'}): ${contentStr}\n\n`;
      }
    }
  }

  // Inject tools instructions
  const toolsInstructions = buildToolsInstructions(body);
  if (toolsInstructions) {
    systemPrompt += toolsInstructions;
  }

  return systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
}
