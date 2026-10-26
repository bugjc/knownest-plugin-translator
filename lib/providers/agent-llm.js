// ============================================================
// translator/lib/providers/agent-llm - TranslateProvider 契约参考实现（material 模式）
// 契约（冻结于 T2，两期不改签名）：
//   { id, label, mode: 'material' | 'direct', material?(text, opts), run?(text, opts) }
//   material 引擎：构造素材+约束，译文由 Agent 在对话内产出（本文件）
//   direct 引擎：插件内直接产出译文 Promise（R2 免费引擎另建 free-web.js）
// 被谁调用：index.js（工具编排选 provider）。
// ============================================================

const prompt = require('../prompt')

// ⚠️ 沙箱缓存契约：exports 属性赋值，禁止 module.exports 重赋值（见 ../md5.js 注）
exports.id = 'agent-llm'
exports.label = 'Agent 模型'
exports.mode = 'material'

/**
 * @param {string} text 待译文本（单文本或文档批次片段）
 * @param {object} opts { dir: detectDirection 结果, terms?, styleLine?, hitNote?,
 *                        doc?: {batchIndex, batchTotal, style, termsLines, styleLine} }
 *   单文本模式此前丢失 opts.terms（S4 术语注入在对话即译路径从未生效）——2026-10-03 B1 修复。
 */
exports.material = function material(text, opts = {}) {
  const dir = opts.dir
  if (!dir) throw new Error('agent-llm.material 缺少 dir（detectDirection 结果）')
  if (opts.doc) return prompt.buildBatchMaterial(text, dir, opts.doc)
  return prompt.buildTextMaterial(text, dir, opts.terms, undefined, opts.styleLine, opts.hitNote)
}
