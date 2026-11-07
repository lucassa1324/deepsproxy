/**
 * Loja de Skills e MCP para o deepsproxy.
 * - Skills: módulos de instrução injetados no prompt (funcionam em 3005 e 3006).
 * - MCP: catálogo de configurações de servidores MCP para o usuário copiar/usar no cliente.
 *
 * Persistência: arquivo JSON local por padrão. Estrutura preparada para migração futura
 * para BD/comunidade (interface StorageBackend + entidades custom/catalog separadas).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const nodeRequire = createRequire(import.meta.url);

export type SkillCategory = 'programming' | 'design' | 'writing' | 'data' | 'security' | 'devops' | 'product' | 'general' | 'custom';
export type McpCategory = 'filesystem' | 'dev' | 'web' | 'data' | 'productivity' | 'ai' | 'cloud' | 'communication' | 'general' | 'custom';

export interface SkillDef {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  tags: string[];
  instructions: string;
  recommended?: boolean;
  scopeHint?: '3005' | '3006' | 'both';
  /** fonte: builtin | custom | community (futuro BD) */
  source?: 'builtin' | 'custom' | 'community';
  author?: string;
  repoUrl?: string;
}

export interface McpDef {
  id: string;
  name: string;
  category: McpCategory;
  description: string;
  tags: string[];
  config: Record<string, any>;
  docsUrl?: string;
  repoUrl?: string;
  scopeHint?: 'client' | 'both';
  source?: 'builtin' | 'custom' | 'community';
  author?: string;
  /** notas de instalação/requisitos */
  notes?: string;
}

export interface InstalledSkill {
  id: string;
  enabled: boolean;
  instructions?: string;
  scope: 'both' | '3005' | '3006';
  installedAt: number;
  updatedAt: number;
}
export interface InstalledMcp {
  id: string;
  enabled: boolean;
  config?: Record<string, any>;
  installedAt: number;
  updatedAt: number;
}

interface StoreState {
  version: number;
  installedSkills: Record<string, InstalledSkill>;
  installedMcps: Record<string, InstalledMcp>;
  customSkills: Record<string, SkillDef>;
  customMcps: Record<string, McpDef>;
  prefs: { autoConfigureNotes?: string; communityEndpoint?: string };
}

const DEFAULT_STATE: StoreState = { version: 2, installedSkills: {}, installedMcps: {}, customSkills: {}, customMcps: {}, prefs: {} };

// ── Storage backend (DB-ready) ──────────────────────────────────────────────
export interface StorageBackend {
  load(): StoreState;
  save(state: StoreState): void;
}
class JsonFileBackend implements StorageBackend {
  constructor(private filePath: string, private dirPath: string) {}
  load(): StoreState {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const j = JSON.parse(raw);
        return {
          ...DEFAULT_STATE, ...j,
          version: j.version || 2,
          installedSkills: j.installedSkills || {},
          installedMcps: j.installedMcps || {},
          customSkills: j.customSkills || {},
          customMcps: j.customMcps || {},
          prefs: j.prefs || {},
        };
      }
    } catch {}
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  save(state: StoreState) {
    try {
      if (!fs.existsSync(this.dirPath)) fs.mkdirSync(this.dirPath, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
  }
}
/** SQLite backend (primeira etapa real de BD). Ativa com DEEPSPROXY_STORE_BACKEND=sqlite
 *  ou DEEPSPROXY_STORE_SQLITE=<path>. Requer node:sqlite (Node 22+; pode precisar de
 *  --experimental-sqlite no runtime). Cai para JSON se indisponível. */
class SqliteBackend implements StorageBackend {
  private db: any;
  private file: string;
  constructor(file: string) {
    this.file = file;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const sqlite = nodeRequire('node:sqlite');
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }
  load(): StoreState {
    try {
      const row = this.db.prepare('SELECT v FROM kv WHERE k=?').get('state');
      if (!row || !row.v) return JSON.parse(JSON.stringify(DEFAULT_STATE));
      const j = JSON.parse(String(row.v));
      return { ...DEFAULT_STATE, ...j, version: j.version||2, installedSkills:j.installedSkills||{}, installedMcps:j.installedMcps||{}, customSkills:j.customSkills||{}, customMcps:j.customMcps||{}, prefs:j.prefs||{} };
    } catch { return JSON.parse(JSON.stringify(DEFAULT_STATE)); }
  }
  save(state: StoreState) {
    try {
      this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('state', JSON.stringify(state));
    } catch {}
  }
  get info(){ return { backend:'sqlite', file:this.file }; }
}

function storeDir(): string { return process.env.DEEPSPROXY_CONFIG_DIR || path.join(os.homedir(), '.deepsproxy'); }
function storePath(): string { return path.join(storeDir(), 'skills-store.json'); }

function createBackend(): StorageBackend {
  const mode = String(process.env.DEEPSPROXY_STORE_BACKEND || '').toLowerCase();
  const sqlitePath = process.env.DEEPSPROXY_STORE_SQLITE;
  if (mode === 'sqlite' || sqlitePath) {
    try {
      const f = sqlitePath || path.join(storeDir(), 'skills-store.sqlite');
      console.log('[skills-store] usando backend SQLite:', f);
      return new SqliteBackend(f);
    } catch (e) {
      console.warn('[skills-store] SQLite indisponível, usando JSON:', (e as any)?.message || e);
    }
  }
  return new JsonFileBackend(storePath(), storeDir());
}

let backend: StorageBackend = createBackend();
let state: StoreState = backend.load();

export function setStorageBackend(b: StorageBackend) { backend = b; state = backend.load(); }
function persist() { backend.save(state); }
export function getStorageInfo() {
  const b: any = backend;
  return { backend: b instanceof SqliteBackend ? 'sqlite' : (b instanceof JsonFileBackend ? 'json' : 'custom'), file: b.file || b.filePath || storePath(), dbReady: true };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function uid(prefix: string) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`; }
function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60) || uid('item'); }

// ── Catálogo embutido (curado: populares + úteis) ───────────────────────────
// Skills: instruções originais/concisas inspiradas em práticas comuns (não cópia literal).
export const BUILTIN_SKILLS: SkillDef[] = [
  { id:'prog-architect', name:'Arquiteto de Software', category:'programming', tags:['arquitetura','design','clean-code'], description:'Planeja estrutura, módulos e decisões técnicas com foco em simplicidade.', scopeHint:'both', recommended:true, source:'builtin',
    instructions:`[SKILL: Arquiteto de Software]\n- Antes de implementar, identifique objetivo, restrições e impacto.\n- Proponha a menor mudança que resolve; evite overengineering.\n- Respeite convenções do projeto; prefira editar arquivos existentes.\n- Explique trade-offs brevemente quando houver decisão relevante.` },
  { id:'prog-debugger', name:'Debugger Sistemático', category:'programming', tags:['debug','bugs','root-cause'], description:'Investiga causa raiz com hipóteses e evidências; correção mínima.', scopeHint:'both', recommended:true, source:'builtin',
    instructions:`[SKILL: Debugger Sistemático]\n- Reproduza o sintoma, levanta hipótese, verifica com evidência.\n- Corrija a causa raiz, não o sintoma. Preserve comportamento não relacionado.\n- Rode o mínimo de verificação relevante após o reparo.` },
  { id:'prog-code-review', name:'Code Review Rigoroso', category:'programming', tags:['review','qualidade','segurança'], description:'Foca em bugs, regressões, segurança e legibilidade.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Code Review]\n- Priorize: bugs/regressões > segurança > performance real > legibilidade.\n- Aponte problemas com evidência (arquivo/trecho) e sugestão objetiva.\n- Evite refactors cosméticos fora do escopo.` },
  { id:'prog-refactor', name:'Refatoração Segura', category:'programming', tags:['refactor','manutenção'], description:'Melhora estrutura sem mudar comportamento observável.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Refatoração Segura]\n- Mantenha comportamento/API; mude em passos pequenos.\n- Refatore só o necessário para a tarefa; preserve contratos.` },
  { id:'prog-tests', name:'Engenheiro de Testes', category:'programming', tags:['testes','qa'], description:'Testes focados no comportamento alterado e bordas relevantes.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Testes]\n- Teste comportamento alterado/regressão real; evite testes frágeis.\n- Cubra caminho feliz + bordas importantes. Não enfraqueça asserts.` },
  { id:'prog-tdd', name:'TDD Pragmático', category:'programming', tags:['tdd','testes'], description:'Ciclo red-green-refactor quando fizer sentido para a tarefa.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: TDD]\n- Quando útil: escreva teste que falha (red), implemente o mínimo (green), refatore (refactor).\n- Não force TDD em mudanças triviais ou exploratórias.` },
  { id:'prog-api-design', name:'Designer de APIs', category:'programming', tags:['api','rest','contratos'], description:'Contratos claros, consistentes e compatíveis.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: API Design]\n- Defina inputs, outputs, erros e status codes. Seja consistente.\n- Preserve compatibilidade retroativa quando aplicável; valide entradas.` },
  { id:'prog-frontend', name:'Frontend Pragmático', category:'programming', tags:['ui','react','css','a11y'], description:'UI funcional, acessível e consistente com o projeto.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Frontend]\n- Reutilize padrões existentes; consistência visual.\n- Acessibilidade: labels, foco, contraste, semântica. Evite deps novas sem necessidade.` },
  { id:'prog-backend', name:'Backend Confiável', category:'programming', tags:['backend','api','db'], description:'Foco em correção, validação, erros e observabilidade.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Backend]\n- Valide entradas, trate erros com mensagens úteis, evite vazar detalhes sensíveis.\n- Atenção a idempotência, concorrência e limites quando relevante.` },
  { id:'prog-performance', name:'Performance com Medição', category:'programming', tags:['performance','otimização'], description:'Otimiza com base em evidência.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Performance]\n- Identifique gargalo real antes de otimizar; prefira ganhos claros.\n- Não sacrifique correção/legibilidade por micro-otimizações.` },
  { id:'prog-typescript', name:'TypeScript Estrito & Seguro', category:'programming', tags:['typescript','tipos'], description:'Tipagem útil, evitando `any` injustificado e suprimindo erros sem motivo.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: TypeScript]\n- Prefira tipos precisos; evite \`any\` e supressões sem justificativa.\n- Modele estados impossíveis como impossíveis; trate null/undefined explicitamente.` },
  { id:'prog-python', name:'Python Claro & Idiomático', category:'programming', tags:['python'], description:'Código Python legível, com tratamento de erros e estrutura simples.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Python]\n- Prefira clareza e idiomatismo (PEP 8 quando fizer sentido).\n- Trate exceções com critério; evite \`except:\` genérico silencioso.` },
  { id:'prog-git', name:'Git & Commits Limpos', category:'programming', tags:['git','commits'], description:'Mudanças pequenas, mensagens claras; evita ações destrutivas implícitas.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Git]\n- Commits focados com mensagem clara (o quê/por quê quando útil).\n- Não faça push/reset/rebase/ações destrutivas sem pedido explícito.` },
  { id:'design-art-director', name:'Direção de Arte', category:'design', tags:['arte','visual','branding','ui'], description:'Estilo visual, composição, hierarquia e consistência estética.', scopeHint:'both', recommended:true, source:'builtin',
    instructions:`[SKILL: Direção de Arte]\n- Defina intenção: mood, paleta, tipografia, hierarquia e contraste.\n- Priorize clareza e consistência; traduza referências em decisões concretas.` },
  { id:'design-ux', name:'UX & Produto', category:'design', tags:['ux','fluxos','usabilidade'], description:'Fluxos simples, estados e feedback claros.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: UX]\n- Deixe ações primárias óbvias; reduza passos.\n- Cubra loading, vazio, erro, sucesso; mensagens acionáveis; acessibilidade.` },
  { id:'design-ui-copy', name:'UX Writing / Microcopy', category:'design', tags:['copy','ux-writing'], description:'Textos de interface claros, úteis e consistentes.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: UX Writing]\n- Microcopy curto, direto e consistente. Evite jargão.\n- Erros devem dizer o que aconteceu e como resolver.` },
  { id:'design-accessibility', name:'Acessibilidade (A11y)', category:'design', tags:['a11y','wcag'], description:'Garante uso por teclado/leitores e contraste adequado.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Acessibilidade]\n- Semântica HTML, labels, foco visível, navegação por teclado, alt text.\n- Verifique contraste e estados; evite depender só de cor.` },
  { id:'write-docs', name:'Documentação Clara', category:'writing', tags:['docs','readme'], description:'Docs objetivas com exemplos e passos verificáveis.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Documentação]\n- Objetivo, pré-requisitos, passos, exemplos, troubleshooting.\n- Não invente comandos/flags; alinhe ao projeto real.` },
  { id:'write-technical', name:'Escrita Técnica', category:'writing', tags:['técnico','explicação'], description:'Explica com precisão e sem jargão desnecessário.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Escrita Técnica]\n- Explique o porquê e o como com precisão; adapte o nível ao contexto.` },
  { id:'data-analysis', name:'Análise de Dados', category:'data', tags:['dados','sql','métricas'], description:'Interpreta com cuidado, valida premissas e limitações.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Dados]\n- Premissas explícitas; cuidado com causalidade vs correlação.\n- Valide queries/transformações; destaque limitações.` },
  { id:'sec-appsec', name:'Segurança de Aplicação', category:'security', tags:['segurança','owasp'], description:'Riscos comuns e mitigação prática.', scopeHint:'both', recommended:true, source:'builtin',
    instructions:`[SKILL: AppSec]\n- Atenção a validação, authn/authz, segredos, injeção, XSS/SSRF conforme contexto.\n- Não exponha segredos em logs/respostas; prefira mudanças mínimas e seguras.` },
  { id:'sec-secrets', name:'Higiene de Segredos', category:'security', tags:['secrets','env'], description:'Evita vazamento de chaves/tokens em código e logs.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Segredos]\n- Nunca hardcode segredos; use env/config segura.\n- Não imprima tokens/chaves em logs, erros ou commits.` },
  { id:'devops-pragmatic', name:'DevOps Pragmático', category:'devops', tags:['ci','deploy','infra'], description:'Automação e deploy seguros, sem ações destrutivas implícitas.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: DevOps]\n- Mudanças reversíveis e delimitadas; não execute deploy/push/destrutivos sem pedido explícito.\n- Documente env vars e passos.` },
  { id:'product-prd', name:'Produto / Requisitos', category:'product', tags:['produto','requisitos'], description:'Clarifica problema, escopo, critérios de aceite e riscos.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Produto]\n- Defina problema, usuário, escopo (in/out), critérios de aceite e riscos.\n- Prefira MVP que resolve o objetivo antes de expandir.` },
  { id:'proxy-operator', name:'Operador do Proxy (deepsproxy)', category:'general', tags:['proxy','deepsproxy','roteamento'], description:'Entende portas 3005/3006, auto-router, gateway/apps, chaves e debug.', scopeHint:'both', recommended:true, source:'builtin',
    instructions:`[SKILL: Operador do Proxy]\n- deepsproxy: OpenAI-compatible. 3005=direta (model do cliente). 3006=gateway (chave virtual do app; app pode definir/sobrescrever model/params).\n- auto/auto-free resolvidos pelo auto-router; modelos não-chat filtrados. Múltiplas chaves por provedor com rotação/failover por cota.\n- Diagnóstico: Debug Session (gravar->usar->parar->relatório/JSON). Distinguir erro do cliente/app (baseURL/auth/model/stream/formato) de erro do provedor/proxy.` },
  { id:'prompt-engineer', name:'Engenharia de Prompt', category:'general', tags:['prompt','instruções'], description:'Escreve instruções claras, testáveis e com restrições explícitas.', scopeHint:'both', source:'builtin',
    instructions:`[SKILL: Prompt Engineering]\n- Seja explícito sobre objetivo, formato de saída, restrições e exemplos quando útil.\n- Prefira instruções verificáveis; evite ambiguidade.` },
];

// MCPs: configs de servidores populares (oficiais/referência/comunidade conhecidos).
// Campos como tokens/paths usam placeholders — o usuário ajusta ao copiar.
export const BUILTIN_MCPS: McpDef[] = [
  { id:'mcp-filesystem', name:'Filesystem (ref)', category:'filesystem', tags:['arquivos','local','official-ref'], description:'Acesso a arquivos locais permitidos. Referência MCP.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ filesystem:{ command:'npx', args:['-y','@modelcontextprotocol/server-filesystem','<PATH_PERMITIDO_1>','<PATH_PERMITIDO_2>'] } } }, notes:'Substitua <PATH_PERMITIDO_*> pelos diretórios que o agente pode acessar.' },
  { id:'mcp-git', name:'Git (ref)', category:'dev', tags:['git','repo','official-ref'], description:'Leitura/operações git no repositório.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ git:{ command:'uvx', args:['mcp-server-git','--repository','<CAMINHO_REPO>'] } } } },
  { id:'mcp-fetch', name:'Fetch (ref)', category:'web', tags:['http','web','official-ref'], description:'Busca e converte conteúdo web para o modelo.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ fetch:{ command:'uvx', args:['mcp-server-fetch'] } } } },
  { id:'mcp-memory', name:'Memory (ref)', category:'ai', tags:['memória','knowledge-graph','official-ref'], description:'Memória persistente (grafo) entre sessões.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ memory:{ command:'npx', args:['-y','@modelcontextprotocol/server-memory'] } } } },
  { id:'mcp-sequential-thinking', name:'Sequential Thinking (ref)', category:'ai', tags:['raciocínio','official-ref'], description:'Raciocínio passo a passo estruturado.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ 'sequential-thinking':{ command:'npx', args:['-y','@modelcontextprotocol/server-sequential-thinking'] } } } },
  { id:'mcp-time', name:'Time (ref)', category:'productivity', tags:['tempo','timezone','official-ref'], description:'Data/hora e fusos.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ time:{ command:'uvx', args:['mcp-server-time'] } } } },
  { id:'mcp-everything', name:'Everything (ref/demo)', category:'general', tags:['demo','teste','official-ref'], description:'Servidor de exemplo para testar MCP.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ everything:{ command:'npx', args:['-y','@modelcontextprotocol/server-everything'] } } } },
  { id:'mcp-github', name:'GitHub (oficial)', category:'dev', tags:['github','issues','pr','official'], description:'Repos, issues, PRs, code search, Actions.', source:'builtin', repoUrl:'https://github.com/github/github-mcp-server',
    config:{ mcpServers:{ github:{ command:'npx', args:['-y','@modelcontextprotocol/server-github'], env:{ GITHUB_PERSONAL_ACCESS_TOKEN:'<GITHUB_TOKEN>' } } } }, notes:'Requer token com escopos adequados. Alternativa: GitHub MCP oficial (Go) — ver repo.' },
  { id:'mcp-gitlab', name:'GitLab', category:'dev', tags:['gitlab','mr','issues'], description:'Integração GitLab (MRs, issues, pipelines) — configure endpoint/token.', source:'builtin',
    config:{ mcpServers:{ gitlab:{ command:'npx', args:['-y','@modelcontextprotocol/server-gitlab'], env:{ GITLAB_PERSONAL_ACCESS_TOKEN:'<GITLAB_TOKEN>', GITLAB_API_URL:'https://gitlab.com/api/v4' } } } } },
  { id:'mcp-postgres', name:'PostgreSQL (ref)', category:'data', tags:['postgres','sql','db','official-ref'], description:'Consultas a Postgres (somente leitura recomendado).', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ postgres:{ command:'npx', args:['-y','@modelcontextprotocol/server-postgres','postgresql://<USER>:<PASS>@<HOST>:5432/<DB>'] } } } },
  { id:'mcp-sqlite', name:'SQLite', category:'data', tags:['sqlite','sql','db'], description:'Consultas a bancos SQLite locais.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ sqlite:{ command:'uvx', args:['mcp-server-sqlite','--db-path','<CAMINHO_DB.sqlite>'] } } } },
  { id:'mcp-brave-search', name:'Brave Search', category:'web', tags:['busca','web','search'], description:'Pesquisa web via Brave Search API.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ 'brave-search':{ command:'npx', args:['-y','@modelcontextprotocol/server-brave-search'], env:{ BRAVE_API_KEY:'<BRAVE_API_KEY>' } } } } },
  { id:'mcp-puppeteer', name:'Puppeteer (browser)', category:'web', tags:['browser','scrape','automation'], description:'Automação de navegador via Puppeteer.', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ puppeteer:{ command:'npx', args:['-y','@modelcontextprotocol/server-puppeteer'] } } } },
  { id:'mcp-playwright', name:'Playwright (popular)', category:'web', tags:['browser','testing','automation'], description:'Automação/teste de browser com Playwright (muito popular).', source:'builtin', repoUrl:'https://github.com/microsoft/playwright-mcp',
    config:{ mcpServers:{ playwright:{ command:'npx', args:['-y','@playwright/mcp@latest'] } } }, notes:'Pacote/args podem variar; confira o repo oficial.' },
  { id:'mcp-slack', name:'Slack', category:'communication', tags:['slack','chat'], description:'Ler/enviar mensagens no Slack (requer token/bot).', source:'builtin', repoUrl:'https://github.com/modelcontextprotocol/servers',
    config:{ mcpServers:{ slack:{ command:'npx', args:['-y','@modelcontextprotocol/server-slack'], env:{ SLACK_BOT_TOKEN:'<SLACK_BOT_TOKEN>', SLACK_TEAM_ID:'<TEAM_ID>' } } } } },
  { id:'mcp-google-drive', name:'Google Drive', category:'productivity', tags:['gdrive','docs'], description:'Acesso a arquivos do Google Drive (OAuth/config).', source:'builtin',
    config:{ mcpServers:{ gdrive:{ command:'npx', args:['-y','@modelcontextprotocol/server-gdrive'], env:{ GDRIVE_CREDENTIALS_PATH:'<PATH_CREDENTIALS.json>' } } } }, notes:'Requer credenciais OAuth; ver documentação do servidor.' },
  { id:'mcp-google-maps', name:'Google Maps', category:'web', tags:['maps','geo'], description:'Geocoding, rotas e lugares via Google Maps API.', source:'builtin',
    config:{ mcpServers:{ 'google-maps':{ command:'npx', args:['-y','@modelcontextprotocol/server-google-maps'], env:{ GOOGLE_MAPS_API_KEY:'<MAPS_API_KEY>' } } } } },
  { id:'mcp-sentry', name:'Sentry', category:'dev', tags:['erros','observabilidade'], description:'Consulta issues/eventos do Sentry.', source:'builtin',
    config:{ mcpServers:{ sentry:{ command:'npx', args:['-y','@modelcontextprotocol/server-sentry'], env:{ SENTRY_AUTH_TOKEN:'<SENTRY_TOKEN>', SENTRY_ORG:'<ORG>' } } } } },
  { id:'mcp-redis', name:'Redis', category:'data', tags:['redis','cache','db'], description:'Operações em Redis (chaves/dados) — use com cuidado.', source:'builtin',
    config:{ mcpServers:{ redis:{ command:'npx', args:['-y','@modelcontextprotocol/server-redis','redis://<HOST>:6379'] } } } },
  { id:'mcp-docker', name:'Docker (comunidade)', category:'devops', tags:['docker','containers'], description:'Gerenciar containers/imagens Docker (popular).', source:'builtin', repoUrl:'https://github.com/ckreiling/mcp-server-docker',
    config:{ mcpServers:{ docker:{ command:'uvx', args:['mcp-server-docker'] } } }, notes:'Servidor comunitário; requer Docker acessível no host. Revise permissões.' },
  { id:'mcp-kubernetes', name:'Kubernetes (comunidade)', category:'devops', tags:['k8s','cluster'], description:'Interagir com clusters Kubernetes (muito cuidado/permissões).', source:'builtin',
    config:{ mcpServers:{ kubernetes:{ command:'npx', args:['-y','mcp-server-kubernetes'], env:{ KUBECONFIG:'<PATH_KUBECONFIG>' } } } }, notes:'Alta sensibilidade: conceda acesso mínimo; revise o pacote antes de usar.' },
  { id:'mcp-aws-kb', name:'AWS Knowledge/Docs (exemplo)', category:'cloud', tags:['aws','cloud'], description:'Integrações AWS variam; configure o servidor MCP AWS desejado.', source:'builtin',
    config:{ mcpServers:{ aws:{ command:'uvx', args:['awslabs.aws-documentation-mcp-server@latest'], env:{ AWS_REGION:'us-east-1' } } } }, notes:'Exemplo; existem vários servidores AWS (awslabs). Ajuste pacote/args/env.' },
  { id:'mcp-cloudflare', name:'Cloudflare (exemplo)', category:'cloud', tags:['cloudflare','edge'], description:'Integrações Cloudflare via MCP (ajuste conforme servidor escolhido).', source:'builtin',
    config:{ mcpServers:{ cloudflare:{ command:'npx', args:['-y','<cloudflare-mcp-package>'], env:{ CLOUDFLARE_API_TOKEN:'<TOKEN>' } } } }, notes:'Placeholder de pacote — escolha o servidor Cloudflare MCP oficial/comunitário desejado.' },
  { id:'mcp-notion', name:'Notion (comunidade)', category:'productivity', tags:['notion','docs'], description:'Ler/atualizar páginas Notion.', source:'builtin',
    config:{ mcpServers:{ notion:{ command:'npx', args:['-y','@notionhq/notion-mcp-server'], env:{ NOTION_TOKEN:'<NOTION_INTEGRATION_TOKEN>' } } } }, notes:'Confira o pacote/args atuais do Notion MCP.' },
  { id:'mcp-linear', name:'Linear (comunidade)', category:'productivity', tags:['linear','issues'], description:'Gerenciar issues/projetos no Linear.', source:'builtin',
    config:{ mcpServers:{ linear:{ command:'npx', args:['-y','mcp-linear'], env:{ LINEAR_API_KEY:'<LINEAR_API_KEY>' } } } }, notes:'Pacote comunitário; verifique nome/args atuais.' },
  { id:'mcp-supabase', name:'Supabase (comunidade)', category:'data', tags:['supabase','postgres','auth'], description:'Interagir com projetos Supabase.', source:'builtin',
    config:{ mcpServers:{ supabase:{ command:'npx', args:['-y','@supabase/mcp-server-supabase@latest'], env:{ SUPABASE_ACCESS_TOKEN:'<TOKEN>', SUPABASE_PROJECT_REF:'<PROJECT_REF>' } } } }, notes:'Verifique pacote/args/env atuais.' },
  { id:'mcp-stripe', name:'Stripe (comunidade/exemplo)', category:'cloud', tags:['stripe','pagamentos'], description:'Operações Stripe via MCP (sensível — mínimo privilégio).', source:'builtin',
    config:{ mcpServers:{ stripe:{ command:'npx', args:['-y','@stripe/mcp','--tools=all'], env:{ STRIPE_SECRET_KEY:'<STRIPE_SECRET_KEY>' } } } }, notes:'Use chaves de teste e permissões mínimas; confira pacote oficial/atual.' },
  { id:'mcp-raycast-everything', name:'Context7 / Docs (popular)', category:'ai', tags:['docs','contexto','bibliotecas'], description:'Busca documentação atualizada de bibliotecas (muito usado em IDEs).', source:'builtin', repoUrl:'https://github.com/upstash/context7',
    config:{ mcpServers:{ context7:{ command:'npx', args:['-y','@upstash/context7-mcp@latest'] } } }, notes:'Pacote/args podem mudar; confira o repo.' },
];

// ── Catálogo efetivo (builtin + custom) ─────────────────────────────────────
export function getAllSkills(): SkillDef[] { return [...BUILTIN_SKILLS, ...Object.values(state.customSkills)]; }
export function getAllMcps(): McpDef[] { return [...BUILTIN_MCPS, ...Object.values(state.customMcps)]; }

export function listCatalog() {
  return {
    skills: getAllSkills().map(s => ({ ...s, installed: !!state.installedSkills[s.id], enabled: !!state.installedSkills[s.id]?.enabled, installedState: state.installedSkills[s.id] || null })),
    mcps: getAllMcps().map(m => ({ ...m, installed: !!state.installedMcps[m.id], enabled: !!state.installedMcps[m.id]?.enabled, installedState: state.installedMcps[m.id] || null })),
    prefs: state.prefs,
    meta: { version: state.version, ...getStorageInfo() },
  };
}

// ── CRUD de itens custom (base para comunidade/BD) ──────────────────────────
export function createCustomSkill(input: Partial<SkillDef>) {
  if (!input.name || !input.instructions) return { ok:false, error:'name e instructions são obrigatórios' };
  const id = String(input.id || `custom-${slugify(input.name)}`);
  const def: SkillDef = {
    id, name: String(input.name), category: (input.category as any) || 'custom',
    description: String(input.description || ''), tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    instructions: String(input.instructions), scopeHint: (input.scopeHint as any) || 'both',
    source: 'custom', author: input.author ? String(input.author) : undefined, repoUrl: input.repoUrl ? String(input.repoUrl) : undefined,
  };
  state.customSkills[id] = def; persist();
  return { ok:true, skill: def };
}
export function updateCustomSkill(id: string, patch: Partial<SkillDef>) {
  const cur = state.customSkills[id]; if (!cur) return { ok:false, error:'Skill custom não encontrada' };
  state.customSkills[id] = { ...cur, ...patch, id, source: 'custom' }; persist();
  return { ok:true, skill: state.customSkills[id] };
}
export function deleteCustomSkill(id: string) { delete state.customSkills[id]; delete state.installedSkills[id]; persist(); return { ok:true }; }

export function createCustomMcp(input: Partial<McpDef>) {
  if (!input.name || !input.config) return { ok:false, error:'name e config são obrigatórios' };
  const id = String(input.id || `custom-${slugify(input.name)}`);
  const def: McpDef = {
    id, name: String(input.name), category: (input.category as any) || 'custom',
    description: String(input.description || ''), tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    config: (input.config && typeof input.config === 'object') ? input.config : {},
    docsUrl: input.docsUrl ? String(input.docsUrl) : undefined, repoUrl: input.repoUrl ? String(input.repoUrl) : undefined,
    source: 'custom', author: input.author ? String(input.author) : undefined, notes: input.notes ? String(input.notes) : undefined,
  };
  state.customMcps[id] = def; persist();
  return { ok:true, mcp: def };
}
export function updateCustomMcp(id: string, patch: Partial<McpDef>) {
  const cur = state.customMcps[id]; if (!cur) return { ok:false, error:'MCP custom não encontrado' };
  state.customMcps[id] = { ...cur, ...patch, id, source: 'custom' }; persist();
  return { ok:true, mcp: state.customMcps[id] };
}
export function deleteCustomMcp(id: string) { delete state.customMcps[id]; delete state.installedMcps[id]; persist(); return { ok:true }; }

// ── Instalação/uso ──────────────────────────────────────────────────────────
export function installSkill(id: string, opts?: { enabled?: boolean; scope?: InstalledSkill['scope'] }) {
  const def = getAllSkills().find(s => s.id === id);
  if (!def) return { ok:false, error:'Skill não encontrada' };
  const now = Date.now();
  state.installedSkills[id] = { id, enabled: opts?.enabled ?? true, scope: opts?.scope ?? (def.scopeHint === '3005' || def.scopeHint === '3006' ? def.scopeHint : 'both'), installedAt: state.installedSkills[id]?.installedAt || now, updatedAt: now };
  persist(); return { ok:true, installed: state.installedSkills[id] };
}
export function uninstallSkill(id: string) { delete state.installedSkills[id]; persist(); return { ok:true }; }
export function updateSkill(id: string, patch: Partial<InstalledSkill> & { instructions?: string }) {
  const cur = state.installedSkills[id]; if (!cur) return { ok:false, error:'Skill não instalada' };
  state.installedSkills[id] = { ...cur, ...patch, id, updatedAt: Date.now() };
  persist(); return { ok:true, installed: state.installedSkills[id] };
}

export function installMcp(id: string, opts?: { enabled?: boolean }) {
  const def = getAllMcps().find(m => m.id === id);
  if (!def) return { ok:false, error:'MCP não encontrado' };
  const now = Date.now();
  state.installedMcps[id] = { id, enabled: opts?.enabled ?? true, installedAt: state.installedMcps[id]?.installedAt || now, updatedAt: now };
  persist(); return { ok:true, installed: state.installedMcps[id] };
}
export function uninstallMcp(id: string) { delete state.installedMcps[id]; persist(); return { ok:true }; }
export function updateMcp(id: string, patch: Partial<InstalledMcp>) {
  const cur = state.installedMcps[id]; if (!cur) return { ok:false, error:'MCP não instalado' };
  state.installedMcps[id] = { ...cur, ...patch, id, updatedAt: Date.now() };
  persist(); return { ok:true, installed: state.installedMcps[id] };
}

// ── Injeção no proxy (3005/3006) ────────────────────────────────────────────
export function getActiveSkillsFor(port?: 3005 | 3006 | null): Array<{ id:string; name:string; instructions:string }> {
  const out: Array<{ id:string; name:string; instructions:string }> = [];
  for (const def of getAllSkills()) {
    const inst = state.installedSkills[def.id];
    if (!inst || !inst.enabled) continue;
    if (port === 3005 && inst.scope === '3006') continue;
    if (port === 3006 && inst.scope === '3005') continue;
    out.push({ id: def.id, name: def.name, instructions: (inst.instructions && inst.instructions.trim()) ? inst.instructions : def.instructions });
  }
  return out;
}
export function injectActiveSkills<T extends { role: string; content: any }>(messages: T[], port?: 3005 | 3006 | null): T[] {
  const skills = getActiveSkillsFor(port);
  if (!skills.length || !Array.isArray(messages)) return messages;
  const block = skills.map(s => s.instructions).join('\n\n');
  const marker = '[DEEPSPROXY_SKILLS]';
  const filtered = messages.filter(m => !(m.role === 'system' && typeof m.content === 'string' && m.content.includes(marker)));
  const sys = { role: 'system', content: `${marker}\n${block}` } as unknown as T;
  return [sys, ...filtered];
}

export function buildAiConfigPrompt(usageSummary?: any): string {
  const installed = Object.values(state.installedSkills).filter(s=>s.enabled).map(s=>s.id);
  const usage = usageSummary ? JSON.stringify(usageSummary).slice(0, 4000) : 'indisponível';
  return `Você é um assistente de configuração do deepsproxy (proxy OpenAI-compatible, portas 3005 direta / 3006 gateway).
Com base no catálogo de skills e no uso do usuário, sugira: (1) quais skills ativar/desativar, (2) escopo 3005/3006/both, (3) ajustes curtos nas instruções (opcional).
Responda em JSON: {"recommendations":[{"id":"skill-id","enabled":true,"scope":"both","instructionsOverride":"(opcional)"}],"notes":"..."}.
Skills instaladas/ativas: ${JSON.stringify(installed)}
Resumo de uso (pode ser parcial): ${usage}
Catálogo (ids): ${JSON.stringify(getAllSkills().map(s=>({id:s.id,name:s.name,category:s.category,source:s.source})))}`;
}

// ── Importação em massa (awesome lists / MCP configs / comunidade) ───────────
function normMcpEntry(name: string, v: any, source: 'custom'|'community'='custom'): McpDef | null {
  if (!v || typeof v !== 'object') return null;
  const config = (v.command || v.args || v.env || v.url) ? v : (v.config && typeof v.config === 'object' ? v.config : null);
  if (!config) return null;
  const id = String(v.id || `import-${slugify(name)}`);
  return {
    id, name: String(v.name || name), category: (v.category as any) || 'custom',
    description: String(v.description || v.notes || ''), tags: Array.isArray(v.tags) ? v.tags.map(String) : [],
    config: (config.mcpServers || config.command || config.args || config.env || config.url) ? config : { mcpServers: { [name]: config } },
    docsUrl: v.docsUrl ? String(v.docsUrl) : undefined, repoUrl: v.repoUrl || v.url || v.homepage ? String(v.repoUrl||v.url||v.homepage) : undefined,
    source, author: v.author ? String(v.author) : undefined, notes: v.notes ? String(v.notes) : undefined,
  };
}

export function importCatalog(payload: any): { ok: boolean; importedSkills: number; importedMcps: number; errors: string[] } {
  const errors: string[] = []; let importedSkills = 0; let importedMcps = 0;
  if (!payload || typeof payload !== 'object') return { ok:false, importedSkills:0, importedMcps:0, errors:['payload inválido'] };
  const source: 'custom'|'community' = payload.source === 'community' ? 'community' : 'custom';

  // Skills (nosso formato)
  const skillsArr: any[] = Array.isArray(payload.skills) ? payload.skills : [];
  for (const s of skillsArr) {
    try {
      if (!s || !s.name || !(s.instructions || s.content || s.prompt)) { errors.push(`skill sem name/instructions: ${s?.id||s?.name||'?'}`); continue; }
      const id = String(s.id || `${source}-${slugify(s.name)}`);
      const def: SkillDef = {
        id, name: String(s.name), category: (s.category as any) || 'custom',
        description: String(s.description || ''), tags: Array.isArray(s.tags)?s.tags.map(String):[],
        instructions: String(s.instructions || s.content || s.prompt),
        scopeHint: (s.scopeHint==='3005'||s.scopeHint==='3006'||s.scopeHint==='both')?s.scopeHint:'both',
        recommended: !!s.recommended, source, author: s.author?String(s.author):undefined,
        repoUrl: s.repoUrl||s.url ? String(s.repoUrl||s.url):undefined,
      };
      if (state.customSkills[id] && !payload.merge && !payload.overwrite) state.customSkills[id] = { ...state.customSkills[id], ...def, id, source };
      else state.customSkills[id] = def;
      importedSkills++;
    } catch(e:any){ errors.push(`skill ${s?.name}: ${e?.message||e}`); }
  }

  // MCPs: array nosso, ou mapa mcpServers/servers
  const mcpsArr: any[] = Array.isArray(payload.mcps) ? payload.mcps : (Array.isArray(payload.servers) ? payload.servers : []);
  for (const m of mcpsArr) {
    const def = normMcpEntry(String(m?.name||m?.id||'mcp'), m, source);
    if (!def) { errors.push(`mcp inválido: ${m?.id||m?.name||'?'}`); continue; }
    state.customMcps[def.id] = def; importedMcps++;
  }
  const mcpMap = (payload.mcpServers && typeof payload.mcpServers==='object') ? payload.mcpServers
    : (payload.servers && !Array.isArray(payload.servers) && typeof payload.servers==='object' ? payload.servers : null);
  if (mcpMap) {
    for (const [name, v] of Object.entries(mcpMap)) {
      const def = normMcpEntry(name, v, source);
      if (def) { state.customMcps[def.id] = def; importedMcps++; }
      else errors.push(`mcpServers.${name} inválido`);
    }
  }

  persist();
  return { ok: errors.length === 0 || (importedSkills+importedMcps)>0, importedSkills, importedMcps, errors };
}

// Compat: export name used earlier in codebase style if any
export const SKILL_CATALOG = BUILTIN_SKILLS;
export const MCP_CATALOG = BUILTIN_MCPS;
