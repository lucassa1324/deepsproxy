/*
 * File: compression.ts
 * Project: deepsproxy
 * Engines de compressão adicionais do modo economia, portadas do freellmapi
 * (server/src/services/compression/) e adaptadas às mensagens OpenAI do
 * deepsproxy — SEM dependências externas (nada de zod).
 *
 * Engines portadas:
 *  - applyWhitespaceHygiene  ('lite'): higiene de whitespace sem perda
 *    (trailing spaces, 3+ quebras de linha, system duplicados exatos).
 *  - applyJsonCompact         ('jsoncompact'): tabelas JSON repetidas em
 *    tool results codificadas como [[json-table]] (lossless).
 *  - applyToolNoiseFilter     ('toolfilter'): remove linhas de ruído de
 *    output de ferramentas (git status/commit hints, progressos de test,
 *    ANSI, runs duplicadas) preservando erros/código (lossy).
 *  - applyOlderTurnCondensing ('aging'): condensa turnos antigos de
 *    user/assistant num digest de intenção (lossy).
 *
 * Os helpers de preservação (scanProtectedSpans / transformUnprotectedText)
 * garantem que URLs, paths, números, código-fenceado, key=value etc. nunca
 * sejam danificados pelas transformações de whitespace.
 */

/* ------------------------- Preservação de spans ------------------------- */

export type ProtectedKind =
  | 'fenced-code'
  | 'inline-code'
  | 'url'
  | 'path'
  | 'json-key'
  | 'number'
  | 'stack-trace'
  | 'diff-hunk'
  | 'key-value'
  | 'error'
  | 'constraint';

export interface ProtectedSpan {
  start: number;
  end: number;
  text: string;
  kinds: ProtectedKind[];
}

const RULES: Array<{ kind: ProtectedKind; regex: RegExp }> = [
  { kind: 'fenced-code', regex: /```[\s\S]*?```/g },
  { kind: 'inline-code', regex: /`[^`\n]+`/g },
  { kind: 'url', regex: /\bhttps?:\/\/[^\s<>()]+/gi },
  {
    kind: 'path',
    regex:
      /(?:\b[A-Za-z]:\\(?:[^\\\s:"<>|?*]+\\)*[^\\\s:"<>|?*]*|\B~?\/(?:[\w.@%+~=-]+\/)*[\w.@%+~=-]+|\B\.{1,2}\/(?:[\w.@%+~=-]+\/)*[\w.@%+~=-]+)/g,
  },
  { kind: 'json-key', regex: /"(?:\\.|[^"\\])+"\s*:/g },
  { kind: 'number', regex: /(?<![\w])[-+]?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(?![\w])/g },
  { kind: 'stack-trace', regex: /^\s*at\s+.+$/gm },
  { kind: 'diff-hunk', regex: /^@@[^\n]*@@[^\n]*$/gm },
  { kind: 'key-value', regex: /\b[A-Za-z_][A-Za-z0-9_.-]*=(?:"[^"]*"|'[^']*'|[^\s]+)/g },
  { kind: 'error', regex: /^.*\b(?:error|exception|fatal|failed|failure|traceback|panic)\b.*$/gim },
  {
    kind: 'constraint',
    regex:
      /^.*\b(?:must(?:\s+not)?|do\s+not|don't|never|always|require(?:d|ment|ments)?|constraint|important|warning|security|permission|authorization|forbidden|prohibited)\b.*$/gim,
  },
];

function mergeProtectedSpans(spans: ProtectedSpan[]): ProtectedSpan[] {
  const ordered = spans
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: ProtectedSpan[] = [];
  for (const s of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || s.start > previous.end) {
      merged.push({ ...s, kinds: [...new Set(s.kinds)] });
      continue;
    }
    previous.end = Math.max(previous.end, s.end);
    previous.kinds = [...new Set([...previous.kinds, ...s.kinds])];
  }
  return merged;
}

function scanProtectedSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      if (match.index == null || !match[0]) continue;
      spans.push({ start: match.index, end: match.index + match[0].length, text: match[0], kinds: [rule.kind] });
    }
  }
  return mergeProtectedSpans(spans).map((s) => ({ ...s, text: text.slice(s.start, s.end) }));
}

function transformUnprotectedText(text: string, transform: (part: string) => string): string {
  const spans = scanProtectedSpans(text);
  if (spans.length === 0) return transform(text);
  const placeholders: string[] = [];
  let masked = '';
  let cursor = 0;
  spans.forEach((span, index) => {
    const placeholder = `\uE000${index.toString(36)}\uE001`;
    placeholders.push(text.slice(span.start, span.end));
    masked += text.slice(cursor, span.start);
    masked += placeholder;
    cursor = span.end;
  });
  masked += text.slice(cursor);
  return transform(masked).replace(
    /\uE000([0-9a-z]+)\uE001/g,
    (match, index: string) => placeholders[Number.parseInt(index, 36)] ?? match
  );
}

function hasProtectedSpan(text: string): boolean {
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) return true;
  }
  return false;
}

/* ------------------------- Helpers locais ------------------------- */

function textContent(msg: any): string | null {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''));
    return parts.join('');
  }
  return null;
}

function withTextContent(msg: any, content: string): any {
  return { ...msg, content };
}

/* ------------------------- Engine 1: lite (whitespace) ------------------------- */

export function applyWhitespaceHygiene(
  messages: any[]
): { messages: any[]; changed: boolean; duplicateSystemMessages: number } {
  const seenSystem = new Set<string>();
  let duplicateSystemMessages = 0;
  let changed = false;
  const output = (messages || []).flatMap((message) => {
    const content = textContent(message);
    if (content == null) return [message];
    if (message.role === 'system') {
      if (seenSystem.has(content)) {
        duplicateSystemMessages += 1;
        changed = true;
        return [];
      }
      seenSystem.add(content);
    }
    const next = transformUnprotectedText(content, (part) =>
      part.replace(/[ \t]+$/gm, '').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    );
    if (next !== content) changed = true;
    return [next === content ? message : withTextContent(message, next)];
  });
  return { messages: output, changed, duplicateSystemMessages };
}

/* ------------------------- Engine 2: jsoncompact ------------------------- */

const JSON_TABLE_HEADER_RE =
  /\[\[json-table:v1 columns=(\[[^\n]+\]) rows=(\d+)\]\]\n([\s\S]*?)\n\[\[\/json-table\]\]/g;

function uniformKeys(value: unknown, minRows: number): { rows: Record<string, unknown>[]; keys: string[] } | null {
  if (!Array.isArray(value) || value.length < minRows) return null;
  if (!value.every((row) => row != null && typeof row === 'object' && !Array.isArray(row))) return null;
  const rows = value as Record<string, unknown>[];
  const keys = Object.keys(rows[0]);
  if (keys.length === 0) return null;
  const signature = [...keys].sort().join('\u0000');
  if (!rows.every((row) => Object.keys(row).length === keys.length && [...Object.keys(row)].sort().join('\u0000') === signature)) {
    return null;
  }
  return { rows, keys };
}

function encodeJsonTable(value: unknown, minRows = 8): string | null {
  const table = uniformKeys(value, minRows);
  if (!table) return null;
  const body = table.rows.map((row) => JSON.stringify(table.keys.map((key) => row[key]))).join('\n');
  return `[[json-table:v1 columns=${JSON.stringify(table.keys)} rows=${table.rows.length}]]\n${body}\n[[/json-table]]`;
}

function decodeJsonTables(text: string): string {
  return text.replace(JSON_TABLE_HEADER_RE, (full, rawColumns: string, rawCount: string, rawRows: string) => {
    try {
      const columns = JSON.parse(rawColumns) as string[];
      const rows = rawRows
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown[]);
      if (rows.length !== Number(rawCount) || !rows.every((row) => row.length === columns.length)) return full;
      return JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))));
    } catch {
      return full;
    }
  });
}

function jsonArrayCandidates(text: string): Array<{ start: number; end: number; value: unknown }> {
  const spans: Array<{ start: number; end: number }> = [];
  const stack: Array<{ opener: '[' | '{'; start: number }> = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && stack.length > 0) {
      inString = true;
      continue;
    }
    if (char === '[' || char === '{') {
      stack.push({ opener: char, start: index });
      continue;
    }
    if (char !== ']' && char !== '}') continue;

    const expected = char === ']' ? '[' : '{';
    const opened = stack.pop();
    if (!opened || opened.opener !== expected) {
      stack.length = 0;
      continue;
    }
    if (opened.opener === '[') spans.push({ start: opened.start, end: index + 1 });
  }

  // Candidadtos maiores primeiro (tabela externa vence arrays aninhados). O
  // budget de parse evita trabalho quadrático em texto patológico.
  spans.sort((a, b) => b.end - b.start - (a.end - a.start));
  const candidates: Array<{ start: number; end: number; value: unknown }> = [];
  const parseCharBudget = Math.max(text.length * 4, 100_000);
  let parsedChars = 0;
  for (const span of spans) {
    const size = span.end - span.start;
    if (candidates.length >= 512 || parsedChars + size > parseCharBudget) break;
    parsedChars += size;
    try {
      candidates.push({ ...span, value: JSON.parse(text.slice(span.start, span.end)) });
    } catch {
      // balanceado estruturalmente não é necessariamente JSON válido.
    }
  }
  return candidates;
}

function compactText(text: string, minRows: number): { text: string; tables: number } {
  const candidates = jsonArrayCandidates(text);
  let output = text;
  let tables = 0;
  const used: Array<{ start: number; end: number }> = [];
  for (const candidate of candidates) {
    if (used.some((range) => candidate.start < range.end && candidate.end > range.start)) continue;
    const encoded = encodeJsonTable(candidate.value, minRows);
    const original = text.slice(candidate.start, candidate.end);
    if (!encoded || encoded.length >= original.length) continue;
    used.push({ start: candidate.start, end: candidate.end });
    tables += 1;
  }
  for (const range of used.sort((a, b) => b.start - a.start)) {
    const candidate = candidates.find((item) => item.start === range.start && item.end === range.end)!;
    output =
      output.slice(0, range.start) + encodeJsonTable(candidate.value, minRows)! + output.slice(range.end);
  }
  return { text: output, tables };
}

export function applyJsonCompact(
  messages: any[],
  minRows = 8
): { messages: any[]; tables: number; changed: boolean } {
  let tables = 0;
  let changed = false;
  const output = (messages || []).map((message) => {
    const content = textContent(message);
    if (message?.role !== 'tool' || content == null) return message;
    const compacted = compactText(content, minRows);
    tables += compacted.tables;
    if (compacted.text !== content) {
      changed = true;
      return withTextContent(message, compacted.text);
    }
    return message;
  });
  return { messages: output, tables, changed };
}

/* ------------------------- Engine 3: toolfilter ------------------------- */

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
export const ERROR_GUARD_RE = /\b(?:error|exception|fatal|failed|failure|traceback|panic|assert(?:ion)?|not ok|✗|×)\b/i;

interface ToolFilterRule {
  id: string;
  version: number;
  detect: { toolNames: string[]; content: string[] };
  stripAnsi: boolean;
  dropLines: Array<{ pattern: string; unless?: string }>;
  keepLines: string[];
  collapseRuns?: { min: number };
  headTail: boolean;
  maxChars?: number;
}

const COMMON = { version: 1, stripAnsi: true, keepLines: [], collapseRuns: { min: 3 }, headTail: true };

export const BUILTIN_FILTERS: ToolFilterRule[] = [
  { ...COMMON, id: 'git-status', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^On branch ', '^Changes (?:not staged|to be committed):'] }, dropLines: [{ pattern: '^\\s*\\(use "git .+" to .+\\)\\s*$' }] },
  { ...COMMON, id: 'git-log', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^(?:commit [0-9a-f]{7,40}|[0-9a-f]{7,40} )'] }, dropLines: [{ pattern: '^Author:\\s' }, { pattern: '^Date:\\s' }] },
  { ...COMMON, id: 'git-diff', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^diff --git ', '^@@'] }, dropLines: [] },
  { ...COMMON, id: 'package-install', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:npm|pnpm|yarn) (?:warn|notice|info)', 'packages? (?:added|audited)'] }, dropLines: [{ pattern: '^(?:npm notice|Progress: resolved|Downloading)\\b' }] },
  { ...COMMON, id: 'vitest-jest', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:vitest|jest|Test Files|Tests:)'] }, dropLines: [{ pattern: '^\\s*[✓✔]\\s.*\\([\\d.]+m?s\\)\\s*$' }] },
  { ...COMMON, id: 'pytest', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:pytest|test session starts|short test summary info)'] }, dropLines: [{ pattern: '^collecting \\.+' }] },
  { ...COMMON, id: 'go-test', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^(?:ok|\\?)\\s+\\S+\\s+[\\d.]+s$', '^--- (?:PASS|FAIL):'] }, dropLines: [{ pattern: '^=== RUN\\s' }] },
  { ...COMMON, id: 'cargo', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^\\s*(?:Compiling|Checking|Finished)\\s', 'running \\d+ tests'] }, dropLines: [{ pattern: '^\\s*(?:Compiling|Checking)\\s' }] },
  { ...COMMON, id: 'tsc', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['error TS\\d+:', 'Found \\d+ errors?'] }, dropLines: [] },
  { ...COMMON, id: 'lint', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:eslint|biome|problems? \\()'] }, dropLines: [{ pattern: '^\\s*ℹ\\s' }] },
  { ...COMMON, id: 'build', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:vite|webpack|built in|modules transformed)'] }, dropLines: [{ pattern: '^transforming\\.\\.\\.' }, { pattern: '^rendering chunks\\.\\.\\.' }] },
  { ...COMMON, id: 'docker', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^#\\d+ \\[', '^CONTAINER ID\\s'] }, dropLines: [{ pattern: '^#\\d+ (?:CACHED|DONE)' }] },
  { ...COMMON, id: 'file-list', detect: { toolNames: ['bash', 'shell', 'run_command', 'glob', 'list_files'], content: ['^(?:\\.?\\.?\\/)?[\\w.-]+\\/(?:[\\w.-]+\\/)*[\\w.-]+$'] }, dropLines: [] },
  { ...COMMON, id: 'search', detect: { toolNames: ['grep', 'rg', 'search', 'bash', 'shell', 'run_command'], content: ['^[^\\n:]+:\\d+:'] }, dropLines: [] },
  { ...COMMON, id: 'json-dump', detect: { toolNames: [], content: ['^\\s*[\\[{][\\s\\S]*[\\]}]\\s*$'] }, dropLines: [] },
  { ...COMMON, id: 'stack-trace', detect: { toolNames: [], content: ['(?:Traceback \\(most recent call last\\)|^\\s*at\\s+\\S+)'] }, dropLines: [], headTail: false },
  { ...COMMON, id: 'fallback', detect: { toolNames: [], content: [] }, dropLines: [] },
];

function safeRegex(source: string, flags = 'i'): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function matches(rule: ToolFilterRule, content: string, toolName?: string): boolean {
  if (rule.id === 'fallback') return true;
  const name = toolName?.toLowerCase();
  if (name && rule.detect.toolNames.some((candidate) => candidate.toLowerCase() === name)) {
    if (rule.detect.content.length === 0) return true;
    // Ferramentas shell genéricas ainda precisam da detecção por conteúdo.
  }
  return rule.detect.content.some((pattern) => safeRegex(pattern, 'im')?.test(content));
}

function rawMustKeep(line: string): boolean {
  return ERROR_GUARD_RE.test(line) || hasProtectedSpan(line);
}

function mustKeep(line: string, cache: Map<string, boolean>): boolean {
  const cached = cache.get(line);
  if (cached !== undefined) return cached;
  const result = rawMustKeep(line);
  cache.set(line, result);
  return result;
}

function collapseRuns(lines: string[], minimum: number, cache: Map<string, boolean>): string[] {
  const output: string[] = [];
  for (let index = 0; index < lines.length; ) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    if (count >= minimum && !mustKeep(lines[index], cache)) {
      output.push(lines[index], `[… ${count - 2} identical lines omitted …]`, lines[end - 1]);
    } else {
      output.push(...lines.slice(index, end));
    }
    index = end;
  }
  return output;
}

function selectHeadTail(lines: string[], head: number, tail: number, cache: Map<string, boolean>): string[] {
  if (lines.length <= head + tail) return lines;
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(head, lines.length); index += 1) selected.add(index);
  for (let index = Math.max(0, lines.length - tail); index < lines.length; index += 1) selected.add(index);
  lines.forEach((line, index) => {
    if (mustKeep(line, cache)) selected.add(index);
  });
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (selected.has(index)) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && !selected.has(index)) index += 1;
    output.push(`[… ${index - start} lines omitted …]`);
  }
  return output;
}

const OMISSION_MARKER_RE = /^\[… \d+ (?:lines|identical lines) omitted …\]$/;

function enforceMaxChars(lines: string[], maxChars: number, cache: Map<string, boolean>): string[] {
  let total = lines.reduce((sum, line) => sum + line.length + 1, -1);
  if (lines.length <= 2 || total <= maxChars) return lines;
  const middle = (lines.length - 1) / 2;
  const removable = lines
    .map((line, index) => ({ line, index, distance: Math.abs(index - middle) }))
    .filter(({ line }) => !mustKeep(line, cache) && !OMISSION_MARKER_RE.test(line))
    .sort((a, b) => a.distance - b.distance);
  const removed = new Set<number>();
  for (const { line, index } of removable) {
    if (total <= maxChars || lines.length - removed.size <= 2) break;
    removed.add(index);
    total -= line.length + 1;
  }
  if (removed.size === 0) return lines;
  return lines.filter((_line, index) => !removed.has(index));
}

function applyRule(content: string, rule: ToolFilterRule): string {
  const cache = new Map<string, boolean>();
  let lines = (rule.stripAnsi ? content.replace(ANSI_RE, '') : content).split('\n');
  const dropPatterns = rule.dropLines
    .map((d) => ({ pattern: safeRegex(d.pattern), unless: d.unless ? safeRegex(d.unless) : null }))
    .filter((d): d is { pattern: RegExp; unless: RegExp | null } => d.pattern != null);
  const keepPatterns = rule.keepLines.map((p) => safeRegex(p)).filter((p): p is RegExp => p != null);
  lines = lines.filter((line) => {
    if (mustKeep(line, cache)) return true;
    for (const drop of dropPatterns) {
      if (!drop.pattern.test(line)) continue;
      if (!drop.unless || !drop.unless.test(line)) return false;
    }
    if (rule.keepLines.length > 0) {
      return keepPatterns.some((pattern) => pattern.test(line));
    }
    return true;
  });
  if (rule.collapseRuns) lines = collapseRuns(lines, rule.collapseRuns.min, cache);
  if (rule.headTail && lines.length > 120) {
    lines = selectHeadTail(lines, 30, 20, cache);
  }
  lines = enforceMaxChars(lines, Math.min(12000, rule.maxChars ?? Infinity), cache);
  return lines.join('\n');
}

/** Aplica os filtros de ruído em tool results. Retorna as mensagens alteradas
 *  e quais filtros foram aplicados (id -> quantidade). */
export function applyToolNoiseFilter(
  messages: any[]
): { messages: any[]; filtersApplied: Record<string, number>; changed: boolean } {
  const filtersApplied: Record<string, number> = {};
  let changed = false;

  // Mapeia tool_call_id -> nome da função olhando os tool_calls de mensagens
  // assistant (mesmo protocolo do freellmapi: buildToolCallOrigins).
  const origins = new Map<string, string>();
  for (const m of messages || []) {
    if (!m?.tool_calls || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      if (call?.id && call?.function?.name) origins.set(call.id, call.function.name);
    }
  }

  const output = (messages || []).map((message) => {
    const content = textContent(message);
    if (message?.role !== 'tool' || content == null) return message;
    const origin = message.tool_call_id ? origins.get(message.tool_call_id) : undefined;
    const rule = BUILTIN_FILTERS.find((candidate) => matches(candidate, content, origin));
    if (!rule) return message;
    const next = applyRule(content, rule);
    if (next.length >= content.length) return message;
    filtersApplied[rule.id] = (filtersApplied[rule.id] ?? 0) + 1;
    changed = true;
    return withTextContent(message, next);
  });

  return { messages: output, filtersApplied, changed };
}

/* ------------------------- Engine 4: aging (turnos antigos) ------------------------- */

function condenseTurn(text: string): string {
  const lines = text.split('\n');
  const intent = lines.filter((line) => /\b(?:need|want|must|should|decid|implement|fix|change|because)\b/i.test(line)).slice(0, 4);
  const protectedValues = [...new Set(scanProtectedSpans(text).map((s) => s.text))];
  const lead = lines.find((line) => line.trim())?.trim().slice(0, 240) ?? '';
  const pieces = [...new Set([lead, ...intent.map((line) => line.trim()), ...protectedValues].filter(Boolean))];
  return `[compressed older turn]\n${pieces.join('\n')}`;
}

/** Condensa turnos antigos (user/assistant) além de condenseAfterTurns num
 *  digest de intenção. liveTurns = nº de turnos de usuário vivos ao final. */
export function applyOlderTurnCondensing(
  messages: any[],
  liveTurns = 3,
  condenseAfterTurns = 8
): { messages: any[]; condensed: number; changed: boolean } {
  const condenseAfter = Math.max(liveTurns + 1, condenseAfterTurns);
  let distance = 0;
  const distances = new Array<number>(messages?.length ?? 0);
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    distances[index] = distance;
    if (messages?.[index]?.role === 'user') distance += 1;
  }
  let condensed = 0;
  let changed = false;
  const output = (messages || []).map((message, index) => {
    const content = textContent(message);
    if (
      content == null ||
      message.role === 'system' ||
      message.role === 'tool' ||
      message.tool_calls?.length ||
      distances[index] < condenseAfter
    ) {
      return message;
    }
    const next = condenseTurn(content);
    if (next.length >= content.length) return message;
    condensed += 1;
    changed = true;
    return withTextContent(message, next);
  });
  return { messages: output, condensed, changed };
}