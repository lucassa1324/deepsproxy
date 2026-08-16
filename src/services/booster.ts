/*
 * File: booster.ts
 * Project: deepsproxy
 * Modo Booster: camada de apoio para modelos "fracos" que se perdem no uso de
 * ferramentas. É um ajuste POR MODELO (lista em `gateway-booster.json`) — só é
 * aplicado nos modelos cadastrados, para não alterar o comportamento dos
 * modelos potentes que já funcionam bem.
 *
 * Ajudas disponíveis (independentes, configuráveis):
 *  - promptReinforcement: injeta regras duras + exemplo pronto de <tool_call>
 *    com uma tool REAL da requisição (reflexo do que o modelo vê no prompt);
 *  - correctiveLoop: no modo agente (agent:true), injeta aviso corretivo quando
 *    um tool_call falha (tool desconhecida, JSON inválido, validação) e dá uma
 *    nova chance em vez de só devolver o texto "narrado";
 *  - tolerantParser: aceita variações de tag e repara JSON de tool calls que os
 *    modelos fracos costumam emitir corrompido (usa robustParseJSON).
 *
 * Atalho: adicionar o modelo especial "*" ativa o booster para TODOS os modelos.
 *
 * Persistência em `gateway-booster.json` (ou o arquivo definido por BOOSTER_FILE),
 * ao lado de `gateway-apps.json` e `gateway-economy.json`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export interface BoosterSettings {
  /** Master: se false, nenhum modelo recebe o booster. */
  enabled: boolean;
  /** Modelos com booster ativo (id exato ou "*" para todos). */
  models: string[];
  /** Injeta regras + exemplo de <tool_call> no prompt de ferramentas. */
  promptReinforcement: boolean;
  /** Corrige tool calls que falharam no loop agêntico. */
  correctiveLoop: boolean;
  /** Parser tolerante para JSON de tool calls corrompidos. */
  tolerantParser: boolean;
}

export const DEFAULT_BOOSTER: BoosterSettings = {
  enabled: true,
  models: [],
  promptReinforcement: true,
  correctiveLoop: true,
  tolerantParser: true,
};

/** Modelo curinga: booster ativo para qualquer modelo. */
export const BOOSTER_WILDCARD = '*';

function boosterFile(): string {
  return process.env.BOOSTER_FILE || join(process.cwd(), 'gateway-booster.json');
}

let boosterCache: BoosterSettings | null = null;

function sanitizeBool(v: any, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function sanitizeModels(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((m) => String(m).trim()).filter(Boolean))];
}

function loadBooster(): BoosterSettings {
  if (boosterCache) return boosterCache;
  try {
    const file = boosterFile();
    if (!existsSync(file)) {
      boosterCache = { ...DEFAULT_BOOSTER };
      return boosterCache;
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    boosterCache = {
      enabled: sanitizeBool(raw.enabled, DEFAULT_BOOSTER.enabled),
      models: sanitizeModels(raw.models),
      promptReinforcement: sanitizeBool(raw.promptReinforcement, DEFAULT_BOOSTER.promptReinforcement),
      correctiveLoop: sanitizeBool(raw.correctiveLoop, DEFAULT_BOOSTER.correctiveLoop),
      tolerantParser: sanitizeBool(raw.tolerantParser, DEFAULT_BOOSTER.tolerantParser),
    };
  } catch {
    boosterCache = { ...DEFAULT_BOOSTER };
  }
  return boosterCache ?? { ...DEFAULT_BOOSTER };
}

function persistBooster(): void {
  try {
    const file = boosterFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(boosterCache ?? DEFAULT_BOOSTER, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[booster] falha ao persistir em ${boosterFile()}:`, err.message);
  }
}

/** Invalida o cache em memória (usado em testes). */
export function resetBoosterCache(): void {
  boosterCache = null;
}

/** Configuração atual do booster (cópia). */
export function getBoosterSettings(): BoosterSettings {
  const s = loadBooster();
  return { enabled: s.enabled, models: [...s.models], promptReinforcement: s.promptReinforcement, correctiveLoop: s.correctiveLoop, tolerantParser: s.tolerantParser };
}

/** Atualiza (parcialmente) e persiste a configuração do booster. */
export function updateBoosterSettings(patch: Partial<BoosterSettings>): BoosterSettings {
  const current = loadBooster();
  const next: BoosterSettings = {
    enabled: sanitizeBool(patch.enabled, current.enabled),
    models: patch.models !== undefined ? sanitizeModels(patch.models) : [...current.models],
    promptReinforcement: sanitizeBool(patch.promptReinforcement, current.promptReinforcement),
    correctiveLoop: sanitizeBool(patch.correctiveLoop, current.correctiveLoop),
    tolerantParser: sanitizeBool(patch.tolerantParser, current.tolerantParser),
  };
  boosterCache = next;
  persistBooster();
  return getBoosterSettings();
}

/** Liga/desliga o booster de um modelo específico (id ou "*"). */
export function toggleModelBooster(modelId: string, on: boolean): BoosterSettings {
  const current = loadBooster();
  const id = String(modelId || '').trim();
  if (!id) return getBoosterSettings();
  const set = new Set(current.models);
  if (on) set.add(id);
  else set.delete(id);
  return updateBoosterSettings({ models: [...set] });
}

/**
 * True quando o booster está ativo para o modelo. Respeita o master `enabled`
 * e o curinga "*". Comparação é insensível a maiúsculas/minúsculas.
 */
export function isModelBoosted(modelId: string): boolean {
  const s = loadBooster();
  if (!s.enabled) return false;
  const id = String(modelId || '').trim();
  if (!id) return false;
  const lower = id.toLowerCase();
  if (s.models.includes(BOOSTER_WILDCARD)) return true;
  return s.models.some((m) => m.trim().toLowerCase() === lower);
}
