import { describe, it, expect } from 'vitest'
import { parse } from '../src/parser.js'

// §2.2: a dot in an attribute key is a literal part of the name — no escape,
// no path-splitting. Same as block names (§2.1). The `\.` escape lives only on
// the access side (`${...}`, §7.1), never in the key.
function keys(lines: string[]): string[][] {
  return parse(lines.join('\n')).root.children[0].attrs.map((a) => a.key)
}

describe('attribute key dots (§2.2): dots are literal, no escape', () => {
  it('a dotted key is one literal name, not a path', () => {
    expect(keys(['# $b', '$a.b.c: x'])).toEqual([['a.b.c']])
  })

  it('real-world dotted key like chub.ru stays literal', () => {
    expect(keys(['# $b', '$chub.ru: x'])).toEqual([['chub.ru']])
  })

  it('multiple dotted keys each stay literal (no nesting)', () => {
    expect(keys(['# $b', '$mapping.depthPrompt: a', '$mapping.depth: 1'])).toEqual([
      ['mapping.depthPrompt'],
      ['mapping.depth'],
    ])
  })

  it('a plain single-segment key is unaffected', () => {
    expect(keys(['# $b', '$name: x'])).toEqual([['name']])
  })
})
