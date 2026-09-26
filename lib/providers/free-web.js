// ============================================================
// translator/lib/providers/free-web - TranslateProvider 契约实现（direct 模式）
// 免费公共翻译接口：MyMemory（api.mymemory.translated.net，无密钥，真机实证可达；
// 匿名配额约 5000 字符/天/IP、单请求 ≤500 字符——只做短文本快翻，整篇走 agent-llm）。
// 网络经沙箱 fetch 全局 → 宿主 netFetch RPC（net:http 权限门控+审计在宿主）。
// 边界：单块 ≤450 字符（段落感知分段复用 segmenter）、串行+250ms 礼貌间隔、
//      失败抛错由调用方降级（面板回退引导对话流）；非中文源按英文对处理（MyMemory 需显式源语言）。
// 被谁调用：index.js translate_doc_entry（面板一键直翻）。
// 契约：{ id, label, mode: 'direct', run(text, opts) → Promise<译文> }
// ============================================================

const { segmentMarkdown } = require('../segmenter')

const MM_ENDPOINT = 'https://api.mymemory.translated.net/get'
const CHUNK_CHARS = 450
const PAUSE_MS = 250
const TL_MAP = { 'zh-CN': 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de' }

/** MyMemory 需显式语言对：中文源=zh-CN，其他源按英文对（best-effort，dir.sourceLang 只有 zh/non-zh） */
function langpairFor(dir) {
  const target = TL_MAP[(dir && dir.code) || 'zh-CN'] || (dir && dir.code) || 'zh-CN'
  const source = (dir && dir.sourceLang) === 'zh' ? 'zh-CN' : 'en'
  return source + '|' + target
}

async function translateChunk(chunk, pair) {
  const url = MM_ENDPOINT + '?q=' + encodeURIComponent(chunk) + '&langpair=' + encodeURIComponent(pair)
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Knomi Translate)' } })
  if (!resp.ok) throw new Error('FREE_ENGINE_HTTP_' + resp.status)
  const data = await resp.json()
  const text = data && data.responseData && data.responseData.translatedText
  if (typeof text !== 'string' || !text.trim()) throw new Error('FREE_ENGINE_BAD_RESPONSE')
  return text
}

exports.id = 'free-web'
exports.label = '免费快引擎'
exports.mode = 'direct'

/** 直连翻译：段落感知切块串行翻译后拼接（块间以空行衔接；原文段落内强制切块会引入额外换行——整篇精度场景走 agent-llm） */
exports.run = async function run(text, opts = {}) {
  const src = String(text || '')
  if (!src.trim()) throw new Error('FREE_ENGINE_EMPTY_TEXT')
  const pair = langpairFor(opts.dir)
  const segs = segmentMarkdown(src, CHUNK_CHARS)
  const out = []
  for (const seg of segs) {
    out.push(await translateChunk(seg, pair))
    if (segs.length > 1) await new Promise((r) => setTimeout(r, PAUSE_MS))
  }
  return out.join('\n\n')
}
