// The floor — every machine on one canvas, drawn as a building on a street.
//
// Each host is a building whose silhouette is its own: roof line, rooftop
// flag, facade texture and chimney placement are hashed from its name, so a
// machine looks the same every time you open flr and different from its
// neighbours. Height follows core count. What's *inside* is live: the pulse
// trace, smoke puffing from the chimney in step with load, windows lit by
// tmux sessions, workers on the floor for running agents. Unreachable hosts
// go dark; auth-blocked ones are locked.
//
// Pure: snapshots + theme + tick in, colored spans per row out — so it draws
// identically in the TUI, the headless test renderer, and a demo script.

import { hash32, hostmark, mix32, SPINNER, stripChart } from "./instruments"
import type { Theme } from "./theme"

export type FloorState = "up" | "warn" | "down" | "auth" | "pending" | "unprobed"

export interface FloorMachine {
  id: string
  name: string
  local?: boolean
  state: FloorState
  /** short reason for down/auth: "timed out", "host key" … */
  reason?: string
  cores?: number
  memGB?: number
  gpu?: string
  /** 1-minute load average */
  load?: number
  /** load / cores history, 0..1, oldest first */
  pulse: number[]
  sessions: Array<{ name: string; attached: boolean }>
  alive: number
  failed: number
}

export interface Span {
  text: string
  fg: string
  bg?: string
}

// ---- canvas ----------------------------------------------------------------

interface Cell {
  ch: string
  fg: string
  bg?: string
}

/** A clipped cell grid; `rows()` merges runs of like-colored cells into spans. */
export class Canvas {
  private cells: (Cell | undefined)[]
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = new Array(Math.max(0, w * h))
  }

  put(x: number, y: number, s: string, fg: string, bg?: string) {
    if (y < 0 || y >= this.h) return
    let i = 0
    for (const ch of s) {
      const cx = x + i++
      if (cx < 0 || cx >= this.w) continue
      this.cells[y * this.w + cx] = { ch, fg, bg }
    }
  }

  get(x: number, y: number): Cell | undefined {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return undefined
    return this.cells[y * this.w + x]
  }

  rows(blankFg: string): Span[][] {
    const out: Span[][] = []
    for (let y = 0; y < this.h; y++) {
      const spans: Span[] = []
      let cur: Span | null = null
      for (let x = 0; x < this.w; x++) {
        const c = this.cells[y * this.w + x]
        const ch = c?.ch ?? " "
        const fg = c?.fg ?? blankFg
        const bg = c?.bg
        if (cur && cur.fg === fg && cur.bg === bg) cur.text += ch
        else spans.push((cur = { text: ch, fg, bg }))
      }
      out.push(spans)
    }
    return out
  }
}

// ---- persona: what makes a building *this* machine's ----------------------

export type Roof = "saw" | "gable" | "flat" | "penthouse" | "spire" | "tower"

export interface Persona {
  roof: Roof
  flag: string
  facade: string
  /** extra width, 0..4 cells */
  girth: number
  /** chimney position as a fraction of the width */
  chimney: number
}

const ROOFS: Roof[] = ["saw", "gable", "flat", "penthouse", "spire"]
const FLAGS = ["✦", "✧", "✱", "✺", "✿", "❋", "☘", "★", "☾", "⚙", "⚑", "♫", "⚘", "✚", "❂", "☀"]
const FACADES = ["░", "·", "╌", "▒", "⋅", " ", "⠶", "┈"]

/** Deterministic traits for a machine id — same id, same building, forever. */
export function persona(id: string, local = false): Persona {
  const h = hash32(id)
  return {
    roof: local ? "tower" : ROOFS[mix32(h, 1) % ROOFS.length]!,
    flag: FLAGS[mix32(h, 2) % FLAGS.length]!,
    facade: FACADES[mix32(h, 3) % FACADES.length]!,
    girth: mix32(h, 4) % 5,
    chimney: 0.2 + (mix32(h, 5) % 60) / 100,
  }
}

// ---- layout -----------------------------------------------------------------

export interface Building {
  m: FloorMachine
  p: Persona
  /** outer width, frame included */
  w: number
  /** interior rows between the frame lines */
  body: number
  roof: number
  smoke: number
  /** rows from the top of the smoke to the bottom frame line, inclusive */
  total: number
  x: number
  /** canvas row of the bottom frame line; the ground is the row below */
  bottom: number
  street: number
}

export interface Street {
  top: number
  /** the ground row */
  ground: number
  buildings: Building[]
}

export interface FloorLayout {
  streets: Street[]
  buildings: Building[]
  /** rows the whole floor needs, ground rows and street gaps included */
  height: number
}

const GAP = 2
const MAX_GAP = 7
const MARGIN = 1
const MIN_W = 16
const MAX_W = 26

function measure(m: FloorMachine, compact: boolean): Omit<Building, "x" | "bottom" | "street"> {
  const p = persona(m.id, m.local)
  const sign = Math.max(m.name.length, hwLine(m).length)
  const need = 1 + 5 + 1 + sign + 1 // frame, hostmark, space, sign text, frame
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.max(need, MIN_W + p.girth)))
  const cores = m.cores ?? 0
  const tier = compact ? 0 : cores >= 32 ? 2 : cores >= 12 ? 1 : 0
  const body = 4 + tier
  const roof = p.roof === "saw" || p.roof === "flat" ? 1 : 2
  const smoke = compact ? 2 : 3
  return { m, p, w, body, roof, smoke, total: smoke + roof + body + 2 }
}

/** Pack buildings onto streets left-to-right, wrapping at the canvas width. */
export function layoutFloor(machines: FloorMachine[], W: number, compact = false): FloorLayout {
  const streets: Street[] = []
  const buildings: Building[] = []
  let cur: Building[] = []
  let x = MARGIN
  const flush = () => {
    if (!cur.length) return
    // spread the street's buildings across the width — a little air between
    // neighbours, never a crowd on the left and a void on the right
    if (cur.length > 1) {
      const used = cur.reduce((n, b) => n + b.w, 0) + (cur.length - 1) * GAP
      const extra = Math.min(MAX_GAP - GAP, Math.floor((W - 2 * MARGIN - used) / (cur.length - 1)))
      if (extra > 0) cur.forEach((b, i) => (b.x += extra * i))
    }
    const tallest = Math.max(...cur.map((b) => b.total))
    const top = streets.length ? streets[streets.length - 1]!.ground + 2 : 0
    const ground = top + tallest
    for (const b of cur) {
      b.bottom = ground - 1
      b.street = streets.length
    }
    streets.push({ top, ground, buildings: cur })
    cur = []
    x = MARGIN
  }
  for (const m of machines) {
    const b: Building = { ...measure(m, compact), x: 0, bottom: 0, street: 0 }
    if (cur.length && x + b.w > W - MARGIN) flush()
    b.x = x
    x += b.w + GAP
    cur.push(b)
    buildings.push(b)
  }
  flush()
  const last = streets[streets.length - 1]
  return { streets, buildings, height: last ? last.ground + 1 : 0 }
}

// ---- drawing ------------------------------------------------------------------

function fit(s: string, n: number): string {
  if (n <= 0) return ""
  return s.length > n ? (n > 1 ? s.slice(0, n - 1) + "…" : s.slice(0, 1)) : s
}

/** "16c · 64G · RTX 4090" — the hardware line under the sign, kept short */
export function hwLine(m: FloorMachine): string {
  const parts: string[] = []
  if (m.cores) parts.push(`${m.cores}c`)
  if (m.memGB) parts.push(`${m.memGB}G`)
  if (m.gpu) {
    const g = m.gpu
      .replace(/NVIDIA|GeForce|Apple|AMD|Radeon|Intel|Inc\.?|\(.*?\)|,.*$/g, "")
      .replace(/\s+/g, " ")
      .trim()
    if (g) parts.push(g)
  }
  return parts.join(" ")
}

const FRAME = {
  light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  dashed: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "┄", v: "┆" },
}

const PUFFS = ["·", "∘", "○", "°"]

export interface FloorFrame {
  rows: Span[][]
  layout: FloorLayout
  /** first canvas row shown (vertical scroll) */
  scroll: number
  hiddenAbove: number
  hiddenBelow: number
}

/**
 * Draw the floor into a W×H window. `tick` advances the smoke and the local
 * beacon; `selected` gets the heavy accent frame.
 */
export function renderFloor(
  machines: FloorMachine[],
  W: number,
  H: number,
  T: Theme,
  opts: { selected?: string; tick?: number; spin?: string } = {},
): FloorFrame {
  const tick = opts.tick ?? 0
  const spin = opts.spin ?? SPINNER[tick % SPINNER.length]!
  const legend = H >= 14
  const view = legend ? H - 1 : H
  const compact = H < 26
  const layout = layoutFloor(machines, W, compact)

  // the floor sits on the bottom of the window (smoke rises into open sky);
  // when it outgrows the window, scroll so the selected street is in view
  let scroll = layout.height <= view ? layout.height - view : 0
  const sel = layout.buildings.find((b) => b.m.id === opts.selected)
  if (sel && layout.height > view) {
    const st = layout.streets[sel.street]!
    if (st.ground + 1 - scroll > view) scroll = st.ground + 1 - view
    if (st.top < scroll) scroll = st.top
    scroll = Math.max(0, Math.min(scroll, layout.height - view))
  }

  const c = new Canvas(W, H)
  // streets draw into the view only — never over the legend row
  const put = (x: number, y: number, s: string, fg: string, bg?: string) => {
    if (y - scroll < view) c.put(x, y - scroll, s, fg, bg)
  }

  for (const st of layout.streets) {
    // ground: a thin line the buildings stand on
    put(0, st.ground, "▔".repeat(W), T.muted)
    for (const b of st.buildings) drawBuilding(b, put, T, tick, spin, b.m.id === opts.selected)
  }

  if (legend) {
    const y = H - 1
    const items: Array<[string, string, string]> = [
      ["▣", T.soft, "session"],
      ["▶", T.ok, "agent"],
      ["✗", T.bad, "failed"],
      ["○", T.dim, "smoke ~ load"],
    ]
    let x = 1
    for (const [g, col, label] of items) {
      c.put(x, y, g, col)
      c.put(x + 2, y, label, T.muted)
      x += label.length + 5
    }
  }

  const hiddenAbove = layout.streets.filter((s) => s.ground + 1 <= scroll).reduce((n, s) => n + s.buildings.length, 0)
  const hiddenBelow = layout.streets.filter((s) => s.top >= scroll + view).reduce((n, s) => n + s.buildings.length, 0)
  if (hiddenAbove) {
    const t = ` ↑ ${hiddenAbove} more `
    put(W - t.length - 1, scroll, t, T.dim)
  }
  if (hiddenBelow) {
    const t = ` ↓ ${hiddenBelow} more `
    put(W - t.length - 1, scroll + view - 1, t, T.dim)
  }

  return { rows: c.rows(T.muted), layout, scroll, hiddenAbove, hiddenBelow }
}

type Put = (x: number, y: number, s: string, fg: string, bg?: string) => void

function drawBuilding(b: Building, put: Put, T: Theme, tick: number, spin: string, selected: boolean) {
  const { m, p, w, x } = b
  const dark = m.state === "down" || m.state === "auth" || m.state === "pending" || m.state === "unprobed"
  const ink = selected ? T.accent : dark ? T.muted : T.dim
  const frame = selected ? FRAME.heavy : m.state === "unprobed" ? FRAME.dashed : FRAME.light
  const inner = w - 2
  const ix = x + 1

  const frameBottom = b.bottom
  const bodyTop = frameBottom - b.body
  const frameTop = bodyTop - 1
  const roofTop = frameTop - b.roof
  const smokeTop = roofTop - b.smoke
  const cx = x + Math.max(2, Math.min(w - 4, Math.round(w * p.chimney)))
  const mid = x + Math.floor(w / 2)

  // ---- frame ----
  put(x, frameTop, frame.tl + frame.h.repeat(inner) + frame.tr, ink)
  for (let y = bodyTop; y < frameBottom; y++) {
    put(x, y, frame.v, ink)
    put(x + w - 1, y, frame.v, ink)
  }
  put(x, frameBottom, frame.bl + frame.h.repeat(inner) + frame.br, ink)

  // ---- roof ----
  const flagFg = selected ? T.highlight : dark ? T.muted : T.info
  switch (p.roof) {
    case "saw":
      put(x, roofTop, "◢◣".repeat(Math.ceil(w / 2)).slice(0, w), ink)
      put(x + 1, roofTop - 1, p.flag, flagFg)
      break
    case "flat":
      put(x + w - 5, roofTop, "▗▄▖", ink) // water tank
      put(x + 1, roofTop, p.flag, flagFg)
      break
    case "gable":
      put(x + 3, roofTop, "◢" + "▀".repeat(w - 8) + "◣", ink)
      put(x, roofTop + 1, "◢" + "▀".repeat(w - 2) + "◣", ink)
      put(mid, roofTop - 1, p.flag, flagFg)
      break
    case "penthouse":
      put(x + 3, roofTop, "╭" + "─".repeat(w - 8) + "╮", ink)
      put(x + 3, roofTop + 1, "│" + " ".repeat(w - 8) + "│", ink)
      put(x + 5, roofTop + 1, p.flag, flagFg)
      break
    case "spire":
      put(mid, roofTop, "▲", ink)
      put(mid - 1, roofTop + 1, "▟█▙", ink)
      put(mid, roofTop - 1, p.flag, flagFg)
      break
    case "tower": {
      // the local machine: a beacon that blinks — you are here
      const on = tick % 4 < 2
      put(mid, roofTop, on ? "✦" : "✧", selected ? T.highlight : on ? T.highlight : T.dim)
      put(mid, roofTop + 1, "┃", ink)
      put(mid + 2, roofTop + 1, "you", T.muted)
      break
    }
  }

  // ---- chimney + smoke ----
  const chimneyRow = roofTop - 1
  if (p.roof !== "tower") put(cx, chimneyRow, "▐▌", ink)
  const frac = m.load !== undefined && m.cores ? m.load / m.cores : undefined
  if (!dark && frac !== undefined) {
    const puffs = frac < 0.12 ? 1 : frac < 0.5 ? 2 : frac < 0.9 ? 3 : 4
    const cycle = frac < 0.12 ? 10 : 4
    const seed = hash32(m.id) % 7
    for (let k = 0; k < puffs; k++) {
      const age = (tick + seed + k * Math.ceil(cycle / puffs)) % cycle
      if (age >= 3) continue // the gap between puffs
      const rise = Math.min(age, b.smoke - 2)
      const y = chimneyRow - 1 - rise
      const drift = age >= 2 ? (mix32(seed, k + tick) % 2 ? 1 : 0) : 0
      const g = PUFFS[Math.min(age + (frac >= 0.5 ? 1 : 0), PUFFS.length - 1)]!
      const col = frac >= 1 ? T.bad : age === 0 ? T.muted : T.dim
      put(cx + 1 + drift, y, g, col)
    }
  }

  // ---- interior ----
  const mark = hostmark(m.id)
  const markFg =
    m.state === "up" ? T.ok : m.state === "warn" ? T.highlight : m.state === "down" ? T.bad : m.state === "auth" ? T.highlight : T.muted
  put(ix, bodyTop, mark[0]!, markFg)
  put(ix, bodyTop + 1, mark[1]!, markFg)
  const textW = inner - 6
  const name = fit(m.name, textW)
  if (selected) put(ix + 6, bodyTop, name, T.selFg, T.selBg)
  else put(ix + 6, bodyTop, name, dark ? T.dim : T.fg)
  const hw = hwLine(m)
  put(ix + 6, bodyTop + 1, fit(hw || (m.state === "unprobed" ? "unknown" : "—"), textW), dark ? T.muted : T.dim)

  const r2 = bodyTop + 2
  const r3 = bodyTop + 3
  if (m.state === "up" || m.state === "warn") {
    // pulse trace + reading
    const traceW = inner - 7
    const trace = m.pulse.length ? stripChart(m.pulse, traceW)[0]! : ""
    const traceFg = frac === undefined ? T.accent : frac >= 1 ? T.bad : frac >= 0.7 ? T.highlight : T.accent
    if (trace) put(ix + 1, r2, trace, traceFg)
    else put(ix + 1, r2, "⠤".repeat(traceW), T.muted)
    const reading = m.load !== undefined ? m.load.toFixed(2) : "—"
    put(ix + inner - 1 - reading.length, r2, reading, frac === undefined ? T.soft : frac >= 1 ? T.bad : frac >= 0.7 ? T.highlight : T.soft)

    // windows (sessions) on the left, workers (agents) on the right
    const maxWin = Math.floor((inner - 1) / 2)
    if (m.sessions.length) {
      const shown = m.sessions.slice(0, Math.min(maxWin, 5))
      shown.forEach((s, i) => put(ix + 1 + i * 2, r3, "▣", s.attached ? T.highlight : T.soft))
      if (m.sessions.length > shown.length) put(ix + 1 + shown.length * 2, r3, `+${m.sessions.length - shown.length}`, T.dim)
    } else {
      put(ix + 1, r3, "▢ ▢ ▢", T.muted)
    }
    // workers never crowd the windows: shrink the glyph run before the count
    const shownWin = Math.min(m.sessions.length, Math.min(maxWin, 5))
    const winW = m.sessions.length ? shownWin * 2 + (m.sessions.length > shownWin ? String(m.sessions.length - shownWin).length + 1 : 0) : 5
    let room = inner - 2 - winW - 1
    const fails = tally(m.failed, "✗", 3, room)
    room -= fails ? fails.length + 1 : 0
    const workers = tally(m.alive, "▶", 5, room)
    const right = ix + inner - 1
    if (fails) put(right - fails.length, r3, fails, T.bad)
    if (workers) put(right - fails.length - (fails ? 1 : 0) - workers.length, r3, workers, T.ok)
    if (!workers && !fails && room > 0) put(right - 1, r3, "·", T.muted)
  } else if (m.state === "down" || m.state === "auth") {
    const auth = m.state === "auth"
    put(ix + 1, r2, fit(`${auth ? "!" : "✗"} ${m.reason ?? (auth ? "ssh blocked" : "unreachable")}`, inner - 2), auth ? T.highlight : T.bad)
    put(ix + 1, r3, "▪ ▪ ▪", T.muted)
    if (auth) put(ix + inner - 2, r3, "⚿", T.highlight)
  } else if (m.state === "pending") {
    put(ix + 1, r2, `${spin} probing…`, T.dim)
    put(ix + 1, r3, "▢ ▢ ▢", T.muted)
  } else {
    put(ix + 1, r2, "not probed", T.muted)
    put(ix + 1, r3, "⇧R to probe", T.dim)
  }

  // ---- facade filler + door ----
  for (let y = bodyTop + 4; y < frameBottom; y++) {
    if (dark) continue
    const tex = p.facade === " " ? " " : p.facade
    put(ix + 1, y, tex.repeat(inner - 2), T.muted)
  }
  if (b.body > 4) {
    const doorY = frameBottom - 1
    if (m.state === "down") put(mid - 1, doorY, " ✗ ", T.bad)
    else if (m.state === "auth") put(mid - 1, doorY, " ⚿ ", T.highlight)
    else if (m.state === "pending") put(mid - 1, doorY, ` ${spin} `, T.dim)
    else put(mid - 1, doorY, " ▐▌", ink)
  }
}

/** `▶▶▶▶▶+19` — up to `max` glyphs then a count, squeezed into `room` cells */
function tally(n: number, glyph: string, max: number, room: number): string {
  if (n <= 0 || room <= 0) return ""
  if (n <= max && n <= room) return glyph.repeat(n)
  const rest = String(n)
  if (room < rest.length + 1) return ""
  const shown = Math.max(1, Math.min(max, room - (`+${n}`.length)))
  return shown >= n ? glyph.repeat(n) : glyph.repeat(shown) + `+${n - shown}`
}

// ---- navigation helpers ----------------------------------------------------------

/** the building in the next/previous street that best overlaps `from` horizontally */
export function neighborStreet(layout: FloorLayout, from: Building, dir: 1 | -1): Building | undefined {
  const st = layout.streets[from.street + dir]
  if (!st) return undefined
  const cx = from.x + from.w / 2
  let best: Building | undefined
  let bestD = Infinity
  for (const b of st.buildings) {
    const d = Math.abs(b.x + b.w / 2 - cx)
    if (d < bestD) {
      bestD = d
      best = b
    }
  }
  return best
}
