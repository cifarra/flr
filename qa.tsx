// Headless visual QA — renders flr with OpenTUI's test renderer and prints a
// character frame, no terminal takeover. Importing index.tsx is safe because
// it only boots the real renderer under import.meta.main.
//   bun qa.tsx [default|floor|jump|machine|procs|ports|themes|fail|remote|soak] [--live] [--size=WxH]
// Scenes run against the demo fleet (deterministic, no ssh); --live probes
// your real machines instead.
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { demoSource } from "./src/demo"
import { App } from "./src/index.tsx"

const args = process.argv.slice(2)
const scene = args.find((a) => !a.startsWith("--")) ?? "default"
const live = args.includes("--live")
const [width, height] = (args.find((a) => a.startsWith("--size="))?.slice(7) ?? "110x30").split("x").map(Number)
const { renderer, mockInput, renderOnce, flush, captureCharFrame } = await createTestRenderer({
  width: width ?? 110,
  height: height ?? 30,
})

createRoot(renderer).render(<App source={live ? undefined : demoSource()} />)
await renderOnce()
await Bun.sleep(300)
await flush()

// live probes take seconds; the demo fleet lands in under two
const settle = live ? 9000 : 2000
if (scene === "floor") await Bun.sleep(settle) // let probes + a few pulse samples land
if (scene === "jump") await mockInput.pressKeys(["c", "r"], 50) // type-ahead lands on crane
if (scene === "machine") await mockInput.pressKeys(["1"], 50)
if (scene === "procs") await mockInput.pressKeys(["3"], 50)
if (scene === "ports") await mockInput.pressKeys(["4"], 50)
if (scene === "themes") mockInput.pressKey("T", { shift: true })
if (scene === "fail") {
  await Bun.sleep(settle) // let probes land, including the failures
  await mockInput.pressKeys(["ARROW_DOWN"], 50)
}
if (scene === "remote") {
  await Bun.sleep(settle) // let probes land
  await mockInput.pressKeys(["ARROW_DOWN", "ARROW_DOWN"], 50)
  await Bun.sleep(11000) // let the live load sampler take a few readings
}
if (scene === "soak") await Bun.sleep(9000) // accrue a few pulse samples
await Bun.sleep(200)
await flush()
await renderOnce()

console.log(captureCharFrame())
process.exit(0)
