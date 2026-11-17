import { execFileSync } from "node:child_process"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface LaunchdJob {
  label: string
  plistPath?: string
  scope: "user" | "global" | "runtime"
  program?: string
  schedule: string
  flags: string[]
  logPath?: string
  errLogPath?: string
  loaded: boolean
  pid?: number
  lastExit?: number
  isApple: boolean
}

const UID = process.getuid!()
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function sh(cmd: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { ok: true, out, err: "" }
  } catch (e: any) {
    return { ok: false, out: e.stdout?.toString() ?? "", err: e.stderr?.toString().trim() || e.message }
  }
}

function readPlist(path: string): Record<string, any> | null {
  const res = sh("plutil", ["-convert", "json", "-o", "-", path])
  if (!res.ok) return null
  try {
    return JSON.parse(res.out)
  } catch {
    return null
  }
}

// discoverJobs runs every 4s; plists rarely change. Cache parses by mtime so
// the steady-state refresh only pays for `launchctl list`, not a plutil fork
// per file (which blocks the single-threaded render loop).
const plistCache = new Map<string, { mtimeMs: number; plist: Record<string, any> | null }>()

function readPlistCached(path: string): Record<string, any> | null {
  try {
    const mtimeMs = statSync(path).mtimeMs
    const hit = plistCache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return hit.plist
    const plist = readPlist(path)
    plistCache.set(path, { mtimeMs, plist })
    return plist
  } catch {
    return readPlist(path)
  }
}

function pad(n: number | undefined, fallback: string): string {
  return n === undefined ? fallback : String(n).padStart(2, "0")
}

function humanizeCalendar(entry: Record<string, number>): string {
  const time = `${pad(entry.Hour, "*")}:${pad(entry.Minute, "00")}`
  if (entry.Weekday !== undefined) return `${WEEKDAYS[entry.Weekday] ?? entry.Weekday} ${time} weekly`
  if (entry.Day !== undefined) return `day ${entry.Day} ${time} monthly`
  if (entry.Hour !== undefined) return `daily ${time}`
  if (entry.Minute !== undefined) return `hourly at :${pad(entry.Minute, "00")}`
  return "every minute"
}

function humanizeInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `every ${seconds / 86400}d`
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`
  if (seconds % 60 === 0) return `every ${seconds / 60}m`
  return `every ${seconds}s`
}

function describeSchedule(plist: Record<string, any>): { schedule: string; flags: string[] } {
  const flags: string[] = []
  let schedule = "on demand"

  const cal = plist.StartCalendarInterval
  if (cal) {
    const entries = Array.isArray(cal) ? cal : [cal]
    schedule = entries.map(humanizeCalendar).join(", ")
  } else if (plist.StartInterval) {
    schedule = humanizeInterval(plist.StartInterval)
  } else if (plist.WatchPaths?.length) {
    schedule = `on change: ${plist.WatchPaths.join(", ")}`
  } else if (plist.QueueDirectories?.length) {
    schedule = `on queue: ${plist.QueueDirectories.join(", ")}`
  }

  if (plist.RunAtLoad) flags.push("run-at-load")
  if (plist.KeepAlive) flags.push("keep-alive")
  if (plist.Disabled) flags.push("disabled")
  return { schedule, flags }
}

/** label -> { pid, lastExit } for everything loaded in this user's session */
function loadedState(): Map<string, { pid?: number; lastExit: number }> {
  const map = new Map<string, { pid?: number; lastExit: number }>()
  const res = sh("launchctl", ["list"])
  if (!res.ok) return map
  for (const line of res.out.split("\n").slice(1)) {
    const [pid, status, label] = line.split("\t")
    if (!label) continue
    map.set(label, {
      pid: pid === "-" ? undefined : Number(pid),
      lastExit: Number(status) || 0,
    })
  }
  return map
}

export function discoverJobs(includeApple: boolean): LaunchdJob[] {
  const state = loadedState()
  const jobs: LaunchdJob[] = []
  const seen = new Set<string>()

  const dirs: Array<[string, LaunchdJob["scope"]]> = [
    [join(homedir(), "Library/LaunchAgents"), "user"],
    ["/Library/LaunchAgents", "global"],
  ]

  for (const [dir, scope] of dirs) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".plist"))) {
      const plistPath = join(dir, file)
      const plist = readPlistCached(plistPath)
      const label = plist?.Label ?? file.replace(/\.plist$/, "")
      const { schedule, flags } = plist ? describeSchedule(plist) : { schedule: "unreadable plist", flags: [] }
      const runtime = state.get(label)
      seen.add(label)
      jobs.push({
        label,
        plistPath,
        scope,
        program: plist?.ProgramArguments?.join(" ") ?? plist?.Program,
        schedule,
        flags,
        logPath: plist?.StandardOutPath,
        errLogPath: plist?.StandardErrorPath,
        loaded: runtime !== undefined,
        pid: runtime?.pid,
        lastExit: runtime?.lastExit,
        isApple: label.startsWith("com.apple."),
      })
    }
  }

  if (includeApple) {
    for (const [label, runtime] of state) {
      if (seen.has(label)) continue
      jobs.push({
        label,
        scope: "runtime",
        schedule: "—",
        flags: [],
        loaded: true,
        pid: runtime.pid,
        lastExit: runtime.lastExit,
        isApple: label.startsWith("com.apple."),
      })
    }
  }

  return jobs
    .filter((j) => includeApple || !j.isApple)
    .sort((a, b) => Number(a.isApple) - Number(b.isApple) || a.label.localeCompare(b.label))
}

export interface ActionResult {
  ok: boolean
  message: string
}

export function runNow(job: LaunchdJob): ActionResult {
  if (!job.loaded) return { ok: false, message: `${job.label} is not loaded — press l to load it first` }
  const res = sh("launchctl", ["kickstart", `gui/${UID}/${job.label}`])
  return res.ok
    ? { ok: true, message: `kicked off ${job.label}` }
    : { ok: false, message: res.err || "kickstart failed" }
}

export function restartJob(job: LaunchdJob): ActionResult {
  if (!job.loaded) return { ok: false, message: `${job.label} is not loaded — press l to load it first` }
  // -k kills any running instance first, so this is start-or-restart
  const res = sh("launchctl", ["kickstart", "-k", `gui/${UID}/${job.label}`])
  return res.ok
    ? { ok: true, message: `restarted ${job.label}` }
    : { ok: false, message: res.err || "kickstart -k failed" }
}

export function toggleLoad(job: LaunchdJob): ActionResult {
  if (job.loaded && !job.plistPath) {
    // runtime-only job: bootout would be one-way — nothing on disk to reload from
    return { ok: false, message: `${job.label} has no plist file — unload it with launchctl if you're sure` }
  }
  if (job.loaded) {
    const res = sh("launchctl", ["bootout", `gui/${UID}/${job.label}`])
    return res.ok
      ? { ok: true, message: `unloaded ${job.label}` }
      : { ok: false, message: res.err || "bootout failed" }
  }
  if (!job.plistPath) return { ok: false, message: "no plist file for this job" }
  const res = sh("launchctl", ["bootstrap", `gui/${UID}`, job.plistPath])
  return res.ok
    ? { ok: true, message: `loaded ${job.label}` }
    : { ok: false, message: res.err || "bootstrap failed" }
}

/** Read at most the last `maxBytes` of a file — log files can be gigabytes. */
function tailFile(path: string, maxBytes = 64 * 1024): string {
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, "r")
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString("utf8")
  // drop the likely-partial first line when we started mid-file
  return start > 0 ? text.slice(text.indexOf("\n") + 1) : text
}

export function readLogTail(job: LaunchdJob, maxLines = 500): string {
  const paths = [...new Set([job.logPath, job.errLogPath].filter(Boolean))] as string[]
  if (paths.length === 0) return "This job has no StandardOutPath/StandardErrorPath configured."
  const chunks: string[] = []
  for (const p of paths) {
    if (!existsSync(p)) {
      chunks.push(`── ${p} (does not exist yet)`)
      continue
    }
    try {
      const lines = tailFile(p).split("\n")
      chunks.push(`── ${p}`, ...lines.slice(-maxLines))
    } catch (e: any) {
      chunks.push(`── ${p} (unreadable: ${e?.code ?? e?.message ?? "error"})`)
    }
  }
  return chunks.join("\n").trimEnd() || "(log is empty)"
}
