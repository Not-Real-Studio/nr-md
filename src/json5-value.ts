// JSON5-объект как значение атрибута (§3 format-spec; docs/specs/json5-scalar-spec.md).
// Детекция по форме, строгая: `{...}` обязан быть валидным JSON5-объектом.
// Битое → ошибка с номером строки, НЕ молчаливый откат в строку.

import { parseJson5 } from '@notrealstudio/nr-json5'
import type { Json5Object } from './types.js'

const LBRACE = 123 // {
const RBRACE = 125 // }

/** Ошибка JSON5-значения атрибута (конвенция — как TableParseError, §5). */
export class Json5ParseError extends Error {
  /** 1-based строка исходного документа, если известна. */
  readonly line?: number
  /** Ключ атрибута, которому принадлежит значение, если известен. */
  readonly key?: string

  constructor(message: string, line?: number, key?: string) {
    super(message)
    this.name = 'Json5ParseError'
    this.line = line
    this.key = key
  }
}

/** Trim spaces/tabs both ends (строковый примитив, не regex). */
function trim(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--
  return s.slice(a, b)
}

/**
 * Форма JSON5-объекта (§3): значение начинается `{` и кончается `}`.
 *
 * Проверять СЫРОЕ значение — до unescape. Иначе `\{literal}` сперва
 * развернулось бы в `{literal}` и было бы поймано детекцией, а эскейп
 * (§2.5) перестал бы работать.
 *
 * `{name} says hi` — начинается с `{`, но не кончается `}` → не форма,
 * обычная проза (конфликта с прозой нет).
 */
export function isJson5Shaped(raw: string): boolean {
  const s = trim(raw)
  return s.length >= 2 && s.charCodeAt(0) === LBRACE && s.charCodeAt(s.length - 1) === RBRACE
}

/** Плоский guard объекта JSON5 против InterpolatedValue (`{raw, placeholders}`). */
export function isJson5Object(v: unknown): v is Json5Object {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !('raw' in v && 'placeholders' in v) &&
    typeof (v as { cast?: unknown }).cast !== 'function'
  )
}

function where(line?: number, key?: string): string {
  const k = key === undefined ? 'attribute value' : `$${key}`
  const l = line === undefined ? '' : ` (line ${line})`
  return `${k}${l}`
}

/**
 * Строгий парс значения, прошедшего {@link isJson5Shaped} (§3).
 *
 * Однострочность — следствие позиции: значение атрибута не переносится.
 * После резолва многострочный результат внутри строки JSON5 невалиден и
 * даёт ошибку — это намеренно (решение 3: многострочное структурное = блоки).
 */
export function parseJson5Object(raw: string, line?: number, key?: string): Json5Object {
  const text = trim(raw)
  let parsed: unknown
  try {
    parsed = parseJson5(text)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Json5ParseError(`${where(line, key)}: ${detail}`, line, key)
  }
  // Форма гарантирует объект, но parseJson5 отдаёт unknown — сужаем честно.
  if (!isJson5Object(parsed)) {
    throw new Json5ParseError(`${where(line, key)}: JSON5 value is not an object`, line, key)
  }
  return parsed
}
