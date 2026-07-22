# nr-md

Markdown as structured data: headings become blocks, `$key: value` lines become attributes, and everything else stays the prose it always was.

```markdown
# $model gpt-4o
$temperature: 0.7
$stop: $["\n\n", "END"]
$limits: {input: 8000, output: 800}

You are a terse assistant.
```

```js
import { parse, serialize } from '@notrealstudio/nr-md'

const doc = parse(text)
const model = doc.root.children[0]

model.id                // 'gpt-4o'
model.attrs[0].value    // 0.7  — coerced, not a string
model.attrs[1].value    // ['\n\n', 'END']
model.attrs[2].value    // { input: 8000, output: 800 }
model.body              // 'You are a terse assistant.'

serialize(doc)          // back to text, in canonical form
```

`serialize` emits the canonical spelling of a document, so `parse(serialize(doc))`
gives back the same tree — values that need no quotes lose them, blank separator
lines are not preserved. Byte-identical output is guaranteed for text that is
already canonical, which is what `serialize` produces.

The point is the file, not the API. It is a Markdown document — it renders in Obsidian, previews on GitHub, diffs by line, and a person can edit it without knowing there is a parser. It is also a tree with typed values, so a program can read it as configuration, as a prompt library, as records. You do not keep two files, one for humans and one for machines.

## Install

```sh
npm install @notrealstudio/nr-md
```

Zero configuration, one dependency (a JSON5 microcodec), no host APIs — it runs wherever a string is a string.

## The grammar

**Blocks.** A heading whose text starts with the sigil opens a block; the rest of the line is its name, and anything after a space is its id. Heading depth nests them.

```markdown
# $character Aria      → block "character", id "Aria", level 1
## $voice              → nested block "voice"
## $                   → closing token: back to the top level
```

**Attributes.** A line starting with the sigil, up to the first `:`, is a key.

```markdown
$name: Aria            → 'Aria'      (string)
$age: 24               → 24          (number)
$active: true          → true        (boolean)
$id: 007               → '007'       (leading zero — an id, not a number)
$phone: +79051234567   → string      (a leading + is not a sign)
$title: "42"           → '42'        (quotes force a string)
```

Repeating a key is reassignment: the last one wins.

**Lists** are flow literals — sigil, brackets, commas:

```markdown
$tags: $[fantasy, "slice, of life", 3]
```

**Objects** are JSON5, on one line:

```markdown
$sampler: {steps: 30, cfg: 7.5, sched: 'karras'}
```

**Bodies.** Every line that is not a heading or an attribute belongs to the current block's body, verbatim — Markdown, code fences, tables, whatever. `serialize` escapes a body line that would re-parse as structure, so a round-trip through a document that talks *about* the format is still exact.

**Interpolation.** `${...}` is recognised but never evaluated. A value carrying one parses to `{ raw, placeholders }`: the original text, plus the spans where interpolations sit. What the expression inside means is your language, not ours — bring your own evaluator. `\${` opts out, and the marker survives parsing intact.

## Two sigils

The sigil is a parameter. `$` is the mdz profile, `@` is mdd — same grammar, different marker, so two conventions can live in one document tree without colliding.

```js
parse(text)                  // '$' by default
parse(text, { sigil: '@' })  // '@name: value', '# @block'
serialize(doc, { sigil: '@' })
```

## Schema layer

A subpath, because it is a different job — laying a JSON Schema out as a document and reading it back:

```js
import { serializeWithSchema, parseWithSchema } from '@notrealstudio/nr-md/schema'

const text = serializeWithSchema(obj, schema)   // x-storage decides attr/body/block/tbl
const back = parseWithSchema(text, schema)      // deep-equals obj
```

`x-storage` and `x-mdd` annotations say where each field lives: an attribute, the block body, a block of its own, a table, a flow list. Unknown fields round-trip losslessly instead of being dropped, so you can layer this over someone else's schema without owning it.

`validate` delegates to Ajv2020, an **optional** peer — install `ajv` if you want it, or pass your own validator. The root import never touches it.

Finding an installed `ajv` from ESM without importing a host module needs `process.getBuiltinModule` (Node 22.3+). Below that, and in the browser, auto-discovery is off and `validate` asks for `opts.validator` — everything else in the package is plain ES2022 and runs on Node 20 LTS and any current browser.

## API

| | |
|---|---|
| `parse(text, opts?)` | text → `Document` |
| `serialize(doc, opts?)` | `Document` → text |
| `parseAttributeValue`, `parseBodyValue` | value-level parsing |
| `coerce`, `isFullyQuoted` | scalar coercion (§3) |
| `serializeValue` | one value → its source form |
| `parseTable`, `parseTableTyped`, `serializeTable`, `serializeTypedTable` | `tbl` bodies |
| `parseHeaderCell`, `emitHeaderCell`, `coerceTyped`, `tableSchema` | typed table headers |
| `isJson5Shaped`, `isJson5Object`, `parseJson5Object` | JSON5 attribute values |
| `resolveIncludes`, `resolveIncludesAsync`, `extractSection` | `$[[path#section]]` preprocessing |

Types: `Document`, `Block`, `Attribute`, `AttributeValue`, `BodyValue`, `Scalar`, `ListItem`, `InterpolatedValue`, `InterpolationSpan`, `Json5Object`, `Json5Value`, `Sigil`, `ParseOptions`, `SerializeOptions`, `Pos`.

`Block` and `Attribute` carry an optional `pos` slot. Nothing populates it yet; it is reserved so that adding position tracking later cannot break an exhaustive walk written against this tree today.

## What this is not

It does not evaluate anything. No expressions, no includes resolved from disk (you inject the reader), no inheritance, no templating. Those belong to whoever consumes the tree, and keeping them out is what makes the tree portable — the same document can feed a different engine, in a different language, with a different idea of what `${x}` means.

The normative grammar reference (format-spec, serialize-spec) is maintained with the engine that grew this format and ships alongside it.

## License

MIT
