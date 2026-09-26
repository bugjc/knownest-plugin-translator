// ============================================================
// translator/lib/md5 - 纯 JS MD5（沙箱内无 crypto 内置：ALLOWED_BUILTINS 只有
// path/os/fs/util/url/events，ADR-300 L7），供源文档内容指纹使用。
// 正确性由 tests/translator-plugin.test.js 用 Node crypto 交叉验证锁定
// （测试运行在沙箱外，可用 crypto 作对照真值）。
// 全项目唯一 MD5 入口（translator 插件内），禁止另写实现。
// ============================================================

/** 字符串 → UTF-8 字节数组（vm 沙箱不保证 TextEncoder，自实现） */
function utf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]
const K = new Array(64)
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

/** MD5 摘要（hex 小写）。输入按 UTF-8 编码。 */
function md5Hex(str) {
  const bytes = utf8Bytes(String(str))
  const bitLenLo = (bytes.length * 8) % 4294967296
  const bitLenHi = Math.floor((bytes.length * 8) / 4294967296)

  const buf = bytes.slice()
  buf.push(0x80)
  while (buf.length % 64 !== 56) buf.push(0)
  buf.push(bitLenLo & 255, (bitLenLo >>> 8) & 255, (bitLenLo >>> 16) & 255, (bitLenLo >>> 24) & 255)
  buf.push(bitLenHi & 255, (bitLenHi >>> 8) & 255, (bitLenHi >>> 16) & 255, (bitLenHi >>> 24) & 255)

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476
  const M = new Array(16)

  for (let off = 0; off < buf.length; off += 64) {
    for (let j = 0; j < 16; j++) {
      M[j] = buf[off + j * 4] | (buf[off + j * 4 + 1] << 8) | (buf[off + j * 4 + 2] << 16) | (buf[off + j * 4 + 3] << 24)
    }
    let A = a, B = b, C = c, D = d
    for (let i = 0; i < 64; i++) {
      let F, g
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      F = (F + A + K[i] + M[g]) >>> 0
      A = D
      D = C
      C = B
      B = (B + ((F << SHIFTS[i]) | (F >>> (32 - SHIFTS[i])))) >>> 0
    }
    a = (a + A) >>> 0
    b = (b + B) >>> 0
    c = (c + C) >>> 0
    d = (d + D) >>> 0
  }

  let hex = ''
  for (const p of [a, b, c, d]) {
    for (let i = 0; i < 4; i++) hex += ((p >>> (i * 8)) & 255).toString(16).padStart(2, '0')
  }
  return hex
}

// ⚠️ 沙箱缓存契约：用 exports.x 属性赋值，禁止 module.exports 重赋值——
// plugin-sandbox-child 的 moduleCache 曾存 exports 快照，重赋值+多路径 require
// 会拿到执行前/undefined 旧值（2026-09-18 实证，平台侧已修：改存 module 对象；
// 本插件仍保持属性赋值作双保险）
exports.md5Hex = md5Hex
