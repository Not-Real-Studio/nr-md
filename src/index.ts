// @notrealstudio/nr-md — Markdown as structured data.
//
// Text ↔ tree, both directions, nothing else: parse a Markdown document whose
// headings and `$key: value` lines carry structure, get a plain AST back;
// serialize an AST, get the document back. The sigil is a parameter — `$` (mdz)
// and `@` (mdd) are two profiles of one grammar.
//
// The boundary this package keeps: it emits FACTS (shapes of data), never
// interpretations. `${...}` is recognised as a span, not parsed as an
// expression; a `$nr-extends` line is an attribute like any other. What the
// facts mean is the caller's language, on top.

// ---------- Parser (format-spec §1–§7) ----------
export { parse } from './parser.js'
export { coerce, isFullyQuoted } from './coerce.js'
export { parseAttributeValue, parseBodyValue, unescape } from './value.js'

// ---------- JSON5 object as an attribute value (§3; json5-scalar-spec) ----------
export { isJson5Shaped, isJson5Object, parseJson5Object, Json5ParseError } from './json5-value.js'

// ---------- Serialization (serialize-spec §1, §2) ----------
export {
  serialize,
  serializeValue,
  serializeTable,
  serializeTypedTable,
  parseTable,
  parseTableRows,
  parseTableTyped,
} from './serialize.js'
export type { TableSerializeOptions, TableRecord } from './serialize.js'

// ---------- Typed tbl header + tableSchema (serialize-spec §2.3) ----------
export { parseHeaderCell, emitHeaderCell, coerceTyped, tableSchema, TableParseError } from './typed-header.js'
export type { TypedColumn, ColumnType, JSONSchema } from './typed-header.js'

// ---------- Includes (format-spec §2.6) ----------
export { resolveIncludes, resolveIncludesAsync, extractSection } from './includes.js'
export type { IncludeOptions } from './includes.js'

// ---------- Tree types ----------
export type {
  Sigil,
  ParseOptions,
  SerializeOptions,
  Document,
  Block,
  Attribute,
  Pos,
  AttributeValue,
  BodyValue,
  Scalar,
  ListItem,
  Json5Object,
  Json5Value,
  InterpolatedValue,
  InterpolationSpan,
} from './types.js'
