// ============================================================
// translator/lib/sys-hub - sys-hub 译文落盘契约（路径推导/frontmatter/MD5 指纹，纯逻辑+ctx 查询）
// 管什么：sys-hub 仓库解析、译文路径推导（sys-hub/translator/translations/<源仓库>/<文档名>.<lang>.md）、
//         frontmatter 组装/解析、缓存有效性判定（source_md5+target_lang 三元组）。
// 不管什么：实际读写（index.js 经 ctx.writeFile/readFile/query 执行——宿主对未入库
//          路径 readFile 返回空串，判定存在性必须走 documents 表查询，晨报实证）。
// 落点契约（收敛点批 2026-10-10）：sys-hub 工作空间规则 sys-hub/<ownerId>/<spaceKey>/——
//          译文落「translator/translations/<源仓库>/」（owner=插件 id，spaceKey 稳定 slug）。
// 被谁调用：index.js translate_doc / save_translation。
// ============================================================

const path = require('path')
const { md5Hex } = require('./md5')

/** 路径归一（Windows \ / 大小写不敏感比较用） */
function normalize(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

/** 解析 sys-hub 仓库（不存在返回 null，由调用方报错） */
async function resolveSysHub(ctx) {
  const repos = (await ctx.listRepositories()) || []
  return repos.find((r) => r.name === 'sys-hub') || null
}

/** 源文档所属仓库名（localPath 前缀匹配；未命中归「未归档」） */
function resolveSourceRepoName(repos, sourcePath) {
  const np = normalize(sourcePath)
  const hit = (repos || []).find((r) => r.localPath && np.startsWith(normalize(r.localPath)))
  return hit ? hit.name : '未归档'
}

function baseNameOf(sourcePath) {
  return path.basename(String(sourcePath)).replace(/\.(md|markdown|txt)$/i, '')
}

/** 译文路径：sys-hub/translator/translations/<源仓库>/<文档名>.<lang>.md */
function translationPathFor(hubLocalPath, repoName, sourcePath, langCode) {
  return path.join(hubLocalPath, 'translator', 'translations', repoName, `${baseNameOf(sourcePath)}.${langCode}.md`)
}

function md5Of(content) {
  return md5Hex(content)
}

/** 组装译文文档：frontmatter（指纹契约，style=bilingual|plain）+ 源文档 wikilink 头部 + 译文正文 */
function buildTranslationDoc({ sourcePath, sourceMd5, dir, engine, repoName, translation, style }) {
  const fm = [
    '---',
    'type: translation',
    `source_ref: ${sourcePath}`,
    `source_md5: ${sourceMd5}`,
    `target_lang: ${dir.code}`,
    `source_lang: ${dir.sourceLang || 'unknown'}`,
    `engine: ${engine}`,
    `style: ${style || 'plain'}`,
    `translated-at: ${new Date().toISOString()}`,
    '---',
    '',
    '',
    `> 🌐 译文 · 源文档：[[${baseNameOf(sourcePath)}]]（${repoName}）`,
    '',
    translation,
    '',
  ]
  return fm.join('\n')
}

/** 解析 frontmatter（无/损坏返回 null，调用方按未命中处理） */
function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(md || ''))
  if (!m) return null
  const fields = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return fields
}

/**
 * 缓存有效性判定：译文已入库（documents 表）且 frontmatter 三元组一致 → 返回译文路径，否则 null。
 * MD5 一致+目标语言一致才命中；frontmatter 损坏视为未命中（自愈：重新生成覆盖）。
 */
async function findValidCache(ctx, translationPath, sourceMd5, langCode, style) {
  // 命中权威=磁盘文件三元组（M3 修复）：此前以「已入索引」为前置——save 后的全仓重索引
  // 未完成窗口内二次翻译必然误判未命中重翻（烧配额且重写译文，accept B2 实证）。
  // 文件在场且指纹/语言/模式一致即命中；可检索性由 save 侧已触发的重索引异步达成。
  try {
    const old = await ctx.readFile(translationPath)
    const fm = parseFrontmatter(old)
    if (fm && fm.source_md5 === sourceMd5 && fm.target_lang === langCode && (fm.style || 'plain') === (style || 'plain')) return translationPath
  } catch { /* 读取失败按未命中 */ }
  return null
}

// ⚠️ 沙箱缓存契约：exports 属性赋值，禁止 module.exports 重赋值（见 md5.js 注）
exports.normalize = normalize
exports.resolveSysHub = resolveSysHub
exports.resolveSourceRepoName = resolveSourceRepoName
exports.baseNameOf = baseNameOf
exports.translationPathFor = translationPathFor
exports.md5Of = md5Of
exports.buildTranslationDoc = buildTranslationDoc
exports.parseFrontmatter = parseFrontmatter
exports.findValidCache = findValidCache
