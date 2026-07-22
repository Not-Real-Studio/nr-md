// NOT-236 — упоры mdd-раскладки Character Card: blocks-массив строк, as: 'json',
// x-storage: 'block', x-mdd.block (переименование), unknown: 'inline', envelope,
// квотирование id заголовка.
import { describe, it, expect } from 'vitest'
import { serializeWithSchema, parseWithSchema, UNKNOWN_KEY, type JSONSchema } from '../src/schema.js'
import { serialize } from '../src/serialize.js'
import { parse } from '../src/parser.js'

function rt<T>(obj: T, schema: JSONSchema, sigil: '@' | '$' = '$'): T {
  return parseWithSchema<T>(serializeWithSchema(obj, schema, { sigil }), schema, { sigil })
}

describe('list: blocks — массив СТРОК (§3.5)', () => {
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

  it('элемент = блок, тело = строка', () => {
    const obj = { alternate_greetings: ['Hi there!', 'Oh, hi.'] }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('## $alternate_greetings\nHi there!\n## $alternate_greetings\nOh, hi.')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('многострочная строка с markdown в теле — round-trip точный', () => {
    const obj = { alternate_greetings: ['*Morning.*\n\n## Not a header\n- list', 'x'] }
    expect(rt(obj, schema)).toEqual(obj)
  })

  it('пустой массив едет вырожденным flow-атрибутом (иначе поле бы исчезло)', () => {
    const text = serializeWithSchema({ alternate_greetings: [] }, schema)
    expect(text).toBe('$alternate_greetings: $[]')
    expect(parseWithSchema(text, schema)).toEqual({ alternate_greetings: [] })
  })

  it('пустая строка-элемент — блок без тела, читается как ""', () => {
    expect(rt({ alternate_greetings: ['', 'x'] }, schema)).toEqual({ alternate_greetings: ['', 'x'] })
  })

  it('отсутствующее поле остаётся отсутствующим', () => {
    expect(parseWithSchema('', schema)).toEqual({})
  })
})

describe("x-mdd as: 'json' — объявленное opaque-поле (§3.9)", () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      extensions: { type: 'object', additionalProperties: true, 'x-mdd': { as: 'json' } },
    },
  }

  it('произвольный JSON → fenced-блок, обратно — тот же объект', () => {
    const obj = { extensions: { chub: { id: 42, tags: ['x'] }, depth_prompt: { depth: 4, prompt: 'stay' } } }
    const text = serializeWithSchema(obj, schema)
    expect(text).toContain('## $extensions')
    expect(text).toContain('```json')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('пустой объект round-trip-ится', () => {
    expect(rt({ extensions: {} }, schema)).toEqual({ extensions: {} })
  })

  it('значение с ${…} внутри JSON не ломает fence', () => {
    const obj = { extensions: { prompt: 'hello ${name}' } }
    expect(rt(obj, schema)).toEqual(obj)
  })
})

describe("x-storage: 'block' — проза отдельными блоками (§3.2)", () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string', 'x-storage': 'block' },
      scenario: { type: 'string', 'x-storage': 'block' },
    },
  }

  it('несколько текстовых полей — каждое своим блоком', () => {
    const obj = { name: 'Alice', description: 'A curious girl.', scenario: 'Wonderland.' }
    const text = serializeWithSchema(obj, schema)
    expect(text).toBe('$name: Alice\n## $description\nA curious girl.\n## $scenario\nWonderland.')
    expect(parseWithSchema(text, schema)).toEqual(obj)
  })

  it('пустая строка сохраняется (блок есть, тела нет)', () => {
    const obj = { name: 'A', description: '', scenario: 'x' }
    expect(rt(obj, schema)).toEqual(obj)
  })

  it('тело со строкой, похожей на атрибут/заголовок, экранируется', () => {
    const obj = { name: 'A', description: '$name: fake\n# $char fake', scenario: '' }
    expect(rt(obj, schema)).toEqual(obj)
  })
})

describe('x-mdd block — имя блока ≠ ключ свойства (§3.9)', () => {
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

  it('объект едет под своим именем, элементы blocks — под своим', () => {
    const obj = { data: { name: 'Alice', entries: [{ name: 'city_fall', content: 'The city fell.' }] } }
    const text = serializeWithSchema(obj, schema, { sigil: '@' })
    expect(text).toContain('## @char Alice')
    expect(text).toContain('### @entry city_fall')
    expect(parseWithSchema(text, schema, { sigil: '@' })).toEqual(obj)
  })
})

describe('envelope — корень без заголовка, блоки с h1 (§3.3)', () => {
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

  it('конверт = атрибуты корня, данные = блок h1, проза — h2', () => {
    const obj = { spec: 'chara_card_v3', data: { name: 'Alice', description: 'text' } }
    const text = serializeWithSchema(obj, schema, { sigil: '@' })
    expect(text).toBe('@spec: chara_card_v3\n# @char Alice\n## @description\ntext')
    expect(parseWithSchema(text, schema, { sigil: '@' })).toEqual(obj)
  })

  it('без envelope раскладка прежняя — блоки с h2', () => {
    const plain: JSONSchema = { ...schema, 'x-mdd': {} }
    expect(serializeWithSchema({ spec: 'v3', data: { name: 'A' } }, plain, { sigil: '@' })).toBe(
      '@spec: v3\n## @char A',
    )
  })
})

describe("unknown: 'inline' — неизвестные поля собственными ключами (§3.6)", () => {
  const schema: JSONSchema = {
    type: 'object',
    'x-mdd': { unknown: 'inline' },
    properties: { name: { type: 'string' } },
  }

  it('форма round-trip-а 1:1 — без обёртки $unknown', () => {
    const obj = { name: 'card', probability: 100, selectiveLogic: 0, extra: { a: [1, 2] } }
    expect(rt(obj, schema)).toEqual(obj)
  })

  it("режим 'block' по-прежнему кладёт бэг под $unknown", () => {
    const bagged: JSONSchema = { ...schema, 'x-mdd': { unknown: 'block' } }
    expect(rt({ name: 'card', foo: 1 }, bagged)).toEqual({ name: 'card', [UNKNOWN_KEY]: { foo: 1 } })
  })
})

describe('id заголовка — кавычки, когда bare-вывод потерял бы значение (§2.1)', () => {
  it('краевые пробелы и пустой id переживают round-trip', () => {
    for (const id of ['Arcadia ', ' lead', '', 'Maki & Yoshi ', 'say "hi"']) {
      const text = serialize({ sigil: '$', root: { name: '', level: 0, attrs: [], children: [{ name: 'char', level: 1, attrs: [], children: [], id }] } })
      expect(parse(text).root.children[0].id ?? '').toBe(id)
    }
  })

  it('обычный id остаётся без кавычек', () => {
    const text = serialize({ sigil: '@', root: { name: '', level: 0, attrs: [], children: [{ name: 'entry', level: 1, attrs: [], children: [], id: 'city_fall' }] } })
    expect(text).toBe('# @entry city_fall')
  })
})
