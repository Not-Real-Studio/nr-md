import { describe, it, expect } from 'vitest'
import { parse, resolveIncludes, serializeValue, FlowParseError } from '../src/index.js'
import { parseAttributeValue } from '../src/value.js'

// DEV-162: молчаливая порча формата → ошибка или корректный разбор.

describe('BOM (DEV-162)', () => {
  const doc = '$type: rz\n$cmd: action\n\n## $step\n$k: v\nbody'

  it('документ с BOM парсится идентично документу без BOM', () => {
    expect(parse('﻿' + doc)).toEqual(parse(doc))
  })

  it('первый атрибут не съеден', () => {
    const root = parse('﻿$type: rz\n$cmd: action').root
    expect(root.attrs.map((a) => a.key[0])).toEqual(['type', 'cmd'])
    expect(root.body).toBeUndefined()
  })

  it('BOM внутри текста не трогается — только в начале', () => {
    const root = parse('$k: a﻿b').root
    expect(root.attrs[0].value).toBe('a﻿b')
  })

  it('BOM включённого файла не попадает в середину текста', () => {
    const out = resolveIncludes('$[[inc]]\n$b: 2', () => '﻿$a: 1')
    expect(out).toBe('$a: 1\n$b: 2')
    expect(parse(out).root.attrs.map((a) => a.key[0])).toEqual(['a', 'b'])
  })
})

describe('вложенный flow-список (DEV-162)', () => {
  it('$[[1,2], x] → FlowParseError с позицией', () => {
    let err: unknown
    try {
      parse('$a: 1\n$k: $[[1,2], x]')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FlowParseError)
    const fe = err as FlowParseError
    expect(fe.line).toBe(2)
    expect(fe.key).toBe('k')
    // `$k: $[` — вложенная `[` в 7-й колонке строки
    expect(fe.column).toBe(7)
    expect(fe.message).toMatch(/\$k \(line 2, column 7\): nested list in a flow literal is not supported/)
  })

  it('вложенный список не первым элементом и в mdd', () => {
    expect(() => parseAttributeValue('$[x, [1, 2]]', '$')).toThrow(FlowParseError)
    expect(() => parseAttributeValue('@[x, [a, b], y]', '@')).toThrow(FlowParseError)
    expect(() => parseAttributeValue('$[a, [b, c', '$')).not.toThrow() // не flow: нет `]` в конце
  })

  it('непарная `[` — текст: у неё одно прочтение (ключи лорбуков из архива chub)', () => {
    expect(parseAttributeValue('@[[Context:, [Narrator:]', '@')).toEqual(['[Context:', '[Narrator:'])
    expect(parseAttributeValue('@[[, [Context:, [Narrator:, [Scene:, <!--, <style>]', '@')).toEqual([
      '[', '[Context:', '[Narrator:', '[Scene:', '<!--', '<style>',
    ])
    expect(parseAttributeValue('@[[Context:, [, [DM:, <!--, [Scene:]', '@')).toEqual(['[Context:', '[', '[DM:', '<!--', '[Scene:'])
  })

  it('парная группа с запятой внутри — ошибка, даже рядом с непарной скобкой', () => {
    expect(() => parseAttributeValue('@[[Context:, [a, b], x]', '@')).toThrow(FlowParseError)
  })

  it('скобки внутри строки в кавычках — текст', () => {
    expect(parseAttributeValue('$["[1,2]", x]', '$')).toEqual(['[1,2]', 'x'])
    expect(parseAttributeValue('$[a, "[b, c]"]', '$')).toEqual(['a', '[b, c]'])
  })

  it('экранированная скобка — текст', () => {
    expect(parseAttributeValue('$[\\[WIP], x]', '$')).toEqual(['[WIP]', 'x'])
    expect(parseAttributeValue('$[\\[a\\, b]', '$')).toEqual(['[a, b'])
  })

  it('скобочная группа без запятой — текст, как раньше', () => {
    expect(parseAttributeValue('@[[OOC], abb, (abb)]', '@')).toEqual(['[OOC]', 'abb', '(abb)'])
    expect(parseAttributeValue('$[foo[0], x]', '$')).toEqual(['foo[0]', 'x'])
    expect(parseAttributeValue('${x}', '$')).toEqual({ raw: '${x}', placeholders: expect.any(Array) })
  })

  it('инклуд $[[file]] как значение не затронут (прежняя форма, без ошибки)', () => {
    expect(parseAttributeValue('$[[file]]', '$')).toEqual(['[file]'])
    expect(() => parse('$k: $[[dir/file.md#sec]]')).not.toThrow()
  })

  it('инклуд в строке и в теле не затронут', () => {
    expect(parseAttributeValue('see $[[file]] here', '$')).toBe('see $[[file]] here')
    expect(parse('## $b\n$[[file]]').root.children[0].body).toBe('$[[file]]')
  })

  it('разрешённый инклуд в значении подставляется как раньше', () => {
    const out = resolveIncludes('$k: $[[list]]', () => '$[a, b]')
    expect(parse(out).root.attrs[0].value).toEqual(['a', 'b'])
  })

  it('сериализатор не пишет неоднозначный flow: элементы со скобками в кавычках', () => {
    const items = ['[', '[Context:', '[OOC]', 'x]']
    const text = serializeValue(items, '@')
    expect(text).toBe('@["[", "[Context:", "[OOC]", "x]"]')
    expect(parseAttributeValue(text, '@')).toEqual(items)
  })
})
