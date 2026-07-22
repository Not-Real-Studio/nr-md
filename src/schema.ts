// Schema layer — object ⇄ Document via JSON Schema + x-storage (serialize-spec §3).
//
// The schema is consumed as PLAIN JSON (no TypeBox, no codegen in core, §3.1).
// Three portable operations:
//   - serializeWithSchema: object + schema → Document (x-storage layout) → text
//   - parseWithSchema:      text → Document → object (x-storage + schema coercion)
//   - validate:             delegate to Ajv2020 (optional peer) or an injected validator
//
// Field order on serialize = order of schema `properties` (§3.3, deterministic).

import type {
  Attribute,
  AttributeValue,
  Block,
  BodyValue,
  Document,
  InterpolatedValue,
  Scalar,
  Sigil,
} from './types.js'
import { parse } from './parser.js'
import { serialize, serializeTable, parseTableRows } from './serialize.js'
import { coerceTyped, type JSONSchema, type TypedColumn } from './typed-header.js'
import { coerce } from './coerce.js'
import { unescape } from './value.js'

export type { JSONSchema } from './typed-header.js'

// ---------- Public types ----------

/**
 * Where a field is stored in mdd/mdz (serialize-spec §3.2).
 *
 * `block` — the field travels as its OWN child block, the value in that block's
 * body. Unlike `body` (the parent block's body, so at most one such field), an
 * object may have any number of these: the prose fields (description, scenario…).
 */
export type XStorage = 'attr' | 'body' | 'name' | 'id' | 'block'

/** How an array is laid out (`x-mdd.list`, §3.2). */
export type XListMode = 'flow' | 'tbl' | 'lines' | 'blocks'

/** Representation refinement (`x-mdd.as`, §3.9) — `json`: a fenced JSON block (opaque). */
export type XAs = 'json'

/**
 * Key of the catch-all bag holding fields NOT described by the schema.
 *
 * Enabled per object schema with `x-mdd: { unknown: 'block' }`; `parseWithSchema`
 * collects every unclaimed attribute/block here and `serializeWithSchema` emits
 * the bag back — round-trip of foreign extensions is lossless.
 */
export const UNKNOWN_KEY = '$unknown'

/**
 * Block name of the overflow bag: unknown keys that are NOT valid mdd names
 * (spaces, leading digits…) cannot be an attribute or a block header, so they
 * travel together in one fenced-JSON block instead of being dropped.
 */
export const UNKNOWN_OVERFLOW_BLOCK = '_unknown'

export interface SchemaSerializeOptions {
  sigil?: Sigil
  baseLevel?: number
  eol?: '\n' | '\r\n'
  /** Diagnostics sink (lossy fallbacks, type conflicts). Default: `console.warn`. */
  warn?: (msg: string) => void
}

export interface ParseWithSchemaOptions {
  sigil?: Sigil
  baseLevel?: number
  /** Diagnostics sink (type conflicts between inline tbl header and schema). Default: `console.warn`. */
  warn?: (msg: string) => void
}

export interface ValidationError {
  /** JSON-pointer-ish path to the offending value (`` for root). */
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

export interface ValidateOptions {
  /** Inject a validator (e.g. a native one) instead of the Ajv delegate. */
  validator?: (obj: unknown, schema: JSONSchema) => ValidationResult
}

/** Injected diagnostics — threaded through the recursion instead of console. */
interface Ctx {
  warn: (msg: string) => void
}

function ctxOf(opts: { warn?: (msg: string) => void }): Ctx {
  // eslint-disable-next-line no-console
  return { warn: opts.warn ?? ((msg: string) => console.warn(msg)) }
}

// ---------- Schema access helpers ----------

function props(schema: JSONSchema): Record<string, JSONSchema> {
  const p = schema.properties
  return p && typeof p === 'object' ? (p as Record<string, JSONSchema>) : {}
}

function xmdd(schema: JSONSchema): Record<string, unknown> {
  const m = schema['x-mdd']
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : {}
}

function storageOf(prop: JSONSchema): XStorage {
  const s = prop['x-storage']
  return s === 'body' || s === 'name' || s === 'id' || s === 'block' ? s : 'attr'
}

/**
 * Block name of a field (§3.9): `x-mdd.block` overrides the property key, so the
 * wire name and the document name can differ (`data` → `# @char`, `entries` →
 * `### @entry`). Default — the key as-is.
 */
function blockNameOf(prop: JSONSchema, key: string): string {
  const b = xmdd(prop).block
  return typeof b === 'string' && b.length > 0 ? b : key
}

/** Opaque JSON representation (`x-mdd: { as: 'json' }`, §3.9)? */
function asJson(prop: JSONSchema): boolean {
  return xmdd(prop).as === 'json'
}

/** Does the items schema describe a scalar (a `blocks` element = block with a string body, §3.5)? */
function isScalarSchema(schema: JSONSchema): boolean {
  const t = schema.type
  return t === 'string' || t === 'number' || t === 'integer' || t === 'boolean'
}

function itemsOf(prop: JSONSchema): JSONSchema {
  const items = prop.items
  return items && typeof items === 'object' ? (items as JSONSchema) : {}
}

/** Does the items schema describe an object (→ tbl by default, §3.2)? */
function itemsAreObjects(prop: JSONSchema): boolean {
  const items = itemsOf(prop)
  if (items.type === 'object') return true
  const ip = items.properties
  return Boolean(ip && typeof ip === 'object' && Object.keys(ip).length > 0)
}

/**
 * List layout of an array field. Explicit `x-mdd.list` always wins; otherwise an
 * array of objects → `tbl` and an array of scalars → `flow` (§3.2 defaults —
 * `blocks` is opt-in only, existing schemas keep their layout).
 */
function listModeOf(prop: JSONSchema, value: unknown): XListMode {
  const explicit = xmdd(prop).list
  if (explicit === 'flow' || explicit === 'tbl' || explicit === 'lines' || explicit === 'blocks') {
    return explicit
  }
  if (itemsAreObjects(prop)) return 'tbl'
  if (Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object')) return 'tbl'
  return 'flow'
}

/**
 * Map field (§3): `type: object` + `patternProperties` (or a schema-valued
 * `additionalProperties`) and NO `properties` — a `Record<string, V>` laid out as a
 * block of per-key sub-blocks.
 */
function isMapSchema(prop: JSONSchema): boolean {
  if (prop.type !== 'object') return false
  const p = prop.properties
  if (p && typeof p === 'object' && Object.keys(p).length > 0) return false
  const pp = prop.patternProperties
  if (pp && typeof pp === 'object' && Object.keys(pp).length > 0) return true
  const ap = prop.additionalProperties
  return Boolean(ap && typeof ap === 'object')
}

/** Value schema of a map field — first `patternProperties` entry, else `additionalProperties`. */
function mapValueSchema(prop: JSONSchema): JSONSchema {
  const pp = prop.patternProperties
  if (pp && typeof pp === 'object') {
    const vals = Object.values(pp as Record<string, JSONSchema>)
    if (vals.length > 0 && vals[0] && typeof vals[0] === 'object') return vals[0]
  }
  const ap = prop.additionalProperties
  if (ap && typeof ap === 'object') return ap as JSONSchema
  return { type: 'string' }
}

function isObjectSchema(prop: JSONSchema, value: unknown): boolean {
  if (prop.type === 'object') return true
  return prop.type === undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasNameStorage(schema: JSONSchema): boolean {
  for (const prop of Object.values(props(schema))) {
    if (prop && typeof prop === 'object' && prop['x-storage'] === 'name') return true
  }
  return false
}

function hasIdStorage(schema: JSONSchema): boolean {
  for (const prop of Object.values(props(schema))) {
    if (prop && typeof prop === 'object' && prop['x-storage'] === 'id') return true
  }
  return false
}

/** Catch-all enabled for this object schema (`x-mdd: { unknown: 'block' | 'inline' }`)? */
function unknownEnabled(schema: JSONSchema): boolean {
  const u = xmdd(schema).unknown
  return u === 'block' || u === 'inline'
}

/**
 * `unknown: 'inline'` (§3.6) — unknown fields come back as the object's OWN keys
 * rather than in an `$unknown` bag. Serialization is identical either way (bare
 * keys outside the schema are always picked up); the modes differ only in the
 * shape of the parse result. `inline` round-trips shape 1:1 — which is what you
 * need when the canonical form is somebody else's JSON.
 */
function unknownInline(schema: JSONSchema): boolean {
  return xmdd(schema).unknown === 'inline'
}

/**
 * `envelope: true` (§3.3) — the root object has no header of its own (the envelope
 * is `@spec`, `@spec_version` plus one data block), so its child blocks sit at the
 * top level (h1) rather than h2. Applies only to a flat root layout.
 */
function envelopeEnabled(schema: JSONSchema): boolean {
  return xmdd(schema).envelope === true && !hasNameStorage(schema) && !hasIdStorage(schema)
}

// ---------- mdd name validity (mirrors parser.ts §2.1/§2.2) ----------

function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 /* _ */
}
function isNameCont(c: number): boolean {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 /* - */ || c === 46 /* . */
}

/** Can this string be an attribute key / block name as-is (no escaping exists for it)? */
function isMddName(s: string): boolean {
  if (s.length === 0) return false
  if (!isNameStart(s.charCodeAt(0))) return false
  for (let i = 1; i < s.length; i++) if (!isNameCont(s.charCodeAt(i))) return false
  return true
}

// ---------- Fenced JSON (opaque, lossless carrier for arbitrary values) ----------

function jsonFence(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```'
}

/** Decode a body that is entirely one ```json fence, else `{ ok: false }`. */
function readJsonFence(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim()
  if (!t.startsWith('```') || !t.endsWith('```') || t.length < 7) return { ok: false }
  const nl = t.indexOf('\n')
  if (nl === -1) return { ok: false }
  const info = t.slice(3, nl).trim()
  if (info !== 'json' && info !== '') return { ok: false }
  try {
    return { ok: true, value: JSON.parse(t.slice(nl + 1, t.length - 3)) }
  } catch {
    return { ok: false }
  }
}

// ---------- Value shape helpers ----------

function isInterpolated(v: unknown): v is InterpolatedValue {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && 'raw' in (v as object)
}

function isPlainScalar(v: unknown): v is Scalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/** Text of a value that may be an InterpolatedValue (`${…}` in an attribute/cell). */
function valueText(v: unknown): string {
  if (isInterpolated(v)) return v.raw
  return v === null || v === undefined ? '' : String(v)
}

function bodyText(body: BodyValue | undefined): string {
  if (body === undefined) return ''
  return typeof body === 'string' ? body : body.raw
}

/**
 * Body text with escapes unfolded — the parser leaves an InterpolatedValue raw
 * (escapes intact, §2.5), so a JSON fence carrying `${` would come back with its
 * backslashes still doubled. Only used where the body is opaque data, not a template.
 */
function bodyData(body: BodyValue | undefined): string {
  if (body === undefined) return ''
  return typeof body === 'string' ? body : unescape(body.raw, { flow: false })
}

/** Parsed attribute value → plain JSON (drop InterpolatedValue wrappers). */
function attrToPlain(v: AttributeValue): unknown {
  if (Array.isArray(v)) return v.map((it) => (isInterpolated(it) ? it.raw : it))
  if (isInterpolated(v)) return v.raw
  return v
}

// ---------- serializeWithSchema (§3.3) ----------

function toBodyString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (value === null || value === undefined) return undefined
  if (isInterpolated(value)) return value.raw.length > 0 ? value.raw : undefined
  return String(value)
}

/** Column order for a tbl field: keys of `items.properties`, else record keys. */
function tblColumns(prop: JSONSchema, records: Array<Record<string, unknown>>): string[] {
  const ip = itemsOf(prop).properties
  if (ip && typeof ip === 'object') return Object.keys(ip)
  return records.length > 0 ? Object.keys(records[0]) : []
}

/** Separator for a list-in-cell column (x-mdd.separator), default `,`. */
function cellSeparator(prop: JSONSchema | undefined): string {
  const sep = prop ? xmdd(prop).separator : undefined
  return typeof sep === 'string' && sep.length === 1 ? sep : ','
}

/** Flatten a tbl cell to a scalar: a list-in-cell array joins by its separator. */
function cellToScalar(value: unknown, prop: JSONSchema | undefined): Scalar {
  if (Array.isArray(value)) {
    return value.map((v) => (v === null ? '' : valueText(v))).join(cellSeparator(prop))
  }
  if (isInterpolated(value)) return value.raw
  return (value ?? null) as Scalar
}

/** Emit one catch-all entry: scalar → attribute, anything else → fenced-JSON block. */
function emitUnknownEntry(parent: Block, key: string, value: unknown, level: number): void {
  if (isPlainScalar(value)) {
    parent.attrs.push({ key: [key], value })
    return
  }
  if (isInterpolated(value)) {
    parent.attrs.push({ key: [key], value: value.raw })
    return
  }
  parent.children.push({ name: key, level, attrs: [], children: [], body: jsonFence(value) })
}

/** Catch-all: `obj[$unknown]` plus any own keys the schema does not describe. */
function unknownBagOf(obj: Record<string, unknown>, schema: JSONSchema): Record<string, unknown> {
  const known = new Set(Object.keys(props(schema)))
  const bag: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === UNKNOWN_KEY || known.has(k) || v === undefined) continue
    bag[k] = v
  }
  const explicit = obj[UNKNOWN_KEY]
  if (explicit !== null && typeof explicit === 'object' && !Array.isArray(explicit)) {
    for (const [k, v] of Object.entries(explicit as Record<string, unknown>)) {
      if (v !== undefined) bag[k] = v
    }
  }
  return bag
}

/** Build the block of a map field: one sub-block per key (§3). */
function buildMapBlock(
  map: Record<string, unknown>,
  prop: JSONSchema,
  key: string,
  level: number,
  ctx: Ctx,
): Block {
  const bad = Object.keys(map).filter((k) => !isMddName(k))
  if (bad.length > 0) {
    ctx.warn(
      `serializeWithSchema: map "${key}" has keys that are not valid mdd names ` +
        `(${bad.join(', ')}) — emitting the whole map as fenced JSON.`,
    )
    return { name: key, level, attrs: [], children: [], body: jsonFence(map) }
  }
  const valueSchema = mapValueSchema(prop)
  const block: Block = { name: key, level, attrs: [], children: [] }
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) continue
    if (isObjectSchema(valueSchema, v) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      block.children.push(buildBlock(v as Record<string, unknown>, valueSchema, k, level + 1, ctx))
      continue
    }
    const child: Block = { name: k, level: level + 1, attrs: [], children: [] }
    const body = toBodyString(v)
    if (body !== undefined) child.body = body
    block.children.push(child)
  }
  return block
}

/** Build a Block from (obj, schema). `defaultName` names a nested child block. */
function buildBlock(
  obj: Record<string, unknown>,
  schema: JSONSchema,
  defaultName: string,
  level: number,
  ctx: Ctx,
): Block {
  const block: Block = { name: defaultName, level, attrs: [], children: [] }
  for (const [key, prop] of Object.entries(props(schema))) {
    if (!(key in obj)) continue
    const value = obj[key]
    if (value === undefined) continue

    const storage = storageOf(prop)
    const bname = blockNameOf(prop, key)

    if (storage === 'name') {
      block.name = String(value)
      continue
    }
    if (storage === 'id') {
      block.id = String(value)
      continue
    }
    if (storage === 'body') {
      const b = toBodyString(value)
      if (b !== undefined) block.body = b
      continue
    }

    // as: 'json' — a declared opaque field (platform extensions): a fenced JSON block.
    if (asJson(prop)) {
      block.children.push({ name: bname, level: level + 1, attrs: [], children: [], body: jsonFence(value) })
      continue
    }

    // storage: 'block' — a body block of its own (prose: description, scenario, …).
    if (storage === 'block') {
      const child: Block = { name: bname, level: level + 1, attrs: [], children: [] }
      const b = toBodyString(value)
      if (b !== undefined) child.body = b
      block.children.push(child)
      continue
    }

    // storage === 'attr' (default), representation refined by shape / x-mdd.
    if (Array.isArray(value)) {
      const mode = listModeOf(prop, value)
      if (mode === 'flow') {
        block.attrs.push({ key: [key], value: value as AttributeValue })
      } else if (mode === 'lines') {
        block.children.push({
          name: bname,
          level: level + 1,
          attrs: [],
          children: [],
          body: value.map((v) => valueText(v)).join('\n'),
        })
      } else if (mode === 'blocks') {
        // blocks — one child block per element, all named after the property key
        // (or x-mdd.block). A scalar element (array of strings) → a block with a string body.
        const items = itemsOf(prop)
        if (value.length === 0) {
          // An empty array is inexpressible as repeated blocks (zero blocks reads as
          // 'no field'), so it degenerates to an empty flow attribute, which parses
          // back as [] (§3.5).
          block.attrs.push({ key: [key], value: [] })
        }
        for (const el of value) {
          if (isScalarSchema(items) || isPlainScalar(el) || isInterpolated(el)) {
            const child: Block = { name: bname, level: level + 1, attrs: [], children: [] }
            const b = toBodyString(el)
            if (b !== undefined) child.body = b
            block.children.push(child)
            continue
          }
          block.children.push(buildBlock((el ?? {}) as Record<string, unknown>, items, bname, level + 1, ctx))
        }
      } else {
        // tbl — one child block whose body is the table.
        const records = value as Array<Record<string, unknown>>
        const columns = tblColumns(prop, records)
        const itemProps = props(itemsOf(prop))
        const flat = records.map((r) => {
          const rec: { [k: string]: Scalar } = {}
          for (const c of columns) rec[c] = cellToScalar(r[c], itemProps[c])
          return rec
        })
        block.children.push({
          name: bname,
          level: level + 1,
          attrs: [],
          children: [],
          body: serializeTable(flat, { columns }),
        })
      }
      continue
    }

    if (isMapSchema(prop)) {
      if (value !== null && typeof value === 'object') {
        block.children.push(buildMapBlock(value as Record<string, unknown>, prop, bname, level + 1, ctx))
      }
      continue
    }

    if (isObjectSchema(prop, value)) {
      block.children.push(buildBlock(value as Record<string, unknown>, prop, bname, level + 1, ctx))
      continue
    }

    // Scalar attribute.
    block.attrs.push({ key: [key], value: cellToScalar(value, prop) })
  }

  if (unknownEnabled(schema)) {
    const overflow: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(unknownBagOf(obj, schema))) {
      if (isMddName(k)) emitUnknownEntry(block, k, v, level + 1)
      else overflow[k] = v
    }
    if (Object.keys(overflow).length > 0) {
      ctx.warn(
        `serializeWithSchema: unknown keys that are not valid mdd names ` +
          `(${Object.keys(overflow).join(', ')}) — carried in the "${UNKNOWN_OVERFLOW_BLOCK}" JSON block.`,
      )
      block.children.push({
        name: UNKNOWN_OVERFLOW_BLOCK,
        level: level + 1,
        attrs: [],
        children: [],
        body: jsonFence(overflow),
      })
    }
  }
  return block
}

/**
 * Serialize an object to mdd/mdz text through a JSON Schema (serialize-spec §3.3).
 *
 * Layout by `x-storage` (attr | body | name | id) and `x-mdd` (list: flow | tbl |
 * lines | blocks, unknown: block). Field order = order of schema `properties` —
 * deterministic, so the same object always serializes byte-for-byte identically.
 */
export function serializeWithSchema(
  obj: unknown,
  schema: JSONSchema,
  opts: SchemaSerializeOptions = {},
): string {
  const sigil: Sigil = opts.sigil ?? '$'
  const record = (obj ?? {}) as Record<string, unknown>
  // envelope — the root has no header of its own and its blocks are top-level, so
  // build the record at level 0 and children land at 1 (h1). Otherwise children go to h2.
  const built = buildBlock(record, schema, '', envelopeEnabled(schema) ? 0 : 1, ctxOf(opts))

  const root: Block = { name: '', level: 0, attrs: [], children: [] }
  if (built.name !== '' || built.id !== undefined) {
    // A name/id-storage field gives the record a header — emit a named block.
    root.children.push(built)
  } else {
    // No header identity — the record IS the document (flat layout).
    root.attrs = built.attrs
    if (built.body !== undefined) root.body = built.body
    root.children = built.children
  }
  return serialize({ sigil, root }, { sigil, baseLevel: opts.baseLevel, eol: opts.eol })
}

// ---------- parseWithSchema (§3.3) ----------

function getAttr(block: Block, key: string): Attribute | undefined {
  for (const a of block.attrs) if (a.key.join('.') === key) return a
  return undefined
}

function childByName(block: Block, name: string): Block | undefined {
  for (const c of block.children) if (c.name === name) return c
  return undefined
}

/** ALL children with this name — a `blocks` array is a repeated block (§3.2). */
function childrenByName(block: Block, name: string): Block[] {
  return block.children.filter((c) => c.name === name)
}

/** Schema type wins over YAML coercion (§3.3 / format-spec §5). */
function coerceToSchema(value: unknown, prop: JSONSchema): unknown {
  // An InterpolatedValue is a `${…}`-bearing raw text — its data form is `.raw`.
  const v = isInterpolated(value) ? value.raw : value
  const t = prop.type
  if (t === 'number' || t === 'integer') {
    if (typeof v === 'number') return v
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return v
  }
  if (t === 'boolean') {
    if (typeof v === 'boolean') return v
    if (v === 'true') return true
    if (v === 'false') return false
    return v
  }
  if (t === 'string') return typeof v === 'string' ? v : String(v)
  return v
}

/** JSON-schema type name that matches an inline column type (for conflict check). */
function inlineTypeName(type: TypedColumn['type']): string | undefined {
  if (!type) return undefined
  return type.kind === 'list' ? 'array' : type.kind
}

/** Coerce a raw tbl cell by an external schema property (schema wins, §3.3). */
function coerceRawBySchema(raw: string, prop: JSONSchema): unknown {
  const t = prop.type
  const isEmpty = raw === ''
  if (t === 'string') {
    if (isEmpty) return ''
    return raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"'
      ? (coerce(raw) as string)
      : raw
  }
  if (t === 'number' || t === 'integer') {
    const c = coerce(raw)
    return typeof c === 'number' ? c : raw
  }
  if (t === 'boolean') {
    const c = coerce(raw)
    return typeof c === 'boolean' ? c : raw
  }
  if (t === 'array') {
    if (isEmpty) return []
    const sep = xmdd(prop).separator
    return raw.split(typeof sep === 'string' && sep.length === 1 ? sep : ',').map((e) => coerce(e.trim()))
  }
  return coerce(raw)
}

/** `integer` and the inline `number` annotation describe the same column. */
function typesConflict(inline: string, schemaType: unknown): boolean {
  if (inline === schemaType) return false
  return !(inline === 'number' && schemaType === 'integer')
}

/**
 * Coerce a tbl cell honouring the type-source priority (serialize-spec §3.3):
 * external schema > inline header annotation > per-cell coercion (§3).
 */
function coerceTblCell(
  raw: string,
  col: TypedColumn,
  schemaProp: JSONSchema | undefined,
  ctx: Ctx,
): unknown {
  if (schemaProp && schemaProp.type !== undefined) {
    const inline = inlineTypeName(col.type)
    if (inline !== undefined && typesConflict(inline, schemaProp.type)) {
      // Conflict: schema wins, but warn (§3.3 / acceptance §7.5).
      ctx.warn(
        `parseWithSchema: column "${col.name}" inline type "${inline}" conflicts with ` +
          `schema type "${String(schemaProp.type)}" — schema wins.`,
      )
    }
    return coerceRawBySchema(raw, schemaProp)
  }
  // No external type — inline annotation, else per-cell §3.
  return coerceTyped(raw, col)
}

function scalarOfListItem(item: unknown): Scalar {
  if (isInterpolated(item)) return item.raw
  return item as Scalar
}

/** Read an unclaimed block with NO schema: fenced JSON, else a generic structure. */
function readUnknownBlock(block: Block): unknown {
  const fence = readJsonFence(bodyData(block.body))
  if (fence.ok) return fence.value

  const out: Record<string, unknown> = {}
  for (const a of block.attrs) out[a.key.join('.')] = attrToPlain(a.value)
  for (const c of block.children) out[c.name] = readUnknownBlock(c)
  const body = bodyText(block.body)
  if (Object.keys(out).length === 0) return body
  if (body !== '') out[UNKNOWN_KEY] = body
  return out
}

function readMap(child: Block, prop: JSONSchema, ctx: Ctx): Record<string, unknown> {
  const fence = readJsonFence(bodyData(child.body))
  if (fence.ok && fence.value !== null && typeof fence.value === 'object') {
    return fence.value as Record<string, unknown>
  }
  const valueSchema = mapValueSchema(prop)
  const map: Record<string, unknown> = {}
  for (const c of child.children) {
    map[c.name] =
      valueSchema.type === 'object'
        ? readObject(c, valueSchema, ctx)
        : coerceToSchema(bodyText(c.body), valueSchema)
  }
  return map
}

/** Block names the schema claims — key or `x-mdd.block` (§3.9). */
function claimedBlockNames(schema: JSONSchema): Set<string> {
  const names = new Set<string>()
  for (const [key, prop] of Object.entries(props(schema))) names.add(blockNameOf(prop, key))
  return names
}

function readObject(block: Block, schema: JSONSchema, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const usedAttrs = new Set<Attribute>()
  const usedChildren = new Set<Block>()

  const takeAttr = (key: string): Attribute | undefined => {
    const a = getAttr(block, key)
    if (a) usedAttrs.add(a)
    return a
  }
  const takeChild = (name: string): Block | undefined => {
    const c = childByName(block, name)
    if (c) usedChildren.add(c)
    return c
  }

  for (const [key, prop] of Object.entries(props(schema))) {
    const storage = storageOf(prop)
    const bname = blockNameOf(prop, key)

    if (storage === 'name') {
      if (block.name !== '') out[key] = coerceToSchema(block.name, prop)
      continue
    }
    if (storage === 'id') {
      if (block.id !== undefined) out[key] = coerceToSchema(block.id, prop)
      continue
    }
    if (storage === 'body') {
      if (block.body !== undefined) out[key] = coerceToSchema(bodyText(block.body), prop)
      continue
    }

    // as: 'json' — a fenced JSON block. A body not recognised as a fence is read
    // generically (like an unknown block): approximate beats lost.
    if (asJson(prop)) {
      const child = takeChild(bname)
      if (child) {
        const fence = readJsonFence(bodyData(child.body))
        out[key] = fence.ok ? fence.value : readUnknownBlock(child)
      }
      continue
    }

    // storage: 'block' — a body block of its own. An empty body is an empty string
    // (the block exists).
    if (storage === 'block') {
      const child = takeChild(bname)
      if (child) out[key] = coerceToSchema(bodyText(child.body), prop)
      continue
    }

    if (prop.type === 'array') {
      const mode = listModeOf(prop, undefined)
      if (mode === 'flow') {
        const a = takeAttr(key)
        if (a && Array.isArray(a.value)) {
          const items = itemsOf(prop)
          out[key] = a.value.map((it) => coerceToSchema(scalarOfListItem(it), items))
        }
      } else if (mode === 'lines') {
        const child = takeChild(bname)
        if (child) {
          const t = bodyText(child.body)
          out[key] = t === '' ? [] : t.split('\n')
        }
      } else if (mode === 'blocks') {
        const items = itemsOf(prop)
        // Elements are repeated blocks named after the property key (or x-mdd.block).
        // When the items schema carries an `x-storage: name` field the element's own
        // name replaces that header, so the elements are instead every block the schema
        // does not otherwise claim (documented limitation: at most one such array per
        // object, and it swallows what a catch-all would have collected).
        const claimed = claimedBlockNames(schema)
        const kids = hasNameStorage(items)
          ? block.children.filter((c) => !claimed.has(c.name))
          : childrenByName(block, bname)
        for (const c of kids) usedChildren.add(c)
        if (kids.length > 0) {
          out[key] = kids.map((c) =>
            isScalarSchema(items) ? coerceToSchema(bodyText(c.body), items) : readObject(c, items, ctx),
          )
        } else {
          // Zero blocks means either no field at all, or an empty list — and an empty
          // list is carried by the degenerate empty flow attribute (§3.5).
          const a = takeAttr(key)
          if (a && Array.isArray(a.value)) out[key] = []
        }
      } else {
        // tbl — external schema wins over inline header types (§3.3 priority).
        const child = takeChild(bname)
        if (child) {
          const { columns, rows } = parseTableRows(bodyText(child.body))
          const itemProps = props(itemsOf(prop))
          out[key] = rows.map((row) => {
            const obj: Record<string, unknown> = {}
            columns.forEach((col, idx) => {
              obj[col.name] = coerceTblCell(row[idx] ?? '', col, itemProps[col.name], ctx)
            })
            return obj
          })
        }
      }
      continue
    }

    if (isMapSchema(prop)) {
      const child = takeChild(bname)
      if (child) out[key] = readMap(child, prop, ctx)
      continue
    }

    if (prop.type === 'object') {
      const child = takeChild(bname)
      if (child) out[key] = readObject(child, prop, ctx)
      continue
    }

    // Scalar attribute.
    const a = takeAttr(key)
    if (a !== undefined) out[key] = coerceToSchema(a.value, prop)
  }

  if (unknownEnabled(schema)) {
    const bag: Record<string, unknown> = {}
    for (const a of block.attrs) {
      if (usedAttrs.has(a)) continue
      bag[a.key.join('.')] = attrToPlain(a.value)
    }
    for (const c of block.children) {
      if (usedChildren.has(c)) continue
      if (c.name === UNKNOWN_OVERFLOW_BLOCK) {
        const fence = readJsonFence(bodyData(c.body))
        if (fence.ok && fence.value !== null && typeof fence.value === 'object' && !Array.isArray(fence.value)) {
          Object.assign(bag, fence.value)
          continue
        }
      }
      bag[c.name] = readUnknownBlock(c)
    }
    if (Object.keys(bag).length > 0) {
      if (unknownInline(schema)) Object.assign(out, bag)
      else out[UNKNOWN_KEY] = bag
    }
  }

  return out
}

/**
 * Parse mdd/mdz text back into an object through a JSON Schema (serialize-spec §3.3).
 *
 * Inverse of {@link serializeWithSchema}: reassembles the object from x-storage
 * placement and coerces each field by its schema type (schema type wins over
 * YAML coercion). Generic `<T>` is a TS-only convenience — no runtime effect.
 */
export function parseWithSchema<T = unknown>(
  text: string,
  schema: JSONSchema,
  opts: ParseWithSchemaOptions = {},
): T {
  const doc: Document = parse(text, { sigil: opts.sigil, baseLevel: opts.baseLevel })
  const recordBlock =
    hasNameStorage(schema) && doc.root.children.length > 0 ? doc.root.children[0] : doc.root
  return readObject(recordBlock, schema, ctxOf(opts)) as T
}

// ---------- validate (§3.4) ----------

let ajvCtor: unknown = undefined // undefined = not yet tried, null = unavailable

function loadAjv2020(): unknown {
  if (ajvCtor !== undefined) return ajvCtor
  ajvCtor = null
  try {
    // Ajv is an OPTIONAL peer (§3.4) — resolve it synchronously if present.
    // This Node-only delegate is the TS binding; ports use their native validator.
    // eval('require') broke under ESM (there is no require, so validate always threw
    // 'not installed'). process.getBuiltinModule gives synchronous access to a builtin
    // from ESM (Node 22.3+); in a browser the typeof guard yields null and the caller
    // injects a validator instead.
    const builtin = (
      typeof process !== 'undefined' &&
      typeof (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule === 'function'
    )
      ? (process as unknown as { getBuiltinModule(id: string): { createRequire(url: string): (id: string) => unknown } }).getBuiltinModule('module')
      : undefined
    const req = builtin?.createRequire(import.meta.url)
    if (typeof req === 'function') {
      const mod = req('ajv/dist/2020.js') as { default?: unknown } | (new (o: unknown) => unknown)
      ajvCtor = (mod as { default?: unknown }).default ?? mod
    }
  } catch {
    ajvCtor = null
  }
  return ajvCtor
}

/**
 * Validate an object against a schema (serialize-spec §3.4).
 *
 * Delegates to Ajv2020 with `addVocabulary(['x-storage','x-mdd','x-ui'])` so the
 * strict mode does not choke on our x-extensions (nr-schema §5). Ajv is an
 * OPTIONAL peer — when it is not installed and no `opts.validator` is provided,
 * a clear error is thrown ("install ajv or provide a validator").
 */
export function validate(obj: unknown, schema: JSONSchema, opts: ValidateOptions = {}): ValidationResult {
  if (opts.validator) return opts.validator(obj, schema)

  const Ctor = loadAjv2020()
  if (!Ctor) {
    throw new Error(
      'validate: Ajv is not installed. Install the optional peer `ajv` (Ajv2020), ' +
        'or pass a validator via opts.validator.',
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = Ctor as new (o: unknown) => any
  const ajv = new AjvCtor({ strict: true, allErrors: true })
  ajv.addVocabulary(['x-storage', 'x-mdd', 'x-ui'])
  const validateFn = ajv.compile(schema)
  const valid = Boolean(validateFn(obj))
  const errors: ValidationError[] = valid
    ? []
    : ((validateFn.errors ?? []) as Array<{ instancePath?: string; message?: string }>).map((e) => ({
        path: e.instancePath ?? '',
        message: e.message ?? 'invalid',
      }))
  return { valid, errors }
}
