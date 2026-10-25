/*
 * File: usage.ts
 * Project: deepsproxy
 * Endpoints REST do painel de Uso & Métricas (alimentam a UI e os relatórios):
 *  - GET /api/usage/summary?period=24h|7d|30d|all  — métricas consolidadas
 *  - GET /api/usage/models?period=...&limit=15     — ranking de modelos
 *  - GET /api/usage/advanced?period=...            — consumo/cotas por modelo + dados avançados
 *  - GET /api/usage/export?format=csv|json&period=... — download do relatório
 */

import { Hono } from 'hono';
import {
  computeAdvancedUsage,
  computeModelRanking,
  computeSummary,
  getUsageByAccount,
  getUsageRecords,
  periodToSince,
  recordsToCsv,
} from '../services/usage.ts';
import { resolveRegistry } from '../services/config.ts';

const KNOWN_PERIODS = new Set(['24h', '7d', '30d', 'all']);

function normalizePeriod(raw: string | undefined): string {
  const p = String(raw || 'all').toLowerCase();
  return KNOWN_PERIODS.has(p) ? p : 'all';
}

export const usageRoutes = new Hono();

/** Métricas consolidadas do período. */
usageRoutes.get('/api/usage/summary', (c) => {
  const period = normalizePeriod(c.req.query('period'));
  return c.json(computeSummary(period));
});

/** Consumo por conta/chave de API (inventário + telemetria + status de cota). */
usageRoutes.get('/api/usage/accounts', (c) => {
  const period = normalizePeriod(c.req.query('period'));
  const registry = resolveRegistry(c.req.header('Cookie'));
  return c.json({ success: true, period, accounts: getUsageByAccount(period, registry) });
});

/** Ranking dos modelos mais usados no período. */
usageRoutes.get('/api/usage/models', (c) => {
  const period = normalizePeriod(c.req.query('period'));
  const limit = parseInt(String(c.req.query('limit') || '15'), 10);
  return c.json({
    period,
    since: periodToSince(period).since,
    models: computeModelRanking(period, Number.isFinite(limit) ? limit : 15),
  });
});

/** Relatório avançado: consumo/cotas por modelo, timeline, failovers e trackers. */
usageRoutes.get('/api/usage/advanced', (c) => {
  const period = normalizePeriod(c.req.query('period'));
  return c.json(computeAdvancedUsage(period));
});

/**
 * Últimas requisições (rastreabilidade Pedido → Final → Provedor), a partir
 * dos registros brutos mais recentes.
 */
usageRoutes.get('/api/usage/recent', (c) => {
  const limitRaw = parseInt(String(c.req.query('limit') || '12'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 12;
  const records = getUsageRecords('all').slice(-limit);
  return c.json({ records: records.reverse() });
});

/** Exportação do relatório (CSV ou JSON) com conteúdo bruto do período. */
usageRoutes.get('/api/usage/export', (c) => {
  const period = normalizePeriod(c.req.query('period'));
  const format = String(c.req.query('format') || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
  const list = getUsageRecords(period);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (format === 'json') {
    const body = JSON.stringify({ generatedAt: new Date().toISOString(), period, records: list }, null, 2);
    return c.body(body, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="deepsproxy-uso-${period}-${stamp}.json"`,
    });
  }
  const csv = recordsToCsv(list);
  return c.body('\ufeff' + csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="deepsproxy-uso-${period}-${stamp}.csv"`,
  });
});
