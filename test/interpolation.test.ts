// The private interpolation lexer (nr-md-extract-spec §0.2, §4.3).
//
// What is under test is the LEXICAL half of `${...}`: is there one, and how far
// does it reach. Nothing here knows what the text between the braces means —
// that is the evaluator's grammar, and it lives outside this package.

import { describe, it, expect } from 'vitest'
import { findMatchingBrace, hasOptOutEscape, scanInterpolations } from '../src/interpolation.js'
import { parseAttributeValue, parseBodyValue } from '../src/value.js'
import type { InterpolatedValue } from '../src/types.js'

describe('scanInterpolations — spans', () => {
  it('finds one interpolation with its bounds', () => {
    expect(scanInterpolations('hello ${name}')).toEqual([{ raw: 'name', start: 6, end: 13 }])
  })

  it('finds several, in source order', () => {
    const spans = scanInterpolations('${a} and ${b}')
    expect(spans.map((s) => s.raw)).toEqual(['a', 'b'])
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 4],
      [9, 13],
    ])
  })

  it('reports nothing for text without interpolations', () => {
    expect(scanInterpolations('plain text, no braces')).toEqual([])
  })

  it('spans slice back to the original text', () => {
    const text = 'a ${x.y} b ${fn(1, 2)} c'
    for (const s of scanInterpolations(text)) {
      expect(text.slice(s.start, s.end)).toBe('${' + s.raw + '}')
    }
  })

  it('takes the OUTER span when interpolations nest', () => {
    expect(scanInterpolations('${a.${b}}')).toEqual([{ raw: 'a.${b}', start: 0, end: 9 }])
  })

  it('nests inside call arguments too', () => {
    expect(scanInterpolations('${fn(${x})}')).toEqual([{ raw: 'fn(${x})', start: 0, end: 11 }])
  })

  it('does not parse the expression — any content is a span', () => {
    // Nonsense to an evaluator, ordinary text to the lexer.
    expect(scanInterpolations('${!!! 1 + }{ }')).toEqual([{ raw: '!!! 1 + ', start: 0, end: 11 }])
    expect(scanInterpolations('${}')).toEqual([{ raw: '', start: 0, end: 3 }])
  })

  it('treats an unbalanced opener as literal text', () => {
    expect(scanInterpolations('${unclosed')).toEqual([])
    expect(scanInterpolations('a ${x b ${y}')).toEqual([{ raw: 'y', start: 8, end: 12 }])
  })

  it('skips an escaped opener — it is a literal ${', () => {
    expect(scanInterpolations('hello \\${world}')).toEqual([])
  })

  it('an escaped opener does not hide a live one after it', () => {
    const spans = scanInterpolations('a \\${lit} b ${real}')
    expect(spans.map((s) => s.raw)).toEqual(['real'])
  })

  it('an escaped backslash leaves the next opener live', () => {
    const spans = scanInterpolations('\\\\${live}')
    expect(spans.map((s) => s.raw)).toEqual(['live'])
  })

  it('sees interpolations inside double quotes — quotes are not grammar here', () => {
    const spans = scanInterpolations('{"model": "${m}"}')
    expect(spans.map((s) => s.raw)).toEqual(['m'])
  })
})

describe('findMatchingBrace', () => {
  it('matches the closer of a flat interpolation', () => {
    expect(findMatchingBrace('${abc}', 2)).toBe(5)
  })

  it('counts nested ${ but not a bare {', () => {
    expect(findMatchingBrace('${a.${b}}', 2)).toBe(8)
    expect(findMatchingBrace('${a}', 2)).toBe(3)
  })

  it('skips a quoted string, including an escaped quote inside it', () => {
    expect(findMatchingBrace('${fn("}")}', 2)).toBe(9)
    expect(findMatchingBrace('${fn("a\\"}b")}', 2)).toBe(13)
  })

  it('consumes both characters of an escape sequence', () => {
    expect(findMatchingBrace('${a\\}b}', 2)).toBe(6)
  })

  it('returns -1 when the brace never closes', () => {
    expect(findMatchingBrace('${abc', 2)).toBe(-1)
    expect(findMatchingBrace('${a.${b}', 2)).toBe(-1)
  })
})

describe('hasOptOutEscape', () => {
  it('sees the escaped opener', () => {
    expect(hasOptOutEscape('literal \\${x}')).toBe(true)
  })

  it('does not fire on a live interpolation', () => {
    expect(hasOptOutEscape('live ${x}')).toBe(false)
  })

  it('does not fire when the backslash is itself escaped', () => {
    expect(hasOptOutEscape('\\\\${live}')).toBe(false)
  })

  it('is false for text with no backslash at all', () => {
    expect(hasOptOutEscape('nothing here')).toBe(false)
  })
})

describe('the lexer as the parser uses it', () => {
  it('an attribute value with ${} becomes an InterpolatedValue carrying spans', () => {
    const v = parseAttributeValue('hi ${name}', '$') as InterpolatedValue
    expect(v.raw).toBe('hi ${name}')
    expect(v.placeholders).toEqual([{ raw: 'name', start: 3, end: 10 }])
  })

  it('a body with ${} becomes an InterpolatedValue carrying spans', () => {
    const v = parseBodyValue('${a} then ${b}') as InterpolatedValue
    expect(v.placeholders.map((p) => p.raw)).toEqual(['a', 'b'])
  })

  it('an expression the parser cannot read is still just a span', () => {
    // nrd-core's evaluator rejects this; nr-md has no opinion, and must not
    // throw at parse time on text it does not claim to understand.
    const v = parseAttributeValue('${1 + 2}', '$') as InterpolatedValue
    expect(v.placeholders.map((p) => p.raw)).toEqual(['1 + 2'])
  })

  it('a flow element splits on top-level commas only, never inside ${}', () => {
    const list = parseAttributeValue('$[a, ${fn(x, y)}, c]', '$') as unknown[]
    expect(list).toHaveLength(3)
    expect(list[0]).toBe('a')
    expect((list[1] as InterpolatedValue).raw).toBe('${fn(x, y)}')
    expect(list[2]).toBe('c')
  })
})
