import { describe, it, expect } from 'vitest'
import { parse } from '../src/parser.js'
import type { Block, InterpolatedValue } from '../src/types.js'

function children(doc: ReturnType<typeof parse>): Block[] {
  return doc.root.children
}

describe('parser: headers (§2.1)', () => {
  it('parses simple block header', () => {
    const doc = parse('# $foo\n')
    expect(children(doc)).toHaveLength(1)
    expect(children(doc)[0]).toMatchObject({ name: 'foo', level: 1 })
    expect(children(doc)[0].id).toBeUndefined()
  })

  it('parses header with id', () => {
    const doc = parse('# $foo my id\n')
    expect(children(doc)[0]).toMatchObject({ name: 'foo', id: 'my id' })
  })

  it('supports dotted name in header', () => {
    const doc = parse('# $chub.ru\n', { sigil: '$' })
    expect(children(doc)[0].name).toBe('chub.ru')
  })

  it('nests by header level', () => {
    const doc = parse(['# $parent', '## $child', '## $sibling'].join('\n'))
    expect(children(doc)).toHaveLength(1)
    expect(children(doc)[0].children).toHaveLength(2)
    expect(children(doc)[0].children[0].name).toBe('child')
    expect(children(doc)[0].children[1].name).toBe('sibling')
  })

  it('coexisting names form a collection', () => {
    const doc = parse(['# $item one', '# $item two', '# $item'].join('\n'))
    expect(children(doc)).toHaveLength(3)
    expect(children(doc).map((b) => b.id)).toEqual(['one', 'two', undefined])
  })

  it('baseLevel shifts effective level', () => {
    const doc = parse('## $foo\n### $bar\n', { baseLevel: 2 })
    expect(children(doc)).toHaveLength(1)
    expect(children(doc)[0].name).toBe('foo')
    expect(children(doc)[0].level).toBe(1)
    expect(children(doc)[0].children[0].name).toBe('bar')
    expect(children(doc)[0].children[0].level).toBe(2)
  })
})

describe('parser: closing tokens (§2.1)', () => {
  it('## $ closes back to global zone', () => {
    const doc = parse(['# $a', '$x: 1', '## $', '# $b'].join('\n'))
    expect(children(doc)).toHaveLength(2)
    expect(children(doc)[0].name).toBe('a')
    expect(children(doc)[1].name).toBe('b')
  })

  it('## $@ closes back to global zone (mdz)', () => {
    const doc = parse(['# $a', '## $@', '# $b'].join('\n'))
    expect(children(doc)).toHaveLength(2)
  })

  it('mdd uses ## @ / ## @@', () => {
    const doc = parse(['# @a', '## @@', '# @b'].join('\n'), { sigil: '@' })
    expect(children(doc)).toHaveLength(2)
    const doc2 = parse(['# @a', '## @', '# @b'].join('\n'), { sigil: '@' })
    expect(children(doc2)).toHaveLength(2)
  })

  it('## $$ is reserved — not a header (treated as body)', () => {
    const doc = parse(['# $a', '## $$'].join('\n'))
    expect(children(doc)[0].body).toBe('## $$')
  })
})

describe('parser: attributes (§2.2)', () => {
  it('parses scalar attribute', () => {
    const doc = parse(['# $b', '$k: 42'].join('\n'))
    expect(children(doc)[0].attrs).toEqual([{ key: ['k'], value: 42 }])
  })

  it('dotted key is a single literal name (not a path)', () => {
    const doc = parse(['# $b', '$a.b.c: x'].join('\n'))
    expect(children(doc)[0].attrs[0].key).toEqual(['a.b.c'])
  })

  it('attributes accumulate in order (for last-wins downstream)', () => {
    const doc = parse(['# $b', '$x: 1', '$x: 2'].join('\n'))
    expect(children(doc)[0].attrs.map((a) => a.value)).toEqual([1, 2])
  })

  it('global attribute (before any block) attaches to root', () => {
    const doc = parse('$g: true\n# $b\n')
    expect(doc.root.attrs).toEqual([{ key: ['g'], value: true }])
  })
})

describe('parser: body (§2.3, §6)', () => {
  it('captures body text', () => {
    const doc = parse(['# $b', 'hello', 'world'].join('\n'))
    expect(children(doc)[0].body).toBe('hello\nworld')
  })

  it('body coexists with attributes', () => {
    const doc = parse(['# $b', '$k: 1', 'body line'].join('\n'))
    const b = children(doc)[0]
    expect(b.attrs).toEqual([{ key: ['k'], value: 1 }])
    expect(b.body).toBe('body line')
  })

  it('recognises ${} inside body', () => {
    const doc = parse(['# $b', 'hello ${name}'].join('\n'))
    const body = children(doc)[0].body as InterpolatedValue
    expect(body.raw).toBe('hello ${name}')
    expect(body.placeholders).toHaveLength(1)
    expect(body.placeholders[0].raw).toBe('name')
  })

  it('normalises CRLF', () => {
    const doc = parse('# $b\r\nfoo\r\nbar\r\n')
    expect(children(doc)[0].body).toBe('foo\nbar')
  })
})

describe('parser: value-level integration', () => {
  it('attribute value with ${} → InterpolatedValue', () => {
    const doc = parse(['# $b', '$k: hi ${name}'].join('\n'))
    const v = children(doc)[0].attrs[0].value as InterpolatedValue
    expect(v.raw).toBe('hi ${name}')
    expect(v.placeholders).toHaveLength(1)
  })

  it('attribute flow value', () => {
    const doc = parse(['# $b', '$k: $[a, b, c]'].join('\n'))
    expect(children(doc)[0].attrs[0].value).toEqual(['a', 'b', 'c'])
  })

  it('attribute with bare comma stays a string (§4)', () => {
    const doc = parse(['# $b', '$k: man, sitting, chair'].join('\n'))
    expect(children(doc)[0].attrs[0].value).toBe('man, sitting, chair')
  })

  it('mdd format uses @ sigil end-to-end', () => {
    const doc = parse(
      ['# @top', '@k: 1', '## @child name-x', '@flow: @[1, 2]'].join('\n'),
      { sigil: '@' },
    )
    expect(doc.sigil).toBe('@')
    expect(children(doc)[0].name).toBe('top')
    expect(children(doc)[0].attrs[0]).toEqual({ key: ['k'], value: 1 })
    expect(children(doc)[0].children[0]).toMatchObject({ name: 'child', id: 'name-x' })
    expect(children(doc)[0].children[0].attrs[0].value).toEqual([1, 2])
  })
})

describe('parser: nr-* attributes are plain', () => {
  it('nr- attributes are parsed as ordinary attributes', () => {
    const doc = parse(['# $b', '$nr-body-parser: tbl'].join('\n'))
    expect(children(doc)[0].attrs[0]).toEqual({
      key: ['nr-body-parser'],
      value: 'tbl',
    })
  })
})


describe('parser: body fragments around nested blocks (data-loss regression)', () => {
  it('root body resumes after a closed block — fragments appended, not overwritten', () => {
    const text = [
      'before fragment',
      '',
      '## $note draft',
      'inside block',
      '## $@',
      '',
      'after fragment',
    ].join('\n')
    const doc = parse(text, { sigil: '$' })
    const body = doc.root.body
    expect(body).toBeDefined()
    const raw = typeof body === 'string' ? body : (body as InterpolatedValue).raw
    expect(raw).toContain('before fragment')
    expect(raw).toContain('after fragment')
    expect(raw).not.toContain('inside block')
    // Fragments joined as strophes (\n\n), document order preserved.
    expect(raw).toBe('before fragment\n\nafter fragment')
  })

  it('three fragments around two blocks all survive in order', () => {
    const text = [
      'one',
      '## $a',
      'x',
      '## $@',
      'two',
      '## $b',
      'y',
      '## $@',
      'three',
    ].join('\n')
    const doc = parse(text, { sigil: '$' })
    const body = doc.root.body
    const raw = typeof body === 'string' ? body : (body as InterpolatedValue).raw
    expect(raw).toBe('one\n\ntwo\n\nthree')
  })

  it('fragment with placeholders re-parses correctly after append', () => {
    const text = [
      'hello ${name}',
      '## $a',
      'x',
      '## $@',
      'bye ${name}',
    ].join('\n')
    const doc = parse(text, { sigil: '$' })
    const body = doc.root.body as InterpolatedValue
    expect(typeof body).toBe('object')
    expect(body.raw).toBe('hello ${name}\n\nbye ${name}')
    expect(body.placeholders.length).toBe(2)
  })
})
