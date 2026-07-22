// Conformance — round-trip parse(serialize(doc)) ≡ doc (format-spec §9, §10).
// The corpus: blocks, nested blocks, flow arrays, quoted scalars, and — the
// interesting part — BODIES containing lines that look like `$key: value`,
// `## $name`, `%role`.
//
// A body line that re-parses as structure is the hard case: serialization has to
// escape the sigil, and the parser has to unfold it exactly once.
import { describe, it, expect } from 'vitest'
import { parse } from '../../src/parser.js'
import { serialize } from '../../src/serialize.js'
import type { Document, Block } from '../../src/types.js'

/** parse(serialize(doc)) must give a structurally identical document. */
function rt(text: string): void {
  const doc = parse(text)
  const out = serialize(doc)
  const back = parse(out)
  expect(back).toEqual(doc)
}

/** Round-trip of a document built in code (the body is set directly). */
function rtDoc(doc: Document): void {
  const out = serialize(doc)
  const back = parse(out)
  expect(back).toEqual(doc)
}

function block(name: string, body: string, extra: Partial<Block> = {}): Block {
  return { name, level: 1, attrs: [], children: [], body, ...extra }
}
function docWith(...children: Block[]): Document {
  return { sigil: '$', root: { name: '', level: 0, attrs: [], children } }
}

describe('conformance: round-trip — the base corpus', () => {
  it('blocks with attributes', () => rt(['# $a', '$x: 1', '# $b my-id', '$y: hello'].join('\n')))
  it('nested blocks', () => rt(['# $p', '$p: 1', '## $c', '$c: 2', '## $d', '$d: 3'].join('\n')))
  it('flow arrays', () => rt(['# $b', '$list: $[a, b, "c, d", 1, true]'].join('\n')))
  it('quoted scalars', () =>
    rt(['# $b', '$q: "  spaced  "', '$n: "42"', '$v: "1.10"'].join('\n')))
  it('a collection of blocks (mixed ids)', () =>
    rt(['# $item one', '$v: 1', '# $item', '$v: 2', '# $item three', '$v: 3'].join('\n')))
  it('interpolation and its opt-out inside values', () =>
    rt(['# $b', '$k: hello ${name}!', '$o: price \\${USD}'].join('\n')))
  it('a plain prose body', () => rt(['# $b', '$x: 1', 'Just some body text.', 'A second line.'].join('\n')))
})

describe('conformance: round-trip — bodies with dangerous lines', () => {
  it('a body line that looks like `$key: value` (the sigil is escaped)', () => {
    rtDoc(docWith(block('b', '$key: value\nordinary text')))
  })

  it('a body line that looks like `## $name` (the sigil is escaped)', () => {
    rtDoc(docWith(block('b', 'intro\n## $inner\noutro')))
  })

  it('a body line that looks like `%role` (stable at the document level)', () => {
    // `%role` is not structure at the document level — a message splitter handles it
    // on request — so the round-trip needs no escape here.
    rtDoc(docWith(block('b', '%user\nhello')))
  })

  it('a body with every marker at once', () => {
    rtDoc(docWith(block('b', '$k: v\n## $h name\n#heading $x\n%assistant\ntail')))
  })

  it('a body starting with a sigil header at root level', () => {
    rtDoc(docWith(block('b', '# $top\n$inner: 1\nbody')))
  })
})

describe('conformance: double-unescaping a body (the append path, §2.5)', () => {
  it('a body resumed after a block unescapes `\\\\$`/`\\\\#` exactly once', () => {
    // root body → block → close → root body again. Unfolding per fragment would
    // unescape the FIRST fragment twice (\\$ → \$ → $) and lose the backslash.
    const doc = parse(
      ['one \\\\$ dollar', '# $blk', '$a: 1', '## $', 'two \\\\# hash'].join('\n'),
    )
    const body = typeof doc.root.body === 'string' ? doc.root.body : (doc.root.body as any)?.raw
    // One unfold: \\$ → \$ (the backslash survives), \\# → \# .
    expect(body).toBe('one \\$ dollar\n\ntwo \\# hash')
  })
})
