import { describe, it, expect } from 'vitest'
import { parse } from '../src/parser.js'
import type { InterpolatedValue } from '../src/types.js'

function attr(lines: string[]): InterpolatedValue {
  return parse(lines.join('\n')).root.children[0].attrs[0].value as InterpolatedValue
}
function body(lines: string[]): InterpolatedValue {
  return parse(lines.join('\n')).root.children[0].body as InterpolatedValue
}

describe('opt-out escape \\${ survives parsing (format-spec open #1)', () => {
  it('attribute with only \\${ → raw preserved, no live placeholders', () => {
    const v = attr(['# $b', '$k: \\${name}'])
    expect(v.raw).toBe('\\${name}') // escape NOT unfolded by the parser
    expect(v.placeholders).toEqual([]) // escaped opener is not a live placeholder
  })

  it('body with only \\${ → raw preserved', () => {
    const v = body(['# $b', 'literal \\${x} here'])
    expect(v.raw).toBe('literal \\${x} here')
    expect(v.placeholders).toEqual([])
  })

  it('\\${ alongside a live placeholder: one resolvable, one preserved', () => {
    const v = attr(['# $b', '$k: ${live} and \\${dead}'])
    expect(v.raw).toBe('${live} and \\${dead}')
    expect(v.placeholders).toHaveLength(1)
    expect(v.placeholders[0].raw).toBe('live')
  })

  it('\\\\${x} is escaped backslash + LIVE placeholder (no false opt-out)', () => {
    const v = attr(['# $b', '$k: \\\\${x}'])
    expect(v.placeholders).toHaveLength(1)
    expect(v.placeholders[0].raw).toBe('x')
  })

  it('flow element with \\${ → raw preserved as a list item', () => {
    const list = parse(['# $b', '$k: $[plain, \\${kept}]'].join('\n')).root.children[0].attrs[0]
      .value as unknown as unknown[]
    expect(list[0]).toBe('plain')
    expect(list[1]).toEqual({ raw: '\\${kept}', placeholders: [] })
  })
})
