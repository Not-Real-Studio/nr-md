// Typed tbl header (serialize-spec §2.3 / format-spec §5.4).
//
// A tbl header cell may carry an optional type annotation: `name[:type][!]`.
// Without an annotation the column keeps the legacy per-cell coercion (§3).
// A typed column is homogeneous: every cell coerces to the declared type and an
// impossible coercion is a LOUD error (TableParseError), never a silent string.
//
// Portable: string primitives only, no regex.

import type { Scalar } from './types.js'
import { coerce, unescapeQuoted } from './coerce.js'

// ---------- Types ----------

export type ColumnType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'list'; sep: string }

export interface TypedColumn {
  /** Column name (annotation and escapes already resolved). */
  name: string
  /** Declared type, or undefined for an un-annotated (legacy) column. */
  type?: ColumnType
  /** `!` marker — an empty cell in this column is an error. */
  required: boolean
}

/** Loud, non-silent table-parse error (serialize-spec §6). */
export class TableParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableParseError'
  }
}

/** Minimal JSON Schema fragment (plain JSON — no TypeBox in core). */
export type JSONSchema = { [k: string]: unknown }

// ---------- Small helpers (no regex) ----------

function trimWs(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--
  return s.slice(a, b)
}

function isQuoted(s: string): boolean {
  return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"'
}

// ---------- Header cell parsing (§2.3) ----------

/**
 * Split a header cell into its name (with `\:` / `\\` resolved) and the raw
 * type-spec after the first UNescaped `:` (or null when there is no annotation).
 */
function splitNameAndType(t: string): { name: string; typeSpec: string | null } {
  let name = ''
  let i = 0
  while (i < t.length) {
    const c = t[i]
    if (c === '\\' && i + 1 < t.length) {
      const n = t[i + 1]
      if (n === ':') { name += ':'; i += 2; continue }
      if (n === '\\') { name += '\\'; i += 2; continue }
      // Unknown escape — preserve the backslash verbatim.
      name += c
      i++
      continue
    }
    if (c === ':') return { name, typeSpec: t.slice(i + 1) }
    name += c
    i++
  }
  return { name, typeSpec: null }
}

function parseTypeSpec(s: string): ColumnType {
  if (s === 'string') return { kind: 'string' }
  if (s === 'number') return { kind: 'number' }
  if (s === 'boolean') return { kind: 'boolean' }
  if (s.length >= 6 && s.slice(0, 5) === 'list(' && s[s.length - 1] === ')') {
    const sep = s.slice(5, -1)
    if (sep.length !== 1) {
      throw new TableParseError(`list separator must be one character, got "${sep}"`)
    }
    return { kind: 'list', sep }
  }
  throw new TableParseError(`unknown column type: "${s}"`)
}

/**
 * Parse a single header cell (`name[:type][!]`, §2.3).
 *
 * - A fully double-quoted cell is a literal name — no annotation.
 * - `\:` escapes a literal colon in the name; `\\` a literal backslash.
 * - `!` (after the optional type) marks the column required.
 * - Un-annotated cells keep legacy behaviour (per-cell coercion §3).
 */
export function parseHeaderCell(cell: string): TypedColumn {
  const t = trimWs(cell)
  if (isQuoted(t)) {
    return { name: unescapeQuoted(t.slice(1, -1)), required: false }
  }
  const { name, typeSpec } = splitNameAndType(t)
  if (typeSpec !== null) {
    let spec = trimWs(typeSpec)
    let required = false
    if (spec.length > 0 && spec[spec.length - 1] === '!') {
      required = true
      spec = trimWs(spec.slice(0, -1))
    }
    return { name: trimWs(name), type: parseTypeSpec(spec), required }
  }
  // No type annotation — still allow a trailing `!` for a required legacy column.
  let bare = name
  let required = false
  if (bare.length > 0 && bare[bare.length - 1] === '!') {
    required = true
    bare = bare.slice(0, -1)
  }
  return { name: trimWs(bare), required }
}

/** Parse a full header line into typed columns (used by {@link tableSchema}). */
export function parseHeaderLine(line: string, splitCells: (l: string) => string[]): TypedColumn[] {
  return splitCells(line).map(parseHeaderCell)
}

// ---------- Header cell emit (§2.3 serialize) ----------

function typeSpecText(type: ColumnType): string {
  switch (type.kind) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'list': return `list(${type.sep})`
  }
}

/** Escape `\` and `:` in a typed column name for header emission. */
function escapeName(name: string): string {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const c = name[i]
    if (c === '\\') out += '\\\\'
    else if (c === ':') out += '\\:'
    else out += c
  }
  return out
}

/**
 * Emit a header cell. Typed columns emit `name[:type][!]` with `\:` escaping;
 * un-annotated columns fall back to the caller's plain cell serializer.
 */
export function emitHeaderCell(col: TypedColumn, plainCell: (s: string) => string): string {
  if (!col.type && !col.required) return plainCell(col.name)
  let out = escapeName(col.name)
  if (col.type) out += ':' + typeSpecText(col.type)
  if (col.required) out += '!'
  return out
}

// ---------- Homogeneous cell coercion (§2.3) ----------

function stripQuotesForList(raw: string): string {
  return isQuoted(raw) ? unescapeQuoted(raw.slice(1, -1)) : raw
}

/**
 * Coerce a raw cell to the column's declared type (§2.3). Un-annotated columns
 * fall back to §3 coercion. Impossible coercions and empty required cells throw
 * {@link TableParseError} — never a silent string.
 */
export function coerceTyped(raw: string, col: TypedColumn): Scalar | Scalar[] {
  const isEmpty = raw === ''
  if (isEmpty && col.required) {
    throw new TableParseError(`column "${col.name}": required cell is empty`)
  }
  const type = col.type
  if (!type) return coerce(raw)

  switch (type.kind) {
    case 'string': {
      if (isEmpty) return ''
      return isQuoted(raw) ? unescapeQuoted(raw.slice(1, -1)) : raw
    }
    case 'number': {
      if (isEmpty) return null
      const c = coerce(raw)
      if (typeof c === 'number') return c
      throw new TableParseError(`column "${col.name}": "${raw}" is not a number`)
    }
    case 'boolean': {
      if (isEmpty) return null
      const c = coerce(raw)
      if (typeof c === 'boolean') return c
      throw new TableParseError(`column "${col.name}": "${raw}" is not a boolean`)
    }
    case 'list': {
      if (isEmpty) return []
      const body = stripQuotesForList(raw)
      return body.split(type.sep).map((e) => coerce(trimWs(e)))
    }
  }
}

// ---------- Derived JSON Schema (§2.3, tableSchema) ----------

function typeToSchema(type?: ColumnType): JSONSchema {
  if (!type) return {}
  switch (type.kind) {
    case 'string': return { type: 'string' }
    case 'number': return { type: 'number' }
    case 'boolean': return { type: 'boolean' }
    case 'list': return { type: 'array', 'x-mdd': { separator: type.sep } }
  }
}

/**
 * Derive a JSON Schema fragment from a typed header (serialize-spec §2.3).
 *
 * `weight:number` → `{type:'number'}`, `!` → required, `list(;)` →
 * `{type:'array', 'x-mdd':{separator:';'}}`. The result is derived, never stored.
 */
export function tableSchema(columns: TypedColumn[]): JSONSchema {
  const properties: Record<string, JSONSchema> = {}
  const required: string[] = []
  for (const col of columns) {
    properties[col.name] = typeToSchema(col.type)
    if (col.required) required.push(col.name)
  }
  const schema: JSONSchema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}
