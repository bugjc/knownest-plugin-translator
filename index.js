// ============================================================
// translator - 翻译助手（迭代计划 docs/iteration-plans/2026-09-18-translation-plugin-plan.md T2/T3）
//
// 管什么：翻译工具面三件——translate_text（对话即译素材）、translate_doc（文档级：
//         MD5 缓存检查 → 批次素材 + Agent 驱动分批协议）、save_translation（译文落
//         sys-hub「翻译/」+ 重索引）；使用计数（ctx.storage plugin_kv 'stats' 命名空间）。
// 不管什么：免费 direct 引擎（R2/T8）、选中翻译浮层与侧边栏翻译页（R2）、双语交错（R2 可配置）。
// 被谁调用：plugin-host 激活；Agent 对话/快速提问窗口经工具编排调用。
// 会话：文档翻译进度存模块级 Map（docPath 键，save 即清）；deactivate 重置。
// 契约：素材+约束一体返回；缓存命中短路（source_md5+target_lang 一致）；写盘后必须
//      reindexRepository（未入库文档 readFile 读不回，晨报实证）；计数失败不阻主流程。
// ============================================================

const agentLlm = require('./lib/providers/agent-llm')
const freeWeb = require('./lib/providers/free-web')
const { detectDirection } = require('./lib/prompt')
const { segmentMarkdown, packBatches } = require('./lib/segmenter')
const hub = require('./lib/sys-hub')

const PROVIDERS = [agentLlm, freeWeb]
const SEG_CHARS = 4000
const MAX_BATCH_CHARS = 5000
/** 面板一键直翻的免费引擎字数上限（MyMemory 匿名配额+短文本定位；超长走对话流 agent-llm 分批） */
const DIRECT_ENGINE_MAX_CHARS = 3000

let ctx = null
/** 文档翻译会话：docPath → { docPath, translationPath, docTitle, repoName, sourceMd5, dir, batchTotal, segmentCount, contentLength } */
const docSessions = new Map()

/** 翻译文档解析：完整路径精确 → 文件名/标题唯一匹配（多义报候选，防误译） */
async function resolveDocPath(c, input) {
  const docs = (await c.getDocuments()) || []
  const np = hub.normalize(input)
  const exact = docs.find((d) => hub.normalize(d.filePath) === np)
  if (exact) return { path: exact.filePath }
  const base = np.split('/').pop().replace(/\.(md|markdown|txt)$/i, '')
  const hits = docs.filter((d) => {
    const fb = hub.normalize(d.filePath).split('/').pop().replace(/\.(md|markdown|txt)$/i, '')
    const t = hub.normalize(String(d.title || ''))
    return fb === base || t === base
  })
  if (hits.length === 1) return { path: hits[0].filePath }
  if (hits.length > 1) {
    return { error: `DOC_AMBIGUOUS（「${input}」匹配到 ${hits.length} 篇同名/同标题文档）：请提供完整路径。候选：${hits.slice(0, 3).map((h) => h.filePath).join(' ; ')}` }
  }
  return { error: `DOC_NOT_FOUND（${input}）：请提供知识库内文档的完整路径或文件名` }
}

/** 使用计数（plugin_kv 'stats'；db:write 门控；失败不影响主流程） */
async function bumpCounter(key) {
  try {
    const cur = (await ctx.storage.get('stats', key)) || 0
    await ctx.storage.set('stats', key, Number(cur) + 1)
  } catch { /* 静默：计数非关键路径 */ }
}

/** 文档缓存检查（translate_doc 工具与 translate_doc_entry 面板共用，规则 7 唯一实现）：
 *  style=bilingual|plain（R5-S2 配置 bilingual，缓存键含 style——切换模式后按语义重译）；
 *  返回 { hubRepo, translationPath, repoName, dir, docTitle, sourceMd5, cachedPath, style } */
async function checkDocTranslation(docPath, content, targetLang) {
  const sourceMd5 = hub.md5Of(content)
  const dir = detectDirection(content, targetLang)
  const docTitle = hub.baseNameOf(docPath)
  let style = 'plain'
  try { style = ((await ctx.getConfig()) || {}).bilingual === true ? 'bilingual' : 'plain' } catch { /* 配置读取失败按 plain */ }
  const hubRepo = await hub.resolveSysHub(ctx)
  let translationPath = null
  let repoName = '未归档'
  let cachedPath = null
  if (hubRepo) {
    const repos = (await ctx.listRepositories()) || []
    repoName = hub.resolveSourceRepoName(repos, docPath)
    translationPath = hub.translationPathFor(hubRepo.localPath, repoName, docPath, dir.code)
    cachedPath = await hub.findValidCache(ctx, translationPath, sourceMd5, dir.code, style)
  }
  return { hubRepo, translationPath, repoName, dir, docTitle, sourceMd5, cachedPath, style }
}

// ⚠️ 沙箱缓存契约：入口与 lib 一律 exports.x 属性赋值，禁止 module.exports 重赋值——
// plugin-sandbox-child 的 moduleCache 在执行前缓存 exports 快照（见 lib/md5.js 注）

const VERSION = '0.9.0'

exports.id = 'translator'
exports.name = '翻译助手'
exports.version = VERSION
exports.description = '翻译能力包：对话即译 + 文档级翻译（译文落 sys-hub「翻译/」，MD5 缓存命中秒回；agent-llm 引擎，无需翻译服务密钥）'

exports.activate = async function activate(context) {
    ctx = context

    context.registerAgentTool(
      {
        name: 'translate_text',
        description: '翻译一段文本。用户说「翻译/译成中文/翻成英文」并提供文本时使用；快速提问窗口（划词快捷键见「设置 → 快捷键」）同样可用。返回翻译任务素材，由你按其中约束产出译文。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '待翻译原文' },
            target_lang: { type: 'string', description: '目标语言：zh/en/ja/ko/fr/de，缺省 auto=自动互译（中文源→英文，其他→中文）' }
          },
          required: ['text']
        }
      },
      async (args) => {
        const text = String((args && args.text) ?? '').trim()
        if (!text) return { output: '', error: 'EMPTY_TEXT' }
        if (text.length > 6000) {
          return { output: '', error: 'TEXT_TOO_LONG（超 6000 字符，请分次翻译，或对整篇文档使用 translate_doc）' }
        }
        const dir = detectDirection(text, args && args.target_lang)
        const terms = await getTerms()
        await bumpCounter('text_translated')
        return { output: agentLlm.material(text, { dir, terms }) }
      }
    )

    context.registerAgentTool(
      {
        name: 'translate_doc',
        description: '翻译文档工具。用户消息提到「翻译」且对象是文档时必须调用本工具（触发例：「翻译这篇文档」「把 xxx 翻译成中文」「翻译一下 xxx」）。本工具自动查缓存（源文档未变更直接秒回）并把译文落盘 sys-hub「翻译/」使其可检索、可出题；调用后你会收到翻译素材，按素材输出译文文本，再调用 save_translation 保存。禁止用文件编辑工具生成译文文件，禁止把译文放进待确认变更。',
        parameters: {
          type: 'object',
          properties: {
            doc_path: { type: 'string', description: '文档完整路径或文件名（唯一匹配即可）' },
            target_lang: { type: 'string', description: '目标语言：zh/en/ja/ko/fr/de，缺省 auto=自动互译方向' },
            batch: { type: 'number', description: '批次号（多批文档取后续批次时传 2..K；缺省 1）' }
          },
          required: ['doc_path']
        }
      },
      async (args) => {
        const raw = String((args && args.doc_path) || '').trim()
        if (!raw) return { output: '', error: 'NO_DOC_PATH' }
        const r = await resolveDocPath(ctx, raw)
        if (r.error) return { output: '', error: r.error }
        const docPath = r.path

        const content = await ctx.readFile(docPath)
        if (!content || !content.trim()) {
          return { output: '', error: 'DOC_EMPTY_OR_NOT_INDEXED（宿主对未入库路径返回空串，请确认文档已在知识库索引）' }
        }

        const info = await checkDocTranslation(docPath, content, args && args.target_lang)
        if (info.cachedPath) {
          await bumpCounter('doc_cache_hits')
          return { output: `✅ 缓存命中（源文档自上次翻译后未变更，MD5 一致）：\n译文路径：${info.cachedPath}\n请告知用户可直接打开该译文文档，无需重新翻译。` }
        }

        const segments = segmentMarkdown(content, SEG_CHARS)
        const batches = packBatches(segments, MAX_BATCH_CHARS)
        docSessions.set(docPath, { docPath, translationPath: info.translationPath, docTitle: info.docTitle, repoName: info.repoName, sourceMd5: info.sourceMd5, dir: info.dir, style: info.style, batchTotal: batches.length, segmentCount: segments.length, contentLength: content.length })

        const batchNo = Math.max(1, Math.min(parseInt((args && args.batch), 10) || 1, batches.length))
        const terms = await getTerms()
        const termsHits = terms.filter((t) => t && t.term && batches[batchNo - 1].toLowerCase().indexOf(String(t.term).toLowerCase()) !== -1)
        const material = agentLlm.material(batches[batchNo - 1], { dir: info.dir, terms, doc: { batchIndex: batchNo, batchTotal: batches.length, style: info.style, termsLines: termsHits.length ? ['术语对照（以下术语必须按对照翻译）：' + termsHits.map((t) => `${t.term}→${t.tr}`).join('；')] : undefined } })

        const lines = []
        if (batchNo === 1) {
          lines.push(`📋 翻译任务：《${info.docTitle}》→ ${info.dir.label}（引擎：${PROVIDERS.map((p) => p.label).join('/')}，消耗当前模型配额；模式：${info.style === 'bilingual' ? '双语交错' : '纯译文'}）`)
          lines.push(`源文档：${docPath}`)
          lines.push(`规模：共 ${segments.length} 段 / ${content.length} 字符，分 ${batches.length} 批（每批 ≤${MAX_BATCH_CHARS} 字符）`)
          lines.push(info.hubRepo
            ? `缓存：未命中（首次翻译或源文档已变更），完成后由 save_translation 写入 sys-hub「翻译/${info.repoName}/」`
            : '⚠️ 未找到 sys-hub 系统仓库，完成后无法落盘保存')
          lines.push('')
          if (batches.length > 1) {
            lines.push('请按批完成翻译：')
            lines.push(`1. 逐批调用 translate_doc（doc_path 不变，batch=2..${batches.length}）获取其余批次素材；`)
            lines.push('2. 每批只输出该批译文（保持段落顺序，不要复述原文、不要解释）；')
            lines.push(`3. 全部批次完成后调用 save_translation（doc_path + translation=各批译文按顺序拼接）一次保存。`)
          } else {
            lines.push('请产出全文译文（保持段落顺序，不要复述原文、不要解释），然后调用 save_translation（doc_path + translation）保存。')
          }
          lines.push('')
          await bumpCounter('doc_started')
        } else {
          lines.push(`《${info.docTitle}》第 ${batchNo}/${batches.length} 批素材（翻译约束同第 1 批）：`)
          lines.push('')
        }
        lines.push(material)
        return { output: lines.join('\n') }
      }
    )

    context.registerAgentTool(
      {
        name: 'save_translation',
        description: '把已完成翻译的文档译文保存到 sys-hub「翻译/」（含源文档指纹 frontmatter 与回跳链接，写入后自动重索引）。文档各批译文全部产出后调用；doc_path 用 translate_doc 时的同一路径。',
        parameters: {
          type: 'object',
          properties: {
            doc_path: { type: 'string', description: '源文档路径（与 translate_doc 一致）' },
            translation: { type: 'string', description: '完整译文（多批文档=各批译文按顺序拼接）' }
          },
          required: ['doc_path', 'translation']
        }
      },
      async (args) => {
        const docPath = String((args && args.doc_path) || '').trim()
        const translation = String((args && args.translation) || '').trim()
        if (!docPath || !translation) return { output: '', error: 'MISSING_ARGS（doc_path 与 translation 均必填）' }
        // 会话查找三级兜底：模型回传的 doc_path 可能是文件名/别名，而会话键=translate_doc 解析后的完整路径
        let s = docSessions.get(docPath)
        if (!s) {
          const r = await resolveDocPath(ctx, docPath)
          if (!r.error && docSessions.has(r.path)) s = docSessions.get(r.path)
        }
        if (!s) {
          const base = hub.normalize(docPath).split('/').pop().replace(/\.(md|markdown|txt)$/i, '')
          for (const [k, v] of docSessions) {
            if (hub.normalize(k).split('/').pop().replace(/\.(md|markdown|txt)$/i, '') === base) { s = v; break }
          }
        }
        if (!s) return { output: '', error: 'NO_SESSION（请先对该文档调用 translate_doc 获取素材）' }
        const hubRepo = await hub.resolveSysHub(ctx)
        if (!hubRepo || !s.translationPath) return { output: '', error: 'NO_SYS_HUB（系统仓库 sys-hub 不存在，无法落盘）' }

        const md = hub.buildTranslationDoc({
          sourcePath: docPath, sourceMd5: s.sourceMd5, dir: s.dir,
          engine: 'agent-llm', repoName: s.repoName, translation, style: s.style,
        })
        await ctx.writeFile(s.translationPath, md)
        await ctx.reindexRepository(hubRepo.id)
        docSessions.delete(docPath)
        await bumpCounter('doc_translated')
        return {
          output: `✅ 译文已写入 sys-hub：${s.translationPath}\n源文档：${docPath}\n请告知用户：译文可在编辑器打开，文档头部链接可回跳源文档；源文档未变更时再次翻译将 MD5 命中秒回。`,
        }
      }
    )

    // 「译文」入口面板（workspace.action 配套；V-b spike 定案升级 2026-09-24：平台字段
    // initialFrom='current_doc_path' 自动带出当前打开文档（平台侧按后缀 {md,markdown,txt} 门控），
    // 手填路径保留为兜底；target_lang defaultValue='auto' 预选自动互译）
    context.registerPanel({
      id: 'translate.form',
      label: '译文',
      surface: 'dock',
      view: 'form',
      hint: '已有译文直接打开（源文档未变更时 MD5 命中秒回，按已保存内容判定）；首次翻译对小诺说「翻译 <文档名>」或未命中时点「交给小诺翻译」，完成后此处即可打开。',
      fields: [
        { key: 'doc_path', label: '源文档', type: 'text', placeholder: '知识库文档路径或文件名', required: true, initialFrom: 'current_doc_path' },
        {
          key: 'target_lang', label: '目标语言', type: 'select', defaultValue: 'auto', options: [
            { value: 'auto', label: '自动互译' },
            { value: 'zh', label: '中文' },
            { value: 'en', label: '英文' },
            { value: 'ja', label: '日文' },
            { value: 'ko', label: '韩文' },
            { value: 'fr', label: '法文' },
            { value: 'de', label: '德文' },
          ],
        },
      ],
      submitLabel: '打开译文',
      submit: 'translate_doc_entry',
    })

    context.registerAgentTool(
      {
        name: 'manage_terms',
        description: '管理翻译术语表（用户自定义术语对照，翻译时自动强制按对照翻译）。用户说「加个术语/把 prompt 翻译成 提示词/删掉术语/看看术语表」时使用。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'list=列出全部 / add=添加或更新 / remove=删除', enum: ['list', 'add', 'remove'] },
            term: { type: 'string', description: '术语原文（add/remove 必填）' },
            translation: { type: 'string', description: '既定译名（add 必填）' }
          },
          required: ['action']
        }
      },
      async (args) => {
        const action = String((args && args.action) || 'list')
        const term = String((args && args.term) || '').trim()
        const tr = String((args && args.translation) || '').trim()
        const list = await getTerms()
        if (action === 'list') {
          if (!list.length) return { output: '术语表为空。添加示例：manage_terms(action=add, term=prompt, translation=提示词)' }
          return { output: '📚 术语表（' + list.length + ' 条，翻译时自动强制按对照翻译）：\n' + list.map((t) => '• ' + t.term + ' → ' + t.tr).join('\n') }
        }
        if (action === 'add') {
          if (!term || !tr) return { output: '', error: 'add 需要 term 与 translation' }
          const i = list.findIndex((t) => t.term.toLowerCase() === term.toLowerCase())
          if (i >= 0) { list[i] = { term, tr } } else { list.push({ term, tr }) }
          await saveTerms(list)
          return { output: '✅ 术语已入表：' + term + ' → ' + tr + '（共 ' + list.length + ' 条，此后翻译自动遵守）' }
        }
        if (action === 'remove') {
          if (!term) return { output: '', error: 'remove 需要 term' }
          const n = list.length
          const next = list.filter((t) => t.term.toLowerCase() !== term.toLowerCase())
          if (next.length === n) return { output: '术语表中没有「' + term + '」' }
          await saveTerms(next)
          return { output: '✅ 已删除术语：' + term + '（剩 ' + next.length + ' 条）' }
        }
        return { output: '', error: '未知 action：' + action }
      }
    )

    context.log(`translator v${VERSION} 已激活：translate_text / translate_doc / save_translation + 译文面板（agent-llm 引擎）就绪`)
}

/** 面板「译文」提交（invokePlugin 直调）：命中 → { filePath } 约定式即开；未命中 → 免费引擎直翻或
 *  { warning, handoffInstruction } 引导契约（面板保持打开+「交给小诺翻译」按钮，指令原文直填快呼窗）。
 *  R2 direct 引擎落地同步直翻；>3000 字符或引擎失败走引导（agent-llm 分批，质量优先）。 */
exports.translate_doc_entry = async function translate_doc_entry(values) {
  const input = String((values && values.doc_path) || '').trim()
  if (!input) throw new Error('请填写源文档路径或文件名')
  const r = await resolveDocPath(ctx, input)
  if (r.error) throw new Error(r.error)
  const content = await ctx.readFile(r.path)
  if (!content || !content.trim()) throw new Error('文档为空或未入库索引，无法翻译')
  const info = await checkDocTranslation(r.path, content, values && values.target_lang)
  if (info.cachedPath) {
    await bumpCounter('doc_cache_hits')
    return { filePath: info.cachedPath, title: '译文已打开' }
  }
  const handoff = { warning: true, handoffInstruction: `翻译 ${info.docTitle}`, handoffLabel: '交给小诺翻译' }
  // R2 一键直翻（评审 P0-1 升级）：direct 引擎同步产出 → 落盘 sys-hub → 即开（无 LLM 路由）
  const direct = PROVIDERS.find((p) => p.mode === 'direct')
  if (direct && info.hubRepo && info.translationPath && content.length <= DIRECT_ENGINE_MAX_CHARS) {
    try {
      const translation = await direct.run(content, { dir: info.dir })
      if (translation && translation.trim()) {
        const md = hub.buildTranslationDoc({
          sourcePath: r.path, sourceMd5: info.sourceMd5, dir: info.dir,
          engine: direct.id, repoName: info.repoName, translation, style: info.style,
        })
        await ctx.writeFile(info.translationPath, md)
        await ctx.reindexRepository(info.hubRepo.id)
        await bumpCounter('doc_translated')
        return { filePath: info.translationPath, title: '译文已生成（免费快引擎）' }
      }
    } catch (e) {
      // 免费引擎失败（限流/封锁/网络）→ 降级引导对话流（agent-llm 质量优先），不阻塞面板
      return { title: `免费引擎暂不可用：对小诺说「翻译 ${info.docTitle}」完成翻译`, ...handoff }
    }
  }
  // 长文档（>12k 字符）或无 direct 引擎：引导对话流（agent-llm 分批，质量优先）
  return { title: `未命中缓存：《${info.docTitle}》超出一键直翻上限（${DIRECT_ENGINE_MAX_CHARS} 字符）`, ...handoff }
}

/** 用户术语表（plugin_kv 'terms' 单键 JSON 数组 [{term, tr}]；读失败返回空） */
async function getTerms() {
  try { return (await ctx.storage.get('terms', 'list')) || [] } catch { return [] }
}

async function saveTerms(list) {
  await ctx.storage.set('terms', 'list', list)
}

/** 自由文本翻译内核（translate_selection / translate_page_text 共用，规则 7 唯一实现）：
 *  划词缓存（plugin_kv 'sel_cache' 键=MD5(文本)+方向）→ 免费引擎直翻 → { title, markdown }；
 *  术语表命中 → 素材注入对照约束（S4） */
async function translateFreeText(src, targetLang) {
  const dir = detectDirection(src, targetLang)
  const key = hub.md5Of(src) + '|' + dir.code
  const terms = await getTerms()
  // 回显判定：译文与原文相同=MyMemory 未收录该词（真机实证 knomi→knomi，2026-09-24）。
  // 回显结果禁入缓存（否则坏结果固化，同词永久无中文）——命中存量回显缓存一并失效
  const isEcho = (md) => !!md && md.trim() === src.trim()
  try {
    const cached = await ctx.storage.get('sel_cache', key)
    if (cached && cached.markdown) {
      if (isEcho(cached.markdown)) {
        await ctx.storage.set('sel_cache', key, { title: '', markdown: '' })
      } else {
        await bumpCounter('sel_cache_hits')
        return { title: cached.title || '翻译（缓存）', markdown: cached.markdown }
      }
    }
  } catch { /* 缓存读失败按未命中 */ }
  const free = PROVIDERS.find((p) => p.mode === 'direct')
  if (!free) return { title: '翻译', markdown: '无可用直连引擎。' }
  const translation = await free.run(src, { dir })
  let markdown = translation
  if (isEcho(translation)) {
    markdown = translation + '\n\n> 免费引擎未收录该词，仅回显原文——可用「交给小诺」对话或 💡释义 获取中文解释。'
  }
  const out = { title: '翻译（免费快引擎）', markdown }
  if (!isEcho(translation)) {
    try {
      await ctx.storage.set('sel_cache', key, out)
      await bumpCounter('selection_translated')
    } catch { /* 缓存写/计数失败不影响返回（配额满时静默） */ }
  }
  // cacheKey：选区浮层编辑保存的回写键（update_selection_cache）
  return { ...out, cacheKey: key }
}

/** 选区翻译（selection.action 选区浮层回调）：签名 (selectedText) 单参。 */
exports.translate_selection = async function translate_selection(selectedText) {
  const src = String(selectedText || '').trim()
  if (!src) return { title: '翻译', markdown: '选区为空。' }
  if (src.length > 5000) return { title: '翻译', markdown: '选区过长（>5000 字符）。请缩短选区，或对整篇文档用「译文」面板 / 对话流翻译。' }
  return translateFreeText(src, null)
}

/** 输入翻译（侧边栏翻译页 form 卡提交）：返回 { markdown, title } 由表单卡页内渲染 */
exports.translate_page_text = async function translate_page_text(values) {
  const src = String((values && values.text) || '').trim()
  if (!src) return { error: '请输入要翻译的文本' }
  if (src.length > 5000) return { error: '文本过长（>5000 字符），请分次翻译或用对话流翻译整篇文档' }
  const out = await translateFreeText(src, values && values.target_lang)
  return { title: '译文（' + (String((values && values.target_lang) || 'auto') === 'auto' ? '自动互译' : String((values && values.target_lang))) + '）', markdown: out.markdown }
}

/** 译文文档显示名：剥 .md 与语言码后缀（a.zh-CN.md → a） */
function translationDisplayName(fp) {
  return hub.baseNameOf(fp).replace(/\.[a-z]{2}(-[A-Za-z]{2})?$/i, '')
}

/** 侧边栏翻译页（nav.entry）：输入翻译 form 卡 + 翻译历史表格卡（v2 复合页载荷） */
exports.pageTranslate = async function pageTranslate() {
  const rows = []
  try {
    const list = await ctx.query("SELECT file_path, title FROM documents WHERE file_path LIKE '%翻译%' ORDER BY rowid DESC LIMIT 50", [])
    for (const row of list || []) {
      // ctx.query 返回驼峰字段（file_path → filePath，PLUGIN-AUTHORING 契约）
      const fp = String(row.filePath || '')
      const langMatch = /\.([a-z]{2}(?:-[A-Za-z]{2})?)\.md$/i.exec(fp)
      rows.push({ doc: translationDisplayName(fp), lang: langMatch ? langMatch[1] : '', path: fp })
    }
  } catch { /* 历史查询失败不阻塞输入翻译卡 */ }
  return {
    title: '翻译',
    cards: [
      {
        type: 'form',
        title: '输入翻译',
        hint: '输入文本即时翻译（免费快引擎，默认自动互译方向；划词与输入翻译共享缓存，同文本秒回）',
        fields: [
          { key: 'text', label: '原文', type: 'textarea', placeholder: '输入要翻译的文本（≤5000 字符）', required: true },
          {
            key: 'target_lang', label: '目标语言', type: 'select', placeholder: '自动互译', options: [
              { value: 'auto', label: '自动互译' },
              { value: 'zh', label: '中文' },
              { value: 'en', label: '英文' },
              { value: 'ja', label: '日文' },
              { value: 'ko', label: '韩文' },
              { value: 'fr', label: '法文' },
              { value: 'de', label: '德文' },
            ],
          },
        ],
        submitLabel: '翻译',
        submitMethod: 'translate_page_text',
      },
      {
        type: 'table',
        title: '翻译历史（sys-hub「翻译/」，点击行查看译文）',
        columns: [
          { key: 'doc', label: '文档' },
          { key: 'lang', label: '目标语言' },
        ],
        rows,
        detail: { method: 'pageTranslateDetail', paramKey: 'path' },
      },
      {
        type: 'form',
        title: '术语表（S4：翻译时自动强制按对照翻译，对话中也可用 manage_terms 管理）',
        hint: '命中的术语将按既定译名翻译（如 prompt→提示词）。适用于对话即译与文档翻译',
        fields: [
          { key: 'term', label: '术语原文', type: 'text', placeholder: '如 prompt', required: true },
          { key: 'tr', label: '既定译名', type: 'text', placeholder: '如 提示词', required: true },
        ],
        submitLabel: '加入术语表',
        submitMethod: 'add_term',
      },
      {
        type: 'table',
        title: '我的术语表',
        columns: [
          { key: 'term', label: '术语' },
          { key: 'tr', label: '译名' },
        ],
        rows: (await getTerms()).map((t) => ({ term: t.term, tr: t.tr })),
        rowAction: { label: '删除', method: 'remove_term', paramKey: 'term' },
      },
    ],
  }
}

/** 术语表添加（翻译页 form 卡提交） */
exports.add_term = async function add_term(values) {
  const term = String((values && values.term) || '').trim()
  const tr = String((values && values.tr) || '').trim()
  if (!term || !tr) return { error: '术语与译名均必填' }
  const list = await getTerms()
  const i = list.findIndex((t) => t.term.toLowerCase() === term.toLowerCase())
  if (i >= 0) { list[i] = { term, tr } } else { list.push({ term, tr }) }
  await saveTerms(list)
  return { message: '术语已入表：' + term + ' → ' + tr }
}

/** 术语表删除（翻译页行级动作） */
exports.remove_term = async function remove_term(term) {
  const t = String(term || '').trim()
  if (!t) return { error: '缺少术语' }
  const list = await getTerms()
  const next = list.filter((x) => x.term.toLowerCase() !== t.toLowerCase())
  if (next.length === list.length) return { error: '术语表中没有「' + t + '」' }
  await saveTerms(next)
  return { message: '已删除术语：' + t }
}

/** 翻译历史下钻：返回译文正文（剥 frontmatter）+ 原文（S5 朗读原文数据源，经 source_ref 读源文档） */
exports.pageTranslateDetail = async function pageTranslateDetail(filePath) {
  const md = await ctx.readFile(String(filePath || ''))
  const body = String(md || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  let sourceText = ''
  try {
    const fm = hub.parseFrontmatter(md)
    if (fm && fm.source_ref) sourceText = await ctx.readFile(fm.source_ref)
  } catch { /* 源文档读取失败不阻塞译文展示 */ }
  return { title: translationDisplayName(String(filePath || '')) + '（译文）', markdown: body.trim() || '（空）', sourceText }
}

/** 选区划词缓存回写（S5 选区浮层编辑保存）：覆盖指定缓存键的译文 */
exports.update_selection_cache = async function update_selection_cache(key, markdown) {
  const k = String(key || '').trim()
  const md = String(markdown || '')
  if (!k || !md.trim()) return { error: 'MISSING_ARGS（key 与 markdown 均必填）' }
  try {
    const old = await ctx.storage.get('sel_cache', k)
    await ctx.storage.set('sel_cache', k, { title: (old && old.title) || '翻译（免费快引擎）', markdown: md, at: new Date().toISOString(), edited: true })
    return { title: '已保存', markdown: md }
  } catch (e) {
    return { error: 'CACHE_WRITE_FAILED：' + String(e && e.message || e) }
  }
}

/** 译文文档回写（S5 历史下钻编辑保存）：保 frontmatter 重写正文 + 重索引。
 *  路径白名单：仅 sys-hub「翻译/」下的译文文档（fail-closed，防插件写入越界） */
exports.update_translation_doc = async function update_translation_doc(filePath, body) {
  const fp = String(filePath || '').trim()
  const bodyMd = String(body || '')
  if (!fp || !bodyMd.trim()) return { error: 'MISSING_ARGS（filePath 与 body 均必填）' }
  const hubRepo = await hub.resolveSysHub(ctx)
  if (!hubRepo) return { error: 'NO_SYS_HUB（系统仓库 sys-hub 不存在）' }
  const normHub = hub.normalize(hubRepo.localPath)
  const normFp = hub.normalize(fp)
  if (!normFp.startsWith(normHub) || !normFp.includes('/翻译/')) {
    return { error: 'PATH_NOT_ALLOWED（仅允许写 sys-hub「翻译/」下的译文文档）' }
  }
  const old = await ctx.readFile(fp)
  const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(old)
  const frontmatter = fmMatch ? fmMatch[0] : ''
  await ctx.writeFile(fp, frontmatter + bodyMd)
  await ctx.reindexRepository(hubRepo.id)
  return { title: '译文已更新', markdown: bodyMd }
}

exports.deactivate = async function deactivate() {
    if (ctx) {
      ctx.unregisterAgentTool('translate_text')
      ctx.unregisterAgentTool('translate_doc')
      ctx.unregisterAgentTool('save_translation')
      ctx.unregisterAgentTool('manage_terms')
    }
    docSessions.clear()
    ctx = null
}
