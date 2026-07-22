import { describe, it, expect } from 'vitest'
import { coerce, isFullyQuoted } from '../src/coerce.js'

describe('coerce (§3)', () => {
  it('coerces booleans', () => {
    expect(coerce('true')).toBe(true)
    expect(coerce('false')).toBe(false)
  })

  it('coerces integers', () => {
    expect(coerce('42')).toBe(42)
    expect(coerce('-7')).toBe(-7)
    expect(coerce('0')).toBe(0)
  })

  it('leading + is not a number -> string (§3)', () => {
    expect(coerce('+42')).toBe('+42')
    expect(coerce('+7905551234')).toBe('+7905551234')
    expect(coerce('+0.5')).toBe('+0.5')
  })

  it('leading-zero int -> string; bare 0 is a number (§3)', () => {
    expect(coerce('007')).toBe('007')
    expect(coerce('-007')).toBe('-007')
    expect(coerce('0')).toBe(0)
    expect(coerce('0.5')).toBe(0.5)
  })

  it('coerces floats', () => {
    expect(coerce('3.14')).toBe(3.14)
    expect(coerce('-0.5')).toBe(-0.5)
  })

  it('treats versionish like float (known collision)', () => {
    expect(coerce('1.10')).toBe(1.1) // collision per §3
  })

  it('coerces null', () => {
    expect(coerce('null')).toBeNull()
  })

  it('returns empty string for empty input', () => {
    expect(coerce('')).toBe('')
  })

  it('quoted forces string and strips quotes', () => {
    expect(coerce('"42"')).toBe('42')
    expect(coerce('"true"')).toBe('true')
    expect(coerce('"hello"')).toBe('hello')
  })

  it('unescapes inside quoted strings', () => {
    expect(coerce('"a\\nb"')).toBe('a\nb')
    expect(coerce('"a\\\\b"')).toBe('a\\b')
    expect(coerce('"a\\"b"')).toBe('a"b')
  })

  it('falls through to string for plain text', () => {
    expect(coerce('hello world')).toBe('hello world')
    expect(coerce('1.2.3')).toBe('1.2.3')
    expect(coerce('1abc')).toBe('1abc')
  })

  it('partially quoted — verbatim, the quotes stay on', () => {
    expect(coerce('"yes" or "no"')).toBe('"yes" or "no"')
    expect(coerce('"a" b')).toBe('"a" b')
    expect(coerce('{"m": "x"}')).toBe('{"m": "x"}')
    expect(coerce('"unterminated')).toBe('"unterminated')
  })

  it('fully quoted — the quotes come off', () => {
    expect(coerce('"quoted"')).toBe('quoted')
    expect(coerce('""')).toBe('')
    expect(coerce('"a\\"b"')).toBe('a"b') // an escaped quote inside is not the closing one
  })
})

describe('isFullyQuoted — the single source of truth about quotes', () => {
  it('quoted end to end', () => {
    expect(isFullyQuoted('"x"')).toBe(true)
    expect(isFullyQuoted('""')).toBe(true)
    expect(isFullyQuoted('"a\\"b"')).toBe(true)
  })

  it('partially quoted, or not quoted at all', () => {
    expect(isFullyQuoted('"yes" or "no"')).toBe(false)
    expect(isFullyQuoted('x')).toBe(false)
    expect(isFullyQuoted('"')).toBe(false)
    expect(isFullyQuoted('"unterminated')).toBe(false)
    expect(isFullyQuoted('a "x"')).toBe(false)
  })
})
