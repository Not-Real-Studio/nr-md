// The hard corners of laying a character card out as mdd: a blocks array of
// strings, as: 'json', x-storage: 'block', x-mdd.block (renaming), unknown:
// 'inline', envelope, and quoting a header id.
import { describe, it, expect } from 'vitest'
import { serializeWithSchema, parseWithSchema, UNKNOWN_KEY, type JSONSchema } from '../src/schema.js'
import { serialize } from '../src/serialize.js'
import { parse } from '../src/parser.js'

function rt<T>(obj: T, schema: JSONSchema, sigil: '@' | '$' = '$'): T {
  return parseWithSchema<T>(serializeWithSchema(obj, schema, { sigil }), schema, { sigil })
}

describe('list: blocks — an array of STRINGS (§3.5)', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      alternate_greetings: {
        type: 'array',
        'x-mdd': { list: 'blocks' },
        items: { type: 'string' },
      },
    },
  }

  it('one element = one block, the string is its body', () => {
    const obj = { alternate_greetings: ['Hi there!', 'Oh, hi.'] }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('## $alternate_greetings\nHi there!\n## $alternate_greetings\nOh, hi.')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('a multi-line string with markdown in it round-trips exactly', () => {
    const obj = { alternate_greetings: ['*Morning.*\n\n## Not a header\n- list', 'x'] }
    expect(rt(obj, schema)).toEqual(obj)
  })

  it('an empty array travels as a degenerate flow attribute — else the field would vanish', () => {
    const text = serializeWithSchema({ alternate_greetings: [] }, schema)
    expect(text).toBe('$alternate_greetings: $[]')
    expect(parseWithSchema(text, schema)).toEqual({ alternate_greetings: [] })
  })

  it('an empty string element is a block with no body, and reads back as ""', () => {
    expect(rt({ alternate_greetings: ['', 'x'] }, schema)).toEqual({ alternate_greetings: ['', 'x'] })
  })

  it('a missing field stays missing', () => {
    expect(parseWithSchema('', schema)).toEqual({})
  })
})

describe("x-mdd as: 'json' — a declared opaque field (§3.9)", () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      extensions: { type: 'object', additionalProperties: true, 'x-mdd': { as: 'json' } },
    },
  }

  it('arbitrary JSON → a fenced block → the same object back', () => {
    const obj = { extensions: { chub: { id: 42, tags: ['x'] }, depth_prompt: { depth: 4, prompt: 'stay' } } }
    const text = serializeWithSchema(obj, schema)
    expect(text).toContain('## $extensions')
    expect(text).toContain('```json')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('an empty object round-trips', () => {
    expect(rt({ extensions: {} }, schema)).toEqual({ extensions: {} })
  })

  it('a value containing ${…} inside the JSON does not break the fence', () => {
    const obj = { extensions: { prompt: 'hello ${name}' } }
    expect(rt(obj, schema)).toEqual(obj)
  })
})

describe("x-storage: 'block' — prose in blocks of its own (§3.2)", () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string', 'x-storage': 'block' },
      scenario: { type: 'string', 'x-storage': 'block' },
    },
  }

  it('several text fields, each in its own block', () => {
    const obj = { name: 'Alice', description: 'A curious girl.', scenario: 'Wonderland.' }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('$name: Alice\n## $description\nA curious girl.\n## $scenario\nWonderland.')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('an empty string survives — the block is there, the body is not', () => {
    const obj = { name: 'A', description: '', scenario: 'x' }
    expect(rt(obj, schema)).toEqual(obj)
  })

  it('a body line that looks like an attribute or a header gets escaped', () => {
    const obj = { name: 'A', description: '$name: fake\n# $char fake', scenario: '' }
    expect(rt(obj, schema)).toEqual(obj)
  })
})

describe('x-mdd block — the block name is not the property key (§3.9)', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        'x-mdd': { block: 'char' },
        properties: {
          name: { type: 'string', 'x-storage': 'id' },
          entries: {
            type: 'array',
            'x-mdd': { list: 'blocks', block: 'entry' },
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', 'x-storage': 'id' },
                content: { type: 'string', 'x-storage': 'body' },
              },
            },
          },
        },
      },
    },
  }

  it('the object travels under its own name, the blocks elements under theirs', () => {
    const obj = { data: { name: 'Alice', entries: [{ name: 'city_fall', content: 'The city fell.' }] } }
    const text = serializeWithSchema(obj, schema, { sigil: '@' })
    expect(text).toContain('## @char Alice')
    expect(text).toContain('### @entry city_fall')
    expect(parseWithSchema(text, schema, { sigil: '@' })).toEqual(obj)
  })
})

describe('envelope — a root with no header, blocks starting at h1 (§3.3)', () => {
  const schema: JSONSchema = {
    type: 'object',
    'x-mdd': { envelope: true },
    properties: {
      spec: { type: 'string' },
      data: {
        type: 'object',
        'x-mdd': { block: 'char' },
        properties: {
          name: { type: 'string', 'x-storage': 'id' },
          description: { type: 'string', 'x-storage': 'block' },
        },
      },
    },
  }

  it('envelope = root attributes, data = an h1 block, prose = h2', () => {
    const obj = { spec: 'chara_card_v3', data: { name: 'Alice', description: 'text' } }
    const text = serializeWithSchema(obj, schema, { sigil: '@' })
    expect(text).toBe('@spec: chara_card_v3\n# @char Alice\n## @description\ntext')
    expect(parseWithSchema(text, schema, { sigil: '@' })).toEqual(obj)
  })

  it('without envelope the layout is unchanged — blocks at h2', () => {
    const plain: JSONSchema = { ...schema, 'x-mdd': {} }
    expect(serializeWithSchema({ spec: 'v3', data: { name: 'A' } }, plain, { sigil: '@' })).toBe(
      '@spec: v3\n## @char A',
    )
  })
})

describe("unknown: 'inline' — unknown fields keep their own keys (§3.6)", () => {
  const schema: JSONSchema = {
    type: 'object',
    'x-mdd': { unknown: 'inline' },
    properties: { name: { type: 'string' } },
  }

  it('shape round-trips 1:1, with no $unknown wrapper', () => {
    const obj = { name: 'card', probability: 100, selectiveLogic: 0, extra: { a: [1, 2] } }
    expect(rt(obj, schema)).toEqual(obj)
  })

  it("mode 'block' still puts the bag under $unknown", () => {
    const bagged: JSONSchema = { ...schema, 'x-mdd': { unknown: 'block' } }
    expect(rt({ name: 'card', foo: 1 }, bagged)).toEqual({ name: 'card', [UNKNOWN_KEY]: { foo: 1 } })
  })
})

describe('header id — quoted when the bare form would lose the value (§2.1)', () => {
  it('edge whitespace and an empty id survive the round-trip', () => {
    for (const id of ['Arcadia ', ' lead', '', 'Maki & Yoshi ', 'say "hi"']) {
      const text = serialize({ sigil: '$', root: { name: '', level: 0, attrs: [], children: [{ name: 'char', level: 1, attrs: [], children: [], id }] } })
      expect(parse(text).root.children[0].id ?? '').toBe(id)
    }
  })

  it('an ordinary id stays unquoted', () => {
    const text = serialize({ sigil: '@', root: { name: '', level: 0, attrs: [], children: [{ name: 'entry', level: 1, attrs: [], children: [], id: 'city_fall' }] } })
    expect(text).toBe('# @entry city_fall')
  })
})
