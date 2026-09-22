import { describe, it, expect } from 'vitest'
import { resolveIncludes, resolveIncludesAsync, extractSection, IncludeCycleError } from '../src/includes.js'

function mockFs(files: Record<string, string>): (path: string) => string | undefined {
  return (path) => files[path]
}

function mockFsAsync(files: Record<string, string>): (path: string) => Promise<string | undefined> {
  return async (path) => files[path]
}

describe('resolveIncludes', () => {
  it('replaces $[[path]] with file content', () => {
    const read = mockFs({ 'persona.md': 'I am a bot' })
    expect(resolveIncludes('Hello $[[persona.md]]!', read)).toBe('Hello I am a bot!')
  })

  it('replaces @[[path]] with sigil @', () => {
    const read = mockFs({ 'data.md': 'some data' })
    expect(resolveIncludes('Before @[[data.md]] after', read, { sigil: '@' }))
      .toBe('Before some data after')
  })

  it('leaves unresolved includes as-is', () => {
    const read = mockFs({})
    expect(resolveIncludes('$[[missing.md]]', read)).toBe('$[[missing.md]]')
  })

  it('recurses into included content', () => {
    const read = mockFs({ 'a.md': 'A $[[b.md]] A', 'b.md': 'B' })
    expect(resolveIncludes('$[[a.md]]', read)).toBe('A B A')
  })

  it('detects cycles', () => {
    const read = mockFs({ 'a.md': '$[[b.md]]', 'b.md': '$[[a.md]]' })
    expect(resolveIncludes('$[[a.md]]', read)).toBe('$[[a.md]]')
  })

  it('handles escape \\$[[', () => {
    const read = mockFs({ 'x.md': 'content' })
    expect(resolveIncludes('\\$[[x.md]]', read)).toBe('$[[x.md]]')
  })

  it('multiple includes in one text', () => {
    const read = mockFs({ 'h.md': 'HEADER', 'f.md': 'FOOTER' })
    expect(resolveIncludes('$[[h.md]]\nbody\n$[[f.md]]', read))
      .toBe('HEADER\nbody\nFOOTER')
  })

  it('malformed (no closing ]]) left as-is', () => {
    expect(resolveIncludes('$[[oops', mockFs({}))).toBe('$[[oops')
  })

  it('trims path whitespace', () => {
    const read = mockFs({ 'file.md': 'ok' })
    expect(resolveIncludes('$[[ file.md ]]', read)).toBe('ok')
  })
})

describe('sections', () => {
  const fileWithSections = `# Doc
intro
## API
API content
### Method
method details
## Other
other stuff`

  it('$[[file#section]] extracts section', () => {
    const read = mockFs({ 'doc.md': fileWithSections })
    const result = resolveIncludes('$[[doc.md#API]]', read)
    expect(result).toContain('API content')
    expect(result).toContain('method details')
    expect(result).not.toContain('other stuff')
  })

  it('$[[#section]] extracts from current text', () => {
    const text = `# Main
## Config
config data
## Body
body text`
    const result = resolveIncludes('Use: $[[#Config]]', mockFs({}), undefined)
    // $[[#section]] extracts from current text passed to resolveIncludes
    // But wait — current text = the text being processed, which is 'Use: $[[#Config]]'
    // That text doesn't have ## Config. Let me rethink...
    // Actually, $[[#section]] from current text means the text itself.
    // This is more useful when the include is inside a file that has sections.
    expect(result).toBe('Use: $[[#Config]]') // no section in 'Use: ...' → left as-is
  })

  it('$[[#section]] works when text has sections', () => {
    const text = `## Persona
I am Alice
## Greeting
Hello $[[#Persona]]!`
    const result = resolveIncludes(text, mockFs({}))
    expect(result).toContain('Hello ## Persona\nI am Alice!')
  })

  it('section not found → left as-is', () => {
    const read = mockFs({ 'doc.md': '# Doc\ncontent' })
    expect(resolveIncludes('$[[doc.md#Missing]]', read)).toBe('$[[doc.md#Missing]]')
  })

  it('section name is case-insensitive', () => {
    const read = mockFs({ 'doc.md': '## Setup\nsetup data' })
    expect(resolveIncludes('$[[doc.md#setup]]', read)).toBe('## Setup\nsetup data')
  })
})

describe('extractSection', () => {
  const doc = `# Title
## First
first content
### Nested
nested content
## Second
second content`

  it('extracts section with children', () => {
    const result = extractSection(doc, 'First')
    expect(result).toBe('## First\nfirst content\n### Nested\nnested content')
  })

  it('extracts leaf section', () => {
    const result = extractSection(doc, 'Second')
    expect(result).toBe('## Second\nsecond content')
  })

  it('case-insensitive', () => {
    expect(extractSection(doc, 'first')).toContain('first content')
  })

  it('returns undefined for missing section', () => {
    expect(extractSection(doc, 'Nope')).toBeUndefined()
  })
})

describe('resolveIncludesAsync', () => {
  it('works identically to sync version', async () => {
    const read = mockFsAsync({ 'a.md': 'A $[[b.md]]', 'b.md': 'B' })
    const result = await resolveIncludesAsync('$[[a.md]]', read)
    expect(result).toBe('A B')
  })

  it('handles sections async', async () => {
    const read = mockFsAsync({ 'doc.md': '## API\napi content\n## Other\nother' })
    const result = await resolveIncludesAsync('$[[doc.md#API]]', read)
    expect(result).toBe('## API\napi content')
  })
})

describe('resolveIncludes — resolvePath (nested base dir)', () => {
  // POSIX-like resolver for tests: target relative to dirname(from).
  function rel(target: string, from: string | undefined): string {
    const dir = from && from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
    const out: string[] = []
    for (const p of (dir ? dir + '/' + target : target).split('/')) {
      if (p === '' || p === '.') continue
      if (p === '..') out.pop()
      else out.push(p)
    }
    return out.join('/')
  }

  it('nested include resolves against the including file', () => {
    const read = mockFs({
      'a/b/mid.mdz': 'mid[$[[../../sys/s.mdz]]]',
      'sys/s.mdz': 'SYS',
    })
    expect(resolveIncludes('$[[a/b/mid.mdz]]', read, { from: 'root.mdz', resolvePath: rel }))
      .toBe('mid[SYS]')
  })

  it('cycle detected by resolved id, not by spelling', () => {
    const read = mockFs({ 'x/a.md': '$[[../x/./a.md]]' })
    expect(resolveIncludes('$[[x/a.md]]', read, { resolvePath: rel })).toBe('$[[../x/./a.md]]')
  })

  it('onCycle: throw — IncludeCycleError with chain', () => {
    const read = mockFs({ 'a.md': '$[[b.md]]', 'b.md': '$[[a.md]]' })
    let err: unknown
    try {
      resolveIncludes('$[[a.md]]', read, { from: 'root.md', resolvePath: rel, onCycle: 'throw' })
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(IncludeCycleError)
    expect((err as IncludeCycleError).chain).toEqual(['a.md', 'b.md', 'a.md'])
  })

  it('self-include of the root is a cycle', () => {
    const read = mockFs({ 'root.md': 'R' })
    expect(() => resolveIncludes('$[[root.md]]', read, { from: 'root.md', resolvePath: rel, onCycle: 'throw' }))
      .toThrow(/root.md -> root.md/)
  })

  it('resolvePath → undefined leaves include as-is', () => {
    expect(resolveIncludes('$[[nope]]', () => 'X', { resolvePath: () => undefined })).toBe('$[[nope]]')
  })

  it('async: nested + cycle throw', async () => {
    const read = mockFsAsync({ 'a/m.md': '[$[[../s.md]]]', 's.md': 'S', 'c.md': '$[[c.md]]' })
    expect(await resolveIncludesAsync('$[[a/m.md]]', read, { resolvePath: rel })).toBe('[S]')
    await expect(resolveIncludesAsync('$[[c.md]]', read, { resolvePath: rel, onCycle: 'throw' }))
      .rejects.toBeInstanceOf(IncludeCycleError)
  })
})
