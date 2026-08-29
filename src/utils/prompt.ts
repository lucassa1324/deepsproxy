/*
 * File: prompt.ts
 * Project: deepsproxy
 * Shared prompt builder: converts an OpenAI-style request (messages + tools)
 * into the plain-text prompt used with the DeepSeek web backend and with local
 * models (Ollama / LM Studio) that lack native tool calling. This is the same
 * mechanism used for agentic tool use (edit files, etc.).
 */

import { OpenAIRequest } from './types.ts';
import { cacheSystemPrompt, getCachedPrompt } from '../services/optimizations.ts';
import { injectHighPrecisionProtocol } from './system-prompt.ts';

export interface PromptOptions {
  /**
   * Booster de modelo fraco: injeta regras duras + exemplo pronto de
   * <tool_call> com uma tool real da requisição. Opt-in por modelo (ver
   * services/booster.ts) — modelos fortes não são afetados.
   */
  booster?: boolean;
}

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

/** Prioridade das tools no bloco: codificação/arquivos primeiro (sobrevivem ao corte de chars). */
const TOOL_PRIORITY: string[] = [
  'Write', 'SearchReplace', 'Edit', 'DeleteFile', 'Read', 'LS', 'Glob', 'Grep',
  'SearchCodebase', 'RunCommand', 'CheckCommandStatus', 'StopCommand', 'Bash',
  'Task', 'Skill', 'run_mcp',
];

function toolPriority(name: string): number {
  const idx = TOOL_PRIORITY.indexOf(name);
  return idx === -1 ? TOOL_PRIORITY.length : idx;
}

/**
 * Minifica o schema: remove as descrições das PROPRIEDADES dos argumentos
 * (mantém tipos e campos obrigatórios). Reduz até ~40% do payload de tools,
 * deixando mais ferramentas visíveis dentro do teto de caracteres.
 */
function minifyParameters(parameters: any): any {
  if (!parameters || typeof parameters !== 'object') return parameters;
  const out: any = { ...parameters };
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]: [string, any]) => {
        if (v && typeof v === 'object') {
          const { description, ...rest } = v;
          return [k, rest];
        }
        return [k, v];
      })
    );
  }
  if (Array.isArray(out.required) && out.required.length === 0) delete out.required;
  return out;
}

/**
 * Monta apenas o bloco de instruções das ferramentas (usado no caminho
 * agentic). Retorna '' quando não há tools.
 *
 * ORDEM IMPORTANTE: o formato do `<tool_call>` + regras + nomes vêm ANTES
 * dos schemas detalhados. Backends com teto de caracteres (ex.: Gemini Web)
 * truncam o bloco pela CABEÇA; se o formato ficasse no fim, o modelo veria
 * as ferramentas mas sem saber COMO chamá-las (e responderia só com texto,
 * narrando que "criou o arquivo" sem criar nada).
 *
 * As tools são REORDENADAS por criticidade (Write/Edit/Read primeiro) e os
 * schemas minificados para caberem no orçamento.
 */
/** Valor de exemplo por tipo de propriedade (usado no few-shot do booster). */
function exampleValue(prop: any): unknown {
  if (!prop || typeof prop !== 'object') return 'example';
  if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum[0];
  if (prop.type === 'array') return [];
  if (prop.type === 'integer' || prop.type === 'number') return 1;
  if (prop.type === 'boolean') return true;
  if (prop.type === 'object') return {};
  return 'example';
}

/** Argumentos de exemplo válidos para o schema de uma tool (máx. 3 campos). */
function buildExampleArguments(schema: any): string {
  const props = schema?.properties || {};
  const keys = Object.keys(props).slice(0, 3);
  if (keys.length === 0) return '{"param_name": "value"}';
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = exampleValue(props[k]);
  return JSON.stringify(obj);
}

/** Bloco de reforço para modelos fracos (booster): regras duras + few-shot. */
function buildBoosterReinforcement(formattedTools: any[]): string {
  const tool = formattedTools[0];
  const exampleName = tool?.name || 'ToolName';
  const exampleArgs = buildExampleArguments(tool?.parameters);
  const exampleBlock = `<tool_call>\n{"name": "${exampleName}", "arguments": ${exampleArgs}}\n</tool_call>`;

  const toolNames = formattedTools.map((t) => t.name).join(', ') || 'the listed tools';

  return (
    `\n\n# WEAK MODEL REINFORCEMENT (CRITICAL)\n` +
    `You are working with tools. This is very important:\n` +
    `1. To COMPLETE the user's task you MUST use the available tools (${toolNames}). Never just describe what you would do.\n` +
    `2. NEVER claim you performed an action (created/edited/read a file, searched the web, ran a command) UNLESS you actually called the tool for it.\n` +
    `3. Your response must be EXACTLY ONE of:\n` +
    `   (a) one or more <tool_call> blocks (and nothing else before/after), or\n` +
    `   (b) a final text answer to the user.\n` +
    `4. After a <tool_call> block, STOP. Do not add text, explanations or notes after it.\n` +
    `5. Worked example (using a real tool from this request):\n` +
    `${exampleBlock}\n` +
    `6. Choose the tool by the action you need: create/write/edit a file -> Write or Edit; read/open a file -> Read; search/find -> search tools; run/execute -> RunCommand/Bash; delete -> DeleteFile; list -> LS; browse a site -> Browser.\n` +
    `7. Keep arguments minimal and exactly as in the schema. If a value contains double quotes (ex. HTML attributes like <html lang="pt-BR">), escape them as \\" so the JSON stays valid.\n` +
    `8. If you are not sure which tool to call, prefer the most specific tool for the action instead of answering from memory.\n\n`
  );
}

export function buildToolsInstructions(body: OpenAIRequest, opts: PromptOptions = {}): string {
  const bodyAny = body as any;
  if (!bodyAny.tools || !Array.isArray(bodyAny.tools) || bodyAny.tools.length === 0) {
    return '';
  }

  const formattedTools = bodyAny.tools
    .map((t: any) => {
      if (t.type === 'function') {
        return {
          name: t.function.name,
          description: t.function.description || '',
          parameters: minifyParameters(t.function.parameters),
        };
      }
      return { name: t.name, description: t.description || '', parameters: minifyParameters(t.parameters) };
    })
    .filter((t: any) => t && t.name)
    .sort((a: any, b: any) => toolPriority(a.name) - toolPriority(b.name));

  const namesList = formattedTools.map((t: any) => `- ${t.name}`).join('\n');
  // Compacto (indent 0) para caber o máximo de schemas no teto de chars.
  const toolsJson = JSON.stringify(formattedTools);

  let instructions =
    `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${namesList}\n\n` +
    `To use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n` +
    `<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\n` +
    `Always respond in the same language as the user's latest message (ex.: user writes in Portuguese -> reply in Portuguese, not English).\n\n` +
    `RULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n` +
    `2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n` +
    `3. The JSON must be valid and accurately follow the tool's parameters.\n` +
    `4. When passing code/HTML inside a JSON string value (ex.: <html lang="pt-BR">), escape the inner double quotes as \\" so the JSON stays valid.\n` +
    `5. Use forward slashes (/) in file_path values (ex.: "C:/Users/nome/arquivo.html"), NEVER backslashes — they break the JSON.\n\n` +
    `Detailed schemas (JSON):\n${toolsJson}\n`;

  if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
    const forcedTool = bodyAny.tool_choice.function.name;
    instructions += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
  }

  if (opts.booster) {
    instructions += buildBoosterReinforcement(formattedTools);
  }

  return instructions;
}

export function buildAgentPrompt(body: OpenAIRequest, opts: PromptOptions = {}): string {
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

  // Inject tools instructions (com cache do system prompt)
  const toolsInstructions = buildToolsInstructions(body, opts);
  if (toolsInstructions) {
    systemPrompt += toolsInstructions;
  }

  // Cache o system prompt parseado (evita reconstruir a cada request)
  if (systemPrompt) {
    const enhancedPrompt = injectHighPrecisionProtocol(systemPrompt);
    const cacheKey = `agent_${body.model || 'default'}`;
    cacheSystemPrompt(cacheKey, enhancedPrompt);
    return `${enhancedPrompt}\n${prompt}`;
  }

  return systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
}

/**
 * Mesma conversão de mensagens para texto, mas achatando TODAS as mensagens do
 * histórico (não só a última). Usado por backends que não mantêm sessão no
 * servidor (ex.: Gemini Web, que abre uma conversa nova por requisição) — o
 * multi-turno só funciona se o histórico completo for reenviado no prompt.
 */
export function buildFullHistoryPrompt(body: OpenAIRequest, opts: PromptOptions = {}): string {
  const messages = body.messages || [];
  let prompt = '';
  let systemPrompt = '';

  for (const msg of messages) {
    const contentStr = messageContentToText(msg.content);

    if (msg.role === 'system') {
      systemPrompt += contentStr + '\n\n';
      continue;
    }

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

  const toolsInstructions = buildToolsInstructions(body, opts);
  if (toolsInstructions) {
    systemPrompt += toolsInstructions;
  }

  // Cache o system prompt parseado
  if (systemPrompt) {
    const enhancedPrompt = injectHighPrecisionProtocol(systemPrompt);
    const cacheKey = `fullhist_${body.model || 'default'}`;
    cacheSystemPrompt(cacheKey, enhancedPrompt);
    return `${enhancedPrompt}\n${prompt}`;
  }

  return systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
}
