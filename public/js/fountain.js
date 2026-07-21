// Script format — parser and utilities for screenplay, teleplay, and stage play
// Extracted from journal.js for testability

export const FOUNTAIN_MARKER = '<!-- fountain -->\n'
export const STAGEPLAY_MARKER = '<!-- stageplay -->\n'

// Element types in Tab-cycle order — per format
export const ELEM_TYPES = ['action', 'scene', 'character', 'dialogue', 'paren', 'transition']
export const STAGE_ELEM_TYPES = ['action', 'act', 'scene', 'character', 'dialogue', 'paren', 'direction']

// Format definitions
export const SCRIPT_FORMATS = {
  screenplay: { marker: FOUNTAIN_MARKER, types: ELEM_TYPES, label: 'screenplay' },
  teleplay: { marker: FOUNTAIN_MARKER, types: ELEM_TYPES, label: 'teleplay' },
  stageplay: { marker: STAGEPLAY_MARKER, types: STAGE_ELEM_TYPES, label: 'stage play' },
}

/**
 * Detect the Fountain element type of a single line based on its text and the previous line's type.
 * Follows the Fountain spec: https://fountain.io/syntax
 */
export function detectLineType(text, prevType) {
  const trimmed = text.trim()
  if (!trimmed) return 'action'

  // forced markers (Fountain spec)
  if (trimmed.startsWith('.') && trimmed.length > 1 && trimmed[1] !== '.') return 'scene'
  if (trimmed.startsWith('@')) return 'character'
  if (trimmed.startsWith('>') && !trimmed.endsWith('<')) return 'transition'

  // scene headings
  if (/^(INT\.|EXT\.|INT\/EXT\.|I\/E\.)[\s.]/i.test(trimmed)) return 'scene'

  // transitions
  if (/^[A-Z\s]+TO:$/.test(trimmed)) return 'transition'

  // parenthetical — line in parens after character or dialogue
  if (/^\(.*\)$/.test(trimmed) && (prevType === 'character' || prevType === 'dialogue')) return 'paren'

  // character — all-caps line (min 2 chars, no lowercase) after blank or action
  if (/^[A-Z][A-Z0-9 .'-]{1,}$/.test(trimmed) && prevType !== 'character' && prevType !== 'dialogue' && prevType !== 'paren') return 'character'

  // dialogue follows character or paren
  if (prevType === 'character' || prevType === 'paren') return 'dialogue'

  // continued dialogue
  if (prevType === 'dialogue' && trimmed) return 'dialogue'

  return 'action'
}

/**
 * Parse a full Fountain text into an array of { text, type } objects.
 * Empty lines reset the context (prevType) to 'action'.
 */
export function parseFountain(text) {
  const lines = text.split('\n')
  const result = []
  let prevType = 'action'
  for (const line of lines) {
    const type = detectLineType(line, prevType)
    result.push({ text: line, type })
    prevType = line.trim() ? type : 'action'
  }
  return result
}

/**
 * Strip forced markers from Fountain text (e.g., leading . @ > used to force element types).
 */
export function stripForcedMarker(text, type) {
  const trimmed = text.trim()
  if (type === 'scene' && trimmed.startsWith('.') && trimmed[1] !== '.') return trimmed.slice(1)
  if (type === 'character' && trimmed.startsWith('@')) return trimmed.slice(1)
  if (type === 'transition' && trimmed.startsWith('>')) return trimmed.slice(1).trim()
  return text
}

/**
 * Determine the next element type after pressing Enter on a given type.
 * Models the smart inference behavior of screenplay editors.
 */
export function nextTypeAfterEnter(currentType) {
  if (currentType === 'scene') return 'action'
  if (currentType === 'character') return 'dialogue'
  if (currentType === 'dialogue') return 'character'
  if (currentType === 'paren') return 'dialogue'
  if (currentType === 'transition') return 'action'
  return 'action'
}

/**
 * Cycle to the next element type (Tab key behavior).
 */
export function cycleType(currentType) {
  const idx = ELEM_TYPES.indexOf(currentType)
  return ELEM_TYPES[(idx + 1) % ELEM_TYPES.length]
}

/**
 * Cycle to the previous element type (Shift+Tab behavior).
 */
export function cycleTypePrev(currentType) {
  const idx = ELEM_TYPES.indexOf(currentType)
  return ELEM_TYPES[(idx - 1 + ELEM_TYPES.length) % ELEM_TYPES.length]
}

/**
 * Check if content is a Fountain/script entry based on the marker prefix.
 */
export function isFountainContent(content) {
  return typeof content === 'string' && content.startsWith(FOUNTAIN_MARKER)
}

/**
 * Extract the Fountain body from a stored entry (strip the marker prefix).
 */
export function extractFountainBody(content) {
  if (!isFountainContent(content)) return content
  return content.slice(FOUNTAIN_MARKER.length)
}

/**
 * Wrap plain Fountain text with the marker for storage.
 */
export function wrapFountainForStorage(plainText) {
  return FOUNTAIN_MARKER + plainText
}

// --- Stage play format ---

/**
 * Detect element type for stage play format.
 * Stage plays use different conventions: ACT/SCENE labels, stage directions in brackets.
 */
export function detectStagePlayLineType(text, prevType) {
  const trimmed = text.trim()
  if (!trimmed) return 'action'

  // act labels: ACT ONE, ACT I, ACT 1, etc.
  if (/^ACT\s+[A-Z0-9IVXLC]+\.?$/i.test(trimmed)) return 'act'

  // scene labels: SCENE 1, SCENE ONE, etc.
  if (/^SCENE\s+[A-Z0-9IVXLC]+\.?$/i.test(trimmed)) return 'scene'

  // stage directions in brackets or parens at start of line (not after character)
  if (/^\[.*\]$/.test(trimmed) || (/^\(.*\)$/.test(trimmed) && prevType !== 'character' && prevType !== 'dialogue')) return 'direction'

  // parenthetical within dialogue
  if (/^\(.*\)$/.test(trimmed) && (prevType === 'character' || prevType === 'dialogue')) return 'paren'

  // character — all-caps (same as screenplay) but also handles "CHARACTER."
  if (/^[A-Z][A-Z0-9 .'-]{1,}\.?$/.test(trimmed) && prevType !== 'character' && prevType !== 'dialogue' && prevType !== 'paren') return 'character'

  // dialogue follows character or paren
  if (prevType === 'character' || prevType === 'paren') return 'dialogue'
  if (prevType === 'dialogue' && trimmed) return 'dialogue'

  return 'action'
}

/**
 * Parse stage play text into typed lines.
 */
export function parseStagePlay(text) {
  const lines = text.split('\n')
  const result = []
  let prevType = 'action'
  for (const line of lines) {
    const type = detectStagePlayLineType(line, prevType)
    result.push({ text: line, type })
    prevType = line.trim() ? type : 'action'
  }
  return result
}

/**
 * Enter key inference for stage play.
 */
export function nextStagePlayTypeAfterEnter(currentType) {
  if (currentType === 'act') return 'scene'
  if (currentType === 'scene') return 'direction'
  if (currentType === 'direction') return 'character'
  if (currentType === 'character') return 'dialogue'
  if (currentType === 'dialogue') return 'character'
  if (currentType === 'paren') return 'dialogue'
  return 'action'
}

/**
 * Cycle through stage play element types (Tab).
 */
export function cycleStagePlayType(currentType) {
  const idx = STAGE_ELEM_TYPES.indexOf(currentType)
  return STAGE_ELEM_TYPES[(idx + 1) % STAGE_ELEM_TYPES.length]
}

export function cycleStagePlayTypePrev(currentType) {
  const idx = STAGE_ELEM_TYPES.indexOf(currentType)
  return STAGE_ELEM_TYPES[(idx - 1 + STAGE_ELEM_TYPES.length) % STAGE_ELEM_TYPES.length]
}

/**
 * Check if content is stage play format.
 */
export function isStagePlayContent(content) {
  return typeof content === 'string' && content.startsWith(STAGEPLAY_MARKER)
}

export function extractStagePlayBody(content) {
  if (!isStagePlayContent(content)) return content
  return content.slice(STAGEPLAY_MARKER.length)
}

export function wrapStagePlayForStorage(plainText) {
  return STAGEPLAY_MARKER + plainText
}

/**
 * Convert stage play text to HTML.
 */
export function stagePlayToHtml(text) {
  const parsed = parseStagePlay(text)
  const lines = []
  for (const item of parsed) {
    const escaped = item.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    if (!escaped.trim()) {
      lines.push('<p class="stageplay-blank">&nbsp;</p>')
      continue
    }
    lines.push(`<p class="stageplay-${item.type}">${escaped}</p>`)
  }
  return lines.join('\n')
}

// --- Format-aware helpers ---

/**
 * Detect format from stored content.
 */
export function detectScriptFormat(content) {
  if (isStagePlayContent(content)) return 'stageplay'
  if (isFountainContent(content)) return 'screenplay'
  return null
}

/**
 * Get parser functions for a given format.
 */
export function getFormatFunctions(format) {
  if (format === 'stageplay') {
    return {
      types: STAGE_ELEM_TYPES,
      detect: detectStagePlayLineType,
      parse: parseStagePlay,
      nextAfterEnter: nextStagePlayTypeAfterEnter,
      cycle: cycleStagePlayType,
      cyclePrev: cycleStagePlayTypePrev,
      toHtml: stagePlayToHtml,
      wrap: wrapStagePlayForStorage,
      marker: STAGEPLAY_MARKER,
      stripMarker: (t) => t, // no forced markers in stage play
    }
  }
  // default: screenplay/teleplay
  return {
    types: ELEM_TYPES,
    detect: detectLineType,
    parse: parseFountain,
    nextAfterEnter: nextTypeAfterEnter,
    cycle: cycleType,
    cyclePrev: cycleTypePrev,
    toHtml: fountainToHtml,
    wrap: wrapFountainForStorage,
    marker: FOUNTAIN_MARKER,
    stripMarker: stripForcedMarker,
  }
}

/**
 * Convert Fountain text to formatted HTML for blog publishing or PDF export.
 * Produces screenplay-formatted HTML with proper margins and styling.
 */
export function fountainToHtml(text) {
  const parsed = parseFountain(text)
  const lines = []
  for (const item of parsed) {
    const escaped = item.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const display = stripForcedMarker(escaped, item.type)
    if (!display.trim()) {
      lines.push('<p class="fountain-blank">&nbsp;</p>')
      continue
    }
    lines.push(`<p class="fountain-${item.type}">${display}</p>`)
  }
  return lines.join('\n')
}

export const AUTO_UPPERCASE_TYPES = new Set(['scene', 'character', 'transition'])

export function shouldAutoUppercase(type) {
  return AUTO_UPPERCASE_TYPES.has(type)
}

export function extractCharacterNames(editorEl) {
  const names = new Set()
  editorEl.querySelectorAll('div.script-line[data-type="character"]').forEach(el => {
    const name = el.textContent.trim()
    if (name) names.add(name.toUpperCase())
  })
  return names
}

export function extractSceneLocations(editorEl) {
  const locations = new Set()
  editorEl.querySelectorAll('div.script-line[data-type="scene"]').forEach(el => {
    const text = el.textContent.trim().toUpperCase()
    if (text) locations.add(text)
  })
  return locations
}
