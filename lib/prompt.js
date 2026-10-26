// ============================================================
// translator/lib/prompt - 翻译素材与方向判断（纯函数，单测锁定）
// 管什么：目标语言解析（显式优先 / auto 字符集互译）、翻译约束行（唯一来源）、
//         单文本素材与文档批次素材构造（沉浸式设计：只输出译文/格式保真/术语保护）、
//         领域方案术语合并（2026-10-03 职业翻译方案 B0）、免费引擎附注、括号术语沉淀建议。
// 不管什么：外部接口调用（agent-llm 引擎素材由 Agent 消费；direct 引擎 R2 另建）、
//         领域包数据本体（lib/domain-packs.js）、启用状态存储（index.js plugin_kv 'domain'）。
// 被谁调用：lib/providers/agent-llm.js（契约实现）、index.js（方向解析/术语合并/附注/沉淀）。
// ============================================================

const domainPacks = require('./domain-packs')

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
 * style='bilingual'（R5-S2 双语交错）：首条约束替换为交错格式指令——每段先原样输出原文、空一行后输出译文；
 * styleLine=领域包风格约束行（职业翻译方案 B0）：紧随术语对照行注入（无术语时插在约束 3 与 4 之间）；
 * 两者皆空时输出与旧版逐字节一致（零回归红线，DoD 8）。
 */
function constraintLines(termsLines, style, styleLine) {
  const first = style === 'bilingual'
    ? '1. 输出为双语交错：对原文每个段落，先原样输出该段原文（保持格式），随后空一行输出该段译文；除段落原文与译文外不要任何解释、注释、前言或后记；'
    : '1. 只输出译文，不要任何解释、注释、前言或后记；'
  const base = [
    first,
    '2. Markdown 格式、代码块、URL、文件路径、命令行保持原样不译；',
    '3. 专有名词/技术术语拿不准时保留原文并在括号内附译文；',
    '4. 段落数量与顺序与原文一致，不增删内容。',
  ]
  const termsCount = termsLines && termsLines.length ? termsLines.length : 0
  if (termsCount) base.splice(3, 0, ...termsLines)
  if (styleLine) base.splice(3 + termsCount, 0, styleLine)
  return base
}

/** 命中提取（termMatchLines 与 freeTermsNote 共用，规则 7）：源文本子串命中（忽略大小写） */
function matchTerms(text, terms) {
  const src = String(text || '').toLowerCase()
  return (terms || []).filter((t) => t && t.term && src.indexOf(String(t.term).toLowerCase()) !== -1)
}

/** 术语对照行（S4）：命中源文本的用户术语表条目 → 「原文必须译为：译名」约束 */
function termMatchLines(text, terms) {
  const hits = matchTerms(text, terms)
  if (!hits.length) return []
  return ['术语对照（以下术语必须按对照翻译）：' + hits.map((t) => `${t.term}→${t.tr}`).join('；')]
}

/**
 * 领域方案解析（B1，D1/D2 拍板）：用户自定义术语与已启用领域包合并——同 term（忽略大小写）用户自定义永远胜出。
 * packId 空/'none'/未知 → 仅用户术语（零启用时素材与旧版逐字节一致）。
 * 返回 { terms, styleLine, packLabel }。
 */
function resolveActiveTerms(userTerms, packId) {
  const list = (Array.isArray(userTerms) ? userTerms : [])
    .map((t) => ({ term: String((t && t.term) || '').trim(), tr: String((t && t.tr) || '').trim() }))
    .filter((t) => t.term && t.tr)
  const pack = domainPacks.getPack(packId)
  if (!pack) return { terms: list, styleLine: '', packLabel: '' }
  const seen = new Set(list.map((t) => t.term.toLowerCase()))
  for (const t of pack.terms) {
    const key = String((t && t.term) || '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    list.push({ term: t.term, tr: t.tr })
  }
  return { terms: list, styleLine: pack.styleLine || '', packLabel: pack.label }
}

/** 免费引擎附注行（B1 诚实化 §3.3）：命中术语附注呈现并明示未强制；无命中返回空串（划词结果零变化）。 */
function freeTermsNote(terms, srcText) {
  const hits = matchTerms(srcText, terms)
  if (!hits.length) return ''
  return '\n\n> 📎 术语表命中：' + hits.map((t) => `${t.term}→${t.tr}`).join('；') + '（免费快引擎未强制，交给白泽可按术语表翻译）'
}

/** 沉淀建议扫描（B2 §3.6）：译文中「原文（译文）」形态的括号术语 → 建议记入术语表；已在术语表的跳过；上限 5。 */
function bracketTermSuggestions(translation, knownTerms) {
  const src = String(translation || '')
  const known = new Set((knownTerms || []).map((t) => String((t && t.term) || '').toLowerCase()))
  const out = []
  const re = /([A-Za-z][A-Za-z0-9 .'_-]{1,30}?)（([^（）]{1,24})）/g
  let m
  while ((m = re.exec(src)) !== null && out.length < 5) {
    const term = m[1].trim()
    const tr = m[2].trim()
    if (!term || !tr) continue
    if (known.has(term.toLowerCase())) continue
    if (out.some((s) => s.term.toLowerCase() === term.toLowerCase())) continue
    out.push({ term, tr })
  }
  return out
}

/** 单文本素材（translate_text 用）；terms=生效术语表（用户∪领域包）；style='bilingual' 双语交错；
 *  styleLine=领域包风格约束；hitNote=命中摘要行（置于原文标记之前，零命中不出现）。 */
function buildTextMaterial(text, dir, terms, style, styleLine, hitNote) {
  const rows = [
    `请将以下内容翻译成${dir.label}。以专业${dir.label}译者标准执行：`,
    ...constraintLines(termMatchLines(text, terms), style, styleLine),
  ]
  if (hitNote) rows.push(hitNote)
  rows.push('', '——原文开始——', text, '——原文结束——')
  return rows.join('\n')
}

/** 文档批次素材（translate_doc 用；批次协议头由 index.js 组织，本函数只出素材体） */
function buildBatchMaterial(batchText, dir, meta) {
  const tag = meta && meta.batchTotal > 1 ? `（第 ${meta.batchIndex}/${meta.batchTotal} 批）` : ''
  return [
    `请将以下文档片段翻译成${dir.label}${tag}。以专业${dir.label}译者标准执行：`,
    ...constraintLines(meta && meta.termsLines, meta && meta.style, meta && meta.styleLine),
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
exports.matchTerms = matchTerms
exports.termMatchLines = termMatchLines
exports.resolveActiveTerms = resolveActiveTerms
exports.freeTermsNote = freeTermsNote
exports.bracketTermSuggestions = bracketTermSuggestions
exports.buildTextMaterial = buildTextMaterial
exports.buildBatchMaterial = buildBatchMaterial
