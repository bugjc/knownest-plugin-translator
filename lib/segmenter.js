// ============================================================
// translator/lib/segmenter - Markdown 文档分段与批次打包（纯函数，单测锁定）
// 管什么：按空行切段 → 单段超长按行二次切 → 行超长按句/空格硬切；段打包成批。
// 不管什么：语义级智能分段（backlog）、翻译本身。
// 被谁调用：index.js translate_doc（批 ≤5000 字符，材料头给规模预期）。
// ============================================================

/** 无自然边界的超长行硬切（优先句号/英文句点/空格，边界不足 40% 长度时按硬长度） */
function hardSplit(line, max) {
  const out = []
  let rest = String(line)
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let at = Math.max(window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf(' '))
    if (at < Math.floor(max * 0.4)) at = max - 1
    const piece = rest.slice(0, at + 1).trim()
    if (piece) out.push(piece)
    rest = rest.slice(at + 1).trimStart()
  }
  if (rest.trim()) out.push(rest.trim())
  return out
}

/** Markdown 内容 → 段落块数组（空行分界；单段超 maxChars 二次切） */
function segmentMarkdown(content, maxChars = 4000) {
  const paras = String(content || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const segs = []
  for (const p of paras) {
    if (p.length <= maxChars) {
      segs.push(p)
      continue
    }
    let cur = ''
    for (const line of p.split('\n')) {
      if (line.length > maxChars) {
        if (cur) { segs.push(cur); cur = '' }
        for (const piece of hardSplit(line, maxChars)) segs.push(piece)
        continue
      }
      if (cur && (cur + '\n' + line).length > maxChars) {
        segs.push(cur)
        cur = line
      } else {
        cur = cur ? cur + '\n' + line : line
      }
    }
    if (cur) segs.push(cur)
  }
  return segs
}

/** 段落块 → 批次数组（连续段打包，批 ≤ maxBatchChars；单段超长独立成批） */
function packBatches(segments, maxBatchChars = 5000) {
  const batches = []
  let cur = []
  let curLen = 0
  for (const seg of segments) {
    if (cur.length && curLen + seg.length + 2 > maxBatchChars) {
      batches.push(cur.join('\n\n'))
      cur = []
      curLen = 0
    }
    cur.push(seg)
    curLen += seg.length + 2
  }
  if (cur.length) batches.push(cur.join('\n\n'))
  return batches
}

// ⚠️ 沙箱缓存契约：exports 属性赋值，禁止 module.exports 重赋值（见 md5.js 注）
exports.segmentMarkdown = segmentMarkdown
exports.packBatches = packBatches
exports.hardSplit = hardSplit
