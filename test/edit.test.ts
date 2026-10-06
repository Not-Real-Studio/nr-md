import { describe, it, expect } from 'vitest'
import { parse } from '../src/parser.js'
import { setAttr, removeAttr, ensureBlock, EditTargetError } from '../src/edit.js'
import type { BlockPath, EditOptions } from '../src/edit.js'
import type { AttributeValue, Block, Document } from '../src/types.js'

// Every fixture here is synthetic. Each case checks two properties (spec §4):
// TEXT — outside the touched lines the text is byte-identical;
// MEANING — parse(result) equals parse(source) with one change to the target block.

const lines = (t: string): string[] => t.split(/\r\n|\n/)

function target(doc: Document, path: BlockPath | undefined): Block {
  let cur = doc.root
  for (const sel of path ?? []) {
    cur = cur.children.find((b) => b.name === sel.name && (sel.id === undefined || b.id === sel.id))!
  }
  return cur
}

/** Exactly one line differs; returns [index, new line]. */
function replacedLine(src: string, out: string): [number, string] {
  const a = lines(src)
  const b = lines(out)
  expect(b.length).toBe(a.length)
  const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0)
  expect(diff).toHaveLength(1)
  return [diff[0], b[diff[0]]]
}

/** Exactly one line added, everything else in place; returns [index, new line]. */
function insertedLine(src: string, out: string): [number, string] {
  const a = lines(src)
  const b = lines(out)
  expect(b.length).toBe(a.length + 1)
  let k = 0
  while (k < a.length && a[k] === b[k]) k++
  expect(b.slice(k + 1)).toEqual(a.slice(k))
  return [k, b[k]]
}

function checkSet(
  src: string,
  path: BlockPath | undefined,
  key: string,
  value: AttributeValue,
  opts?: EditOptions,
): string {
  const out = setAttr(src, path, key, value, opts)
  const before = parse(src, opts)
  const expected = structuredClone(before)
  const blk = target(expected, path)
  const idx = blk.attrs.map((a) => a.key.join('.')).lastIndexOf(key)
  if (idx >= 0) blk.attrs[idx] = { key: blk.attrs[idx].key, value }
  else blk.attrs.push({ key: [key], value })
  expect(parse(out, opts)).toEqual(expected)
  return out
}

function checkRemove(src: string, path: BlockPath | undefined, key: string, opts?: EditOptions): string {
  const out = removeAttr(src, path, key, opts)
  const expected = structuredClone(parse(src, opts))
  const blk = target(expected, path)
  blk.attrs = blk.attrs.filter((a) => a.key.join('.') !== key)
  expect(parse(out, opts)).toEqual(expected)
  return out
}

const DOC = [
  '$title: Demo',
  '$// root comment',
  '',
  '## $step load',
  '$src: in.txt',
  '$// note about src',
  '$mode: fast',
  '',
  'Body of load.',
  '',
  '## $step save',
  '$dst: out.txt',
  '',
  '## $empty',
  '',
  'Just a body.',
  '',
  '## $@',
  '$after: 1',
  '',
].join('\n')

describe('positions in parse', () => {
  it('off by default: no pos anywhere', () => {
    expect(JSON.stringify(parse(DOC))).not.toContain('"pos"')
  })

  it('on: every attribute and header points at its own line', () => {
    const doc = parse(DOC, { positions: true })
    const src = DOC.split('\n')
    const walk = (b: Block): void => {
      if (b.level === 0) expect(b.pos).toBeUndefined()
      else {
        expect(src[b.pos!.line - 1].startsWith('## $' + b.name)).toBe(true)
        expect(b.pos!.col).toBe(1)
        expect(DOC.slice(b.pos!.offset).startsWith(src[b.pos!.line - 1])).toBe(true)
      }
      for (const a of b.attrs) {
        expect(src[a.pos!.line - 1].startsWith('$' + a.key.join('.') + ':')).toBe(true)
        expect(DOC.slice(a.pos!.offset).startsWith(src[a.pos!.line - 1])).toBe(true)
      }
      b.children.forEach(walk)
    }
    walk(doc.root)
    // `$// …` is not an attribute (`/` is no name start) — body text, no pos.
    expect(doc.root.attrs.map((a) => a.pos!.line)).toEqual([1, 19])
  })

  it('lines count in the original text under \\r\\n and BOM', () => {
    const doc = parse('\uFEFF$a: 1\r\n\r\n$b: 2', { positions: true })
    expect(doc.root.attrs.map((a) => [a.pos!.line, a.pos!.offset])).toEqual([[1, 0], [3, 7]])
  })

  it('without the option the tree equals the positions tree minus pos', () => {
    const strip = (b: Block): void => {
      delete b.pos
      b.attrs.forEach((a) => delete a.pos)
      b.children.forEach(strip)
    }
    const withPos = parse(DOC, { positions: true })
    strip(withPos.root)
    expect(withPos).toEqual(parse(DOC))
  })
})

describe('setAttr: replace', () => {
  it('root attribute', () => {
    const out = checkSet(DOC, [], 'title', 'Other')
    expect(replacedLine(DOC, out)).toEqual([0, '$title: Other'])
  })

  it('block by name (first match) keeps comments and blanks around', () => {
    const out = checkSet(DOC, [{ name: 'step' }], 'mode', 'slow')
    expect(replacedLine(DOC, out)).toEqual([6, '$mode: slow'])
  })

  it('block by name and id', () => {
    const out = checkSet(DOC, [{ name: 'step', id: 'save' }], 'dst', 'x.txt')
    expect(replacedLine(DOC, out)).toEqual([11, '$dst: x.txt'])
  })

  it('root attribute after a closed block; `## $@` stays', () => {
    const out = checkSet(DOC, undefined, 'after', 2)
    expect(replacedLine(DOC, out)).toEqual([18, '$after: 2'])
    expect(out).toContain('\n## $@\n')
  })

  it('keeps everything before the value as it was', () => {
    const src = '$k:1\n$j:  2\n'
    expect(setAttr(src, [], 'k', 5)).toBe('$k:5\n$j:  2\n')
    // `$j:  2` — the parser eats one space; the second belongs to the value.
    expect(setAttr(src, [], 'j', 3)).toBe('$k:1\n$j: 3\n')
  })

  it('duplicates: the last one is edited, the others untouched', () => {
    const src = '## $b\n$k: 1\n$x: y\n$k: 2\n'
    const out = checkSet(src, [{ name: 'b' }], 'k', 3)
    expect(out).toBe('## $b\n$k: 1\n$x: y\n$k: 3\n')
  })

  it('dotted key is one name', () => {
    const src = '$chub.ru: old\n$chub: other\n'
    const out = checkSet(src, [], 'chub.ru', 'new')
    expect(out).toBe('$chub.ru: new\n$chub: other\n')
  })

  it('same value → the very same text', () => {
    expect(setAttr(DOC, [{ name: 'step' }], 'mode', 'fast')).toBe(DOC)
    expect(setAttr(DOC, [], 'after', 1)).toBe(DOC)
  })
})

describe('setAttr: insert', () => {
  it('into a block with attributes — right after the last one', () => {
    const out = checkSet(DOC, [{ name: 'step', id: 'load' }], 'retries', 3)
    expect(insertedLine(DOC, out)).toEqual([7, '$retries: 3'])
  })

  it('into a block without attributes — right after the header', () => {
    const out = checkSet(DOC, [{ name: 'empty' }], 'k', 'v')
    expect(insertedLine(DOC, out)).toEqual([14, '$k: v'])
  })

  it('into a root with attributes — after the last root attribute', () => {
    const out = checkSet(DOC, [], 'new', true)
    expect(insertedLine(DOC, out)).toEqual([19, '$new: true'])
  })

  it('into an empty root — first line of the document', () => {
    const src = '# Title\n\n## $b\n$k: 1\n'
    const out = checkSet(src, [], 'root', 'x')
    expect(insertedLine(src, out)).toEqual([0, '$root: x'])
  })

  it('into an empty document', () => {
    expect(checkSet('', [], 'k', 1)).toBe('$k: 1\n')
  })

  it('no trailing newline: insertion after the last line', () => {
    const src = '## $b\n$k: 1'
    const out = checkSet(src, [{ name: 'b' }], 'j', 2)
    expect(out).toBe('## $b\n$k: 1\n$j: 2')
  })

  it('empty string value → `$k:`', () => {
    expect(checkSet('$a: 1\n', [], 'k', '')).toBe('$a: 1\n$k:\n')
  })
})

describe('setAttr: values', () => {
  const src = '## $b\n$k: 0\n'
  it.each<[AttributeValue, string]>([
    ['text', '$k: text'],
    [42, '$k: 42'],
    [false, '$k: false'],
    [['a', 'b c', 3], '$k: $[a, b c, 3]'],
    ['007', '$k: 007'],
    ['42', '$k: "42"'],
    ['two\nlines', '$k: "two\\nlines"'],
    [{ steps: 30 }, '$k: {steps: 30}'],
  ])('%j', (value, line) => {
    const out = checkSet(src, [{ name: 'b' }], 'k', value)
    expect(replacedLine(src, out)).toEqual([1, line])
  })

  it('a raw value that cannot fit one line → Error', () => {
    const v = { raw: 'a ${x}\nb', placeholders: [{ raw: 'x', start: 2, end: 6 }] }
    expect(() => setAttr(src, [{ name: 'b' }], 'k', v)).toThrow(/one line/)
  })

  it('invalid key → Error', () => {
    expect(() => setAttr(src, [], 'a b', 1)).toThrow(/invalid attribute key/)
    expect(() => setAttr(src, [], '1a', 1)).toThrow(/invalid attribute key/)
  })
})

describe('setAttr: document style', () => {
  it('\\r\\n document stays \\r\\n', () => {
    const src = '$a: 1\r\n\r\n## $b\r\n$k: 1\r\n'
    const out = checkSet(src, [{ name: 'b' }], 'j', 2)
    expect(out).toBe('$a: 1\r\n\r\n## $b\r\n$k: 1\r\n$j: 2\r\n')
    expect(checkSet(src, [], 'a', 5)).toBe('$a: 5\r\n\r\n## $b\r\n$k: 1\r\n')
  })

  it('BOM is kept; a root insertion goes after it', () => {
    const src = '\uFEFF## $b\n$k: 1\n'
    const out = checkSet(src, [], 'r', 1)
    expect(out).toBe('\uFEFF$r: 1\n## $b\n$k: 1\n')
    expect(checkSet(src, [{ name: 'b' }], 'k', 2)).toBe('\uFEFF## $b\n$k: 2\n')
  })

  it('mdd with sigil @', () => {
    const src = '# @card hero\n@name: A\n@// c\n'
    const opts: EditOptions = { sigil: '@' }
    expect(checkSet(src, [{ name: 'card', id: 'hero' }], 'name', 'B', opts)).toBe('# @card hero\n@name: B\n@// c\n')
    expect(checkSet(src, [{ name: 'card' }], 'tags', ['x'], opts)).toBe('# @card hero\n@name: A\n@tags: @[x]\n@// c\n')
  })

  it('baseLevel is passed through to the parser', () => {
    const src = '# Title\n## $b\n$k: 1\n'
    expect(checkSet(src, [{ name: 'b' }], 'k', 2, { baseLevel: 2 })).toBe('# Title\n## $b\n$k: 2\n')
  })
})

describe('code fence in a body (parser has no fences — neither has the edit)', () => {
  const src = ['## $b', '$k: 1', '', '```', '$k: 2', '```', ''].join('\n')

  it('the fenced line IS an attribute of the block, and the last one', () => {
    expect(parse(src).root.children[0].attrs.map((a) => a.value)).toEqual([1, 2])
    const out = checkSet(src, [{ name: 'b' }], 'k', 9)
    expect(replacedLine(src, out)).toEqual([4, '$k: 9'])
  })

  it('a new attribute lands after the fenced line, inside the fence', () => {
    const out = checkSet(src, [{ name: 'b' }], 'j', 1)
    expect(insertedLine(src, out)).toEqual([5, '$j: 1'])
  })

  it('removeAttr takes the fenced line too', () => {
    const out = checkRemove(src, [{ name: 'b' }], 'k')
    expect(out).toBe(['## $b', '', '```', '```', ''].join('\n'))
  })
})

describe('removeAttr', () => {
  it('removes only the key lines, comments and blanks stay', () => {
    const out = checkRemove(DOC, [{ name: 'step' }], 'src')
    const expected = lines(DOC)
    expected.splice(4, 1)
    expect(lines(out)).toEqual(expected)
  })

  it('removes all duplicates', () => {
    const src = '$k: 1\n$a: x\n$k: 2\n$// c\n$k: 3\n'
    expect(checkRemove(src, [], 'k')).toBe('$a: x\n$// c\n')
  })

  it('absent key → same text', () => {
    expect(removeAttr(DOC, [], 'nope')).toBe(DOC)
  })

  it('last line without a newline', () => {
    expect(checkRemove('$a: 1\n$k: 2', [], 'k')).toBe('$a: 1')
    expect(checkRemove('$k: 2', [], 'k')).toBe('')
    expect(checkRemove('$a: 1\n$k: 2\n$k: 3', [], 'k')).toBe('$a: 1')
  })

  it('\\r\\n and BOM', () => {
    expect(checkRemove('\uFEFF$k: 1\r\n$a: 2\r\n', [], 'k')).toBe('\uFEFF$a: 2\r\n')
  })

  it('root attribute after a closed block', () => {
    const out = checkRemove(DOC, [], 'after')
    expect(out).toBe(DOC.replace('## $@\n$after: 1\n', '## $@\n'))
  })
})

describe('ensureBlock', () => {
  it('present → same text', () => {
    expect(ensureBlock(DOC, [{ name: 'step' }])).toBe(DOC)
    expect(ensureBlock(DOC, [{ name: 'step', id: 'save' }])).toBe(DOC)
  })

  it('absent → appended with a blank line, hashes like the first block', () => {
    const out = ensureBlock(DOC, [{ name: 'step', id: 'check' }])
    expect(out).toBe(DOC + '\n## $step check\n')
    const blocks = parse(out).root.children
    expect(blocks[blocks.length - 1]).toMatchObject({ name: 'step', id: 'check', level: 2 })
    expect({ ...parse(out), root: { ...parse(out).root, children: blocks.slice(0, -1) } }).toEqual(parse(DOC))
  })

  it('twice → once', () => {
    const once = ensureBlock(DOC, [{ name: 'x' }])
    expect(ensureBlock(once, [{ name: 'x' }])).toBe(once)
  })

  it('no trailing newline, \\r\\n, level 1 blocks', () => {
    expect(ensureBlock('# $a\r\n$k: 1', [{ name: 'b' }])).toBe('# $a\r\n$k: 1\r\n\r\n# $b\r\n')
  })

  it('no blocks → two hashes; empty document', () => {
    expect(ensureBlock('$k: 1\n', [{ name: 'b' }])).toBe('$k: 1\n\n## $b\n')
    expect(ensureBlock('', [{ name: 'b' }])).toBe('## $b\n')
  })

  it('id that needs quotes', () => {
    const out = ensureBlock('', [{ name: 'b', id: ' x ' }])
    expect(out).toBe('## $b " x "\n')
    expect(parse(out).root.children[0].id).toBe(' x ')
  })

  it('mdd sigil', () => {
    expect(ensureBlock('# @a\n', [{ name: 'b' }], { sigil: '@' })).toBe('# @a\n\n# @b\n')
  })

  it('path of other length → Error; bad name → Error', () => {
    expect(() => ensureBlock(DOC, [])).toThrow(/single top-level/)
    expect(() => ensureBlock(DOC, [{ name: 'step' }, { name: 'x' }])).toThrow(/single top-level/)
    expect(() => ensureBlock(DOC, [{ name: '1bad' }])).toThrow(/invalid block header/)
  })
})

describe('EditTargetError', () => {
  it('missing block, with the path in the message', () => {
    expect(() => setAttr(DOC, [{ name: 'step', id: 'nope' }], 'k', 1)).toThrow(EditTargetError)
    expect(() => setAttr(DOC, [{ name: 'step', id: 'nope' }], 'k', 1)).toThrow(/step\[nope\]/)
    expect(() => removeAttr(DOC, [{ name: 'missing' }], 'k')).toThrow(EditTargetError)
  })
})
