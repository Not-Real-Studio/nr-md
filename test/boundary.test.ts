// Dependency boundary (nr-md-extract-spec §3, §5).
//
// nr-md is a codec: text in, tree out. It must stay runnable anywhere a string
// is a string — no host APIs, and exactly one dependency (the JSON5 microcodec).
// A red test here means the package picked up a tie it cannot carry.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, sep } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(HERE, '..', 'src')

/** External packages nr-md may import (allowlist). */
const ALLOWED_BARE = new Set(['@notrealstudio/nr-json5'])

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Every `import/export ... from '<spec>'` and dynamic `import('<spec>')`. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const fromRe = /\bfrom\s*['"]([^'"]+)['"]/g
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [fromRe, dynRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) specs.push(m[1])
  }
  return specs
}

describe('nr-md boundary', () => {
  const files = tsFiles(SRC_DIR)

  it('finds the source modules', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = relative(SRC_DIR, file).split(sep).join('/')
    it(`${rel}: imports stay inside src/ plus the allowlist`, () => {
      const specs = importSpecifiers(readFileSync(file, 'utf8'))
      const violations: string[] = []
      for (const spec of specs) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          const relToSrc = relative(SRC_DIR, target)
          if (relToSrc.startsWith('..') || relToSrc.split(sep)[0] === '..') {
            violations.push(spec)
          }
        } else if (!ALLOWED_BARE.has(spec)) {
          violations.push(spec)
        }
      }
      expect(violations, `forbidden imports in ${rel}`).toEqual([])
    })
  }

  it('never reaches for a host API (no node: imports)', () => {
    const guilty = files
      .filter((f) => importSpecifiers(readFileSync(f, 'utf8')).some((s) => s.startsWith('node:')))
      .map((f) => relative(SRC_DIR, f).split(sep).join('/'))
    expect(guilty).toEqual([])
  })
})
