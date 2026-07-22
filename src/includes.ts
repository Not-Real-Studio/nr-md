// File includes: $[[path]] / @[[path]] preprocessor (format-spec §2.6).
// Text-level substitution BEFORE parsing. Recursive with cycle detection.
// Supports sections: $[[path#section]], $[[#section]] (from current text).

export interface IncludeOptions {
  /** Maximum nesting depth (default: 10). */
  maxDepth?: number
  /** Active sigil — only this sigil's includes are resolved. */
  sigil?: '$' | '@'
}

/**
 * Resolve file includes in text. Replaces `$[[path]]` / `$[[path#section]]`
 * with file/section content, recursively. Cycle detection by path.
 *
 * readFile: `(path: string) => string | undefined` — returns file content
 * or undefined if not found (left as-is in output).
 *
 * Async version: resolveIncludesAsync.
 */
export function resolveIncludes(
  text: string,
  readFile: (path: string) => string | undefined,
  opts?: IncludeOptions,
): string {
  const sigil = opts?.sigil ?? '$'
  const maxDepth = opts?.maxDepth ?? 10
  return expand(text, readFile, sigil, maxDepth, new Set(), 0, text)
}

/**
 * Async version — readFile returns Promise.
 */
export async function resolveIncludesAsync(
  text: string,
  readFile: (path: string) => Promise<string | undefined>,
  opts?: IncludeOptions,
): Promise<string> {
  const sigil = opts?.sigil ?? '$'
  const maxDepth = opts?.maxDepth ?? 10
  return expandAsync(text, readFile, sigil, maxDepth, new Set(), 0, text)
}

// ---------- Extract section from markdown ----------

/**
 * Extract a section from markdown by heading name. Case-insensitive.
 * Returns content from that heading until next heading of same/higher level.
 * Returns undefined if not found.
 */
export function extractSection(content: string, sectionName: string): string | undefined {
  const lines = content.split('\n')
  const target = sectionName.trim().toLowerCase()

  let startIdx = -1
  let startLevel = 0

  for (let i = 0; i < lines.length; i++) {
    const lvl = headingLevel(lines[i])
    if (lvl > 0) {
      const name = lines[i].slice(lvl).trim().toLowerCase()
      if (name === target) {
        startIdx = i
        startLevel = lvl
        break
      }
    }
  }

  if (startIdx === -1) return undefined

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const lvl = headingLevel(lines[i])
    if (lvl > 0 && lvl <= startLevel) {
      endIdx = i
      break
    }
  }

  // Trim trailing empty lines
  while (endIdx > startIdx && lines[endIdx - 1].trim() === '') endIdx--

  return lines.slice(startIdx, endIdx).join('\n')
}

function headingLevel(line: string): number {
  let i = 0
  while (i < line.length && line[i] === '#') i++
  if (i === 0 || i > 6 || line[i] !== ' ') return 0
  return i
}

// ---------- Sync expand ----------

function expand(
  text: string,
  readFile: (path: string) => string | undefined,
  sigil: string,
  maxDepth: number,
  visited: Set<string>,
  depth: number,
  currentText: string,
): string {
  if (depth > maxDepth) return text

  let out = ''
  let i = 0
  while (i < text.length) {
    // Escaped include: \$[[ → literal $[[
    if (text[i] === '\\' && i + 3 < text.length && text[i + 1] === sigil && text[i + 2] === '[' && text[i + 3] === '[') {
      out += sigil + '[['
      i += 4
      continue
    }

    // Include: $[[ or @[[
    if (text[i] === sigil && i + 2 < text.length && text[i + 1] === '[' && text[i + 2] === '[') {
      const start = i
      i += 3
      let raw = ''
      let closed = false
      while (i < text.length) {
        if (text[i] === ']' && i + 1 < text.length && text[i + 1] === ']') {
          closed = true
          i += 2
          break
        }
        raw += text[i]
        i++
      }

      if (!closed) {
        out += text.slice(start, i)
        continue
      }

      raw = raw.trim()

      // Parse path#section
      const hashIdx = raw.indexOf('#')
      const filePath = hashIdx >= 0 ? raw.slice(0, hashIdx).trim() : raw
      const section = hashIdx >= 0 ? raw.slice(hashIdx + 1).trim() : undefined

      // $[[#section]] — section from current text
      if (!filePath && section) {
        const extracted = extractSection(currentText, section)
        if (extracted !== undefined) {
          out += extracted
        } else {
          out += text.slice(start, i) // not found — leave as-is
        }
        continue
      }

      // Cycle detection
      if (visited.has(filePath)) {
        out += text.slice(start, i)
        continue
      }

      const content = readFile(filePath)
      if (content === undefined) {
        out += text.slice(start, i)
        continue
      }

      // Extract section if requested
      let result = content
      if (section) {
        const extracted = extractSection(content, section)
        if (extracted === undefined) {
          out += text.slice(start, i) // section not found — leave as-is
          continue
        }
        result = extracted
      }

      // Recurse
      visited.add(filePath)
      out += expand(result, readFile, sigil, maxDepth, visited, depth + 1, content)
      visited.delete(filePath)
      continue
    }

    out += text[i]
    i++
  }

  return out
}

// ---------- Async expand ----------

async function expandAsync(
  text: string,
  readFile: (path: string) => Promise<string | undefined>,
  sigil: string,
  maxDepth: number,
  visited: Set<string>,
  depth: number,
  currentText: string,
): Promise<string> {
  if (depth > maxDepth) return text

  // Collect all include positions first, then resolve in order
  // (sequential, not parallel — order matters for cycle detection)
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && i + 3 < text.length && text[i + 1] === sigil && text[i + 2] === '[' && text[i + 3] === '[') {
      out += sigil + '[['
      i += 4
      continue
    }

    if (text[i] === sigil && i + 2 < text.length && text[i + 1] === '[' && text[i + 2] === '[') {
      const start = i
      i += 3
      let raw = ''
      let closed = false
      while (i < text.length) {
        if (text[i] === ']' && i + 1 < text.length && text[i + 1] === ']') {
          closed = true
          i += 2
          break
        }
        raw += text[i]
        i++
      }

      if (!closed) {
        out += text.slice(start, i)
        continue
      }

      raw = raw.trim()
      const hashIdx = raw.indexOf('#')
      const filePath = hashIdx >= 0 ? raw.slice(0, hashIdx).trim() : raw
      const section = hashIdx >= 0 ? raw.slice(hashIdx + 1).trim() : undefined

      if (!filePath && section) {
        const extracted = extractSection(currentText, section)
        out += extracted ?? text.slice(start, i)
        continue
      }

      if (visited.has(filePath)) {
        out += text.slice(start, i)
        continue
      }

      const content = await readFile(filePath)
      if (content === undefined) {
        out += text.slice(start, i)
        continue
      }

      let result = content
      if (section) {
        const extracted = extractSection(content, section)
        if (extracted === undefined) {
          out += text.slice(start, i)
          continue
        }
        result = extracted
      }

      visited.add(filePath)
      out += await expandAsync(result, readFile, sigil, maxDepth, visited, depth + 1, content)
      visited.delete(filePath)
      continue
    }

    out += text[i]
    i++
  }

  return out
}
