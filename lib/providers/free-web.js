// ============================================================
// translator/lib/providers/free-web - TranslateProvider 契约实现（direct 模式）
// 免费公共翻译接口：MyMemory（api.mymemory.translated.net，无密钥，真机实证可达；
// 匿名配额约 5000 字符/天/IP、单请求 ≤500 字符——只做短文本快翻，整篇走 agent-llm）。
// 网络经沙箱 fetch 全局 → 宿主 netFetch RPC（net:http 权限门控+审计在宿主）。
// 收敛（2026-10-10）：翻译引擎唯一权威=electron/shared/plugin-stdlib/translate-core.js，
// 经沙箱 knownest.stdlib['translate-core'] 消费（B1' T1 通道）；宿主 free-translate.ts 同源同实现
// ——同一文本热键直翻与应用内选区翻译分块一致、译文一致（用户实证两路结果漂移的收敛修复）。
// 0.16.2 起无本地降级副本（未上线无版本斜窗；quiz-maker 消费 stdlib 同款纪律）：stdlib 缺面
// 抛 FREE_ENGINE_STDLIB_MISSING 显式报错，由调用方既有降级文案接管（面板引导对话流/直翻失败
// 通知）——正常安装（第一方随包种子，宿主/插件同版本）永不触发。
// 边界：单块 ≤450 字符（段落感知分段）、串行+250ms 礼貌间隔、失败抛错由调用方降级
//      （面板回退引导对话流）；非中文源按英文对处理（MyMemory 需显式源语言）。
// 被谁调用：index.js translate_doc_entry（面板一键直翻）与 translate_selection（选区翻译）。
// 契约：{ id, label, mode: 'direct', run(text, opts) → Promise<译文> }
// ============================================================

// 偏斜守卫（quiz-maker 同款）：stdlib 缺面显式报错，不持本地副本——引擎单一实现由平台 stdlib 保障
const std = (typeof knownest !== 'undefined' && knownest.stdlib) || null
const core = std && std['translate-core'] ? std['translate-core'] : null

const TL_MAP = { 'zh-CN': 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de' }

/** MyMemory 需显式语言对：中文源=zh-CN，其他源按英文对（best-effort，dir.sourceLang 只有 zh/non-zh） */
function langpairFor(dir) {
  const target = TL_MAP[(dir && dir.code) || 'zh-CN'] || (dir && dir.code) || 'zh-CN'
  const source = (dir && dir.sourceLang) === 'zh' ? 'zh-CN' : 'en'
  return source + '|' + target
}

exports.id = 'free-web'
exports.label = '免费快引擎'
exports.mode = 'direct'

/** 直连翻译：段落感知切块串行翻译后拼接（分块/串行/拼接全部委托共享内核；
 *  与宿主热键直翻同一实现、同一错误码前缀契约；整篇精度场景走 agent-llm） */
exports.run = async function run(text, opts = {}) {
  if (!core) throw new Error('FREE_ENGINE_STDLIB_MISSING（平台共享翻译内核缺面：请完整重启应用重试，或改用 AI 质量轨）')
  const src = String(text || '')
  if (!src.trim()) throw new Error('FREE_ENGINE_EMPTY_TEXT')
  return core.translateChunks(src, { langpair: langpairFor(opts.dir), errorPrefix: 'FREE_ENGINE' })
}
