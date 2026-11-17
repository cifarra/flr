// The demo fleet is what the README screenshots show and what `bun run demo`
// serves, so it must stay obviously fictional and internally consistent.
import { expect, test } from "bun:test"
import { demoSource } from "./demo"

const src = demoSource()

test("demo addresses are documentation-only (RFC 5737, example.net, mDNS/lan)", () => {
  for (const h of src.hosts()) {
    const name = h.hostName ?? ""
    const ok = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(name) || /\.(example\.net|local|lan)$/.test(name)
    expect(ok, `${h.alias} → ${name}`).toBe(true)
  }
})

test("demo never acts on a real machine", () => {
  expect(src.demo).toBe(true)
})

test("every demo host probes: reachable ones with data, broken ones classified", async () => {
  const probes = await Promise.all(src.hosts().map(async (h) => [h.alias, await src.probeHost(h.alias)] as const))
  const by = Object.fromEntries(probes)
  expect(by.forge!.status).toBe("ok")
  expect(by.forge!.hw?.cores).toBe(32)
  expect(by.forge!.agents?.some((a) => a.failed)).toBe(true)
  expect(by.lathe).toMatchObject({ status: "fail", failKind: "net", reason: "timed out" })
  expect(by.rivet).toMatchObject({ status: "fail", failKind: "auth", reason: "host key mismatch" })
})

test("proxy jumps point at hosts in the fleet", () => {
  const aliases = new Set(src.hosts().map((h) => h.alias))
  for (const h of src.hosts()) if (h.proxyJump) expect(aliases.has(h.proxyJump)).toBe(true)
})

test("load readings stay finite and move", async () => {
  const a = await src.probeLoad("crane")
  const b = await src.probeLoad("crane")
  expect(Number.isFinite(a)).toBe(true)
  expect(a).not.toBe(b)
  expect(await src.probeLoad("lathe")).toBeUndefined()
})
