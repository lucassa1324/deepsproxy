import { randomUUID } from 'node:crypto';

export type DebugEventType =
  | 'request:start'
  | 'router:decision'
  | 'orchestrator:decision'
  | 'provider:attempt'
  | 'provider:success'
  | 'provider:error'
  | 'rotation:used'
  | 'request:end';

export interface DebugEvent {
  id: string;
  ts: number;
  type: DebugEventType;
  requestId?: string;
  appId?: string | null;
  appName?: string | null;
  port?: number | string | null;
  path?: string;
  method?: string;
  modelRequested?: string | null;
  modelSelected?: string | null;
  provider?: string | null;
  keyId?: string | null;
  keyLabel?: string | null;
  strategy?: string | null;
  reason?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  errorClass?: string | null;
  attempt?: number | null;
  usedOrchestrator?: boolean | null;
  activity?: string | null;
  details?: Record<string, any>;
}

export interface DebugSession {
  id: string;
  startedAt: number;
  stoppedAt?: number | null;
  running: boolean;
  events: DebugEvent[];
  meta?: Record<string, any>;
}

class DebugSessionStore {
  private session: DebugSession | null = null;

  start(meta?: Record<string, any>): DebugSession {
    const id = randomUUID();
    this.session = {
      id,
      startedAt: Date.now(),
      stoppedAt: null,
      running: true,
      events: [],
      meta: meta || {},
    };
    return this.session;
  }

  stop(): DebugSession | null {
    if (!this.session) return null;
    this.session.running = false;
    this.session.stoppedAt = Date.now();
    return this.session;
  }

  clear(): void {
    this.session = null;
  }

  isRunning(): boolean {
    return !!(this.session && this.session.running);
  }

  getSession(): DebugSession | null {
    return this.session;
  }

  record(ev: Partial<DebugEvent> & { type: DebugEventType }): DebugEvent | null {
    if (!this.session || !this.session.running) return null;
    const event: DebugEvent = {
      id: randomUUID(),
      ts: Date.now(),
      type: ev.type,
      requestId: ev.requestId,
      appId: ev.appId,
      appName: ev.appName,
      port: ev.port,
      path: ev.path,
      method: ev.method,
      modelRequested: ev.modelRequested,
      modelSelected: ev.modelSelected,
      provider: ev.provider,
      keyId: ev.keyId,
      keyLabel: ev.keyLabel,
      strategy: ev.strategy,
      reason: ev.reason,
      status: ev.status,
      latencyMs: ev.latencyMs,
      error: ev.error,
      errorClass: ev.errorClass,
      attempt: ev.attempt,
      usedOrchestrator: ev.usedOrchestrator,
      activity: ev.activity,
      details: ev.details || {},
    };
    this.session.events.push(event);
    // keep memory reasonable
    if (this.session.events.length > 5000) {
      this.session.events = this.session.events.slice(this.session.events.length - 5000);
    }
    return event;
  }

  getSnapshot(limit = 200) {
    if (!this.session) return { running: false, session: null, events: [] };
    const events = this.session.events.slice(-limit);
    return {
      running: this.session.running,
      session: {
        id: this.session.id,
        startedAt: this.session.startedAt,
        stoppedAt: this.session.stoppedAt,
        meta: this.session.meta,
        count: this.session.events.length,
      },
      events,
    };
  }

  generateReport() {
    if (!this.session) return null;
    const events = this.session.events;
    const startedAt = this.session.startedAt;
    const stoppedAt = this.session.stoppedAt || Date.now();
    const durationMs = stoppedAt - startedAt;

    const requests = new Map<string, DebugEvent[]>();
    for (const ev of events) {
      const rid = ev.requestId || 'no-id';
      if (!requests.has(rid)) requests.set(rid, []);
      requests.get(rid)!.push(ev);
    }

    const reqList = Array.from(requests.values()).map((list) => {
      list.sort((a, b) => a.ts - b.ts);
      const start = list.find((e) => e.type === 'request:start') || list[0];
      const end = list.find((e) => e.type === 'request:end') || list[list.length - 1];
      const router = list.find((e) => e.type === 'router:decision');
      const orch = list.find((e) => e.type === 'orchestrator:decision');
      const attempts = list.filter((e) => e.type === 'provider:attempt');
      const errors = list.filter((e) => e.type === 'provider:error');
      const success = list.find((e) => e.type === 'provider:success');
      return {
        requestId: start?.requestId || end?.requestId || null,
        startTs: start?.ts,
        endTs: end?.ts,
        durationMs: start?.ts && end?.ts ? end.ts - start.ts : null,
        port: start?.port || end?.port,
        path: start?.path || end?.path,
        appName: start?.appName || end?.appName,
        appId: start?.appId || end?.appId,
        modelRequested: start?.modelRequested || router?.modelRequested,
        modelSelected: router?.modelSelected || orch?.modelSelected || success?.modelSelected || end?.modelSelected,
        usedOrchestrator: !!(orch?.usedOrchestrator || orch),
        strategy: router?.strategy || orch?.strategy,
        reason: router?.reason || orch?.reason,
        provider: success?.provider || attempts[attempts.length - 1]?.provider,
        keyId: success?.keyId || attempts[attempts.length - 1]?.keyId,
        keyLabel: success?.keyLabel || attempts[attempts.length - 1]?.keyLabel,
        attemptsCount: attempts.length || (errors.length ? errors.length + (success ? 1 : 0) : 1),
        errors: errors.map((e) => ({ ts: e.ts, provider: e.provider, error: e.error, errorClass: e.errorClass, status: e.status })),
        status: end?.status || success?.status,
        error: end?.error || errors[errors.length - 1]?.error,
      };
    });

    const total = reqList.length;
    const errorsCount = reqList.filter((r) => r.error || (r.status && r.status >= 400)).length;
    const usedOrch = reqList.filter((r) => r.usedOrchestrator).length;
    const models = new Map<string, number>();
    for (const r of reqList) {
      const m = r.modelSelected || r.modelRequested || 'desconhecido';
      models.set(m, (models.get(m) || 0) + 1);
    }
    const providers = new Map<string, number>();
    for (const r of reqList) {
      const p = r.provider || 'desconhecido';
      providers.set(p, (providers.get(p) || 0) + 1);
    }

    const report = {
      sessionId: this.session.id,
      startedAt,
      stoppedAt,
      durationMs,
      generatedAt: Date.now(),
      summary: {
        totalRequests: total,
        errorsOrFailures: errorsCount,
        usedOrchestratorCount: usedOrch,
        usedRouterOnly: total - usedOrch,
        modelsUsed: Array.from(models.entries()).sort((a, b) => b[1] - a[1]),
        providersUsed: Array.from(providers.entries()).sort((a, b) => b[1] - a[1]),
      },
      requests: reqList,
      events: events,
    };

    const text = this.formatReportText(report);
    return { report, text };
  }

  private formatReportText(report: any) {
    const s = report.summary;
    const lines: string[] = [];
    lines.push('=== DEBUG SESSION REPORT (deepsproxy) ===');
    lines.push(`Session: ${report.sessionId}`);
    lines.push(`Iniciado: ${new Date(report.startedAt).toISOString()}`);
    lines.push(`Parado: ${new Date(report.stoppedAt).toISOString()}`);
    lines.push(`Duração: ${(report.durationMs / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push('--- SUMÁRIO ---');
    lines.push(`Total de requisições: ${s.totalRequests}`);
    lines.push(`Com erros/falhas: ${s.errorsOrFailures}`);
    lines.push(`Usou Orquestrador: ${s.usedOrchestratorCount} | Só roteador/decisão direta: ${s.usedRouterOnly}`);
    lines.push(`Modelos distintos: ${s.modelsUsed.length}`);
    lines.push('Modelos (top): ' + s.modelsUsed.slice(0, 12).map((x: any) => `${x[0]} (${x[1]})`).join(', '));
    lines.push('Provedores: ' + s.providersUsed.map((x: any) => `${x[0]} (${x[1]})`).join(', '));
    lines.push('');
    lines.push('--- POR REQUISIÇÃO (timeline) ---');
    for (let i = 0; i < report.requests.length; i++) {
      const r = report.requests[i];
      const t = r.durationMs != null ? `${r.durationMs}ms` : '?';
      lines.push(`#${i + 1} [${r.port || '-'}] ${r.path || '-'} | app:${r.appName || '-'} | req:${r.requestId || '-'} | ${t}`);
      lines.push(`  solicitado:${r.modelRequested || '-'} -> escolhido:${r.modelSelected || '-'} | provedor:${r.provider || '-'} | chave:${r.keyLabel || r.keyId || '-'} | status:${r.status || '-'}`);
      lines.push(`  orquestrador:${r.usedOrchestrator ? 'SIM' : 'NAO'} | estratégia:${r.strategy || '-'} | motivo:${r.reason || '-'}`);
      if (r.attemptsCount) lines.push(`  tentativas:${r.attemptsCount}`);
      if (r.errors && r.errors.length) {
        for (const e of r.errors) {
          lines.push(`  ERRO[${e.errorClass || '-'}]: ${String(e.error || '-').slice(0, 200)}`);
        }
      }
      if (r.error && !(r.errors && r.errors.length)) {
        lines.push(`  ERRO: ${String(r.error).slice(0, 200)}`);
      }
      lines.push('');
    }
    lines.push('--- ANÁLISE RÁPIDA (p/ eu revisar) ---');
    if (s.usedOrchestratorCount === 0 && s.totalRequests > 0) {
      lines.push('- Orquestrador NÃO apareceu nas decisões registradas. Pode estar desativado, ou as decisões não foram instrumentadas. Verificar config/orquestrador.');
    } else if (s.usedOrchestratorCount > 0) {
      lines.push(`- Orquestrador foi usado em ${s.usedOrchestratorCount}/${s.totalRequests} requisições.`);
    }
    if (s.modelsUsed.length === 1 && s.totalRequests > 2) {
      lines.push(`- ATENÇÃO: praticamente TODOS usaram o MESMO modelo (${s.modelsUsed[0][0]}). Se o objetivo era testar o roteador/orquestrador, verifique por que não há variação.`);
    } else if (s.modelsUsed.length >= 2) {
      lines.push(`- Há variação entre modelos (${s.modelsUsed.length} distintos) — bom sinal de roteamento.`);
    }
    if (s.errorsOrFailures > 0) {
      lines.push(`- Existem ${s.errorsOrFailures} requisições com erro/falha. Olhar tentativas/fallback/rotação por chave.`);
    } else {
      lines.push('- Sem erros aparentes nas requisições registradas.');
    }
    lines.push('');
    lines.push('Cole TODO este texto + o JSON completo aqui que eu analiso detalhadamente: quais modelos foram pra quais atividades, se roteador/orquestrador está funcionando, falhas, tentativas e sugestões.');
    return lines.join('\n');
  }
}

export const debugSession = new DebugSessionStore();
