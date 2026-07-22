// Serialization — Document → text (serialize-spec §1) and tbl (serialize-spec §2).
//
// Mirror image of the parser (§1–§7 of format-spec): walk the Document and emit
// canonical text such that `parse(serialize(doc)) ≡ doc` and
// `serialize(parse(text))` is idempotent (serialize-spec §1.2).
//
// Portable: string primitives only, no regex (matches the parser's discipline).
// Schema serialization (serialize-spec §3) is a SEPARATE task — not here.

import type {
  Attribute,
  AttributeValue,
  Block,
  BodyValue,
  Document,
  ListItem,
  Scalar,
  SerializeOptions,
  Sigil,
} from './types.js'
import { coerce } from './coerce.js'
import { isJson5Object, isJson5Shaped } from './json5-value.js'
import { stringifyJson5 } from '@notrealstudio/nr-json5'
import {
  parseHeaderCell,
  emitHeaderCell,
  coerceTyped,
  type TypedColumn,
} from './typed-header.js'

// ---------- Small string helpers (no regex) ----------

function hasChar(s: string, ch: string): boolean {
  for (let i = 0; i < s.length; i++) if (s[i] === ch) return true
  return false
}

function hasSubstr(s: string, sub: string): boolean {
  return s.indexOf(sub) !== -1
}

/** Trim leading/trailing spaces and tabs (matches the parser's flow trim). */
function trimWs(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--
  return s.slice(a, b)
}

/** `coerce(s)` returns the same string → the bare value re-parses unchanged. */
function coercesToSame(s: string): boolean {
  const c = coerce(s)
  return typeof c === 'string' && c === s
}

/** Decorative line prefix (§5.2 / §6.2): `#`, `*`, `` ` ``. */
function startsDecorative(s: string): boolean {
  const c = s[0]
  return c === '#' || c === '*' || c === '`'
}

// ---------- Scalar escaping (serialize-spec §1.5) ----------

/**
 * Quote a string scalar: wrap in `"` and escape the minimal set understood by
 * `unescapeQuoted` (`\\`, `\"`, real newline → `\n`, real tab → `\t`). Inside
 * quotes the parser skips placeholder/flow recognition, so this also neutralises
 * `${`, leading sigils and commas.
 */
function quoteScalar(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') out += '\\\\'
    else if (c === '"') out += '\\"'
    else if (c === '\n') out += '\\n'
    else if (c === '\t') out += '\\t'
    else out += c
  }
  return out + '"'
}

/**
 * Reverse of §2.5 escapes for a bare scalar: double backslashes, turn a literal
 * `${` into the opt-out `\${`, escape a leading `sigil[` so it is not read back
 * as a flow-literal, and escape a leading `{` of a fully brace-wrapped string so
 * it is not read back as a JSON5-объект (§3).
 */
function escapeBareScalar(s: string, sigil: Sigil): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      out += '\\\\'
      i++
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      out += '\\${'
      i += 2
      continue
    }
    out += c
    i++
  }
  if (out.length >= 2 && out[0] === sigil && out[1] === '[') {
    out = '\\' + out
  }
  // Строка, целиком выглядящая как `{...}`, перечиталась бы объектом (§3) —
  // гасим ведущую `{` эскейпом, тем же идиомом, что и `sigil[` выше.
  if (isJson5Shaped(out)) {
    out = '\\' + out
  }
  return out
}

/**
 * Would a bare emission of this string scalar re-parse as a different value
 * (different type, lost whitespace, an accidental placeholder)? Then quote it.
 */
function scalarNeedsQuote(s: string): boolean {
  if (s === '') return false // bare empty → `$k:` → "" already
  if (!coercesToSame(s)) return true // would coerce to number/bool/null or strip quotes
  if (s !== trimWs(s)) return true // leading/trailing ws is dropped by the parser
  if (hasChar(s, '\n') || hasChar(s, '\t')) return true // multiline impossible bare
  if (hasSubstr(s, '${')) return true // a literal `${` would become a placeholder
  return false
}

function serializeScalarString(s: string, sigil: Sigil): string {
  if (scalarNeedsQuote(s)) return quoteScalar(s)
  return escapeBareScalar(s, sigil)
}

function serializeScalar(v: Scalar, sigil: Sigil): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  return serializeScalarString(v, sigil)
}

// ---------- Flow-literal lists (§4) ----------

/** A flow element is quoted when bare emission would change it or break splitting. */
function flowElementNeedsQuote(s: string): boolean {
  if (s === '') return true // empty element must be `""` (≠ empty list)
  if (!coercesToSame(s)) return true
  if (s !== trimWs(s)) return true // elements are trimmed on parse
  if (hasChar(s, '\n') || hasChar(s, '\t')) return true
  if (hasChar(s, ',')) return true // separator
  if (hasChar(s, '"')) return true
  if (hasChar(s, '\\')) return true // would be eaten by the element unescape
  if (hasSubstr(s, '${')) return true
  return false
}

function serializeListItem(it: ListItem, sigil: Sigil): string {
  if (it === null) return 'null'
  if (typeof it === 'boolean') return it ? 'true' : 'false'
  if (typeof it === 'number') return String(it)
  if (typeof it === 'string') {
    return flowElementNeedsQuote(it) ? quoteScalar(it) : it
  }
  // InterpolatedValue — raw already carries `${…}` / `\${`. The flow splitter is
  // brace- and quote-aware, so the raw segment survives intact.
  return it.raw
}

function serializeFlowList(items: ListItem[], sigil: Sigil): string {
  const parts = items.map((it) => serializeListItem(it, sigil))
  return sigil + '[' + parts.join(', ') + ']'
}

// ---------- Public value serializer (serialize-spec §1.3) ----------

/**
 * Serialize a single attribute value to its canonical text form.
 *
 * - scalars → coerced literal with reverse escaping (§1.5)
 * - list (flow-literal) → `sigil[a, b, c]`
 * - InterpolatedValue → its raw text (placeholders and `\${` opt-out restored)
 * - JSON5-объект → канонический relaxed одной строкой (json5-scalar-spec §5)
 */
export function serializeValue(value: AttributeValue, sigil: Sigil = '$'): string {
  if (Array.isArray(value)) return serializeFlowList(value, sigil)
  if (value !== null && typeof value === 'object') {
    // JSON5-объект против InterpolatedValue: guard отсеивает форму
    // {raw, placeholders}, индексная сигнатура Json5Object её не различает.
    if (isJson5Object(value)) return stringifyJson5(value)
    return value.raw // InterpolatedValue
  }
  return serializeScalar(value, sigil)
}

// ---------- Body (§2.3, §6) ----------

function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 /* _ */
}
function isBlockNameCont(c: number): boolean {
  return (
    isNameStart(c) ||
    (c >= 48 && c <= 57) ||
    c === 45 /* - */ ||
    c === 46 /* . */
  )
}

/**
 * Позиция сигила, который заставит парсер прочитать строку тела как СТРУКТУРУ
 * (атрибут §2.2 или заголовок §2.1), либо -1. Экранируем именно сигил (`\$`), а
 * не первый символ: `\$` парсер уже разворачивает (§2.5), новых эскейпов (`\#`,
 * `\%`) не вводим. `%role` на уровне документа структурой НЕ является (splitter
 * по запросу cast('messages')) — не трогаем (B3).
 */
function structuralSigilPos(line: string, sigil: Sigil): number {
  // Атрибут: сигил + name-start + name-cont* + ':'
  if (line[0] === sigil && isNameStart(line.charCodeAt(1))) {
    let i = 2
    while (i < line.length && isBlockNameCont(line.charCodeAt(i))) i++
    if (line[i] === ':') return 0
  }
  // Заголовок: #{1..6} + ' ' + сигил (имя или закрытие)
  let n = 0
  while (n < line.length && line[n] === '#') n++
  if (n >= 1 && n <= 6 && line[n] === ' ' && line[n + 1] === sigil) return n + 1
  return -1
}

/**
 * Reverse §2.5 for a plain body string: double backslashes, и защитить строки,
 * которые при репарсе стали бы атрибутом/заголовком, эскейпом сигила (B3).
 * Round-trip: parser разворачивает `\$` ровно один раз (после B1).
 */
function escapeBodyString(s: string, sigil: Sigil): string {
  return s
    .split('\n')
    .map((line) => {
      let esc = ''
      for (let i = 0; i < line.length; i++) esc += line[i] === '\\' ? '\\\\' : line[i]
      const pos = structuralSigilPos(line, sigil)
      // Префикс [0..pos) не содержит `\` (только сигил / `#` / пробел), поэтому
      // индекс в esc совпадает с индексом в line.
      return pos === -1 ? esc : esc.slice(0, pos) + '\\' + esc.slice(pos)
    })
    .join('\n')
}

function serializeBody(body: BodyValue, sigil: Sigil): string {
  if (typeof body === 'string') return escapeBodyString(body, sigil)
  return body.raw // InterpolatedValue — emit raw verbatim
}

// ---------- Blocks (§2.1, §2.2) ----------

function serializeAttribute(attr: Attribute, sigil: Sigil): string {
  const key = attr.key.join('.')
  const v = serializeValue(attr.value, sigil)
  return v.length > 0 ? `${sigil}${key}: ${v}` : `${sigil}${key}:`
}

/**
 * Header id survives bare emission unless it carries edge whitespace, is empty,
 * or would itself read back as a quoted literal (§2.1, NOT-236). Then — quotes.
 */
function idNeedsQuote(s: string): boolean {
  if (s === '') return true
  if (s !== trimWs(s)) return true
  if (hasChar(s, '\n')) return true
  if (s[0] === '"') return true
  return false
}

function serializeId(id: string): string {
  return idNeedsQuote(id) ? quoteScalar(id) : id
}

function emitBlock(block: Block, sigil: Sigil, baseLevel: number, out: string[]): void {
  const hashes = '#'.repeat(block.level + baseLevel - 1)
  let header = `${hashes} ${sigil}${block.name}`
  if (block.id !== undefined) header += ' ' + serializeId(block.id)
  out.push(header)

  for (const attr of block.attrs) out.push(serializeAttribute(attr, sigil))
  if (block.body !== undefined) out.push(serializeBody(block.body, sigil))
  for (const child of block.children) emitBlock(child, sigil, baseLevel, out)
}

// ---------- serialize (serialize-spec §1.1) ----------

/**
 * Serialize a Document back to mdd/mdz text (serialize-spec §1).
 *
 * Canonical output (§1.4): one space after `:`, blocks/attributes in Document
 * order, minimal-but-sufficient escaping, no explicit block closings (the parser
 * derives nesting from header levels). Block-closing tokens (`## $@`) are NOT
 * emitted (§1.3 rule 5).
 */
export function serialize(doc: Document, opts: SerializeOptions = {}): string {
  const sigil: Sigil = opts.sigil ?? doc.sigil
  const baseLevel = opts.baseLevel ?? 1
  if (baseLevel < 1 || baseLevel > 6) {
    throw new Error(`baseLevel must be in 1..6, got ${baseLevel}`)
  }
  const eol = opts.eol ?? '\n'

  const out: string[] = []
  const root = doc.root
  // Root (level 0) has no header — emit its global attributes and body, then
  // the top-level blocks.
  for (const attr of root.attrs) out.push(serializeAttribute(attr, sigil))
  if (root.body !== undefined) out.push(serializeBody(root.body, sigil))
  for (const child of root.children) emitBlock(child, sigil, baseLevel, out)

  const text = out.join('\n')
  return eol === '\n' ? text : text.split('\n').join(eol)
}

// ---------- tbl (serialize-spec §2) ----------

export interface TableSerializeOptions {
  /** Explicit column order; defaults to the keys of the first record. */
  columns?: string[]
  /** Line ending. Default `\n`. */
  eol?: '\n' | '\r\n'
}

type Record_ = { [k: string]: Scalar }
/** A typed table record — a list-typed column carries an array cell. */
export type TableRecord = { [k: string]: Scalar | Scalar[] }

/** A header/cell is quoted when bare emission would change it or break a column. */
function cellNeedsQuote(s: string): boolean {
  if (s === '') return true
  if (!coercesToSame(s)) return true
  if (s !== trimWs(s)) return true
  if (hasChar(s, '|')) return true // column separator
  if (hasSubstr(s, '//')) return true // comment marker (§5.2)
  if (hasChar(s, '"')) return true
  if (hasChar(s, '\n')) return true
  if (startsDecorative(s)) return true // would be skipped as a decorative line
  return false
}

function serializeCell(v: Scalar): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  return cellNeedsQuote(v) ? quoteScalar(v) : v
}

/**
 * Serialize an array of flat records to a tbl table (serialize-spec §2 / §5).
 *
 * Header from the keys of the first record (or `opts.columns`), then one line
 * per record with cells joined by ` | `. Cells carrying `|`, `//`, quotes, edge
 * whitespace, or that would coerce to another type are quoted (open item §2.1).
 */
export function serializeTable(records: Record_[], opts: TableSerializeOptions = {}): string {
  const eol = opts.eol ?? '\n'
  const columns = opts.columns ?? (records.length > 0 ? Object.keys(records[0]) : [])
  const lines: string[] = []
  lines.push(columns.map((c) => serializeCell(c)).join(' | '))
  for (const rec of records) {
    lines.push(columns.map((c) => serializeCell(rec[c] ?? null)).join(' | '))
  }
  const text = lines.join('\n')
  return eol === '\n' ? text : text.split('\n').join(eol)
}

/** A list cell needs quoting when the joined text would break the column. */
function listCellText(items: Scalar[], sep: string): string {
  const joined = items.map((it) => (it === null ? '' : String(it))).join(sep)
  // Quote when the joined text carries the column separator or would re-coerce.
  return cellNeedsQuote(joined) ? quoteScalar(joined) : joined
}

/**
 * Serialize records to a tbl table with a TYPED header (serialize-spec §2.3).
 *
 * The header emits `name[:type][!]` annotations (with `\:` escaping); list-typed
 * cells are joined by their separator. Round-trips with {@link parseTableTyped}.
 */
export function serializeTypedTable(
  records: TableRecord[],
  columns: TypedColumn[],
  opts: { eol?: '\n' | '\r\n' } = {},
): string {
  const eol = opts.eol ?? '\n'
  const lines: string[] = []
  lines.push(columns.map((c) => emitHeaderCell(c, serializeCell)).join(' | '))
  for (const rec of records) {
    lines.push(
      columns
        .map((c) => {
          const v = rec[c.name]
          if (c.type?.kind === 'list' && Array.isArray(v)) return listCellText(v, c.type.sep)
          return serializeCell((v ?? null) as Scalar)
        })
        .join(' | '),
    )
  }
  const text = lines.join('\n')
  return eol === '\n' ? text : text.split('\n').join(eol)
}

// ---------- tbl parse (inverse, for round-trip; §5) ----------

/** Strip a `//` comment that sits outside a double-quoted region (§5.2). */
function stripComment(line: string): string {
  let i = 0
  let inStr = false
  while (i < line.length) {
    const c = line[i]
    if (inStr) {
      if (c === '\\' && i + 1 < line.length) {
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      i++
      continue
    }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
    i++
  }
  return line
}

/** Split a table line into cells by `|`, respecting double-quoted regions. */
function splitCells(line: string): string[] {
  const cells: string[] = []
  let buf = ''
  let i = 0
  let inStr = false
  while (i < line.length) {
    const c = line[i]
    if (inStr) {
      buf += c
      if (c === '\\' && i + 1 < line.length) {
        buf += line[i + 1]
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      buf += c
      i++
      continue
    }
    if (c === '|') {
      cells.push(buf)
      buf = ''
      i++
      continue
    }
    buf += c
    i++
  }
  cells.push(buf)
  return cells
}

/** Collect significant lines of a tbl body (drop blanks, decoratives, comments). */
function significantLines(text: string): string[] {
  const rawLines = text.split('\n')
  const significant: string[] = []
  for (const raw of rawLines) {
    const stripped = stripComment(raw)
    const t = trimWs(stripped)
    if (t.length === 0) continue
    if (startsDecorative(t)) continue
    significant.push(stripped)
  }
  return significant
}

/**
 * Parse a tbl table into typed columns + RAW (uncoerced) string cells.
 *
 * Used by the schema layer, where the external schema — not the inline header —
 * drives coercion (priority: external schema > inline types > per-cell §3).
 * Header names still honour `\:` / quoting via {@link parseHeaderCell}.
 */
export function parseTableRows(text: string): { columns: TypedColumn[]; rows: string[][] } {
  const significant = significantLines(text)
  if (significant.length === 0) return { columns: [], rows: [] }
  const columns = splitCells(significant[0]).map(parseHeaderCell)
  const rows: string[][] = []
  for (let i = 1; i < significant.length; i++) {
    rows.push(splitCells(significant[i]).map((c) => trimWs(c)))
  }
  return { columns, rows }
}

/**
 * Parse a tbl table into its typed columns + records (serialize-spec §2.3).
 *
 * The header cells are parsed as `name[:type][!]` annotations; typed columns are
 * coerced homogeneously and raise {@link TableParseError} on impossible values
 * or empty required cells. Un-annotated headers behave exactly like the legacy
 * per-cell coercion (§3) — full backward compatibility.
 */
export function parseTableTyped(text: string): { columns: TypedColumn[]; records: TableRecord[] } {
  const significant = significantLines(text)
  if (significant.length === 0) return { columns: [], records: [] }
  const columns = splitCells(significant[0]).map(parseHeaderCell)
  const records: TableRecord[] = []
  for (let i = 1; i < significant.length; i++) {
    const cells = splitCells(significant[i])
    const rec: TableRecord = {}
    for (let j = 0; j < columns.length; j++) {
      rec[columns[j].name] = coerceTyped(trimWs(cells[j] ?? ''), columns[j])
    }
    records.push(rec)
  }
  return { columns, records }
}

/**
 * Parse a tbl table back into records (inverse of {@link serializeTable}, §5).
 *
 * First significant line is the header; each later significant line is a record.
 * Blank lines, decorative lines (`#`/`*`/`` ` ``) and `//` comments are ignored
 * (§5.2). Cells are trimmed and coerced (§3); typed headers (§2.3) coerce
 * homogeneously and throw on bad cells.
 */
export function parseTable(text: string): TableRecord[] {
  return parseTableTyped(text).records
}
