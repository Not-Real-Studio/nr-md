// JSON5 object as an attribute value (format-spec §3; json5-scalar-spec).
// Detection is by shape and it is strict: `{...}` MUST be a valid JSON5 object.
// Malformed input throws with a line number — no silent fallback to a string.

import { parseJson5 } from '@notrealstudio/nr-json5'
import type { Json5Object } from './types.js'

const LBRACE = 123 // {
const RBRACE = 125 // }

/** A malformed JSON5 attribute value (same convention as TableParseError, §5). */
export class Json5ParseError extends Error {
  /** 1-based line in the source document, when known. */
  readonly line?: number
  /** Attribute key the value belongs to, when known. */
  readonly key?: string

  constructor(message: string, line?: number, key?: string) {
    super(message)
    this.name = 'Json5ParseError'
    this.line = line
    this.key = key
  }
}

/** Trim spaces/tabs at both ends (string primitives, no regex). */
function trim(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--
  return s.slice(a, b)
}

/**
 * The shape of a JSON5 object (§3): the value opens with `{` and closes with `}`.
 *
 * Test the RAW value, before unescape. Otherwise `\{literal}` would unfold to
 * `{literal}` first, get caught by the detection, and the escape (§2.5) would
 * stop working.
 *
 * `{name} says hi` opens with `{` but does not close with `}`, so it is not the
 * shape — just prose. Prose and this detection do not collide.
 */
export function isJson5Shaped(raw: string): boolean {
  const s = trim(raw)
  return s.length >= 2 && s.charCodeAt(0) === LBRACE && s.charCodeAt(s.length - 1) === RBRACE
}

/** Flat guard telling a JSON5 object from an InterpolatedValue (`{raw, placeholders}`). */
export function isJson5Object(v: unknown): v is Json5Object {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !('raw' in v && 'placeholders' in v) &&
    typeof (v as { cast?: unknown }).cast !== 'function'
  )
}

function where(line?: number, key?: string): string {
  const k = key === undefined ? 'attribute value' : `$${key}`
  const l = line === undefined ? '' : ` (line ${line})`
  return `${k}${l}`
}

/**
 * Strict parse of a value that passed {@link isJson5Shaped} (§3).
 *
 * Single-line is a consequence of position, not a rule: an attribute value does
 * not wrap. A multi-line result substituted into a JSON5 string is invalid and
 * throws, deliberately — multi-line structure is what blocks are for.
 */
export function parseJson5Object(raw: string, line?: number, key?: string): Json5Object {
  const text = trim(raw)
  let parsed: unknown
  try {
    parsed = parseJson5(text)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Json5ParseError(`${where(line, key)}: ${detail}`, line, key)
  }
  // The shape guarantees an object, but parseJson5 returns unknown — narrow honestly.
  if (!isJson5Object(parsed)) {
    throw new Json5ParseError(`${where(line, key)}: JSON5 value is not an object`, line, key)
  }
  return parsed
}
