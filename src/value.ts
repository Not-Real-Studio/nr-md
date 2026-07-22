// Value parsing — escapes (§2.5), flow literals (§4), interpolation lexing (§7).

import type { AttributeValue, BodyValue, ListItem, Sigil } from './types.js'
import { coerce, isFullyQuoted } from './coerce.js'
import { isJson5Shaped, parseJson5Object } from './json5-value.js'
import { findMatchingBrace, hasOptOutEscape, scanInterpolations } from './interpolation.js'

// ---------- Escape unfolding ----------

interface EscapeMode {
  /** Inside a flow-literal `[...]` element — `\,` is meaningful (§2.5). */
  flow: boolean
}

/**
 * Unfold escape sequences in a value (§2.5).
 *
 * Always recognised: `\$`, `\@`, `\[`, `\{`, `\\`, `\n`, `\t`, `\${`.
 * Context-dependent: `\,` (flow only); `\.` only inside `${}` paths and so
 * is meaningful only inside `${}`, where this module does not reach.
 *
 * Note on `\${`: this branch is the RESOLVER's final-pass behaviour (run once,
 * after all recursion settles). The parser must NOT feed `\${`-bearing values
 * here — see hasOptOutEscape — or opt-out is lost when the value flows through
 * recursion.
 *
 * Any other `\X` is preserved verbatim (backslash + char).
 */
export function unescape(s: string, mode: EscapeMode): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      // `\${` — a literal `${` (interpolation opt-out).
      if (s[i + 1] === '$' && s[i + 2] === '{') {
        out += '${'
        i += 3
        continue
      }
      const n = s[i + 1]
      // `\{` — a literal `{` (§2.5): a value wrapped in braces stays a string
      // instead of becoming a JSON5 object. Checked after `\${` above, so the
      // interpolation opt-out is untouched.
      if (n === '$' || n === '@' || n === '[' || n === '{' || n === '\\') {
        out += n
        i += 2
        continue
      }
      if (mode.flow && n === ',') {
        out += ','
        i += 2
        continue
      }
      // Unknown — preserve verbatim.
      out += '\\' + n
      i += 2
      continue
    }
    out += s[i]
    i++
  }
  return out
}

// ---------- Flow-literal splitting (§4) ----------

/**
 * Split flow-literal body into elements by top-level commas, respecting
 * string literals, escape sequences and nested `${...}`.
 */
function splitFlowElements(s: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  let inStr = false
  while (i < s.length) {
    const c = s[i]
    if (inStr) {
      buf += c
      if (c === '\\' && i + 1 < s.length) {
        buf += s[i + 1]
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      buf += c + s[i + 1]
      i += 2
      continue
    }
    if (c === '"') {
      inStr = true
      buf += c
      i++
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      const close = findMatchingBrace(s, i + 2)
      if (close === -1) {
        buf += c
        i++
        continue
      }
      buf += s.slice(i, close + 1)
      i = close + 1
      continue
    }
    if (c === ',') {
      out.push(buf)
      buf = ''
      i++
      continue
    }
    buf += c
    i++
  }
  out.push(buf)
  return out
}

function trim(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--
  return s.slice(a, b)
}

function parseFlowElement(raw: string): ListItem {
  const t = trim(raw)
  // A whole-element scalar literal `"..."` → coerce (quotes come off, `${}`
  // inside stays literal). Otherwise the lexer sees everything.
  if (isFullyQuoted(t)) return coerce(t)
  const ph = scanInterpolations(t)
  if (ph.length > 0 || hasOptOutEscape(t)) {
    return { raw: t, placeholders: ph }
  }
  return coerce(unescape(t, { flow: true }))
}

// ---------- Public value parsers ----------

/**
 * Parse the raw text after an attribute's `:` (with surrounding ws stripped
 * by the caller — single optional space after `:` already consumed; trailing
 * trimmed). Returns a coerced scalar, a list (flow-literal), or an
 * InterpolatedValue when `${}` is present.
 */
export function parseAttributeValue(
  raw: string,
  sigil: Sigil,
  line?: number,
  key?: string,
): AttributeValue {
  // Trim trailing whitespace (incl. \r left after split).
  const value = trimTrailingWs(raw)

  // Flow-literal trigger: sigil + `[` at the very start.
  if (value.length >= 2 && value[0] === sigil && value[1] === '[') {
    if (value[value.length - 1] !== ']') {
      // Malformed — fall through to regular parsing.
    } else {
      const inner = value.slice(2, value.length - 1)
      if (trim(inner).length === 0) return []
      return splitFlowElements(inner).map(parseFlowElement)
    }
  }

  // A fully quoted value is a scalar literal: coerce strips the quotes and the
  // `${}` inside stays literal. Partial quoting (JSON `{"m":"${x}"}`) is ordinary
  // text — the lexer sees the `${}` and the value becomes an InterpolatedValue.
  if (isFullyQuoted(value)) return coerce(value)

  const ph = scanInterpolations(value)
  if (ph.length > 0 || hasOptOutEscape(value)) {
    // JSON5 detection waits until after resolution (§7.2): `{model: '${m}'}`
    // becomes an object once the substitution has happened, not here.
    return { raw: value, placeholders: ph }
  }

  // JSON5 object (§3) — tested on the RAW value, before unescape: otherwise
  // `\{literal}` would unfold to `{literal}` and be caught by the detection.
  if (isJson5Shaped(value)) return parseJson5Object(value, line, key)

  return coerce(unescape(value, { flow: false }))
}

/**
 * Parse a body string. Body is raw text; we only recognise `${}` and unfold
 * escapes (§2.5 says escapes act in body too).
 */
export function parseBodyValue(raw: string): BodyValue {
  const ph = scanInterpolations(raw)
  if (ph.length > 0 || hasOptOutEscape(raw)) {
    return { raw, placeholders: ph }
  }
  return unescape(raw, { flow: false })
}

function trimTrailingWs(s: string): string {
  let end = s.length
  while (end > 0) {
    const c = s[end - 1]
    if (c === ' ' || c === '\t' || c === '\r') end--
    else break
  }
  return s.slice(0, end)
}
