// The floor is a pure renderer: given machines + a window it must always
// produce a W×H frame, never overlap buildings, and draw the same building
// for the same machine every time.
import { expect, test } from "bun:test"
import { hwLine, layoutFloor, neighborStreet, persona, renderFloor, type FloorMachine } from "./floor"
import { FALL } from "./theme"

const up = (id: string, extra: Partial<FloorMachine> = {}): FloorMachine => ({
  id,
  name: id,
  state: "up",
  cores: 8,
  memGB: 16,
  load: 1,
  pulse: [0.1, 0.4, 0.2],
  sessions: [{ name: "main", attached: true }],
  alive: 2,
  failed: 0,
  ...extra,
})

const FLEET = [
  up("local", { local: true, name: "anvil", cores: 12 }),
  up("forge", { cores: 32, memGB: 128, gpu: "NVIDIA GeForce RTX 4090", state: "warn", failed: 2 }),
  up("loom", { cores: 4 }),
  { ...up("lathe"), state: "down" as const, reason: "timed out", load: undefined },
  { ...up("pi"), state: "auth" as const, reason: "host key" },
  { ...up("vault"), state: "pending" as const },
  { ...up("kite"), state: "unprobed" as const, cores: undefined, memGB: undefined },
  up("bastion", { cores: 2 }),
]

test("persona is deterministic and distinguishes hosts", () => {
  expect(persona("forge")).toEqual(persona("forge"))
  const roofs = new Set(["forge", "loom", "pi", "vault", "kite", "bastion", "lathe", "mercury"].map((id) => persona(id).roof))
  expect(roofs.size).toBeGreaterThan(2)
  expect(persona("anything", true).roof).toBe("tower")
})

test("hwLine keeps the gpu short", () => {
  expect(hwLine(up("x", { cores: 32, memGB: 128, gpu: "NVIDIA GeForce RTX 4090" }))).toBe("32c 128G RTX 4090")
  expect(hwLine(up("x", { gpu: "Apple M3 Pro" }))).toBe("8c 16G M3 Pro")
  expect(hwLine(up("x", { cores: undefined, memGB: undefined }))).toBe("")
})

for (const W of [60, 80, 120, 200]) {
  test(`layout at ${W} cols: inside the canvas, no overlaps, taller for more cores`, () => {
    const l = layoutFloor(FLEET, W)
    expect(l.buildings.length).toBe(FLEET.length)
    for (const b of l.buildings) {
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.w).toBeLessThanOrEqual(W)
    }
    for (const st of l.streets) {
      const sorted = [...st.buildings].sort((a, b) => a.x - b.x)
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.x).toBeGreaterThanOrEqual(sorted[i - 1]!.x + sorted[i - 1]!.w + 2)
      for (const b of st.buildings) expect(b.bottom).toBe(st.ground - 1)
    }
    const by = (id: string) => l.buildings.find((b) => b.m.id === id)!
    expect(by("forge").body).toBeGreaterThan(by("loom").body)
    expect(by("local").body).toBeGreaterThan(by("bastion").body)
  })
}

test("renderFloor always fills exactly W×H cells", () => {
  for (const [W, H] of [
    [40, 10],
    [80, 24],
    [120, 34],
    [200, 60],
  ] as const) {
    const f = renderFloor(FLEET, W, H, FALL, { selected: "forge", tick: 3 })
    expect(f.rows.length).toBe(H)
    for (const row of f.rows) expect(row.reduce((n, s) => n + [...s.text].length, 0)).toBe(W)
  }
})

test("the floor sits on the bottom when it fits, scrolls to the selection when it doesn't", () => {
  const roomy = renderFloor(FLEET, 200, 60, FALL, { selected: "local" })
  expect(roomy.scroll).toBeLessThan(0)
  expect(roomy.hiddenBelow).toBe(0)
  const tight = renderFloor(FLEET, 40, 20, FALL, { selected: "bastion" })
  expect(tight.scroll).toBeGreaterThan(0)
  expect(tight.hiddenAbove).toBeGreaterThan(0)
  const text = tight.rows.map((r) => r.map((s) => s.text).join("")).join("\n")
  expect(text).toContain("bastion")
})

test("state shows on the building", () => {
  const f = renderFloor(FLEET, 200, 60, FALL, {})
  const text = f.rows.map((r) => r.map((s) => s.text).join("")).join("\n")
  expect(text).toContain("✗ timed out")
  expect(text).toContain("! host key")
  expect(text).toContain("probing…")
  expect(text).toContain("⇧R to probe")
  expect(text).toContain("you")
  expect(text).toContain("▶▶") // workers
  expect(text).toContain("✗✗") // forge's two failed agents
})

test("neighborStreet finds the building below/above by column", () => {
  const l = layoutFloor(FLEET, 60)
  expect(l.streets.length).toBeGreaterThan(1)
  const first = l.streets[0]!.buildings[0]!
  const below = neighborStreet(l, first, 1)
  expect(below?.street).toBe(1)
  expect(neighborStreet(l, first, -1)).toBeUndefined()
})

test("workers never crowd the windows on a narrow building", () => {
  const m = up("kiln", { cores: 14, memGB: 24, alive: 7, sessions: [] })
  const f = renderFloor([m], 40, 20, FALL, {})
  const text = f.rows.map((r) => r.map((s) => s.text).join("")).join("\n")
  expect(text).toMatch(/▢ ▢ ▢\s+▶/)
})

test("a scrolled floor never draws over the legend row", () => {
  const many = Array.from({ length: 12 }, (_, i) => up(`host-${i}`))
  const f = renderFloor(many, 60, 30, FALL, { selected: "host-0" })
  expect(f.hiddenBelow).toBeGreaterThan(0)
  const last = f.rows[f.rows.length - 1]!.map((s) => s.text).join("")
  expect(last).toContain("▣ session")
  expect(last).not.toMatch(/[│┃└┘┗┛]/)
})

test("session overflow count survives a crowded row", () => {
  const m = up("loom", { cores: 12, alive: 24, sessions: Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, attached: false })) })
  const f = renderFloor([m], 40, 20, FALL, {})
  const text = f.rows.map((r) => r.map((s) => s.text).join("")).join("\n")
  expect(text).toContain("▣ ▣ ▣ ▣ ▣ +3")
})
