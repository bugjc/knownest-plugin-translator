// ============================================================
// translator/lib/prompt - 翻译素材与方向判断（纯函数，单测锁定）
// 管什么：目标语言解析（显式优先 / auto 字符集互译）、翻译约束行（唯一来源）、
//         单文本素材与文档批次素材构造（沉浸式设计：只输出译文/格式保真/术语保护）。
// 不管什么：外部接口调用（agent-llm 引擎素材由 Agent 消费；direct 引擎 R2 另建）。
// 被谁调用：lib/providers/agent-llm.js（契约实现）、index.js（方向解析）。
// ============================================================

const LANGS = {
  zh: { code: 'zh-CN', label: '中文' },
  en: { code: 'en', label: '英文' },
  ja: { code: 'ja', label: '日文' },
  ko: { code: 'ko', label: '韩文' },
  fr: { code: 'fr', label: '法文' },
  de: { code: 'de', label: '德文' },
}

/** 汉字字符占比 */
function cjkRatio(text) {
  const t = String(text || '')
  if (!t) return 0
  const cjk = t.match(/[\u4e00-\u9fff]/g)
  return cjk ? cjk.length / t.length : 0
}

/**
 * 方向解析：显式指定优先（zh/en/ja/ko/fr/de 或自定义串）；auto=中文源→英文、其他→中文。
 * 返回 { code, label, sourceLang }；sourceLang 仅 auto 推断标记（zh/non-zh，frontmatter 排查用）。
 * 混排阈值 0.35：中文技术笔记（内嵌英文术语）的典型 CJK 占比下限（评审 P2-7）。
 */
function detectDirection(text, targetLang) {
  const t = String(targetLang || 'auto').trim().toLowerCase()
  const isZh = cjkRatio(text) > 0.35
  if (t === 'auto' || t === '') {
    return isZh ? { ...LANGS.en, sourceLang: 'zh' } : { ...LANGS.zh, sourceLang: 'non-zh' }
  }
  if (LANGS[t]) return { ...LANGS[t], sourceLang: isZh ? 'zh' : 'non-zh' }
  const code = t.replace(/[^a-z0-9-]/g, '') || 'xx'
  return { code, label: t, sourceLang: isZh ? 'zh' : 'non-zh' }
}

/**
 * 翻译约束（唯一来源，文本/文档素材共用）。
 * termsLines=术语对照行（S4 术语表注入，命中的术语必须按对照翻译）；
 * style='bilingual'（R5-S2 双语交错）：首条约束替换为交错格式指令——每段先原样输出原文、空一行后输出译文。
 */
function constraintLines(termsLines, style) {
  const first = style === 'bilingual'
    ? '1. 输出为双语交错：对原文每个段落，先原样输出该段原文（保持格式），随后空一行输出该段译文；除段落原文与译文外不要任何解释、注释、前言或后记；'
    : '1. 只输出译文，不要任何解释、注释、前言或后记；'
  const base = [
    first,
    '2. Markdown 格式、代码块、URL、文件路径、命令行保持原样不译；',
    '3. 专有名词/技术术语拿不准时保留原文并在括号内附译文；',
    '4. 段落数量与顺序与原文一致，不增删内容。',
  ]
  if (termsLines && termsLines.length) base.splice(3, 0, ...termsLines)
  return base
}

/** 术语对照行（S4）：命中源文本的用户术语表条目 → 「原文必须译为：译名」约束 */
function termMatchLines(text, terms) {
  const hits = (terms || []).filter((t) => t && t.term && text.toLowerCase().indexOf(String(t.term).toLowerCase()) !== -1)
  if (!hits.length) return []
  return ['术语对照（以下术语必须按对照翻译）：' + hits.map((t) => `${t.term}→${t.tr}`).join('；')]
}

/** 单文本素材（translate_text 用）；terms=用户术语表（命中注入对照约束）；style='bilingual' 双语交错 */
function buildTextMaterial(text, dir, terms, style) {
  return [
    `请将以下内容翻译成${dir.label}。以专业${dir.label}译者标准执行：`,
    ...constraintLines(termMatchLines(text, terms), style),
    '',
    '——原文开始——',
    text,
    '——原文结束——',
  ].join('\n')
}

/** 文档批次素材（translate_doc 用；批次协议头由 index.js 组织，本函数只出素材体） */
function buildBatchMaterial(batchText, dir, meta) {
  const tag = meta && meta.batchTotal > 1 ? `（第 ${meta.batchIndex}/${meta.batchTotal} 批）` : ''
  return [
    `请将以下文档片段翻译成${dir.label}${tag}。以专业${dir.label}译者标准执行：`,
    ...constraintLines(meta && meta.termsLines, meta && meta.style),
    '',
    '——片段开始——',
    batchText,
    '——片段结束——',
  ].join('\n')
}

// ⚠️ 沙箱缓存契约：exports 属性赋值，禁止 module.exports 重赋值（见 md5.js 注）
exports.LANGS = LANGS
exports.cjkRatio = cjkRatio
exports.detectDirection = detectDirection
exports.constraintLines = constraintLines
exports.buildTextMaterial = buildTextMaterial
exports.termMatchLines = termMatchLines
exports.buildBatchMaterial = buildBatchMaterial
