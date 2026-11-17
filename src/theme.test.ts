// Contrast contract for every theme: each token must hold its WCAG ratio
// against the theme's own bg, so "readable in all themes" is enforced, not
// hoped for. Tune a color → `bun test` tells you if it slipped.
import { expect, test } from "bun:test"
import { allThemes, type Theme } from "./theme"

function lum(hex: string): number {
  const c = hex.replace("#", "")
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function ratio(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (l1! + 0.05) / (l2! + 0.05)
}

// token → [min, max] ratio vs bg; muted is capped so chrome stays quieter
// than dim, keeping the three-step text ramp an actual ramp
const VS_BG: Array<[keyof Theme, number, number]> = [
  ["fg", 9, Infinity],
  ["soft", 6.5, Infinity],
  ["dim", 4.6, Infinity],
  ["muted", 3.0, 4.8],
  ["highlight", 6, Infinity],
  ["info", 4.5, Infinity],
  ["ok", 4.5, Infinity],
  ["bad", 4.0, Infinity],
  ["accent", 3.5, Infinity],
]

for (const t of allThemes()) {
  for (const [token, lo, hi] of VS_BG) {
    test(`${t.name}: ${token} vs bg in [${lo}, ${hi === Infinity ? "∞" : hi}]`, () => {
      const r = ratio(t[token] as string, t.bg)
      expect(r).toBeGreaterThanOrEqual(lo)
      expect(r).toBeLessThanOrEqual(hi)
    })
  }
  test(`${t.name}: selFg vs selBg ≥ 4.5`, () => {
    expect(ratio(t.selFg, t.selBg)).toBeGreaterThanOrEqual(4.5)
  })
}
