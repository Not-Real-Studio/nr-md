// YAML-like scalar coercion (§3).
// Portable: string primitives only, no regex dialects.

import type { Scalar } from './types.js'

const CC_0 = 48
const CC_9 = 57
const CC_DOT = 46
const CC_MINUS = 45

function isDigit(c: number): boolean {
  return c >= CC_0 && c <= CC_9
}

// Integer: optional leading `-`, then digits. NOT a number if:
// - leading `+` — a `+` is not a sign (`+7905...` is a phone, §3) → string
// - multi-digit with a leading zero (`007` is an id/code → string); bare `0`
//   stays the number 0
function isInt(s: string): boolean {
  if (s.length === 0) return false
  let i = 0
  if (s.charCodeAt(0) === CC_MINUS) i++
  if (i === s.length) return false
  if (s.charCodeAt(i) === CC_0 && s.length - i > 1) return false
  for (; i < s.length; i++) {
    if (!isDigit(s.charCodeAt(i))) return false
  }
  return true
}

// Float: optional leading `-`, digits with exactly one dot. Same sign/zero
// exclusions as isInt (`+0.5` → string, `00.5` → string; lone `0.5` is fine).
function isFloat(s: string): boolean {
  if (s.length === 0) return false
  let i = 0
  if (s.charCodeAt(0) === CC_MINUS) i++
  if (s.charCodeAt(i) === CC_0 && i + 1 < s.length && isDigit(s.charCodeAt(i + 1))) return false
  let hasDigit = false
  let hasDot = false
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (isDigit(c)) {
      hasDigit = true
    } else if (c === CC_DOT) {
      if (hasDot) return false
      hasDot = true
    } else {
      return false
    }
  }
  return hasDigit && hasDot
}

/**
 * Является ли `s` целиком одним quoted-скаляром `"..."` — открывающая кавычка
 * первый символ, закрывающая последний, между ними нет закрывающей (с учётом
 * эскейпов). Только в такой позиции кавычка имеет силу скаляр-литерала: `${}`
 * внутри — литерал, а не плейсхолдер (B2/B5), а сами кавычки снимаются.
 *
 * Частично-кавыченное (`"yes" or "no"`, JSON `{"m":"${x}"}`) — обычный текст:
 * кавычки его, а не разметки.
 */
export function isFullyQuoted(s: string): boolean {
  if (s.length < 2 || s.charCodeAt(0) !== 34 /* " */) return false
  let i = 1
  while (i < s.length) {
    if (s.charCodeAt(i) === 92 /* \ */ && i + 1 < s.length) {
      i += 2
      continue
    }
    if (s.charCodeAt(i) === 34) return i === s.length - 1
    i++
  }
  return false
}

/**
 * Coerce a scalar string to a typed value (§3).
 *
 * Rules:
 * - `""` (empty) → empty string
 * - `"..."` (fully quoted) → string with quotes removed (no further coercion)
 * - `null` → null
 * - `true` / `false` → boolean
 * - integer → number (leading `+` → string; leading-zero multi-digit `007` → string)
 * - decimal → number (note: `1.10` → `1.1`)
 * - anything else → string (incl. partially quoted `"yes" or "no"` — verbatim)
 */
export function coerce(s: string): Scalar {
  if (s.length === 0) return ''

  // Fully-quoted string — force string, drop quotes, do NOT re-coerce content.
  if (isFullyQuoted(s)) {
    return unescapeQuoted(s.slice(1, -1))
  }

  if (s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false

  if (isInt(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  if (isFloat(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }

  return s
}

/**
 * Unescape a double-quoted scalar literal. Inside quotes only the minimal
 * set `\"`, `\\`, `\n`, `\t` is recognised; everything else stays literal.
 */
export function unescapeQuoted(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c === 92 /* \ */ && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === '"') { out += '"'; i += 2; continue }
      if (n === '\\') { out += '\\'; i += 2; continue }
      if (n === 'n') { out += '\n'; i += 2; continue }
      if (n === 't') { out += '\t'; i += 2; continue }
      out += '\\' + n
      i += 2
      continue
    }
    out += s[i]
    i++
  }
  return out
}
