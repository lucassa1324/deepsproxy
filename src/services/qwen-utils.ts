/*
 * File: qwen-utils.ts
 * Project: deepsproxy
 * Classificação de modelos (visão, programação, matemática, chat) usada no
 * dashboard e na UI (select de modelos do chat, chips, header).
 *
 * A heurística foi validada em scripts/playground/qwen-classify.ts. Fica num
 * módulo separado para evitar dependência circular qwen.ts <-> dashboard.ts.
 */

export const CATEGORY_LABELS: Record<string, string> = {
  'visao': 'Visão',
  'programacao': 'Programação',
  'matematica': 'Matemática',
  'chat': 'Chat',
};

/** Ordem das categorias na UI (select agrupado, chips). */
export const CATEGORY_ORDER = ['visao', 'programacao', 'matematica', 'chat'];

/** Classifica um id de modelo em uma categoria (heurística por nome + meta). */
export function classifyQwenModel(id: string, meta?: any): string {
  const m = String(id || '').toLowerCase().replace('-no-thinking', '');
  if (m.includes('coder')) return 'programacao';
  if (m.includes('math')) return 'matematica';
  if (m.includes('vl') || m.includes('vision') || m.includes('omni')) return 'visao';
  const caps = meta?.capabilities || {};
  if (caps.vision) return 'visao';
  if ((meta?.modality || []).includes('image')) return 'visao';
  return 'chat';
}

/** Rótulo amigável de uma categoria. */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category || 'Chat';
}

/** Lista de capacidades (rótulos) de um modelo. */
export function capabilitiesOf(id: string, meta?: any): string[] {
  const m = String(id || '').toLowerCase();
  const caps: string[] = [];
  if (m.includes('-no-thinking')) caps.push('no-thinking');
  else caps.push('thinking');
  if (m.includes('coder')) caps.push('codigo');
  if (m.includes('math')) caps.push('matematica');
  if (meta) {
    const capsMeta = meta.capabilities || {};
    const modality = meta.modality || [];
    if (capsMeta.vision || modality.includes('image')) caps.push('imagem');
    if (capsMeta.video || modality.includes('video')) caps.push('video');
    if (capsMeta.audio || modality.includes('audio')) caps.push('audio');
    if (capsMeta.search) caps.push('busca');
  }
  return caps;
}

/**
 * Enriquece um modelo com category/category_label/capabilities. Idempotente:
 * se o modelo já tiver `category`/`capabilities`, mantém os valores. Garante
 * que todo modelo retornado nas APIs tenha a classificação para a UI.
 */
export function enrichModel(m: any): any {
  if (!m || typeof m !== 'object') return m;
  const meta = m.meta || m.info?.meta;
  const id = String(m.id || '');
  const category = m.category || classifyQwenModel(id, meta);
  return {
    ...m,
    category,
    category_label: m.category_label || categoryLabel(category),
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : capabilitiesOf(id, meta),
  };
}
