import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { serializeWithSchema, parseWithSchema, type JSONSchema } from '../src/schema.js'

// Roundtrip over a character-card schema: a schema written by someone else, for
// something else, with our storage hints layered ON TOP of it. That layering is
// the whole point — you do not get to edit a third party's schema, so the x-*
// annotations live in an IN-MEMORY overlay and the original is never touched
// (the nr-schema "overlay" pattern, spec §3.2).
//
// The card properties below are the shape the overlay needs, inlined so the test
// is self-contained. Point NR_MD_TEST_SCHEMA at a real vendor schema file to run
// the same overlay against it — the vendor's own properties then join the mix.
const VENDOR_SCHEMA = process.env.NR_MD_TEST_SCHEMA

/** Minimal stand-in for the vendor's scalar fields. */
const CARD_PROPERTIES: Record<string, JSONSchema> = {
  project_name: { type: 'string' },
  name: { type: 'string' },
  tagline: { type: 'string' },
  description: { type: 'string' },
  is_nsfw: { type: 'boolean' },
  alternate_greetings: { type: 'array', items: { type: 'string' } },
}

describe('serializeWithSchema ↔ parseWithSchema on a card schema (§7.1)', () => {
  const vendored = VENDOR_SCHEMA !== undefined && existsSync(VENDOR_SCHEMA)
  const base: JSONSchema = vendored
    ? JSON.parse(readFileSync(VENDOR_SCHEMA!, 'utf8'))
    : { properties: CARD_PROPERTIES }

  // Overlay: description → body, alternate_greetings → flow, add a tbl field.
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      ...CARD_PROPERTIES,
      ...(base.properties as Record<string, JSONSchema>),
      description: { ...(base.properties as Record<string, JSONSchema>).description, 'x-storage': 'body' },
      alternate_greetings: {
        ...(base.properties as Record<string, JSONSchema>).alternate_greetings,
        'x-mdd': { list: 'flow' },
      },
      loras: {
        type: 'array',
        'x-mdd': { list: 'tbl' },
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            sm: { type: 'number' },
            tags: { type: 'array', 'x-mdd': { separator: ';' } },
          },
        },
      },
    },
  }

  const card = {
    project_name: 'demo',
    name: 'Aria',
    tagline: 'A curious wanderer',
    description: 'A long personality description.\nSecond line, still body text.',
    is_nsfw: false,
    alternate_greetings: ['Hello there.', 'Well met.'],
    loras: [
      { name: 'zit/pinup.safetensors', sm: 1, tags: ['pinup', 'soft'] },
      { name: 'zit/anime.safetensors', sm: 0.8, tags: ['anime'] },
    ],
  }

  it('roundtrips object → text → object (body + flow + tbl)', () => {
    const text = serializeWithSchema(card, schema)
    const back = parseWithSchema<typeof card>(text, schema)
    expect(back).toEqual(card)
  })

  it('re-serialization is byte-identical (§7.2 determinism)', () => {
    const once = serializeWithSchema(card, schema)
    const twice = serializeWithSchema(parseWithSchema(once, schema), schema)
    expect(twice).toBe(once)
  })
})

describe('tbl cells with | and , survive roundtrip quoted (§7.3)', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        'x-mdd': { list: 'tbl' },
        items: {
          type: 'object',
          properties: { note: { type: 'string' }, csv: { type: 'string' } },
        },
      },
    },
  }
  const obj = { rows: [{ note: 'a | b', csv: 'x,y,z' }] }

  it('quotes a cell containing a pipe and roundtrips exactly', () => {
    const text = serializeWithSchema(obj, schema)
    expect(text).toContain('"a | b"')
    expect(parseWithSchema<typeof obj>(text, schema)).toEqual(obj)
  })
})
