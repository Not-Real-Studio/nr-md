// blocks mode, the catch-all unknown bag, map fields, integer.
import { describe, it, expect, vi } from 'vitest'
import {
  serializeWithSchema,
  parseWithSchema,
  UNKNOWN_KEY,
  UNKNOWN_OVERFLOW_BLOCK,
  type JSONSchema,
} from '../src/schema.js'

/** Roundtrip helper: object → text → object must deep-equal. */
function rt<T>(obj: T, schema: JSONSchema): T {
  return parseWithSchema<T>(serializeWithSchema(obj, schema), schema)
}

describe('x-mdd list: blocks (§3.2)', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      greetings: {
        type: 'array',
        'x-mdd': { list: 'blocks' },
        items: {
          type: 'object',
          properties: { text: { type: 'string', 'x-storage': 'body' } },
        },
      },
    },
  }

  it('array of objects → repeated blocks named after the property key', () => {
    const obj = { greetings: [{ text: 'A' }, { text: 'B' }] }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('## $greetings\nA\n## $greetings\nB')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('items schema is a full object — attrs / flow lists per element', () => {
    const s: JSONSchema = {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          'x-mdd': { list: 'blocks' },
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              keys: { type: 'array', 'x-mdd': { list: 'flow' }, items: { type: 'string' } },
              content: { type: 'string', 'x-storage': 'body' },
            },
          },
        },
      },
    }
    const obj = {
      entries: [
        { id: 1, keys: ['a', 'b'], content: 'first' },
        { id: 2, keys: ['c'], content: 'second' },
      ],
    }
    expect(rt(obj, s)).toEqual(obj)
  })

  it('nesting is recursive — blocks inside blocks', () => {
    const s: JSONSchema = {
      type: 'object',
      properties: {
        chapters: {
          type: 'array',
          'x-mdd': { list: 'blocks' },
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              notes: {
                type: 'array',
                'x-mdd': { list: 'blocks' },
                items: {
                  type: 'object',
                  properties: { body: { type: 'string', 'x-storage': 'body' } },
                },
              },
            },
          },
        },
      },
    }
    const obj = {
      chapters: [
        { title: 'one', notes: [{ body: 'n1' }, { body: 'n2' }] },
        { title: 'two', notes: [{ body: 'n3' }] },
      ],
    }
    expect(rt(obj, s)).toEqual(obj)
  })

  it('x-storage name inside items → the element names its own block', () => {
    const s: JSONSchema = {
      type: 'object',
      properties: {
        chars: {
          type: 'array',
          'x-mdd': { list: 'blocks' },
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', 'x-storage': 'name' },
              role: { type: 'string' },
            },
          },
        },
      },
    }
    const obj = { chars: [{ name: 'alice', role: 'hero' }, { name: 'bob', role: 'villain' }] }
    const text = serializeWithSchema(obj, s)
    expect(text).toContain('## $alice')
    expect(text).toContain('## $bob')
    expect(parseWithSchema(text, s)).toEqual(obj)
  })

  it('default for an array of objects stays tbl — blocks is opt-in', () => {
    const s: JSONSchema = {
      type: 'object',
      properties: {
        loras: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, sm: { type: 'number' } } },
        },
      },
    }
    const obj = { loras: [{ name: 'a', sm: 1 }] }
    const text = serializeWithSchema(obj, s)
    expect(text).toContain('name | sm')
    expect(parseWithSchema(text, s)).toEqual(obj)
  })
})

describe('catch-all: unknown fields (x-mdd unknown: block)', () => {
  const schema: JSONSchema = {
    type: 'object',
    'x-mdd': { unknown: 'block' },
    properties: { name: { type: 'string' } },
  }

  it('scalar unknowns → attributes, structured unknowns → fenced JSON blocks', () => {
    const obj = {
      name: 'card',
      [UNKNOWN_KEY]: {
        talkativeness: '0.5',
        fav: true,
        extensions: { chub: { id: 42, tags: ['x'] }, depth_prompt: { depth: 4 } },
      },
    }
    const text = serializeWithSchema(obj, schema)
    expect(text).toContain('```json')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('bare extra keys are absorbed into the bag — nothing is lost', () => {
    const text = serializeWithSchema({ name: 'card', foo: 1, bar: { deep: [1, 2] } }, schema)
    expect(parseWithSchema(text, schema)).toEqual({
      name: 'card',
      [UNKNOWN_KEY]: { foo: 1, bar: { deep: [1, 2] } },
    })
  })

  it('keys that are not valid mdd names travel in the overflow block', () => {
    const warn = vi.fn()
    const obj = { name: 'card', [UNKNOWN_KEY]: { 'not a name': 1, '2legit': 'x' } }
    const text = serializeWithSchema(obj, schema, { warn })
    expect(warn).toHaveBeenCalled()
    expect(text).toContain('$' + UNKNOWN_OVERFLOW_BLOCK)
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('without the opt-in, unknown fields are dropped — default unchanged', () => {
    const plain: JSONSchema = { type: 'object', properties: { name: { type: 'string' } } }
    const text = serializeWithSchema({ name: 'card', foo: 1 }, plain)
    expect(text).toBe('$name: card')
    expect(parseWithSchema(text, plain)).toEqual({ name: 'card' })
  })

  it('no unknown fields → no $unknown key in the result', () => {
    const text = serializeWithSchema({ name: 'card' }, schema)
    expect(parseWithSchema(text, schema)).toEqual({ name: 'card' })
  })

  it('works on a nested object schema too', () => {
    const s: JSONSchema = {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          'x-mdd': { unknown: 'block' },
          properties: { name: { type: 'string' } },
        },
      },
    }
    const obj = { data: { name: 'x', [UNKNOWN_KEY]: { extra: 7 } } }
    expect(rt(obj, s)).toEqual(obj)
  })
})

describe('map fields — patternProperties → block with sub-blocks', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      creator_notes_multilingual: {
        type: 'object',
        patternProperties: { '^.*$': { type: 'string' } },
      },
    },
  }

  it('string map → one sub-block per key, value in the body', () => {
    const obj = { creator_notes_multilingual: { ru: 'текст', en: 'text' } }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('## $creator_notes_multilingual\n### $ru\nтекст\n### $en\ntext')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('object map → one sub-block per key with attributes', () => {
    const s: JSONSchema = {
      type: 'object',
      properties: {
        limits: {
          type: 'object',
          patternProperties: {
            '^.*$': {
              type: 'object',
              properties: { rpm: { type: 'number' }, tier: { type: 'string' } },
            },
          },
        },
      },
    }
    const obj = { limits: { openai: { rpm: 60, tier: 'free' }, anthropic: { rpm: 50, tier: 'pro' } } }
    expect(rt(obj, s)).toEqual(obj)
  })

  it('keys that are not valid mdd names fall back to fenced JSON — lossless', () => {
    const warn = vi.fn()
    const obj = { creator_notes_multilingual: { 'zh Hans': 'text' } }
    const text = serializeWithSchema(obj, schema, { warn })
    expect(warn).toHaveBeenCalled()
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })
})

describe('scalar coercion additions', () => {
  it('type integer is coerced (creation_date / modification_date)', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { creation_date: { type: 'integer' }, tick: { type: 'integer' } },
    }
    const obj = { creation_date: 1752451200, tick: 0 }
    expect(rt(obj, schema)).toEqual(obj)
    expect(parseWithSchema('$creation_date: "1752451200"', schema)).toEqual({
      creation_date: 1752451200,
    })
  })

  it('integer column does not conflict with an inline number annotation', () => {
    const warn = vi.fn()
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          'x-mdd': { list: 'tbl' },
          items: { type: 'object', properties: { n: { type: 'integer' } } },
        },
      },
    }
    expect(parseWithSchema('## $rows\nn:number\n7', schema, { warn })).toEqual({ rows: [{ n: 7 }] })
    expect(warn).not.toHaveBeenCalled()
  })

  it('a real type conflict routes through the injected warn hook', () => {
    const warn = vi.fn()
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          'x-mdd': { list: 'tbl' },
          items: { type: 'object', properties: { n: { type: 'string' } } },
        },
      },
    }
    parseWithSchema('## $rows\nn:number\n7', schema, { warn })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('schema wins')
  })

  it('an InterpolatedValue in a string attribute yields its raw text, not [object Object]', () => {
    const schema: JSONSchema = { type: 'object', properties: { prompt: { type: 'string' } } }
    expect(parseWithSchema('$prompt: hello ${name}', schema)).toEqual({ prompt: 'hello ${name}' })
  })
})

describe('acceptance: realistic Character-Card-like round-trip', () => {
  const CARD: JSONSchema = {
    type: 'object',
    'x-mdd': { unknown: 'block' },
    properties: {
      name: { type: 'string' },
      description: { type: 'string', 'x-storage': 'body' },
      tags: { type: 'array', 'x-mdd': { list: 'flow' }, items: { type: 'string' } },
      greetings: {
        type: 'array',
        'x-mdd': { list: 'blocks' },
        items: { type: 'object', properties: { text: { type: 'string', 'x-storage': 'body' } } },
      },
      creator_notes_multilingual: {
        type: 'object',
        patternProperties: { '^[a-z]{2}$': { type: 'string' } },
      },
      creation_date: { type: 'integer' },
    },
  }

  const card = {
    name: 'Alice',
    description: 'A curious girl.\nLikes rabbits.',
    tags: ['fantasy', 'classic'],
    greetings: [{ text: 'Hello there!' }, { text: 'Oh, hi.' }],
    creator_notes_multilingual: { ru: 'заметки', en: 'notes' },
    creation_date: 1752451200,
    [UNKNOWN_KEY]: {
      talkativeness: '0.5',
      extensions: {
        chub: { full_path: 'x/alice', related_lorebooks: [] },
        depth_prompt: { depth: 4, prompt: 'stay in character' },
      },
    },
  }

  it('serializeWithSchema → parseWithSchema → deep-equal', () => {
    const text = serializeWithSchema(card, CARD)
    expect(parseWithSchema(text, CARD)).toEqual(card)
  })

  it('is deterministic — re-serialization is byte-identical', () => {
    const once = serializeWithSchema(card, CARD)
    expect(serializeWithSchema(parseWithSchema(once, CARD), CARD)).toBe(once)
  })
})
