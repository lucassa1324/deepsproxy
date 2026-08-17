/*
 * File: task-classifier.ts
 * Project: deepsproxy
 * Classificador de tarefas — analisa a mensagem do usuário e determina
 * que tipo de capacidades o modelo precisa ter para resolver a tarefa.
 *
 * Usa heurísticas baseadas em palavras-chave e padrões para classificar
 * tarefas sem necessidade de chamadas a IA externa (zero custo extra).
 */

import type { TaskClassification, ModelCapabilities } from './types.ts';

// ── Padrões de classificação por categoria ──────────────────────────────

interface CategoryPattern {
  category: keyof ModelCapabilities;
  /** Palavras/frases que indicam a categoria (case-insensitive). */
  keywords: string[];
  /** Peso da palavra-chave (0-1). */
  weight: number;
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: 'coding',
    keywords: [
      // Português
      'programação', 'programar', 'código', 'códigos', 'implementar', 'implemente',
      'função', 'funções', 'classe', 'classes', 'método', 'métodos', 'api', 'endpoint',
      'bug', 'bugs', 'debug', 'depurar', 'refatorar', 'refatoração', 'refator',
      'compilar', 'compilação', 'compilador', 'typescript', 'javascript', 'python',
      'node', 'react', 'angular', 'vue', 'html', 'css', 'sql', 'database', 'banco de dados',
      'servidor', 'server', 'backend', 'frontend', 'fullstack', 'framework',
      'variável', 'constante', 'array', 'objeto', 'loop', 'laço', 'condicional',
      'algoritmo', 'estrutura de dados', 'repositório', 'git', 'docker', 'kubernetes',
      'pipelines', 'ci/cd', 'deploy', 'serviço', 'microserviço', 'middleware',
      'autenticação', 'autorização', 'criptografia', 'hash', 'token',
      'regex', 'expressão regular', 'parse', 'serializar', 'deserializar',
      'endpoint', 'rota', 'route', 'controller', 'service', 'handler',
      // Inglês
      'code', 'coding', 'program', 'implement', 'function', 'class', 'method',
      'api', 'endpoint', 'bug', 'debug', 'refactor', 'compile', 'typescript',
      'javascript', 'python', 'node', 'react', 'angular', 'vue', 'html', 'css',
      'sql', 'database', 'server', 'backend', 'frontend', 'framework', 'algorithm',
      'variable', 'constant', 'array', 'object', 'loop', 'conditional', 'git', 'docker',
      'deploy', 'microservice', 'middleware', 'authentication', 'encrypt', 'hash',
      'regex', 'parse', 'serialize', 'route', 'controller', 'service', 'component',
      'arquivo', 'file', 'script', 'build', 'compilar', 'buildar', 'npm', 'yarn',
      'pip', 'cargo', 'go build', 'makefile', 'package.json',
    ],
    weight: 1.0,
  },
  {
    category: 'reasoning',
    keywords: [
      'analise', 'analisar', 'análise', 'avalie', 'avaliar', 'avaliação',
      'explique', 'explique por que', 'por que', 'porque', 'qual a razão',
      'raciocínio', 'deduza', 'dedução', 'deduzir', 'inferência', 'inferir',
      'compare', 'comparação', 'contraste', 'diferença', 'semelhança',
      'prós e contras', 'vantagens', 'desvantagens',
      'planeje', 'planejar', 'planejamento', 'estratégia', 'estratégico',
      'decida', 'decisão', 'decidir', 'qual é a melhor', 'recomende',
      'problema lógico', 'logica', 'lógica', 'raciocine',
      'analyze', 'analyze', 'explain', 'why', 'reasoning', 'deduce', 'deduction',
      'compare', 'contrast', 'pros and cons', 'advantages', 'disadvantages',
      'plan', 'planning', 'strategy', 'decide', 'decision', 'recommend',
      'logical problem', 'logic', 'reason',
      'arquitetura', 'architecture', 'design pattern', 'padrão de projeto',
      'refatoração', 'refactoring', 'revisão de código', 'code review',
    ],
    weight: 1.0,
  },
  {
    category: 'math',
    keywords: [
      'matemática', 'matematica', 'calcular', 'cálculo', 'calculo',
      'equação', 'equacao', 'equação diferencial', 'integral', 'derivada',
      'geometria', 'álgebra', 'algebra', 'estatística', 'estatistica',
      'probabilidade', 'regressão', 'regressao', 'média', 'media',
      'desvio padrão', 'variação', 'variancia',
      'soma', 'subtração', 'multiplicação', 'divisão',
      'fatorial', 'combinatória', 'combinatoria', 'permutação', 'permutacao',
      'teorema', 'prova', 'demonstração', 'demonstracao',
      'matriz', 'vetor', 'tensor',
      'math', 'mathematics', 'calculate', 'calculation', 'equation',
      'calculus', 'integral', 'derivative', 'geometry', 'algebra',
      'statistics', 'probability', 'regression', 'mean', 'average',
      'standard deviation', 'variance', 'factorial', 'combinatorics',
      'theorem', 'proof', 'matrix', 'vector', 'tensor',
      'soma', 'resolva', 'solve', 'quanto é', 'what is',
    ],
    weight: 1.0,
  },
  {
    category: 'writing',
    keywords: [
      'escreva', 'escrever', 'texto', 'redação', 'redigir', 'artigo',
      'blog', 'post', 'publicação', 'publicacao', 'newsletter',
      'email', 'e-mail', 'mensagem', 'carta', 'ofício', 'oficio',
      'relatório', 'relatorio', 'documento', 'documentação', 'documentacao',
      'copywriting', 'copy', 'slogan', 'tagline', 'manchete',
      'criativo', 'criatividade', 'estilo', 'tom de voz',
      'publicitário', 'publicitario', 'marketing', 'propaganda',
      'poema', 'poesia', 'conto', 'história', 'historia', 'narrativa',
      'roteiro', 'script', 'dialogo', 'diálogo',
      'tradução', 'traduza', 'traduzir', 'translate',
      'resumo', 'resumir', 'sumário', 'sumario', 'síntese', 'sintese',
      'paráfrase', 'parafrase', 'reescreva', 'rewrite',
      'write', 'writing', 'text', 'essay', 'article', 'blog', 'post',
      'email', 'message', 'letter', 'report', 'document', 'documentation',
      'copywriting', 'copy', 'slogan', 'headline', 'creative', 'style',
      'marketing', 'advertising', 'poem', 'poetry', 'story', 'narrative',
      'script', 'dialogue', 'translate', 'translation', 'summary', 'summarize',
      'rewrite', 'paraphrase',
      'crie um texto', 'escreva um', 'write a', 'draft',
    ],
    weight: 1.0,
  },
  {
    category: 'vision',
    keywords: [
      'imagem', 'imagens', 'foto', 'fotos', 'photograph', 'photographs',
      'desenho', 'desenhos', 'drawing', 'drawings',
      'gráfico', 'grafico', 'gráficos', 'graficos', 'chart', 'charts',
      'diagrama', 'diagramas', 'diagram', 'diagrams',
      'screenshot', 'print', 'tela', 'interface', 'ui', 'ux',
      'analise essa imagem', 'analyze this image', 'o que tem na imagem',
      'what is in the image', 'descreva a imagem', 'describe the image',
      'visual', 'ocr', 'reconhecimento de texto', 'text recognition',
      'pixel', 'pixels', 'resolução', 'resolution',
      'veja', 'see', 'olhe', 'look', 'observe',
      'image', 'images', 'photo', 'picture', 'visual',
      'art', 'arte', 'painting', 'pintura', 'illustration', 'ilustração',
      '3d', 'render', 'renderização',
    ],
    weight: 1.0,
  },
  {
    category: 'general',
    keywords: [
      'o que é', 'quem é', 'onde é', 'quando é', 'como funciona',
      'what is', 'who is', 'where is', 'when is', 'how does',
      'explique', 'explain', 'definição', 'definition',
      'qual é', 'what is', 'liste', 'list', 'liste os', 'list the',
      'diferença entre', 'difference between',
      'opinião', 'opinion', 'conselho', 'advice', 'sugestão', 'suggestion',
      'tutorial', 'guia', 'guide', 'como fazer', 'how to',
      'informação', 'information', 'dados', 'data', 'fato', 'fact',
      'conhecimento', 'knowledge', 'curiosidade', 'curiosity',
    ],
    weight: 0.6, // Peso menor: general é o fallback
  },
];

// ── Indicadores de complexidade ─────────────────────────────────────────

interface ComplexityIndicator {
  pattern: RegExp;
  delta: number;  // Mudança na complexidade (-0.3 a +0.4)
  description: string;
}

const COMPLEXITY_INDICATORS: ComplexityIndicator[] = [
  // Complexidade alta
  { pattern: /arquitet|architect|design system|escalab|scalab/i, delta: 0.3, description: 'arquitetura/sistemas complexos' },
  { pattern: /refator.*complet|refactor.*entire|todo o projeto|整个项目/i, delta: 0.3, description: 'refatoração de projeto inteiro' },
  { pattern: /multi.?step|múltiplas etapas|várias etapas|multiple steps/i, delta: 0.2, description: 'processo multi-etapas' },
  { pattern: /compar(e|ação).*modelos?|compare.*models?|versus|vs\.?/i, delta: 0.15, description: 'comparação de abordagens' },
  { pattern: /optimi[zs]|performance|otimize|maximize/i, delta: 0.15, description: 'otimização de performance' },
  { pattern: /seguran[çc]|security|criptografi|encript|vulnerab/i, delta: 0.2, description: 'segurança/cRIPTOGRAFIA' },
  { pattern: /deploy|ci\/cd|pipeline|kubernetes|docker.*com/i, delta: 0.15, description: 'infraestrutura/deploy' },
  { pattern: /debug|debugg|encontre o bug|find the bug|erro.*complex/i, delta: 0.2, description: 'debug complexo' },
  { pattern: /algoritmo.*eficien|algorithm.*efficien|big.?o|complexidade.*temporal/i, delta: 0.25, description: 'análise de algoritmos' },
  { pattern: /concorr|parallel|thread|async.*múltipl|race condition/i, delta: 0.2, description: 'concorrência/paralelismo' },
  { pattern: /machine learning|ml model|neural|deep learning|treinar.*modelo/i, delta: 0.25, description: 'machine learning' },
  { pattern: /sistema.*complet|full.*system|todo.*sistema|end.?to.?end/i, delta: 0.3, description: 'sistema completo' },

  // Complexidade média
  { pattern: /implement|criar.*funç|create.*function|nova.*rota|new.*route/i, delta: 0.1, description: 'implementação de componente' },
  { pattern: /explic|explique|explain|descreva|describe/i, delta: -0.05, description: 'explicação' },
  { pattern: /resumo|summar|resumir|synthesize/i, delta: -0.1, description: 'resumo/síntese' },

  // Complexidade baixa
  { pattern: /^.{0,50}$/i, delta: -0.15, description: 'mensagem curta' },
  { pattern: /converta|convert|transforme|transform/i, delta: -0.1, description: 'conversão simples' },
  { pattern: /liste|list|enumere|enumerate/i, delta: -0.1, description: 'listagem' },
  { pattern: /quanto é|what is \d|calcule.*\d/i, delta: -0.2, description: 'cálculo simples' },
  { pattern: /obrigad|thanks|thank you|valeu|vlw/i, delta: -0.3, description: 'agradecimento' },
];

// ── Indicadores de presença de imagens (multimodal) ─────────────────────

const IMAGE_INDICATORS = [
  /<img\s/i,
  /!\[.*\]\(.*\)/i,         // Markdown image
  /image_url/i,
  /base64/i,
  /content_type.*image/i,
  /type.*image_url/i,
];

// ── Classificador principal ─────────────────────────────────────────────

/**
 * Classifica uma mensagem de usuário em termos de capacidades necessárias
 * e complexidade. Usa heurísticas locais (sem chamadas externas).
 *
 * @param messages - Histórico completo da conversa (últimas N mensagens)
 * @param currentMessage - A mensagem atual do usuário
 */
export function classifyTask(
  messages: Array<{ role: string; content: string | any[] }>,
  currentMessage: string
): TaskClassification {
  const text = extractTextContent(currentMessage);
  const fullContext = buildContext(messages, text);

  // 1. Detectar categorias necessárias
  const categories = detectCategories(fullContext);

  // 2. Estimar complexidade
  const complexity = estimateComplexity(fullContext, messages);

  // 3. Gerar descrição legível
  const description = describeClassification(categories, complexity);

  return { categories, complexity, description };
}

// ── Helpers internos ────────────────────────────────────────────────────

function extractTextContent(content: string | any[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text || '';
        if (part.type === 'image_url') return '[IMAGE]';
        return '';
      })
      .join(' ');
  }
  return '';
}

function buildContext(messages: Array<{ role: string; content: string | any[] }>, current: string): string {
  // Pega as últimas 6 mensagens para contexto (não precisa de todas)
  const recent = messages.slice(-6);
  const contextParts = recent
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => extractTextContent(m.content));
  contextParts.push(current);
  return contextParts.join(' ').toLowerCase();
}

function detectCategories(text: string): Partial<ModelCapabilities> {
  const scores: Record<string, number> = {};

  for (const pattern of CATEGORY_PATTERNS) {
    let hits = 0;
    for (const keyword of pattern.keywords) {
      const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b|${escapeRegex(keyword)}`, 'gi');
      if (regex.test(text)) hits++;
    }
    if (hits > 0) {
      scores[pattern.category] = (scores[pattern.category] || 0) + hits * pattern.weight;
    }
  }

  // Verificar presença de imagens → boost vision
  const hasImages = IMAGE_INDICATORS.some((p) => p.test(text));
  if (hasImages) {
    scores['vision'] = (scores['vision'] || 0) + 5;
  }

  // Normalizar para 0-10
  const result: Partial<ModelCapabilities> = {};
  const maxScore = Math.max(...Object.values(scores), 1);

  for (const [cat, score] of Object.entries(scores)) {
    const normalized = Math.min(10, Math.round((score / maxScore) * 10));
    if (normalized >= 1) {
      (result as any)[cat] = normalized;
    }
  }

  // Se nenhuma categoria foi detectada, usar general
  if (Object.keys(result).length === 0) {
    result.general = 6;
  }

  return result;
}

function estimateComplexity(text: string, messages: Array<{ role: string; content: string | any[] }>): number {
  let complexity = 0.4; // Base: média

  // Indicadores de complexidade
  for (const indicator of COMPLEXITY_INDICATORS) {
    if (indicator.pattern.test(text)) {
      complexity += indicator.delta;
    }
  }

  // Comprimento da mensagem (mensagens longas tendem a ser mais complexas)
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 200) complexity += 0.1;
  if (wordCount > 500) complexity += 0.1;
  if (wordCount < 15) complexity -= 0.1;

  // Número de mensagens na conversa (conversas longas = mais contexto = mais complexidade)
  if (messages.length > 10) complexity += 0.05;
  if (messages.length > 20) complexity += 0.05;

  // Presença de código no contexto → tende a ser mais complexo
  const codeIndicators = [/```[\s\S]*```/, /function\s/, /class\s/, /import\s/, /const\s|let\s|var\s/];
  const hasCode = codeIndicators.some((p) => p.test(text));
  if (hasCode) complexity += 0.05;

  // Clamp 0-1
  return Math.max(0, Math.min(1, complexity));
}

function describeClassification(
  categories: Partial<ModelCapabilities>,
  complexity: number
): string {
  const catNames: Record<string, string> = {
    reasoning: 'Raciocínio',
    coding: 'Programação',
    math: 'Matemática',
    writing: 'Escrita',
    vision: 'Visão/Imagem',
    general: 'Geral',
  };

  const activeCategories = Object.entries(categories)
    .filter(([, v]) => v && v >= 3)
    .sort(([, a], [, b]) => (b || 0) - (a || 0))
    .map(([k]) => catNames[k] || k);

  const complexityLabel =
    complexity < 0.25 ? 'simples' :
    complexity < 0.5 ? 'intermediária' :
    complexity < 0.75 ? 'complexa' :
    'muito complexa';

  if (activeCategories.length === 0) {
    return `Tarefa ${complexityLabel} — geral`;
  }

  return `Tarefa ${complexityLabel} — ${activeCategories.join(' + ')}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Função para extrair se tem imagens ──────────────────────────────────

export function hasImageInput(messages: Array<{ role: string; content: string | any[] }>): boolean {
  return messages.some((m) => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some((part: any) => part.type === 'image_url' || part.type === 'image');
  });
}
