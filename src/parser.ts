// Top-level parser for mdd/mdz documents (§2, §6).

import type { Attribute, Block, Document, ParseOptions, Sigil } from './types.js'
import { parseAttributeValue, parseBodyValue } from './value.js'
import { isFullyQuoted, unescapeQuoted } from './coerce.js'

const CC_A_UP = 65
const CC_Z_UP = 90
const CC_A_LO = 97
const CC_Z_LO = 122
const CC_0 = 48
const CC_9 = 57
const CC_UNDER = 95
const CC_DASH = 45
const CC_DOT = 46

function isNameStart(c: number): boolean {
  return (c >= CC_A_UP && c <= CC_Z_UP) || (c >= CC_A_LO && c <= CC_Z_LO) || c === CC_UNDER
}
function isNameCont(c: number): boolean {
  return (
    isNameStart(c) ||
    (c >= CC_0 && c <= CC_9) ||
    c === CC_DASH
  )
}
function isBlockNameCont(c: number): boolean {
  return isNameCont(c) || c === CC_DOT
}

// ---------- Header (§2.1) ----------

interface ParsedHeader {
  level: number
  /** Closing token (`## $`, `## $@`, `## @`, `## @@`)? */
  closing: boolean
  name: string
  id?: string
}

/** Read `#`-prefix and return raw hash count, or null. */
function readHashes(line: string): { count: number; next: number } | null {
  let n = 0
  while (n < line.length && line[n] === '#') n++
  if (n === 0) return null
  return { count: n, next: n }
}

/**
 * Try to parse a markdown heading as a structured block header.
 *
 * Returns null when the line isn't a structured header (regular markdown
 * heading, or just non-header text).
 */
function parseHeader(line: string, sigil: Sigil): ParsedHeader | null {
  const hash = readHashes(line)
  if (!hash) return null
  if (hash.count < 1 || hash.count > 6) return null
  if (line[hash.next] !== ' ') return null
  let i = hash.next + 1
  if (line[i] !== sigil) return null

  const rest = line.slice(i)
  // Closing forms.
  if (rest === sigil) {
    return { level: hash.count, closing: true, name: '' }
  }
  if (sigil === '$' && rest === '$@') {
    return { level: hash.count, closing: true, name: '' }
  }
  if (sigil === '@' && rest === '@@') {
    return { level: hash.count, closing: true, name: '' }
  }
  if (sigil === '$' && rest === '$$') {
    // `## $$` reserved (Obsidian math conflict, §2.1) — not a header.
    return null
  }

  i++ // consume sigil
  // Block name (allows dot).
  if (i >= line.length) return null
  if (!isNameStart(line.charCodeAt(i))) return null
  const nameStart = i
  i++
  while (i < line.length && isBlockNameCont(line.charCodeAt(i))) i++
  const name = line.slice(nameStart, i)

  let id: string | undefined
  if (i < line.length) {
    if (line[i] !== ' ') return null
    const tail = line.slice(i + 1).trim()
    // Bare id — rest of the line as-is. Quotes are for an id that bare form
    // would lose: edge whitespace, or an empty string (§2.1).
    if (tail.length > 0) id = isFullyQuoted(tail) ? unescapeQuoted(tail.slice(1, -1)) : tail
  }
  return { level: hash.count, closing: false, name, id }
}

// ---------- Attribute (§2.2) ----------

interface ParsedAttribute {
  key: string[]
  rawValue: string
}

/**
 * Parse a line as `$key: value` / `$a.b: value`. Returns null if the line
 * is not a valid attribute.
 */
function parseAttribute(line: string, sigil: Sigil): ParsedAttribute | null {
  if (line.length === 0) return null
  if (line[0] !== sigil) return null
  let i = 1
  if (i >= line.length) return null
  if (!isNameStart(line.charCodeAt(i))) return null
  // Key is a single literal name; a dot is part of the name (§2.2), exactly like
  // block names (§2.1). NO path-splitting, NO escape on the key side — addressing
  // a dotted key from a placeholder uses the escape there (§7.1), not here.
  const keyStart = i
  i++
  while (i < line.length && isBlockNameCont(line.charCodeAt(i))) i++
  const segs: string[] = [line.slice(keyStart, i)]
  if (line[i] !== ':') return null
  i++
  if (line[i] === ' ') i++
  return { key: segs, rawValue: line.slice(i) }
}

// ---------- Body line ----------

/** A line that does not match any structured form contributes to body. */

// ---------- Driver ----------

export function parse(text: string, options: ParseOptions = {}): Document {
  const sigil: Sigil = options.sigil ?? '$'
  const baseLevel: number = options.baseLevel ?? 1
  if (baseLevel < 1 || baseLevel > 6) {
    throw new Error(`baseLevel must be in 1..6, got ${baseLevel}`)
  }

  // Normalise line endings (§2: parser normalises \r\n → \n).
  const normalised = normaliseNewlines(text)
  const lines = normalised.split('\n')

  const root: Block = { name: '', level: 0, attrs: [], children: [] }
  const stack: Block[] = [root]
  let bodyLines: string[] = []
  // Raw (un-unescaped) body per block — the source of truth when stanzas are
  // joined. The body stays raw until the final assembly, and unescape runs
  // exactly once, in parseBodyValue, over the COMPLETE raw text (§2.5).
  // Unescaping per fragment would double-unescape a resumed body (\\$ → \$ → $).
  const bodyRaw = new Map<Block, string>()

  const flushBody = (target: Block): void => {
    // Drop trailing/leading blank-only lines — they are "separators" (§2.3).
    let start = 0
    let end = bodyLines.length
    while (start < end && bodyLines[start].length === 0) start++
    while (end > start && bodyLines[end - 1].length === 0) end--
    if (start < end) {
      const frag = bodyLines.slice(start, end).join('\n')
      // Body resumed after a nested block closed → append raw as strophes.
      const prev = bodyRaw.get(target)
      const full = prev === undefined ? frag : prev + '\n\n' + frag
      bodyRaw.set(target, full)
      target.body = parseBodyValue(full) // one unescape, over the whole raw
    }
    bodyLines = []
  }

  const top = (): Block => stack[stack.length - 1]

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const header = parseHeader(line, sigil)
    if (header) {
      // Effective level — header.level minus (baseLevel - 1).
      const effLevel = header.level - (baseLevel - 1)
      if (header.closing) {
        flushBody(top())
        // Pop everything back to root (global zone).
        while (stack.length > 1) stack.pop()
        continue
      }
      if (effLevel < 1) {
        // Heading below baseLevel — treat as body content (regular markdown).
        bodyLines.push(line)
        continue
      }
      flushBody(top())
      // Pop until parent's level < new block's level.
      while (stack.length > 1 && top().level >= effLevel) {
        stack.pop()
      }
      const block: Block = {
        name: header.name,
        level: effLevel,
        attrs: [],
        children: [],
      }
      if (header.id !== undefined) block.id = header.id
      top().children.push(block)
      stack.push(block)
      continue
    }

    const attr = parseAttribute(line, sigil)
    if (attr) {
      // li is a 0-based index into the lines; errors (Json5ParseError) are 1-based.
      const value = parseAttributeValue(attr.rawValue, sigil, li + 1, attr.key.join('.'))
      const a: Attribute = { key: attr.key, value }
      top().attrs.push(a)
      continue
    }

    // Anything else is a body line. Empty lines are kept for now; they may
    // get trimmed by flushBody if they sit at the edges.
    bodyLines.push(line)
  }

  // Flush trailing body of every open block.
  while (stack.length > 0) {
    flushBody(top())
    stack.pop()
  }

  return { sigil, root }
}

function normaliseNewlines(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\r') {
      out += '\n'
      if (s[i + 1] === '\n') i += 2
      else i++
      continue
    }
    out += c
    i++
  }
  return out
}
