// Cell-space instrumentation — vectors drawn with braille (2×4 dots per cell)
// and eighth-blocks (8 steps per cell). Pure strings; callers pick colors, so
// every instrument works in all themes and over ssh/tmux.

import { cpus, loadavg } from "node:os"

// ---- braille strip chart ---------------------------------------------------

// Unicode braille dot bits, indexed by cell-local [column][row]
const DOT: number[][] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/**
 * Draw values (0..1) as a filled strip chart, newest sample at the right edge.
 * Returns `rows` strings of `cells` braille characters, top row first. Columns
 * with no data yet stay blank, so the chart fills in from the right like a
 * strip-chart recorder. Any nonzero value lights at least the baseline dot.
 */
export function stripChart(values: number[], cells: number, rows = 1): string[] {
  const cols = cells * 2
  const dotRows = rows * 4
  const window = values.slice(-cols)
  const pad = cols - window.length
  const grid: number[][] = Array.from({ length: rows }, () => new Array(cells).fill(0))
  window.forEach((v, i) => {
    const clamped = Math.min(Math.max(v, 0), 1)
    const h = clamped > 0 ? Math.max(1, Math.round(clamped * dotRows)) : 0
    const x = pad + i
    for (let d = 0; d < h; d++) {
      const y = dotRows - 1 - d
      grid[Math.floor(y / 4)]![Math.floor(x / 2)]! |= DOT[x % 2]![y % 4]!
    }
  })
  return grid.map((row) => row.map((mask) => String.fromCharCode(0x2800 + mask)).join(""))
}

// ---- eighth-block meter ----------------------------------------------------

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

/** Horizontal meter like `█▍····` — frac clamped to 0..1 over a dotted track. */
export function meter(frac: number, width: number): string {
  const f = Math.min(Math.max(frac, 0), 1)
  const eighths = Math.round(f * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  return "█".repeat(full) + part + "·".repeat(Math.max(0, width - full - (part ? 1 : 0)))
}

// ---- hostmark (per-machine identicon) --------------------------------------

// quadrant-block characters indexed by bitmask: 1=top-left 2=top-right
// 4=bottom-left 8=bottom-right
const QUAD = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"

/** FNV-1a over a string — the seed behind every per-machine trait. */
export function hash32(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Derive the n-th independent 32-bit value from a seed (murmur3 finalizer). */
export function mix32(seed: number, n: number): number {
  let x = seed ^ Math.imul(n + 1, 0x9e3779b1)
  x = Math.imul(x ^ (x >>> 15), 2246822519)
  x = Math.imul(x ^ (x >>> 13), 3266489917)
  return (x ^ (x >>> 16)) >>> 0
}

/**
 * A deterministic block-art mark for a machine — same id, same mark, forever.
 * Mirrored horizontally so every mark reads as a deliberate emblem rather
 * than noise. Returns `rows` strings of `cells` quadrant characters.
 */
export function hostmark(id: string, cells = 5, rows = 2): string[] {
  const h = hash32(id)
  const bit = (n: number) => mix32(h, n) % 5 < 2 // ~40% ink
  const qw = cells * 2
  const qh = rows * 2
  const half = Math.ceil(qw / 2)
  const cell = (qx: number, qy: number) => bit(qy * half + (qx < half ? qx : qw - 1 - qx))
  const out: string[] = []
  for (let cy = 0; cy < rows; cy++) {
    let line = ""
    for (let cx = 0; cx < cells; cx++) {
      const m =
        (cell(cx * 2, cy * 2) ? 1 : 0) |
        (cell(cx * 2 + 1, cy * 2) ? 2 : 0) |
        (cell(cx * 2, cy * 2 + 1) ? 4 : 0) |
        (cell(cx * 2 + 1, cy * 2 + 1) ? 8 : 0)
      line += QUAD[m]
    }
    out.push(line)
  }
  return out
}

// ---- spinner ----------------------------------------------------------------

/** braille spinner frames — index with a fast tick while work is in flight */
export const SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]

// ---- pulse history (per machine) -------------------------------------------

export const CORES = cpus().length || 1
const HISTORY = 240
const buffers = new Map<string, number[]>()
let lastLocalLoad = 0

/** Append one 0..1 sample to a machine's history ring. */
export function recordPulse(id: string, frac: number) {
  const buf = buffers.get(id) ?? []
  buf.push(Math.min(Math.max(frac, 0), 1))
  if (buf.length > HISTORY) buf.shift()
  buffers.set(id, buf)
}

/** A machine's load history, oldest first. Empty until samples land. */
export function pulse(id: string): number[] {
  return buffers.get(id) ?? []
}

/** Take one local load-average reading; call on a steady interval. */
export function sampleLocalPulse() {
  lastLocalLoad = loadavg()[0] ?? 0
  recordPulse("local", lastLocalLoad / CORES)
}

export function localLoad(): number {
  return lastLocalLoad
}
