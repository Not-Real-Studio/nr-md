// Interpolation lexing (§7) — brace-balanced, no regex, internal to nr-md.
//
// The split this file draws: nr-md answers "does this value interpolate, and
// where", never "what does the expression mean". Recognising `${...}` is
// lexical — you need it to tokenise attribute values at all, since a comma or a
// closing bracket inside `${}` is not a delimiter. Reading the expression is a
// different language on top, and it belongs to whoever evaluates it.
//
// So: spans out, no expression tree, no evaluation vocabulary in the AST.

import type { InterpolationSpan } from './types.js'

/**
 * Given that `${` opens just before `fromAfterOpen`, return the offset of the
 * matching `}` in `s`, or -1 if it is unbalanced.
 *
 * Brace-balanced and aware of:
 * - escape sequences `\X` (consume both characters)
 * - nested `${...}` (increment depth; a bare `{` is NOT counted — §7.1 has no
 *   bare braces outside string literals)
 * - double-quoted strings (skip the content; honour `\"`)
 */
export function findMatchingBrace(s: string, fromAfterOpen: number): number {
  let depth = 1
  let i = fromAfterOpen
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    if (c === '"') {
      i++
      while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) {
          i += 2
          continue
        }
        if (s[i] === '"') { i++; break }
        i++
      }
      continue
    }
    if (c === '$' && i + 1 < s.length && s[i + 1] === '{') {
      depth++
      i += 2
      continue
    }
    if (c === '}') {
      depth--
      if (depth === 0) return i
      i++
      continue
    }
    i++
  }
  return -1
}

/**
 * Scan a value or body string for `${...}` and return their spans, in source
 * order.
 *
 * - `\${` is a literal `${` and is NOT an interpolation.
 * - An unbalanced `${` is silently treated as literal text.
 *
 * NB: quotes are NOT skipped here. `${}` inside `"..."` in arbitrary text (JSON,
 * prose) is a live interpolation; quotes are grammar only in a whole-value
 * scalar literal (coerce.ts), not in this scan.
 */
export function scanInterpolations(s: string): InterpolationSpan[] {
  const out: InterpolationSpan[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '$' && s[i + 2] === '{') {
      // literal ${
      i += 3
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      const start = i
      const end = findMatchingBrace(s, i + 2)
      if (end === -1) {
        // Unbalanced — literal text; step past the `$`.
        i++
        continue
      }
      out.push({ raw: s.slice(i + 2, end), start, end: end + 1 })
      i = end + 1
      continue
    }
    i++
  }
  return out
}

/**
 * Detect a backslash-escaped interpolation opener — the opt-out marker (§2.5).
 *
 * An escaped opener means "do NOT resolve this". The marker MUST survive parsing
 * intact: unescaping it eagerly into a bare `${` would turn the value into an
 * ordinary interpolation, and a resolver would substitute it the moment the
 * value flowed through recursion — silently breaking opt-out (format-spec
 * open #1: in values and results, not only in source text).
 *
 * So any value carrying the marker is stored as an InterpolatedValue with `raw`
 * preserved, escapes NOT unfolded.
 *
 * Char codes (no string literals) keep this robust across edit transports. The
 * walk mirrors scanInterpolations' escape handling, so an escaped backslash
 * followed by a LIVE interpolation is not a false positive.
 */
export function hasOptOutEscape(s: string): boolean {
  const BACKSLASH = 92
  const DOLLAR = 36
  const BRACE = 123
  let i = 0
  while (i < s.length) {
    if (
      s.charCodeAt(i) === BACKSLASH &&
      s.charCodeAt(i + 1) === DOLLAR &&
      s.charCodeAt(i + 2) === BRACE
    ) {
      return true
    }
    if (s.charCodeAt(i) === BACKSLASH && i + 1 < s.length) {
      i += 2
      continue
    }
    i++
  }
  return false
}
