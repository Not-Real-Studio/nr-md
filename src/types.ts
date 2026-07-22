// Parse-tree types: what `parse` produces and `serialize` consumes.
// Section numbers throughout this package refer to format-spec / serialize-spec,
// the normative grammar reference (see README).

/** Format sigil — `$` for mdz, `@` for mdd. */
export type Sigil = '@' | '$'

// ---------- Values (§3, §4, §7.2) ----------

export type Scalar = string | number | boolean | null

/**
 * A recognised `${...}` interpolation, as a span in the containing raw text.
 *
 * nr-md lexes interpolations, it does not parse them: the span says WHERE the
 * expression is, never what it means. The expression grammar belongs to whoever
 * evaluates it — a different layer, possibly a different language.
 */
export interface InterpolationSpan {
  /** Text between `${` and the matching `}`, verbatim. */
  raw: string
  /** Offset of the `$` in the containing raw value. */
  start: number
  /** Offset just past the closing `}` (exclusive). */
  end: number
}

/**
 * A value that carries at least one `${...}` (or the `\${` opt-out marker).
 *
 * `raw` is the fact: original text, escapes NOT unfolded, interpolations left
 * in place. Consumers that resolve interpolations read `raw`; `placeholders`
 * is the lexer's index into it.
 */
export interface InterpolatedValue {
  raw: string
  placeholders: InterpolationSpan[]
}

export type ListItem = Scalar | InterpolatedValue

/** A value inside a JSON5 object: scalars, arrays, nested objects. */
export type Json5Value = Scalar | Json5Value[] | Json5Object

/**
 * A JSON5 object used as an attribute value (§3; json5-scalar-spec).
 *
 * A plain object — no behaviour attached. A path into it (`${attr.path}`) is
 * the evaluator's business, not the parser's.
 */
export interface Json5Object {
  [key: string]: Json5Value
}

export type AttributeValue = Scalar | ListItem[] | InterpolatedValue | Json5Object

export type BodyValue = string | InterpolatedValue

// ---------- Tree (§2) ----------

/**
 * Source position of a tree node.
 *
 * Reserved slot: nothing populates it yet. It exists so that adding position
 * tracking later cannot break an exhaustive walk written against this AST.
 */
export interface Pos {
  /** 1-based line in the source text. */
  line: number
  /** 1-based column. */
  col: number
  /** 0-based character offset. */
  offset: number
}

export interface Attribute {
  /** Dotted key as segments (§2.2). Single-segment keys → array of length 1. */
  key: string[]
  value: AttributeValue
  /** Reserved — see {@link Pos}. Not populated. */
  pos?: Pos
}

export interface Block {
  /** Block name (after the sigil in the header). The root pseudo-block has an empty name. */
  name: string
  /** Optional id from the header (§2.1). */
  id?: string
  /** Effective level (1..6) after the baseLevel shift. Root is 0. */
  level: number
  /** Attributes in order of appearance (relevant for §2.4 last-wins). */
  attrs: Attribute[]
  /** Block body, or undefined if empty. */
  body?: BodyValue
  /** Child blocks in order of appearance. */
  children: Block[]
  /** Reserved — see {@link Pos}. Not populated. */
  pos?: Pos
}

export interface Document {
  sigil: Sigil
  root: Block
}

export interface ParseOptions {
  /** Format sigil — `$` for mdz (default), `@` for mdd. */
  sigil?: Sigil
  /** Offset added to the header `#` count; default 1 (h1 root). */
  baseLevel?: number
}

export interface SerializeOptions {
  /**
   * Format sigil to emit — `$` (mdz) | `@` (mdd).
   * Defaults to the document's own sigil (`doc.sigil`).
   */
  sigil?: Sigil
  /** Level of root blocks; mirrors ParseOptions.baseLevel. Default 1. */
  baseLevel?: number
  /** Line ending. Default `\n`. */
  eol?: '\n' | '\r\n'
}
