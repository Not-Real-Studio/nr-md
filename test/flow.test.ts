import { describe, it, expect } from 'vitest'
import { parseAttributeValue } from '../src/value.js'

describe('flow-literals (§4)', () => {
  it('parses simple flow list', () => {
    expect(parseAttributeValue('$[a, b, c]', '$')).toEqual(['a', 'b', 'c'])
  })

  it('empty flow → []', () => {
    expect(parseAttributeValue('$[]', '$')).toEqual([])
  })

  it('single-element flow → list of one', () => {
    expect(parseAttributeValue('$[a]', '$')).toEqual(['a'])
  })

  it('coerces each element (§4 + §3)', () => {
    expect(parseAttributeValue('$[1, 2, true]', '$')).toEqual([1, 2, true])
  })

  it('quoted element preserves comma', () => {
    expect(parseAttributeValue('$[a, "b, c", d]', '$')).toEqual(['a', 'b, c', 'd'])
  })

  it('escaped comma inside element', () => {
    expect(parseAttributeValue('$[a, b\\,c, d]', '$')).toEqual(['a', 'b,c', 'd'])
  })

  it('bare comma is NOT a list (§4)', () => {
    expect(parseAttributeValue('a, b, c', '$')).toBe('a, b, c')
  })

  it('proseStarting with [ via escape stays a string', () => {
    expect(parseAttributeValue('\\[WIP] foo', '$')).toBe('[WIP] foo')
  })

  it('mdd uses @ sigil for flow', () => {
    expect(parseAttributeValue('@[1, 2]', '@')).toEqual([1, 2])
    // Wrong-sigil → not a flow trigger
    expect(parseAttributeValue('$[1, 2]', '@')).toBe('$[1, 2]')
  })

  it('quoted forces string element', () => {
    expect(parseAttributeValue('$["42", true]', '$')).toEqual(['42', true])
  })

  it('element with ${} stays as InterpolatedValue', () => {
    const v = parseAttributeValue('$[a, ${x}, c]', '$') as any[]
    expect(v[0]).toBe('a')
    // The span, not the expression: nr-md records WHERE `${x}` sits, and leaves
    // reading `x` to whoever evaluates it.
    expect(v[1]).toMatchObject({
      raw: '${x}',
      placeholders: [{ raw: 'x', start: 0, end: 4 }],
    })
    expect(v[2]).toBe('c')
  })
})
