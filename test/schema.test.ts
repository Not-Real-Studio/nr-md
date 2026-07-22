import { describe, it, expect, vi } from 'vitest'
import {
  serializeWithSchema,
  parseWithSchema,
  validate,
  type JSONSchema,
  type ValidationResult,
} from '../src/schema.js'

/** Roundtrip helper: object → text → object must deep-equal. */
function rt<T>(obj: T, schema: JSONSchema): T {
  const text = serializeWithSchema(obj, schema)
  return parseWithSchema<T>(text, schema)
}

describe('x-storage layout (§3.2)', () => {
  it('attr is the default storage', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { model: { type: 'string' }, steps: { type: 'number' } },
    }
    const obj = { model: 'sdxl', steps: 30 }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('$model: sdxl\n$steps: 30')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('body storage → block body', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', 'x-storage': 'body' },
      },
    }
    const obj = { title: 'hero', description: 'A long\nmultiline description.' }
    const text = serializeWithSchema(obj, schema)
    expect(text.startsWith('$title: hero')).toBe(true)
    expect(text).toContain('A long\nmultiline description.')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('name / id storage → block header', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        provider: { type: 'string', 'x-storage': 'name' },
        instance: { type: 'string', 'x-storage': 'id' },
        model: { type: 'string' },
      },
    }
    const obj = { provider: 'provider', instance: 'openrouter', model: 'gpt-4' }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('# $provider openrouter\n$model: gpt-4')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })
})

describe('x-mdd list representations (§3.2)', () => {
  it('flow → inline @[...] attribute', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { tags: { type: 'array', 'x-mdd': { list: 'flow' }, items: { type: 'string' } } },
    }
    const obj = { tags: ['a', 'b', 'c'] }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('$tags: $[a, b, c]')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('lines → body per line', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { greetings: { type: 'array', 'x-mdd': { list: 'lines' }, items: { type: 'string' } } },
    }
    const obj = { greetings: ['hi', 'hello', 'hey'] }
    const text = serializeWithSchema(obj, schema)
    expect(text).toContain('## $greetings\nhi\nhello\nhey')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('tbl → body table (columns from items.properties)', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        loras: {
          type: 'array',
          'x-mdd': { list: 'tbl' },
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, sm: { type: 'number' } },
          },
        },
      },
    }
    const obj = { loras: [{ name: 'a', sm: 1 }, { name: 'b', sm: 0.5 }] }
    const text = serializeWithSchema(obj, schema)
    expect(text).toContain('name | sm')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('separator applies to a list-in-cell within a tbl', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          'x-mdd': { list: 'tbl' },
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              tags: { type: 'array', 'x-mdd': { separator: ';' } },
            },
          },
        },
      },
    }
    const obj = { rows: [{ name: 'x', tags: ['p', 'q'] }] }
    const text = serializeWithSchema(obj, schema)
    const back = parseWithSchema<typeof obj>(text, schema)
    expect(back).toEqual(obj)
  })
})

describe('field order = schema properties order (§3.3)', () => {
  it('emits fields in schema order regardless of object key order', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' } },
    }
    const obj = { c: 3, a: 1, b: 2 }
    expect(serializeWithSchema(obj, schema)).toBe('$a: 1\n$b: 2\n$c: 3')
  })

  it('is deterministic — re-serialization is byte-identical (§7.2)', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string', 'x-storage': 'body' },
        tags: { type: 'array', 'x-mdd': { list: 'flow' } },
      },
    }
    const obj = { name: 'x', description: 'desc', tags: ['a', 'b'] }
    const once = serializeWithSchema(obj, schema)
    const twice = serializeWithSchema(parseWithSchema(once, schema), schema)
    expect(twice).toBe(once)
  })
})

describe('schema-type coercion (§3.3, schema wins over YAML)', () => {
  it('a numeric-looking string field stays a string', () => {
    const schema: JSONSchema = { type: 'object', properties: { code: { type: 'string' } } }
    const obj = { code: '42' }
    expect(rt(obj, schema)).toEqual(obj)
  })

  it('undefined is not emitted; null is emitted as null', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: {} },
    }
    const text = serializeWithSchema({ a: undefined, b: null }, schema)
    expect(text).toBe('$b: null')
    expect(parseWithSchema(text, schema)).toEqual({ b: null })
  })
})

describe('validate (§3.4)', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: { model: { type: 'string' }, steps: { type: 'number' } },
    required: ['model'],
  }

  it('uses an injected validator and reports error paths', () => {
    const fakeValidator = (obj: unknown): ValidationResult => {
      const o = obj as { model?: unknown }
      return typeof o.model === 'string'
        ? { valid: true, errors: [] }
        : { valid: false, errors: [{ path: '/model', message: 'must be string' }] }
    }
    expect(validate({ model: 'x' }, schema, { validator: fakeValidator })).toEqual({
      valid: true,
      errors: [],
    })
    const bad = validate({ steps: 3 }, schema, { validator: fakeValidator })
    expect(bad.valid).toBe(false)
    expect(bad.errors[0].path).toBe('/model')
  })

  it('throws a clear install error when Ajv is absent and no validator given', () => {
    expect(() => validate({ model: 'x' }, schema)).toThrow(/install .*ajv|ajv.*install/i)
  })
})
