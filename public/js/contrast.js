// WCAG contrast correction utilities
// Pure color math — no DOM dependencies. Works in both Node.js and browser.

export function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const full = h.length === 3
    ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')
}

export function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map(c => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s * 100, l * 100]
}

export function hslToHex(h, s, l) {
  const s1 = s / 100
  const l1 = l / 100
  if (s1 === 0) {
    const v = Math.round(l1 * 255)
    return rgbToHex(v, v, v)
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l1 < 0.5 ? l1 * (1 + s1) : l1 + s1 - l1 * s1
  const p = 2 * l1 - q
  const hNorm = h / 360
  const r = Math.round(hue2rgb(p, q, hNorm + 1 / 3) * 255)
  const g = Math.round(hue2rgb(p, q, hNorm) * 255)
  const b = Math.round(hue2rgb(p, q, hNorm - 1 / 3) * 255)
  return rgbToHex(r, g, b)
}

// sRGB linearization for luminance calc
function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

export function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export function isDarkBackground(hex) {
  return relativeLuminance(hex) < 0.18
}

export function ensureContrast(bgHex, fgHex, targetRatio = 4.5) {
  const currentRatio = contrastRatio(bgHex, fgHex)
  if (currentRatio >= targetRatio) {
    return { color: fgHex, adjusted: false, original: fgHex, ratio: Math.round(currentRatio * 100) / 100 }
  }

  const dark = isDarkBackground(bgHex)
  const [h, s, origL] = hexToHsl(fgHex)

  // Binary search on lightness — push away from bg
  let lo, hi
  if (dark) {
    // lighten: search between current lightness and 100
    lo = origL
    hi = 100
  } else {
    // darken: search between 0 and current lightness
    lo = 0
    hi = origL
  }

  let bestL = dark ? 100 : 0 // fallback to extreme
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    const candidate = hslToHex(h, s, mid)
    const ratio = contrastRatio(bgHex, candidate)
    if (ratio >= targetRatio) {
      bestL = mid
      if (dark) {
        hi = mid // try to find lower (closer to original) lightness that still passes
      } else {
        lo = mid // try to find higher (closer to original) lightness that still passes
      }
    } else {
      if (dark) {
        lo = mid
      } else {
        hi = mid
      }
    }
  }

  const corrected = hslToHex(h, s, bestL)
  const finalRatio = contrastRatio(bgHex, corrected)
  return {
    color: corrected,
    adjusted: true,
    original: fgHex,
    ratio: Math.round(finalRatio * 100) / 100,
  }
}

export function deriveFullPalette(bg, fg, accent) {
  const dark = isDarkBackground(bg)
  const [bgH, bgS, bgL] = hexToHsl(bg)
  const [fgH, fgS, fgL] = hexToHsl(fg)

  // Derive intermediate colors by interpolating lightness between bg and fg
  const mutedL = dark
    ? bgL + (fgL - bgL) * 0.55
    : bgL - (bgL - fgL) * 0.55
  const dimL = dark
    ? bgL + (fgL - bgL) * 0.35
    : bgL - (bgL - fgL) * 0.35
  const surfaceL = dark
    ? bgL + 5
    : bgL - 5
  const borderL = dark
    ? bgL + 12
    : bgL - 12

  const mutedRaw = hslToHex(fgH, fgS * 0.6, mutedL)
  const dimRaw = hslToHex(fgH, fgS * 0.4, dimL)
  // surface + border: neutral gray (no hue tinting) to match minimal aesthetic
  const surfaceRaw = hslToHex(bgH, 0, Math.max(0, Math.min(100, surfaceL)))
  const borderRaw = hslToHex(bgH, 0, Math.max(0, Math.min(100, borderL)))

  // Semantic colors
  const greenRaw = dark ? '#44aa99' : '#22aa77'
  const blueRaw = dark ? '#44aaff' : '#2277cc'
  const redRaw = dark ? '#ee5555' : '#cc3333'
  const yellowRaw = dark ? '#ddaa33' : '#aa8800'
  const purpleRaw = dark ? '#aa77ff' : '#7733cc'

  // Enforce contrast: fg/accent/muted on bg >= 4.5:1, dim/border/green/semantic on bg >= 3:1
  const fgResult = ensureContrast(bg, fg, 4.5)
  const accentResult = ensureContrast(bg, accent, 4.5)
  const mutedResult = ensureContrast(bg, mutedRaw, 4.5)
  const dimResult = ensureContrast(bg, dimRaw, 3)
  const surfaceResult = { color: surfaceRaw, adjusted: false, ratio: contrastRatio(bg, surfaceRaw) }
  const borderResult = ensureContrast(bg, borderRaw, 3)
  const greenResult = ensureContrast(bg, greenRaw, 3)
  const blueResult = ensureContrast(bg, blueRaw, 3)
  const redResult = ensureContrast(bg, redRaw, 3)
  const yellowResult = ensureContrast(bg, yellowRaw, 3)
  const purpleResult = ensureContrast(bg, purpleRaw, 3)

  return {
    fg: fgResult,
    accent: accentResult,
    muted: mutedResult,
    dim: dimResult,
    surface: surfaceResult,
    border: borderResult,
    green: greenResult,
    blue: blueResult,
    red: redResult,
    yellow: yellowResult,
    purple: purpleResult,
  }
}
