import { describe, it, expect } from 'vitest'
import {
  parseTable,
  parseTableTyped,
  serializeTypedTable,
} from '../src/serialize.js'
import { parseHeaderCell, tableSchema, TableParseError } from '../src/typed-header.js'
import { parseWithSchema } from '../src/schema.js'

describe('typed tbl header — parsing annotations (§2.3)', () => {
  it('parses name[:type][!] annotations', () => {
    expect(parseHeaderCell('name')).toEqual({ name: 'name', required: false })
    expect(parseHeaderCell('weight:number')).toEqual({
      name: 'weight',
      type: { kind: 'number' },
      required: false,
    })
    expect(parseHeaderCell('rare:boolean!')).toEqual({
      name: 'rare',
      type: { kind: 'boolean' },
      required: true,
    })
    expect(parseHeaderCell('tags:list(;)')).toEqual({
      name: 'tags',
      type: { kind: 'list', sep: ';' },
      required: false,
    })
  })

  it('rejects an unknown type', () => {
    expect(() => parseHeaderCell('x:date')).toThrow(TableParseError)
  })

  it('escapes a literal colon in a name with \\:', () => {
    expect(parseHeaderCell('a\\:b')).toEqual({ name: 'a:b', required: false })
    expect(parseHeaderCell('a\\:b:number')).toEqual({
      name: 'a:b',
      type: { kind: 'number' },
      required: false,
    })
  })

  it('a fully quoted header name carries no annotation', () => {
    expect(parseHeaderCell('"weight:number"')).toEqual({ name: 'weight:number', required: false })
  })
})

describe('typed tbl — homogeneous coercion (§2.3, acceptance §7.4)', () => {
  it('number column: "abc" is a LOUD error, not a silent string', () => {
    const text = ['weight:number', '1.5', 'abc'].join('\n')
    expect(() => parseTable(text)).toThrow(/is not a number/)
  })

  it('boolean column stays boolean; a bad cell errors', () => {
    expect(parseTable(['ok:boolean', 'true', 'false'].join('\n'))).toEqual([
      { ok: true },
      { ok: false },
    ])
    expect(() => parseTable(['ok:boolean', 'yes'].join('\n'))).toThrow(/is not a boolean/)
  })

  it('required (!) empty cell is an error', () => {
    const text = ['name | rare:boolean!', 'a | true', 'b | '].join('\n')
    expect(() => parseTable(text)).toThrow(/required cell is empty/)
  })

  it('list(sep) yields an array', () => {
    const text = ['tags:list(;)', 'a;b;c', 'x'].join('\n')
    expect(parseTable(text)).toEqual([{ tags: ['a', 'b', 'c'] }, { tags: ['x'] }])
  })

  it('list elements are coerced (§3)', () => {
    expect(parseTable(['nums:list(,)', '1,2,3'].join('\n'))).toEqual([{ nums: [1, 2, 3] }])
  })

  it('typed string column does NOT coerce numeric-looking cells', () => {
    expect(parseTable(['code:string', '007', '42'].join('\n'))).toEqual([
      { code: '007' },
      { code: '42' },
    ])
  })
})

describe('typed tbl — backward compatibility', () => {
  it('un-annotated headers keep legacy per-cell coercion', () => {
    const text = ['name | sm | sc', 'a | 1.0 | 0.8', 'b | 2 | 3'].join('\n')
    expect(parseTable(text)).toEqual([
      { name: 'a', sm: 1, sc: 0.8 },
      { name: 'b', sm: 2, sc: 3 },
    ])
  })
})

describe('typed tbl — roundtrip with annotations and \\: (§7.4)', () => {
  it('roundtrips a typed header exactly', () => {
    const text = [
      'name | weight:number | tags:list(;) | rare:boolean!',
      'sword | 1.5 | sharp;metal | true',
      'shield | 3 | wood;round | false',
    ].join('\n')
    const { columns, records } = parseTableTyped(text)
    const out = serializeTypedTable(records, columns)
    expect(out).toBe(text)
    // and stable on a second pass
    const again = parseTableTyped(out)
    expect(serializeTypedTable(again.records, again.columns)).toBe(text)
  })

  it('roundtrips a column name containing \\:', () => {
    const text = ['a\\:b:number', '5'].join('\n')
    const { columns, records } = parseTableTyped(text)
    expect(records).toEqual([{ 'a:b': 5 }])
    expect(serializeTypedTable(records, columns)).toBe(text)
  })
})

describe('tableSchema — derived micro-schema (§2.3)', () => {
  it('derives a JSON Schema fragment from typed columns', () => {
    const cols = ['name', 'weight:number', 'tags:list(;)', 'rare:boolean!'].map(parseHeaderCell)
    expect(tableSchema(cols)).toEqual({
      type: 'object',
      properties: {
        name: {},
        weight: { type: 'number' },
        tags: { type: 'array', 'x-mdd': { separator: ';' } },
        rare: { type: 'boolean' },
      },
      required: ['rare'],
    })
  })
})

describe('typed tbl — external schema overrides inline types (§7.5)', () => {
  it('external schema (string) wins over the inline number annotation', () => {
    // Inline says weight:number, but the external schema declares it a string.
    const text = ['# card', '## $rows', 'weight:number', '007'].join('\n')
    const schema = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          'x-mdd': { list: 'tbl' },
          items: { type: 'object', properties: { weight: { type: 'string' } } },
        },
      },
    }
    const obj = parseWithSchema<{ rows: Array<{ weight: unknown }> }>(text, schema)
    // schema type string > inline number > per-cell coercion
    expect(obj.rows[0].weight).toBe('007')
  })
})
