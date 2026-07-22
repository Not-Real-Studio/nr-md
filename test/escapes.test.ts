import { describe, it, expect } from 'vitest'
import { unescape } from '../src/value.js'

describe('escapes (§2.5)', () => {
  it('unfolds basic sigil escapes', () => {
    expect(unescape('\\$foo', { flow: false })).toBe('$foo')
    expect(unescape('\\@foo', { flow: false })).toBe('@foo')
  })

  it('unfolds bracket escape', () => {
    expect(unescape('\\[WIP] foo', { flow: false })).toBe('[WIP] foo')
  })

  it('unfolds backslash escape, preserves \\n \\t outside quotes', () => {
    expect(unescape('a\\\\b', { flow: false })).toBe('a\\b')
    // \n and \t are only escapes inside quoted strings (coerce.ts).
    // Outside quotes they are preserved verbatim: backslash + letter.
    expect(unescape('a\\nb', { flow: false })).toBe('a\\nb')
    expect(unescape('a\\tb', { flow: false })).toBe('a\\tb')
  })

  it('\\${ is a literal ${', () => {
    expect(unescape('hello \\${world}', { flow: false })).toBe('hello ${world}')
  })

  it('\\, is only meaningful inside flow', () => {
    expect(unescape('a\\,b', { flow: false })).toBe('a\\,b') // outside flow → preserved
    expect(unescape('a\\,b', { flow: true })).toBe('a,b')
  })

  it('preserves unknown escapes verbatim', () => {
    expect(unescape('\\r\\u0041', { flow: false })).toBe('\\r\\u0041')
    expect(unescape('\\x', { flow: false })).toBe('\\x')
  })
})
