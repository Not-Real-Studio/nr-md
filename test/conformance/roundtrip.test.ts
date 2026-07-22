// Conformance — round-trip parse(serialize(doc)) ≡ doc (format-spec §9, §10).
// Корпус: блоки, вложенные блоки, flow-массивы, quoted-скаляры, и — главное —
// ТЕЛА, содержащие строки вида `$key: value`, `## $name`, `%role`.
//
// Часть кейсов (тела с опасными строками, двойной unescape) падает до фиксов
// B1/B3 — помечена `.fails`. Пометка снимается в коммите B.
import { describe, it, expect } from 'vitest'
import { parse } from '../../src/parser.js'
import { serialize } from '../../src/serialize.js'
import type { Document, Block } from '../../src/types.js'

/** parse(serialize(doc)) должен дать структурно идентичный документ. */
function rt(text: string): void {
  const doc = parse(text)
  const out = serialize(doc)
  const back = parse(out)
  expect(back).toEqual(doc)
}

/** Round-trip документа, собранного программно (тело задаётся напрямую). */
function rtDoc(doc: Document): void {
  const out = serialize(doc)
  const back = parse(out)
  expect(back).toEqual(doc)
}

function block(name: string, body: string, extra: Partial<Block> = {}): Block {
  return { name, level: 1, attrs: [], children: [], body, ...extra }
}
function docWith(...children: Block[]): Document {
  return { sigil: '$', root: { name: '', level: 0, attrs: [], children } }
}

describe('conformance: round-trip — базовый корпус (проходит до B)', () => {
  it('блоки с атрибутами', () => rt(['# $a', '$x: 1', '# $b my-id', '$y: hello'].join('\n')))
  it('вложенные блоки', () => rt(['# $p', '$p: 1', '## $c', '$c: 2', '## $d', '$d: 3'].join('\n')))
  it('flow-массивы', () => rt(['# $b', '$list: $[a, b, "c, d", 1, true]'].join('\n')))
  it('quoted-скаляры', () =>
    rt(['# $b', '$q: "  spaced  "', '$n: "42"', '$v: "1.10"'].join('\n')))
  it('коллекция блоков (смешанные id)', () =>
    rt(['# $item one', '$v: 1', '# $item', '$v: 2', '# $item three', '$v: 3'].join('\n')))
  it('интерполяция и opt-out в значениях', () =>
    rt(['# $b', '$k: hello ${name}!', '$o: price \\${USD}'].join('\n')))
  it('простое тело прозы', () => rt(['# $b', '$x: 1', 'Просто текст тела.', 'Вторая строка.'].join('\n')))
})

describe('conformance: round-trip — тела с опасными строками', () => {
  it('тело со строкой `$key: value` (B3: эскейп сигила)', () => {
    rtDoc(docWith(block('b', '$key: value\nобычный текст')))
  })

  it('тело со строкой `## $name` (B3: эскейп сигила)', () => {
    rtDoc(docWith(block('b', 'intro\n## $inner\noutro')))
  })

  it('тело со строкой `%role` (round-trip на уровне документа стабилен)', () => {
    // `%role` на уровне документа — не структура (обрабатывается splitter'ом по
    // запросу cast('messages')), поэтому round-trip не требует эскейпа.
    rtDoc(docWith(block('b', '%user\nпривет')))
  })

  it('тело со всеми маркерами сразу (B3)', () => {
    rtDoc(docWith(block('b', '$k: v\n## $h name\n#заголовок $x\n%assistant\nхвост')))
  })

  it('тело, начинающееся с заголовка-сигила на root', () => {
    rtDoc(docWith(block('b', '# $top\n$inner: 1\nтело')))
  })
})

describe('conformance: двойной unescape тела (append path, §2.5)', () => {
  it('тело возобновляется после блока: `\\\\$`/`\\\\#` unescape-ится один раз (B1)', () => {
    // root body → блок → close → root body снова. Старый парсер разворачивает
    // ПЕРВЫЙ фрагмент дважды (\\$ → \$ → $), теряя обратный слеш.
    const doc = parse(
      ['один \\\\$ доллар', '# $blk', '$a: 1', '## $', 'два \\\\# решётка'].join('\n'),
    )
    const body = typeof doc.root.body === 'string' ? doc.root.body : (doc.root.body as any)?.raw
    // Один разворот: \\$ → \$ (обратный слеш сохранён), \\# → \# .
    expect(body).toBe('один \\$ доллар\n\nдва \\# решётка')
  })
})
