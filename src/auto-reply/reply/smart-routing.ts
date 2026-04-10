/**
 * Smart model routing — heuristic message classifier.
 *
 * Classifies inbound messages into three tiers (simple / moderate / complex)
 * using zero-LLM-cost regex/keyword heuristics. When enabled, simple messages
 * are routed to a fast local model (e.g. 3B), moderate to a larger local model,
 * and complex to the configured API model (e.g. Claude).
 *
 * Inspired by LocalClaw's 3-tier routing system.
 *
 * @module
 */

import { normalizeModelRef } from "../../agents/models/model-selection.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type MessageComplexity = "simple" | "moderate" | "complex";

/**
 * Routing profile — predefined bias presets that shift tier thresholds.
 *
 * - "balanced" (default): standard heuristic thresholds.
 * - "cost-optimized": aggressively routes to cheaper local models.
 * - "quality-first": biases toward the API/orchestrator model.
 * - "local-only": never routes to cloud — all messages stay on local models.
 */
export type RoutingProfile = "balanced" | "cost-optimized" | "quality-first" | "local-only";

export type AgentRoutingConfig = {
  /** Enable smart routing (default: false — zero behavior change without opt-in). */
  enabled?: boolean;
  /** Routing profile preset (default: "balanced"). */
  profile?: RoutingProfile;
  /** Fast-tier model for simple messages (e.g. "ollama/qwen3:1.7b"). */
  fastModel?: string;
  /** Local-tier model for moderate messages (e.g. "ollama/gemma3:12b"). */
  localModel?: string;
  /** Max message length (chars) for simple classification (default: 150). */
  maxSimpleLength?: number;
  /** Context token cap for fast model (default: 4096). */
  fastModelContextTokens?: number;
  /** ECO-tier model for ultra-short messages under 20 words (e.g. "gemini-2.5-flash-lite"). */
  ecoModel?: string;
  /**
   * Per-persona model overrides — maps persona name to a model string.
   * When the current agent persona matches a key, that model is used instead of tier routing.
   * @example { "Researcher": "anthropic/claude-opus-4-6", "Quick": "openai/gpt-4o-mini" }
   */
  personaModels?: Record<string, string>;
};

export type AgentOrchestratorConfig = {
  /** Enable orchestrator escalation for complex messages (default: false). */
  enabled?: boolean;
  /** Orchestrator model (e.g. "anthropic/claude-sonnet-4"). */
  model?: string;
  /** Routing strategy (default: "auto"). */
  strategy?: "auto" | "always" | "fallback-only";
};

/** B.3: Default timeouts for local model tiers. */
const LOCAL_TIER_TIMEOUT_MS = 240_000; // 4 min when fallback model available
const LOCAL_ONLY_TIER_TIMEOUT_MS = 600_000; // 10 min when no cloud fallback

export type SmartRoutingResult = {
  complexity: MessageComplexity;
  /** Provider override (undefined = use default). */
  provider?: string;
  /** Model override (undefined = use default). */
  model?: string;
  /** Whether tool calling should be disabled. */
  disableTools: boolean;
  /** Context token cap override (undefined = use default). */
  contextTokensCap?: number;
  /** Timeout in ms for the LLM call. When exceeded, caller should escalate to fallback. */
  timeoutMs?: number;
  /**
   * When true, the caller should reset the model back to the local/fast
   * tier after this turn completes. Prevents a single complex message from
   * locking all subsequent messages to the expensive orchestrator model.
   *
   * Inspired by LocalClaw's per-message model reset pattern.
   */
  resetModelAfterTurn?: boolean;
  /** Whether orchestrator was used for this routing decision. */
  orchestrated?: boolean;
  /** Estimated cost in cents for this routing decision (from pricing table). */
  estimatedCostCents?: number;
  /** Percentage savings vs routing to the default API model. */
  savingsPercent?: number;
};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SIMPLE_LENGTH = 150;
const DEFAULT_FAST_CONTEXT_TOKENS = 4096;

/** Patterns that always indicate complex messages. */
const COMPLEX_PATTERNS: RegExp[] = [
  // Code blocks (triple backticks or indented code)
  /```[\s\S]*?```/,
  /^    \S/m,
  // File paths (Unix or Windows)
  /(?:\/[\w.-]+){2,}/,
  /[A-Z]:\\[\w\\.-]+/,
  // URLs
  /https?:\/\/\S+/,
  // Version numbers (e.g., v1.2.3, 3.14.0)
  /\bv?\d+\.\d+\.\d+\b/,
  // Import/require statements
  /\b(?:import|require|from)\s+['"][\w@/.-]+['"]/,
  // Stack traces
  /at\s+\S+\s+\([\w/\\.-]+:\d+:\d+\)/,
  // JSON-like structures
  /\{[\s\S]*"[\w]+"\s*:/,
  // Shell commands with pipes or redirection
  /\|\s*\w+|[>]{1,2}\s*\S+/,
  // Regex patterns
  /\/[^/\s]+\/[gims]*/,
];

/** Keywords that strongly indicate complex messages (case-insensitive, word boundary). */
const COMPLEX_KEYWORDS = new Set([
  "fix",
  "debug",
  "create",
  "build",
  "refactor",
  "implement",
  "deploy",
  "configure",
  "install",
  "migrate",
  "optimize",
  "analyze",
  "architect",
  "design",
  "test",
  "compile",
  "transpile",
  "bundle",
  "lint",
  "format",
  "scaffold",
  "provision",
  "integrate",
  "authenticate",
  "authorize",
  "encrypt",
  "decrypt",
  "serialize",
  "parse",
  "validate",
  "transform",
  "resolve",
  "investigate",
  "diagnose",
  "benchmark",
  "profile",
  "containerize",
  "dockerize",
  "orchestrate",
  "pipeline",
  "workflow",
  "database",
  "schema",
  "mutation",
  "endpoint",
  "middleware",
  "component",
  "module",
  "package",
  "dependency",
  "algorithm",
  "function",
  "class",
  "interface",
  "typescript",
  "javascript",
  "python",
  "rust",
  "docker",
  "kubernetes",
]);

/** Keywords that indicate moderate complexity (need tools or lookups). */
const MODERATE_KEYWORDS = new Set([
  "show",
  "list",
  "find",
  "search",
  "lookup",
  "check",
  "email",
  "calendar",
  "weather",
  "reminder",
  "schedule",
  "send",
  "read",
  "open",
  "download",
  "upload",
  "fetch",
  "get",
  "set",
  "update",
  "delete",
  "remove",
  "add",
  "copy",
  "move",
  "rename",
  "status",
  "summarize",
  "translate",
  "calculate",
  "convert",
  "compare",
  "explain",
  "describe",
]);

// ── Multilingual keyword maps (C.2) — lazy-loaded per language ───────────────

type LangKeywordSet = { complex: Set<string>; moderate: Set<string> };

// Lazy-load keyword sets so they're only materialized when the detected
// language actually matches. Most sessions only ever hit 0-1 languages.

const _multilingualCache = new Map<string, LangKeywordSet>();

function getZhKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("zh");
  if (!kw) {
    kw = {
      complex: new Set([
        "修复",
        "调试",
        "创建",
        "构建",
        "重构",
        "部署",
        "配置",
        "安装",
        "迁移",
        "优化",
        "分析",
        "设计",
        "测试",
        "编译",
        "实现",
        "数据库",
        "算法",
        "接口",
        "组件",
        "模块",
      ]),
      moderate: new Set([
        "显示",
        "查找",
        "搜索",
        "检查",
        "发送",
        "读取",
        "打开",
        "下载",
        "上传",
        "更新",
        "删除",
        "添加",
        "复制",
        "移动",
        "状态",
        "总结",
        "翻译",
        "计算",
        "比较",
        "解释",
      ]),
    };
    _multilingualCache.set("zh", kw);
  }
  return kw;
}

function getJaKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("ja");
  if (!kw) {
    kw = {
      complex: new Set([
        "修正",
        "デバッグ",
        "作成",
        "構築",
        "リファクタ",
        "デプロイ",
        "設定",
        "インストール",
        "移行",
        "最適化",
        "分析",
        "設計",
        "テスト",
        "コンパイル",
        "実装",
        "データベース",
        "アルゴリズム",
      ]),
      moderate: new Set([
        "表示",
        "検索",
        "確認",
        "送信",
        "読む",
        "開く",
        "ダウンロード",
        "アップロード",
        "更新",
        "削除",
        "追加",
        "コピー",
        "移動",
        "ステータス",
        "翻訳",
        "計算",
        "比較",
        "説明",
      ]),
    };
    _multilingualCache.set("ja", kw);
  }
  return kw;
}

function getKoKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("ko");
  if (!kw) {
    kw = {
      complex: new Set([
        "수정",
        "디버그",
        "생성",
        "빌드",
        "리팩터",
        "배포",
        "구성",
        "설치",
        "마이그레이션",
        "최적화",
        "분석",
        "설계",
        "테스트",
        "컴파일",
        "구현",
        "데이터베이스",
        "알고리즘",
      ]),
      moderate: new Set([
        "표시",
        "검색",
        "확인",
        "보내기",
        "읽기",
        "열기",
        "다운로드",
        "업로드",
        "업데이트",
        "삭제",
        "추가",
        "복사",
        "이동",
        "상태",
        "번역",
        "계산",
        "비교",
        "설명",
      ]),
    };
    _multilingualCache.set("ko", kw);
  }
  return kw;
}

function getRuKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("ru");
  if (!kw) {
    kw = {
      complex: new Set([
        "исправить",
        "отладить",
        "создать",
        "построить",
        "рефакторинг",
        "развернуть",
        "настроить",
        "установить",
        "мигрировать",
        "оптимизировать",
        "анализировать",
        "спроектировать",
        "тестировать",
        "скомпилировать",
        "реализовать",
        "база данных",
        "алгоритм",
      ]),
      moderate: new Set([
        "показать",
        "найти",
        "искать",
        "проверить",
        "отправить",
        "прочитать",
        "открыть",
        "скачать",
        "загрузить",
        "обновить",
        "удалить",
        "добавить",
        "копировать",
        "переместить",
        "статус",
        "перевести",
        "посчитать",
        "сравнить",
        "объяснить",
      ]),
    };
    _multilingualCache.set("ru", kw);
  }
  return kw;
}

function getDeKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("de");
  if (!kw) {
    kw = {
      complex: new Set([
        "reparieren",
        "debuggen",
        "erstellen",
        "bauen",
        "refactoren",
        "deployen",
        "konfigurieren",
        "installieren",
        "migrieren",
        "optimieren",
        "analysieren",
        "entwerfen",
        "testen",
        "kompilieren",
        "implementieren",
        "datenbank",
        "algorithmus",
      ]),
      moderate: new Set([
        "zeigen",
        "finden",
        "suchen",
        "prüfen",
        "senden",
        "lesen",
        "öffnen",
        "herunterladen",
        "hochladen",
        "aktualisieren",
        "löschen",
        "hinzufügen",
        "kopieren",
        "verschieben",
        "status",
        "übersetzen",
        "berechnen",
        "vergleichen",
        "erklären",
      ]),
    };
    _multilingualCache.set("de", kw);
  }
  return kw;
}

function getEsKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("es");
  if (!kw) {
    kw = {
      complex: new Set([
        "arreglar",
        "depurar",
        "crear",
        "construir",
        "refactorizar",
        "desplegar",
        "configurar",
        "instalar",
        "migrar",
        "optimizar",
        "analizar",
        "diseñar",
        "probar",
        "compilar",
        "implementar",
        "base de datos",
        "algoritmo",
      ]),
      moderate: new Set([
        "mostrar",
        "buscar",
        "verificar",
        "enviar",
        "leer",
        "abrir",
        "descargar",
        "subir",
        "actualizar",
        "eliminar",
        "agregar",
        "copiar",
        "mover",
        "estado",
        "traducir",
        "calcular",
        "comparar",
        "explicar",
      ]),
    };
    _multilingualCache.set("es", kw);
  }
  return kw;
}

function getPtKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("pt");
  if (!kw) {
    kw = {
      complex: new Set([
        "corrigir",
        "depurar",
        "criar",
        "construir",
        "refatorar",
        "implantar",
        "configurar",
        "instalar",
        "migrar",
        "otimizar",
        "analisar",
        "projetar",
        "testar",
        "compilar",
        "implementar",
        "banco de dados",
        "algoritmo",
      ]),
      moderate: new Set([
        "mostrar",
        "buscar",
        "verificar",
        "enviar",
        "ler",
        "abrir",
        "baixar",
        "enviar",
        "atualizar",
        "excluir",
        "adicionar",
        "copiar",
        "mover",
        "status",
        "traduzir",
        "calcular",
        "comparar",
        "explicar",
      ]),
    };
    _multilingualCache.set("pt", kw);
  }
  return kw;
}

function getArKeywords(): LangKeywordSet {
  let kw = _multilingualCache.get("ar");
  if (!kw) {
    kw = {
      complex: new Set([
        "إصلاح",
        "تصحيح",
        "إنشاء",
        "بناء",
        "إعادة هيكلة",
        "نشر",
        "تكوين",
        "تثبيت",
        "ترحيل",
        "تحسين",
        "تحليل",
        "تصميم",
        "اختبار",
        "تجميع",
        "تنفيذ",
        "قاعدة بيانات",
        "خوارزمية",
      ]),
      moderate: new Set([
        "عرض",
        "بحث",
        "تحقق",
        "إرسال",
        "قراءة",
        "فتح",
        "تنزيل",
        "رفع",
        "تحديث",
        "حذف",
        "إضافة",
        "نسخ",
        "نقل",
        "حالة",
        "ترجمة",
        "حساب",
        "مقارنة",
        "شرح",
      ]),
    };
    _multilingualCache.set("ar", kw);
  }
  return kw;
}

/** Lazy getter dispatch — returns keyword set for the given language, or undefined. */
const MULTILINGUAL_GETTERS: Record<string, () => LangKeywordSet> = {
  zh: getZhKeywords,
  ja: getJaKeywords,
  ko: getKoKeywords,
  ru: getRuKeywords,
  de: getDeKeywords,
  es: getEsKeywords,
  pt: getPtKeywords,
  ar: getArKeywords,
};

function getMultilingualKeywords(lang: string): LangKeywordSet | undefined {
  return MULTILINGUAL_GETTERS[lang]?.();
}

/**
 * Unicode script range detection for language-specific keyword lookup.
 * Returns a language code or "en" as fallback.
 */
function detectMessageLanguage(text: string): string {
  // Count characters in specific Unicode ranges
  let cjkCount = 0;
  let hangulCount = 0;
  let cyrillicCount = 0;
  let arabicCount = 0;
  let latinCount = 0;
  let jpOnlyCount = 0; // Hiragana + Katakana only (subset of cjkCount, for ja vs zh disambiguation)
  let total = 0;

  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20) {
      continue;
    } // skip control chars
    total++;
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjkCount++;
    } // CJK Unified
    else if (code >= 0x3040 && code <= 0x30ff) {
      cjkCount++;
      jpOnlyCount++;
    } // Hiragana + Katakana
    else if (code >= 0xac00 && code <= 0xd7af) {
      hangulCount++;
    } // Hangul
    else if (code >= 0x0400 && code <= 0x04ff) {
      cyrillicCount++;
    } // Cyrillic
    else if (code >= 0x0600 && code <= 0x06ff) {
      arabicCount++;
    } // Arabic
    else if (code >= 0x0041 && code <= 0x024f) {
      latinCount++;
    } // Basic+Extended Latin
  }

  if (total === 0) {
    return "en";
  }
  const threshold = total * 0.15;

  // Japanese: has Hiragana/Katakana (distinct from pure CJK which signals Chinese)
  if (jpOnlyCount > threshold) {
    return "ja";
  }
  if (hangulCount > threshold) {
    return "ko";
  }
  if (cjkCount > threshold) {
    return "zh";
  }
  if (cyrillicCount > threshold) {
    return "ru";
  }
  if (arabicCount > threshold) {
    return "ar";
  }

  // For Latin-script languages, use keyword heuristics
  if (latinCount > threshold) {
    const lower = text.toLowerCase();
    // Quick heuristic: check for common function words
    if (/\b(der|die|das|ist|und|nicht|ich|ein)\b/.test(lower)) {
      return "de";
    }
    if (/\b(el|la|los|las|es|está|por|con|del)\b/.test(lower)) {
      return "es";
    }
    if (/\b(o|os|as|é|está|por|com|dos|das)\b/.test(lower)) {
      return "pt";
    }
  }

  return "en";
}

/**
 * Check if a word matches any multilingual complex/moderate keyword.
 * Used as a supplement to the English keyword check.
 */
function classifyWordMultilingual(word: string, lang: string): "complex" | "moderate" | undefined {
  const keywords = getMultilingualKeywords(lang);
  if (!keywords) {
    return undefined;
  }
  if (keywords.complex.has(word)) {
    return "complex";
  }
  if (keywords.moderate.has(word)) {
    return "moderate";
  }
  return undefined;
}

/** Affirmative/confirmation patterns that indicate moderate (may need tools for context). */
const AFFIRMATIVE_PATTERNS =
  /^(?:go\s+ahead|do\s+it|proceed|continue|yes\s+please|sure|absolutely|go\s+for\s+it|make\s+it\s+so|execute|run\s+it|ship\s+it)\s*[.!]?\s*$/i;

/** Bare ambiguous acknowledgements → simple. */
const BARE_ACK_PATTERNS =
  /^(?:yes|yeah|yep|yup|no|nah|nope|ok|okay|k|sure|thanks|thank\s+you|ty|thx|cool|nice|great|good|awesome|perfect|lol|haha|heh|👍|👎|❤️|🙏|😊|😂|🤣|🎉|✅|❌)\s*[.!?]?\s*$/i;

// ── Classifier ───────────────────────────────────────────────────────────────

// Memoize the last classification result — messages are processed serially so
// caching one (message, maxSimpleLength) → result pair avoids redundant work
// when the same message is classified multiple times in a single turn.
let _lastClassifyInput: { message: string; maxSimple: number } | undefined;
let _lastClassifyResult: MessageComplexity | undefined;

/**
 * Classify a message's complexity using heuristic rules.
 * First match wins.
 */
export function classifyMessage(
  message: string,
  options?: { maxSimpleLength?: number },
): MessageComplexity {
  const maxSimple = options?.maxSimpleLength ?? DEFAULT_MAX_SIMPLE_LENGTH;

  // Fast-path: return cached result when inputs haven't changed.
  if (
    _lastClassifyInput &&
    _lastClassifyResult &&
    _lastClassifyInput.message === message &&
    _lastClassifyInput.maxSimple === maxSimple
  ) {
    return _lastClassifyResult;
  }

  const result = classifyMessageCore(message, maxSimple);
  _lastClassifyInput = { message, maxSimple };
  _lastClassifyResult = result;
  return result;
}

/** Core classification logic — separated so the memoization wrapper stays clean. */
function classifyMessageCore(message: string, maxSimple: number): MessageComplexity {
  // 1. Empty / whitespace-only → simple
  const trimmed = message.trim();
  if (!trimmed) {
    return "simple";
  }

  // 2. Complex patterns (code blocks, file paths, URLs, etc.)
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "complex";
    }
  }

  // 3. Complex keywords (English)
  const words = trimmed.toLowerCase().split(/\s+/);
  for (const word of words) {
    // Strip punctuation for matching
    const clean = word.replace(/[^a-z]/g, "");
    if (clean && COMPLEX_KEYWORDS.has(clean)) {
      return "complex";
    }
  }

  // 4. Moderate keywords (English)
  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, "");
    if (clean && MODERATE_KEYWORDS.has(clean)) {
      return "moderate";
    }
  }

  // 4b. Multilingual keyword check (C.2)
  const lang = detectMessageLanguage(trimmed);
  if (lang !== "en" && MULTILINGUAL_GETTERS[lang]) {
    let multilingualResult: "complex" | "moderate" | undefined;
    for (const word of words) {
      const result = classifyWordMultilingual(word, lang);
      if (result === "complex") {
        return "complex";
      }
      if (result === "moderate") {
        multilingualResult = "moderate";
      }
    }
    if (multilingualResult) {
      return multilingualResult;
    }
  }

  // 5. Slash commands → complex (they invoke specific functionality)
  if (/^\/\w+/.test(trimmed)) {
    return "complex";
  }

  // 6. 3+ sentences → complex (long-form request)
  const sentences = trimmed.split(/[.!?]+\s/).filter(Boolean);
  if (sentences.length >= 3) {
    return "complex";
  }

  // 7. Affirmative confirmations → moderate (needs tools for context)
  if (AFFIRMATIVE_PATTERNS.test(trimmed)) {
    return "moderate";
  }

  // 8. Bare acknowledgements → simple
  if (BARE_ACK_PATTERNS.test(trimmed)) {
    return "simple";
  }

  // 9. Message too long for simple
  if (trimmed.length > maxSimple) {
    return "moderate";
  }

  // 10. Default → simple
  return "simple";
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Parse a "provider/model" string into its parts, normalizing both the
 * provider ID and model ID so that aliases and alternate provider names
 * (e.g. "z.ai" → "zai", "opus-4.5" → "claude-opus-4-5") are resolved
 * consistently with the core model-selection pipeline.
 *
 * Returns undefined if the string is empty or missing the slash.
 */
function parseModelRef(ref: string | undefined): { provider: string; model: string } | undefined {
  if (!ref) {
    return undefined;
  }
  const slash = ref.indexOf("/");
  if (slash < 1) {
    return undefined;
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  const normalized = normalizeModelRef(provider, model);
  return { provider: normalized.provider, model: normalized.model };
}

/**
 * Route a message to the appropriate model tier.
 *
 * Returns a routing result indicating model overrides, tool disabling,
 * and context token capping. Returns `undefined` when routing is disabled
 * or doesn't apply (caller should use default behavior).
 */
/**
 * Apply profile bias to shift the classified complexity tier.
 *
 * - "balanced": no change.
 * - "cost-optimized": downgrade moderate → simple, complex → moderate.
 * - "quality-first": upgrade simple → moderate, moderate → complex.
 * - "local-only": cap at moderate (never route to cloud API).
 */
export function applyProfileBias(
  complexity: MessageComplexity,
  profile: RoutingProfile | undefined,
): MessageComplexity {
  const p = profile ?? "balanced";
  if (p === "balanced") {
    return complexity;
  }
  if (p === "cost-optimized") {
    if (complexity === "moderate") {
      return "simple";
    }
    if (complexity === "complex") {
      return "moderate";
    }
    return complexity;
  }
  if (p === "quality-first") {
    if (complexity === "simple") {
      return "moderate";
    }
    if (complexity === "moderate") {
      return "complex";
    }
    return complexity;
  }
  if (p === "local-only") {
    if (complexity === "complex") {
      return "moderate";
    }
    return complexity;
  }
  return complexity;
}

export function routeMessage(params: {
  message: string;
  routing?: AgentRoutingConfig;
  orchestrator?: AgentOrchestratorConfig;
  /** Current agent persona name — used for per-persona model override lookup. */
  currentPersona?: string;
}): SmartRoutingResult | undefined {
  const { message, routing } = params;

  if (!routing?.enabled) {
    return undefined;
  }

  // FF.1: Per-persona model override — check before tier classification.
  if (params.currentPersona && routing.personaModels) {
    const personaModel = routing.personaModels[params.currentPersona];
    if (personaModel) {
      const personaRef = parseModelRef(personaModel);
      if (personaRef) {
        return {
          complexity: "complex",
          provider: personaRef.provider,
          model: personaRef.model,
          disableTools: false,
        };
      }
    }
  }

  // FF.2: ECO tier — ultra-short messages route to the cheapest configured model.
  if (routing.ecoModel) {
    const ecoRef = parseModelRef(routing.ecoModel);
    if (ecoRef) {
      const words = params.message.trim().split(/\s+/).filter(Boolean).length;
      if (words < 20 && params.message.trim().length < 80) {
        return {
          complexity: "simple",
          provider: ecoRef.provider,
          model: ecoRef.model,
          disableTools: true,
          contextTokensCap: routing.fastModelContextTokens ?? DEFAULT_FAST_CONTEXT_TOKENS,
          timeoutMs: LOCAL_TIER_TIMEOUT_MS,
        };
      }
    }
  }

  // "always" strategy: skip tier classification, route everything to orchestrator.
  // (local-only profile disables orchestrator always-route to keep traffic local)
  if (routing.profile !== "local-only") {
    const alwaysRoute = routeAlwaysOrchestrator(params.orchestrator);
    if (alwaysRoute) {
      return alwaysRoute;
    }
  }

  const rawComplexity = classifyMessage(message, {
    maxSimpleLength: routing.maxSimpleLength,
  });
  const complexity = applyProfileBias(rawComplexity, routing.profile);

  const fastRef = parseModelRef(routing.fastModel);
  const localRef = parseModelRef(routing.localModel);
  // B.3: Pick timeout based on whether a cloud fallback exists.
  const hasFallback = Boolean(params.orchestrator?.enabled && params.orchestrator.model);
  const localTimeoutMs = hasFallback ? LOCAL_TIER_TIMEOUT_MS : LOCAL_ONLY_TIER_TIMEOUT_MS;

  switch (complexity) {
    case "simple": {
      if (!fastRef) {
        // No fast model configured — fall through to default
        return undefined;
      }
      return {
        complexity: "simple",
        provider: fastRef.provider,
        model: fastRef.model,
        disableTools: true,
        contextTokensCap: routing.fastModelContextTokens ?? DEFAULT_FAST_CONTEXT_TOKENS,
        timeoutMs: localTimeoutMs,
      };
    }

    case "moderate": {
      if (!localRef) {
        // No local model configured — fall through to default
        return undefined;
      }
      return {
        complexity: "moderate",
        provider: localRef.provider,
        model: localRef.model,
        disableTools: false,
        timeoutMs: localTimeoutMs,
      };
    }

    case "complex": {
      return routeComplex(params.orchestrator);
    }
  }
}

// ── Orchestrator dispatch ────────────────────────────────────────────────────

/**
 * Route a complex message based on the orchestrator strategy.
 *
 * - `auto` (default): complex → orchestrator model, simple/moderate → local.
 * - `always`: always use orchestrator. Simple/moderate handled by caller via
 *   the "always" strategy check before tier routing.
 * - `fallback-only`: use local/default for everything; orchestrator only on
 *   failure (handled at the caller level, not here).
 */
function routeComplex(orchestrator?: AgentOrchestratorConfig): SmartRoutingResult {
  const strategy = orchestrator?.strategy ?? "auto";

  if (orchestrator?.enabled && orchestrator.model) {
    const orchRef = parseModelRef(orchestrator.model);

    if (strategy === "auto" && orchRef) {
      return {
        complexity: "complex",
        provider: orchRef.provider,
        model: orchRef.model,
        disableTools: false,
        resetModelAfterTurn: true,
        orchestrated: true,
      };
    }

    // "always" strategy complex case — same as auto.
    if (strategy === "always" && orchRef) {
      return {
        complexity: "complex",
        provider: orchRef.provider,
        model: orchRef.model,
        disableTools: false,
        resetModelAfterTurn: true,
        orchestrated: true,
      };
    }
  }

  // fallback-only or no orchestrator configured — use default API model.
  return {
    complexity: "complex",
    disableTools: false,
  };
}

/**
 * For the "always" strategy: route ANY message to the orchestrator, regardless
 * of classification tier. Local model is used as fallback only if orchestrator
 * is unreachable (handled by the caller).
 *
 * Returns undefined if the strategy isn't "always" or orchestrator isn't configured.
 */
export function routeAlwaysOrchestrator(
  orchestrator?: AgentOrchestratorConfig,
): SmartRoutingResult | undefined {
  if (!orchestrator?.enabled || orchestrator.strategy !== "always" || !orchestrator.model) {
    return undefined;
  }
  const orchRef = parseModelRef(orchestrator.model);
  if (!orchRef) {
    return undefined;
  }
  return {
    complexity: "complex",
    provider: orchRef.provider,
    model: orchRef.model,
    disableTools: false,
    resetModelAfterTurn: true,
    orchestrated: true,
  };
}

// ── Session Pinning ──────────────────────────────────────────────────────────

export type SessionPin = {
  provider: string;
  model: string;
  complexity: MessageComplexity;
  pinnedAt: number;
  /** Full routing result — preserved so callers can apply all routing properties (timeout, context cap, etc.). */
  routingResult: SmartRoutingResult;
};

/**
 * In-memory session pin map — bounded with TTL eviction.
 *
 * When a session's first message is routed to a specific model, subsequent
 * messages reuse that model without re-classifying — preventing jarring
 * mid-conversation model switches.
 *
 * Pins are scoped by session key and auto-expire after SESSION_PIN_TTL_MS.
 * Map is capped at SESSION_PIN_MAX_ENTRIES to prevent unbounded growth in
 * long-lived processes.
 */
const SESSION_PIN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SESSION_PIN_MAX_ENTRIES = 10_000;

const sessionPins = new Map<string, SessionPin>();

/** Evict expired entries and enforce max-size cap. */
function evictStalePins(): void {
  const now = Date.now();
  for (const [key, pin] of sessionPins) {
    if (now - pin.pinnedAt > SESSION_PIN_TTL_MS) {
      sessionPins.delete(key);
    }
  }
  // If still over cap after TTL sweep, remove oldest entries
  if (sessionPins.size > SESSION_PIN_MAX_ENTRIES) {
    const entries = [...sessionPins.entries()].toSorted((a, b) => a[1].pinnedAt - b[1].pinnedAt);
    const toRemove = entries.length - SESSION_PIN_MAX_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      sessionPins.delete(entries[i][0]);
    }
  }
}

/**
 * Pin a session to a specific model routing result.
 */
export function pinSession(sessionKey: string, result: SmartRoutingResult): void {
  if (!result.provider || !result.model) {
    return;
  }
  // Periodic eviction: run every 100 writes to amortize cost
  if (sessionPins.size > 0 && sessionPins.size % 100 === 0) {
    evictStalePins();
  }
  sessionPins.set(sessionKey, {
    provider: result.provider,
    model: result.model,
    complexity: result.complexity,
    pinnedAt: Date.now(),
    routingResult: result,
  });
}

/**
 * Get the current pin for a session, or undefined if not pinned / expired.
 */
export function getSessionPin(sessionKey: string): SessionPin | undefined {
  const pin = sessionPins.get(sessionKey);
  if (!pin) {
    return undefined;
  }
  // Lazy TTL check on read
  if (Date.now() - pin.pinnedAt > SESSION_PIN_TTL_MS) {
    sessionPins.delete(sessionKey);
    return undefined;
  }
  return pin;
}

/**
 * Remove a session's pin (e.g. on session reset or model change command).
 */
export function unpinSession(sessionKey: string): boolean {
  return sessionPins.delete(sessionKey);
}

/**
 * Clear all session pins (e.g. on config reload).
 */
export function clearAllSessionPins(): void {
  sessionPins.clear();
}

/** @internal — exposed for tests only */
export const _sessionPinInternals = {
  sessionPins,
  evictStalePins,
  SESSION_PIN_TTL_MS,
  SESSION_PIN_MAX_ENTRIES,
} as const;

// ── System Prompt ────────────────────────────────────────────────────────────

/** System prompt suffix injected when routing to fast model (tools disabled). */
export const FAST_CHAT_SYSTEM_PROMPT = `IMPORTANT: You are in fast chat mode. Respond conversationally in plain text only.
Do NOT output any JSON, tool calls, function calls, or code blocks.
Do NOT attempt to use memory_get, read, email, or any other tool.
Just reply naturally as a helpful assistant.`;

// ── Memory Snapshot ──────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import path from "node:path";

const MEMORY_SNAPSHOT_MAX_CHARS = 800;

/**
 * Read a concise memory snapshot for injection into the fast model's system prompt.
 *
 * Looks for `memory/state.md` in the workspace directory. Returns undefined if
 * the file is missing or empty. Truncates at 800 chars to stay within small
 * model context budgets.
 */
export async function readMemorySnapshot(workspaceDir: string): Promise<string | undefined> {
  const statePath = path.join(workspaceDir, "memory", "state.md");
  let content: string;
  try {
    content = await readFile(statePath, "utf-8");
  } catch {
    return undefined;
  }
  if (!content.trim()) {
    return undefined;
  }
  if (content.length > MEMORY_SNAPSHOT_MAX_CHARS) {
    content = content.slice(0, MEMORY_SNAPSHOT_MAX_CHARS) + "\n[...truncated]";
  }
  return `## Current Memory State (read-only snapshot)\n\n${content}`;
}
