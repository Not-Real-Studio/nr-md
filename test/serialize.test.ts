import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '../src/parser.js'
import {
  serialize,
  serializeValue,
  serializeTable,
  parseTable,
} from '../src/serialize.js'
import type { ParseOptions, Sigil } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))

/** parse → serialize → parse must yield a semantically identical Document. */
function roundtrip(text: string, opts: ParseOptions = {}): void {
  const doc = parse(text, opts)
  const out = serialize(doc, { sigil: doc.sigil, baseLevel: opts.baseLevel })
  const reparsed = parse(out, { sigil: doc.sigil, baseLevel: opts.baseLevel })
  expect(reparsed).toEqual(doc)
}

/** serialize must be idempotent: serialize(parse(serialize(parse(x)))) == serialize(parse(x)). */
function idempotent(text: string, opts: ParseOptions = {}): void {
  const doc = parse(text, opts)
  const once = serialize(doc, { sigil: doc.sigil, baseLevel: opts.baseLevel })
  const twice = serialize(parse(once, { sigil: doc.sigil, baseLevel: opts.baseLevel }), {
    sigil: doc.sigil,
    baseLevel: opts.baseLevel,
  })
  expect(twice).toBe(once)
}

describe('serialize: round-trip per value type (§1.2)', () => {
  const cases: Array<[string, string]> = [
    ['string', '$k: hello world'],
    ['int', '$k: 42'],
    ['negative int', '$k: -7'],
    ['float', '$k: 3.14'],
    ['boolean true', '$k: true'],
    ['boolean false', '$k: false'],
    ['null', '$k: null'],
    ['empty string', '$k:'],
    ['quoted number stays string', '$k: "42"'],
    ['quoted bool stays string', '$k: "true"'],
    ['version-like via quotes', '$k: "1.10"'],
    ['leading-zero code', '$k: 007'],
    ['leading plus phone', '$k: +79055551234'],
    ['bare comma is one string', '$k: man, sitting, chair'],
    ['flow list', '$k: $[a, b, c]'],
    ['empty flow list', '$k: $[]'],
    ['single-element flow list', '$k: $[only]'],
    ['flow with quoted comma element', '$k: $[a, "b, c", d]'],
    ['flow with typed elements', '$k: $[1, 2, true, null]'],
    ['interpolated value', '$k: hello ${name}!'],
    ['interpolated only', '$k: ${name}'],
    ['nested interpolation', '$k: ${fn(${x})} done'],
    ['opt-out escape', '$k: \\${x}'],
    ['call with comma args', '$k: ${join(a, b)}'],
  ]
  for (const [label, src] of cases) {
    it(label, () => {
      roundtrip(['# $b', src].join('\n'))
      idempotent(['# $b', src].join('\n'))
    })
  }
})

describe('serialize: escaping (§1.5)', () => {
  it('leading sigil that forms a flow trigger is escaped', () => {
    // A scalar string that literally looks like a flow literal.
    const doc = parse('# $b\n$k: \\$[a]\n')
    const out = serialize(doc)
    const reparsed = parse(out)
    expect(reparsed).toEqual(doc)
    // The re-parsed value is the literal string, not a list.
    expect(reparsed.root.children[0].attrs[0].value).toBe('$[a]')
  })

  it('literal backslash survives', () => {
    const doc = parse('# $b\n$k: a\\\\b\n') // value: a\\b → scalar a\b
    expect(doc.root.children[0].attrs[0].value).toBe('a\\b')
    roundtrip('# $b\n$k: a\\\\b\n')
  })

  it('\\${ opt-out round-trips and stays literal', () => {
    roundtrip('# $b\n$k: price \\${USD}\n')
    const doc = parse('# $b\n$k: price \\${USD}\n')
    const v = doc.root.children[0].attrs[0].value as { raw: string }
    expect(v.raw).toBe('price \\${USD}')
    expect(serializeValue(v as never)).toBe('price \\${USD}')
  })

  it('whitespace-bearing scalar is quoted', () => {
    const doc = parse('# $b\n$k: "  spaced  "\n')
    expect(doc.root.children[0].attrs[0].value).toBe('  spaced  ')
    roundtrip('# $b\n$k: "  spaced  "\n')
  })

  it('newline/tab scalar (from quotes) round-trips', () => {
    roundtrip('# $b\n$k: "line1\\nline2\\tend"\n')
  })
})

describe('serialize: blocks (§2.1)', () => {
  it('block with and without id', () => {
    roundtrip(['# $a', '# $b my id', '$x: 1'].join('\n'))
  })

  it('nested blocks', () => {
    roundtrip(['# $parent', '$p: 1', '## $child', '$c: 2', '## $sibling', '$s: 3'].join('\n'))
  })

  it('collection of blocks (mixed id)', () => {
    roundtrip(['# $item one', '$v: 1', '# $item', '$v: 2', '# $item three', '$v: 3'].join('\n'))
  })

  it('dotted block name and dotted key', () => {
    roundtrip(['# $chub.ru', '$positive.text: hi'].join('\n'))
  })

  it('global attributes attach to root', () => {
    roundtrip(['$g: true', '$h: 5', '# $b', '$x: 1'].join('\n'))
  })

  it('body coexists with attributes and children', () => {
    roundtrip(['# $b', '$k: 1', 'body line one', 'body line two', '## $child', '$c: 2'].join('\n'))
  })

  it('explicit close ## $@ is NOT emitted but structure preserved', () => {
    const doc = parse(['# $a', '$x: 1', '## $@', '# $b'].join('\n'))
    const out = serialize(doc)
    expect(out).not.toContain('$@')
    expect(parse(out)).toEqual(doc)
  })

  it('baseLevel is honoured symmetrically', () => {
    roundtrip(['## $foo', '$x: 1', '### $bar', '$y: 2'].join('\n'), { baseLevel: 2 })
  })
})

describe('serialize: mdd (@ sigil)', () => {
  it('round-trips mdd documents', () => {
    const src = ['# @top', '@k: 1', '@flow: @[1, 2]', '## @child name-x', '@m: v'].join('\n')
    const doc = parse(src, { sigil: '@' })
    const out = serialize(doc)
    expect(out).toContain('@[1, 2]')
    expect(parse(out, { sigil: '@' })).toEqual(doc)
  })
})

describe('serialize: body (§2.3, §6)', () => {
  it('raw prose body', () => {
    roundtrip(['# $b', 'just some', 'multi-line prose'].join('\n'))
  })

  it('interpolated body restores raw', () => {
    roundtrip(['# $b', 'hello ${name}, welcome'].join('\n'))
  })

  it('opt-out in body stays literal', () => {
    roundtrip(['# $b', 'literal \\${x} here'].join('\n'))
  })

  it('backslash path in body round-trips', () => {
    roundtrip(['# $b', 'path C:\\tmp\\out'].join('\n'))
  })
})

describe('serializeValue: direct', () => {
  it('scalars', () => {
    expect(serializeValue(42)).toBe('42')
    expect(serializeValue(true)).toBe('true')
    expect(serializeValue(null)).toBe('null')
    expect(serializeValue('hello')).toBe('hello')
  })

  it('forces string when needed', () => {
    expect(serializeValue('42')).toBe('"42"')
    expect(serializeValue('true')).toBe('"true"')
  })

  it('flow list', () => {
    expect(serializeValue(['a', 'b'], '$')).toBe('$[a, b]')
    expect(serializeValue([1, 2], '@')).toBe('@[1, 2]')
    expect(serializeValue([], '$')).toBe('$[]')
  })
})

describe('tbl: serialize + parse round-trip (§2, §5)', () => {
  it('basic table', () => {
    const records = [
      { name: 'zit/pinup.safetensors', sm: 1.0, sc: 1.0 },
      { name: 'zit/anime.safetensors', sm: 0.8, sc: 1.0 },
    ]
    const text = serializeTable(records)
    expect(text.split('\n')[0]).toBe('name | sm | sc')
    expect(parseTable(text)).toEqual(records)
  })

  it('typed cells (number/bool/null/string)', () => {
    const records = [{ a: 1, b: true, c: null, d: 'text' }]
    expect(parseTable(serializeTable(records))).toEqual(records)
  })

  it('string that looks numeric is quoted', () => {
    const records = [{ id: '007', code: '42' }]
    const text = serializeTable(records)
    expect(text).toContain('"42"')
    expect(parseTable(text)).toEqual(records)
  })

  it('cell with pipe is quoted', () => {
    const records = [{ note: 'a | b', ok: true }]
    const text = serializeTable(records)
    expect(parseTable(text)).toEqual(records)
  })

  it('cell with comment marker is quoted', () => {
    const records = [{ url: 'http://example.com', n: 1 }]
    const text = serializeTable(records)
    expect(parseTable(text)).toEqual(records)
  })

  it('empty records → header only', () => {
    expect(serializeTable([], { columns: ['a', 'b'] })).toBe('a | b')
    expect(parseTable('a | b')).toEqual([])
  })

  it('ignores decorative and comment lines on parse', () => {
    const text = ['name | v', '// a comment', '# group', 'x | 1', '* y | 2 // inline'].join('\n')
    expect(parseTable(text)).toEqual([
      { name: 'x', v: 1 },
    ])
  })
})

describe('serialize: real comfy sample', () => {
  const sample = readFileSync(join(here, 'samples', 'comfy.mdz'), 'utf8')

  it('round-trips the comfy sample', () => {
    const doc = parse(sample)
    const out = serialize(doc)
    expect(parse(out)).toEqual(doc)
  })

  it('is idempotent on the comfy sample', () => {
    idempotent(sample)
  })

  it('preserves the lora table body verbatim (as raw body)', () => {
    const doc = parse(sample)
    const out = serialize(doc)
    const reparsed = parse(out)
    const findLora = (d: ReturnType<typeof parse>) =>
      d.root.children.find((b) => b.name === 'lora')!.body
    expect(findLora(reparsed)).toEqual(findLora(doc))
  })
})
