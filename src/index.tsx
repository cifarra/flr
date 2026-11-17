import { createCliRenderer, type SelectKeyBinding } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { execFileSync } from "node:child_process"
import { useEffect, useMemo, useRef, useState } from "react"
import { agentHideList } from "./config"
import { demoSource } from "./demo"
import { restartJob, runNow, toggleLoad, type ActionResult, type LaunchdJob } from "./launchd"
import { initCrashLog, log, LOG_PATH } from "./log"
import { liveSource, type Source } from "./source"
import {
  attachCommand,
  failProbe,
  fmtGB,
  killProcCommand,
  killSessionCommand,
  newSessionCommand,
  restartRemoteAgent,
  shellCommand,
  sshCommand,
  type HostHw,
  type HostProbe,
  type PortInfo,
  type ProcInfo,
  type SshHost,
  type TmuxSession,
} from "./ssh"
import { neighborStreet, renderFloor, type FloorLayout, type FloorMachine } from "./floor"
import { hostmark, meter, pulse, recordPulse, SPINNER, stripChart } from "./instruments"
import { allThemes, loadSavedThemeName, resolveTheme, saveThemeName, type Theme } from "./theme"

// Active theme — module-level mutable so glyph helpers and child components
// can read it without prop-drilling; refreshed at the top of each App render.
const T: Theme = { ...resolveTheme(loadSavedThemeName(), allThemes()) }

// "floor" (key 0) is the whole fleet plus the selected machine's details;
// the rest are sections of that machine
type Section = "floor" | "agents" | "tmux" | "procs" | "ports"
const SECTIONS: Section[] = ["floor", "agents", "tmux", "procs", "ports"]

// letters are for jumping between hosts, so the list widgets must not eat j/k
const SELECT_KEYS: SelectKeyBinding[] = [
  { name: "j", action: undefined as unknown as SelectKeyBinding["action"] },
  { name: "k", action: undefined as unknown as SelectKeyBinding["action"] },
]

// demo waveform for the theme preview's instrument rows
const DEMO_PULSE = Array.from({ length: 36 }, (_, i) => 0.15 + 0.75 * Math.abs(Math.sin(i / 5)))

// true while the terminal is handed to a child (ssh/tmux) — signal handlers
// must not tear flr down mid-handoff
let suspended = false

type ProbeState = HostProbe | "pending"

interface Machine {
  id: string // "local" or the ssh alias
  host?: SshHost
}

/** one row in the agents section — local jobs keep their rich struct for actions */
interface AgentRow {
  id: string
  running: boolean
  failed: boolean
  desc: string
  job?: LaunchdJob
}

/** a colored fragment of a description line */
type Frag = [text: string, color: string]

interface MachineStatus {
  light: string
  lightColor: string
  frags: Frag[]
}

/**
 * The annunciator for one machine: a colored light plus a short reason.
 * Green = up, amber = up-with-failures or ssh-is-blocking-us, red = down.
 * Agent counts respect the hide list so they match the agents pane.
 */
function machineStatus(probe: ProbeState | undefined, hideList: string[], spin = "⣷"): MachineStatus {
  if (probe === undefined) return { light: "·", lightColor: T.muted, frags: [["not probed · ⇧R to probe", T.dim]] }
  if (probe === "pending") return { light: spin, lightColor: T.highlight, frags: [["probing…", T.dim]] }
  if (probe.status === "fail") {
    const auth = probe.failKind === "auth"
    return {
      light: auth ? "!" : "✗",
      lightColor: auth ? T.highlight : T.bad,
      frags: [[probe.reason ?? "unreachable", auth ? T.highlight : T.bad]],
    }
  }
  const vis = (probe.agents ?? []).filter((a) => !hideList.some((h) => a.name.includes(h)))
  const alive = vis.filter((a) => a.running).length
  const failed = vis.filter((a) => a.failed).length
  const frags: Frag[] = [[`${probe.sessions.length} sesh · ${alive} alive`, T.dim]]
  if (failed) frags.push([` · ${failed} failed`, T.bad])
  return { light: "●", lightColor: failed ? T.highlight : T.ok, frags }
}

/** relative age of a probe — remote data is a snapshot, say how old it is */
function ago(ts: number | undefined, now: number): string {
  if (!ts) return ""
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return "just now"
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function agentGlyph(row: AgentRow): { glyph: string; color: string } {
  if (row.running) return { glyph: "▶", color: T.ok }
  if (row.failed) return { glyph: "✗", color: T.bad }
  return { glyph: "●", color: T.muted }
}

function Detail({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <text>
      <span fg={T.muted}>{label.padEnd(10)}</span>
      <span fg={color ?? T.fg}>{value}</span>
    </text>
  )
}

function HwDetails({ hw }: { hw: HostHw | undefined }) {
  if (!hw?.cpu) return null
  return (
    <>
      <Detail
        label="hw"
        value={`${hw.cpu}${hw.cores ? ` · ${hw.cores}c` : ""}${hw.memGB ? ` · ${fmtGB(hw.memGB)}` : ""}`}
        color={T.soft}
      />
      {hw.gpu && <Detail label="gpu" value={hw.gpu} color={T.info} />}
      {(hw.diskFreeGB || hw.os) && (
        <Detail
          label="sys"
          value={[hw.diskFreeGB ? `${fmtGB(hw.diskFreeGB)} free` : "", hw.os ?? ""].filter(Boolean).join(" · ")}
          color={T.dim}
        />
      )}
    </>
  )
}

/**
 * Load reading + strip chart — one instrument for local and remote machines.
 * The reading and trace shift color as load crosses 70% and 100% of cores.
 */
function PulseBlock({
  id,
  load,
  cores,
  live,
  width = 40,
}: {
  id: string
  load: number | undefined
  cores: number | undefined
  live?: boolean
  width?: number
}) {
  const frac = load !== undefined && cores ? load / cores : undefined
  const traceColor = frac === undefined ? T.accent : frac >= 1 ? T.bad : frac >= 0.7 ? T.highlight : T.accent
  const readColor = frac === undefined ? T.soft : frac >= 1 ? T.bad : frac >= 0.7 ? T.highlight : T.soft
  const warming = live && pulse(id).length < 3
  return (
    <>
      <text> </text>
      <text>
        <span fg={T.muted}>{"load".padEnd(10)}</span>
        <span fg={readColor}>{load !== undefined ? load.toFixed(2) : "—"}</span>
        {cores ? <span fg={T.muted}> / {cores} cores</span> : null}
        {warming ? <span fg={T.dim}>   ⣷ sampling every 5s…</span> : null}
      </text>
      {stripChart(pulse(id), width, 2).map((row, i) => (
        <text key={i}>
          <span>{"          "}</span>
          <span fg={traceColor}>{row}</span>
        </text>
      ))}
    </>
  )
}

function Pane({ title, focused, children }: { title: string; focused?: boolean; children?: any }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={T.muted}
      focusedBorderColor={T.accent}
      title={` ${title} `}
      flexGrow={1}
      flexDirection="column"
      padding={1}
      focused={focused}
    >
      {children}
    </box>
  )
}

/** a command line minus the ssh mux plumbing (`-o Key=value` pairs), for display */
function brief(cmd: string[]): string {
  return cmd.filter((a, i) => a !== "-o" && cmd[i - 1] !== "-o").join(" ")
}

export function App({ source, theme }: { source?: Source; theme?: string } = {}) {
  const renderer = useRenderer()
  const [status, setStatus] = useState<ActionResult | null>(null)
  // where the data comes from — fixed for the life of the app
  const src = useMemo(() => source ?? liveSource(), [])

  /** in demo mode an action only says what it would have done */
  const demoNoop = (what: string): boolean => {
    if (!src.demo) return false
    setStatus({ ok: true, message: `demo · ${what} — nothing touched` })
    return true
  }

  // themes
  const themes = useMemo(() => allThemes(), [])
  const [themeName, setThemeName] = useState(() => theme ?? loadSavedThemeName())
  const [themesOpen, setThemesOpen] = useState(false)
  Object.assign(T, resolveTheme(themeName, themes))
  const themeIdx = Math.max(0, themes.findIndex((t) => t.name === themeName))

  // machines: local + every ssh host
  const hosts = useMemo(() => src.hosts(), [])
  const machines: Machine[] = useMemo(() => [{ id: "local" }, ...hosts.map((h) => ({ id: h.alias, host: h }))], [hosts])
  const [machineIdx, setMachineIdx] = useState(0)
  const machine = machines[Math.min(machineIdx, machines.length - 1)]!
  const isLocal = machine.id === "local"

  // navigation: which section of the machine, and which pane has focus
  const [section, setSection] = useState<Section>("floor")
  const [focus, setFocus] = useState<"machines" | "section">("machines")

  // local machine data
  const [jobs, setJobs] = useState<LaunchdJob[]>(() => src.jobs())
  const [localSessions, setLocalSessions] = useState<TmuxSession[]>(() => src.localSessions())
  const [localHwState] = useState<HostHw>(() => src.localHw())
  const [localProcsState, setLocalProcsState] = useState(() => src.localProcs())
  const [localPortsState, setLocalPortsState] = useState<PortInfo[]>(() => src.localPorts())
  const [logOpen, setLogOpen] = useState(false)
  const [logText, setLogText] = useState("")

  // remote data
  const [probes, setProbes] = useState<Map<string, ProbeState>>(new Map())

  // selections within sections, anchored by identity — lists rebuild under
  // the cursor as data lands, and a raw index would retarget actions
  const [agentKey, setAgentKey] = useState<string | null>(null)
  const [sessKey, setSessKey] = useState<string | null>(null)
  const [pendingKill, setPendingKill] = useState<string | null>(null)
  // armed sudo retry after a plain remote restart bounced off missing privileges
  const [pendingSudo, setPendingSudo] = useState<{ key: string; cmd: string[] } | null>(null)

  // agent filtering: persistent hide list (config) + live "/" filter
  const hideList = useMemo(() => agentHideList(), [])
  const [showAllAgents, setShowAllAgents] = useState(false)
  const [agentFilter, setAgentFilter] = useState("")
  const [filterOpen, setFilterOpen] = useState(false)

  useEffect(() => {
    renderer.setTerminalTitle(src.demo ? "flr · factory floor (demo)" : "flr · factory floor")
  }, [])

  // wall clock + pulse sampling share one tick so the trace redraws steadily
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    src.sampleLocal()
    const t = setInterval(() => {
      src.sampleLocal()
      setNow(new Date())
    }, 2500)
    return () => clearInterval(t)
  }, [])
  const { city, machineName } = src
  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`

  // job refresh keeps the selection anchored by label
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  const refreshJobs = () => setJobs(src.jobs())

  useEffect(() => {
    const t = setInterval(() => refreshJobs(), 4000)
    return () => clearInterval(t)
  }, [])

  // probe sequencing: a result only lands if nothing newer superseded it
  const probeSeq = useRef(new Map<string, number>())
  const nextSeq = (alias: string) => {
    const n = (probeSeq.current.get(alias) ?? 0) + 1
    probeSeq.current.set(alias, n)
    return n
  }
  const isCurrent = (alias: string, n: number) => probeSeq.current.get(alias) === n

  /** silent: fast sessions-only refresh, keeps cached hw + agents
   *  quiet: full probe, but keep showing the old data until the result lands */
  const probeOne = (alias: string, opts: { silent?: boolean; quiet?: boolean } = {}) => {
    const seq = nextSeq(alias)
    if (opts.silent) {
      src
        .probeSessions(alias)
        .then((res) => {
          if (!isCurrent(alias, seq)) return
          log(`probe ${alias} (fast): ${res.status}${res.status === "ok" ? ` · ${res.sessions.length} sessions` : ""}`)
          setProbes((prev) => {
            const cur = prev.get(alias)
            if (res.status === "fail" && cur && cur !== "pending" && cur.status === "ok") return prev
            const merged =
              res.status === "ok" && cur && cur !== "pending"
                ? { ...res, hw: cur.hw, agents: cur.agents, procs: cur.procs, ports: cur.ports }
                : res
            return new Map(prev).set(alias, merged)
          })
        })
        .catch((e) => log(`probe ${alias} (fast) rejected: ${e?.message ?? e}`))
      return
    }
    if (!opts.quiet) setProbes((prev) => new Map(prev).set(alias, "pending"))
    src
      .probeHost(alias)
      .then((res) => {
        if (!isCurrent(alias, seq)) return
        log(`probe ${alias}: ${res.status}${res.status === "ok" ? ` · ${res.sessions.length} sessions · ${res.agents?.length ?? 0} agents` : ""}`)
        setProbes((prev) => {
          const cur = prev.get(alias)
          // a quiet refresh never downgrades good data to a transient failure
          if (opts.quiet && res.status === "fail" && cur && cur !== "pending" && cur.status === "ok") return prev
          return new Map(prev).set(alias, res)
        })
      })
      .catch((e) => {
        log(`probe ${alias} rejected: ${e?.message ?? e}`)
        if (!isCurrent(alias, seq)) return
        setProbes((prev) => new Map(prev).set(alias, failProbe(alias, String(e?.message ?? "probe failed"))))
      })
  }

  const probeAll = () => {
    setLocalSessions(src.localSessions())
    for (const h of hosts) probeOne(h.alias)
  }

  // the machines are the spine now — probe the whole floor once at startup
  useEffect(() => {
    if (hosts.length > 0) probeAll()
  }, [])

  const machineProbe = isLocal ? undefined : probes.get(machine.id)
  const probeData = machineProbe && machineProbe !== "pending" ? machineProbe : undefined

  // the floor pulse: sample load on EVERY reachable host on a steady cadence
  // (over the ssh mux, ~50ms a sample), so every machine row carries a live
  // trace — the whole floor is instrumented, not just the machine on screen
  const [liveLoads, setLiveLoads] = useState<Map<string, number>>(new Map())
  const reachable = !!probeData && probeData.status === "ok"
  const probesRef = useRef(probes)
  probesRef.current = probes
  const loadInflight = useRef(new Set<string>())
  useEffect(() => {
    const take = () => {
      if (suspended) return // don't race the terminal handoff
      for (const [alias, p] of probesRef.current) {
        if (p === "pending" || p.status !== "ok" || loadInflight.current.has(alias)) continue
        const cores = p.hw?.cores
        loadInflight.current.add(alias)
        src
          .probeLoad(alias)
          .then((load) => {
            if (load === undefined) return
            recordPulse(alias, load / (cores || 8))
            setLiveLoads((prev) => new Map(prev).set(alias, load))
          })
          .finally(() => loadInflight.current.delete(alias))
      }
    }
    const t = setInterval(take, 5000)
    return () => clearInterval(t)
  }, [])

  // fast tick only while probes are in flight, so the spinners actually spin
  const anyPending = [...probes.values()].some((p) => p === "pending")
  const [spin, setSpin] = useState(0)
  useEffect(() => {
    if (!anyPending) return
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 120)
    return () => clearInterval(t)
  }, [anyPending])
  const spinChar = SPINNER[spin % SPINNER.length]!

  // the floor animates (smoke, the beacon) on its own gentle tick, only while
  // it's on screen
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (section !== "floor") return
    const t = setInterval(() => setTick((n) => n + 1), 400)
    return () => clearInterval(t)
  }, [section])
  const floorLayout = useRef<FloorLayout | null>(null)

  /** hand the terminal to an interactive command, then come back */
  const shellOut = (cmd: string[]) => {
    if (demoNoop(`would run: ${brief(cmd)}`)) return
    log(`shellOut: ${cmd.join(" ")}`)
    suspended = true
    try {
      renderer.suspend()
      const res = Bun.spawnSync({ cmd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      renderer.resume()
      log(`shellOut done: exit ${res.exitCode}`)
      if (res.exitCode !== 0) setStatus({ ok: false, message: `${cmd[0]} exited ${res.exitCode} — see ${LOG_PATH}` })
    } catch (e: any) {
      log(`shellOut ERROR: ${e?.stack ?? e}`)
      try {
        renderer.resume()
      } catch {}
      setStatus({ ok: false, message: `failed: ${e.message}` })
    } finally {
      suspended = false
    }
    refreshJobs()
    setLocalSessions(src.localSessions())
  }

  /** run a local launchd action (skipped in demo mode) and show its result */
  const act = (what: string, run: () => ActionResult) => {
    if (demoNoop(what)) return
    const result = run()
    setStatus(result)
    refreshJobs()
  }

  // ---- agents section rows -------------------------------------------------

  const agentRows: AgentRow[] = useMemo(() => {
    let rows: AgentRow[]
    if (isLocal) {
      rows = jobs.map((j) => ({
        id: j.label,
        running: j.pid !== undefined,
        failed: !!j.lastExit,
        desc: j.pid !== undefined ? `pid ${j.pid} · ${j.schedule}` : j.loaded ? j.schedule : `not loaded · ${j.schedule}`,
        job: j,
      }))
    } else {
      rows = (probeData?.agents ?? []).map((a) => ({
        id: a.name,
        running: a.running,
        failed: a.failed,
        desc: `${a.kind} · ${a.detail}`,
      }))
    }
    if (!showAllAgents) rows = rows.filter((r) => !hideList.some((h) => r.id.includes(h)))
    if (agentFilter) {
      const q = agentFilter.toLowerCase()
      rows = rows.filter((r) => r.id.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q))
    }
    // failed first (they need eyes), then running, then the rest — alpha within
    return rows.sort(
      (a, b) =>
        Number(b.failed) - Number(a.failed) || Number(b.running) - Number(a.running) || a.id.localeCompare(b.id),
    )
  }, [isLocal, jobs, probeData, showAllAgents, agentFilter, hideList])

  const agentIdx = Math.max(0, agentRows.findIndex((r) => r.id === agentKey))
  const agentRow = agentRows[Math.min(agentIdx, Math.max(agentRows.length - 1, 0))]

  // ---- remote status, shared by the info pane and empty states -------------

  const remoteStatus = machineStatus(machineProbe, hideList, spinChar)
  const remoteAt = machineProbe && machineProbe !== "pending" ? machineProbe.at : undefined
  const remoteFail = probeData?.status === "fail" ? probeData : undefined
  const remoteHwLoad = Number(probeData?.hw?.load?.trim().split(/[\s,]+/)[0])
  const remoteLoad = liveLoads.get(machine.id) ?? (Number.isFinite(remoteHwLoad) ? remoteHwLoad : undefined)

  /** what an empty section pane should say for a remote machine, and why */
  const remoteEmpty = (whenOk: string): string => {
    if (machineProbe === "pending") return " probing…"
    if (remoteFail) {
      const what = remoteFail.failKind === "auth" ? "ssh is blocked" : "is unreachable"
      return ` ${machine.id} ${what} · ${remoteFail.reason} · esc then ⇧R to retry`
    }
    if (!probeData) return " not probed yet · esc then ⇧R to probe"
    return whenOk
  }

  // ---- tmux section rows ---------------------------------------------------

  type SessRow = { kind: "session"; session: TmuxSession } | { kind: "new" } | { kind: "shell" }
  const sessRows: SessRow[] = useMemo(() => {
    const sessions = isLocal ? localSessions : (probeData?.sessions ?? [])
    const rows: SessRow[] = sessions.map((session) => ({ kind: "session", session }))
    if (!isLocal) rows.push({ kind: "new" }, { kind: "shell" })
    return rows
  }, [isLocal, localSessions, probeData])
  const sessKeyOf = (r: SessRow) => (r.kind === "session" ? `s:${r.session.name}` : r.kind)
  const sessIdx = Math.max(0, sessRows.findIndex((r) => sessKeyOf(r) === sessKey))
  const sessRow = sessRows[Math.min(sessIdx, Math.max(sessRows.length - 1, 0))]

  // ---- procs section rows --------------------------------------------------

  const procRows = isLocal ? localProcsState : (probeData?.procs ?? [])
  const [procIdx, setProcIdx] = useState(0)

  // ---- ports section rows --------------------------------------------------

  const portRows = isLocal ? localPortsState : (probeData?.ports ?? [])
  const [portIdx, setPortIdx] = useState(0)

  // refresh local procs/ports when their section comes into view
  useEffect(() => {
    if (section === "procs" && isLocal) setLocalProcsState(src.localProcs())
    if (section === "ports" && isLocal) setLocalPortsState(src.localPorts())
  }, [section, machineIdx])

  const runSessRow = (row: SessRow) => {
    if (row.kind === "session") shellOut(attachCommand(row.session))
    else if (row.kind === "new") shellOut(newSessionCommand(machine.id))
    else shellOut(shellCommand(machine.id))
    if (!isLocal) probeOne(machine.id, { silent: true })
  }

  const killSession = (session: TmuxSession) => {
    const rowKey = `${session.host}:${session.name}`
    if (session.host !== "local") {
      nextSeq(session.host)
      setProbes((prev) => {
        const cur = prev.get(session.host)
        if (!cur || cur === "pending") return prev
        return new Map(prev).set(session.host, {
          ...cur,
          sessions: cur.sessions.filter((s) => s.name !== session.name),
        })
      })
    }
    if (session.host === "local" && src.demo) setLocalSessions((prev) => prev.filter((s) => s.name !== session.name))
    if (demoNoop(`killed ${rowKey}`)) return
    setStatus({ ok: true, message: `killed ${rowKey}` })
    Bun.spawn({ cmd: killSessionCommand(session), stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited.then(
      (code) => {
        log(`kill ${rowKey}: exit ${code}`)
        if (code !== 0) setStatus({ ok: false, message: `kill ${rowKey} failed (exit ${code})` })
        if (session.host === "local") setLocalSessions(src.localSessions())
        else probeOne(session.host, { silent: true })
      },
    )
  }

  const killProc = (p: ProcInfo, force: boolean) => {
    const host = machine.id
    const name = p.comm.split("/").pop() ?? p.comm
    const label = `${force ? "force kill" : "kill"} ${name} (pid ${p.pid}) on ${host}`
    if (demoNoop(`would ${label}`)) return
    setStatus({ ok: true, message: label })
    Bun.spawn({ cmd: killProcCommand(host, p.pid, force), stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited.then(
      (code) => {
        log(`${label}: exit ${code}`)
        if (code !== 0) setStatus({ ok: false, message: `${label} failed (exit ${code}) — not your process?` })
        // give TERM a moment to land before re-reading the tables
        setTimeout(() => {
          if (host === "local") {
            setLocalProcsState(src.localProcs())
            setLocalPortsState(src.localPorts())
          } else probeOne(host, { quiet: true })
        }, 600)
      },
    )
  }

  // ---- keyboard ------------------------------------------------------------

  const quit = () => {
    try {
      renderer.destroy()
    } catch {}
    process.exit(0)
  }

  const selectMachine = (next: number) => {
    if (next < 0 || next >= machines.length || next === machineIdx) return
    setMachineIdx(next)
    setPendingKill(null)
    setPendingSudo(null)
    setAgentFilter("")
  }

  // ---- type-ahead: letters always jump between hosts -----------------------
  // Typing "fo" lands on forge from anywhere; the same letter again cycles
  // through everything starting with it. The buffer fades after a moment.
  const [jump, setJump] = useState("")
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const jumpTo = (buf: string) => {
    if (jumpTimer.current) clearTimeout(jumpTimer.current)
    if (buf) jumpTimer.current = setTimeout(() => setJump(""), 1500)
    setJump(buf)
    if (!buf) return
    const names = machines.map((m) => (m.id === "local" ? ["local", machineName.toLowerCase()] : [m.id.toLowerCase()]))
    const idx = machines.map((_, i) => i)
    const prefix = (q: string) => idx.filter((i) => names[i]!.some((n) => n.startsWith(q)))
    const repeated = buf.length > 1 && /^(.)\1+$/.test(buf)
    if (repeated) {
      const ring = prefix(buf[0]!)
      if (ring.length) selectMachine(ring[(ring.indexOf(machineIdx) + 1) % ring.length]!)
      return
    }
    const hits = prefix(buf).length ? prefix(buf) : idx.filter((i) => names[i]!.some((n) => n.includes(buf)))
    if (hits.length && !hits.includes(machineIdx)) selectMachine(hits[0]!)
  }
  const jumpMatch = jump
    ? machines[machineIdx] && (machines[machineIdx]!.id.toLowerCase().includes(jump) || (isLocal && machineName.toLowerCase().includes(jump)))
      ? machine.id
      : null
    : null

  // ---- keyboard ------------------------------------------------------------
  // The contract: plain letters jump between hosts, arrows move, digits switch
  // tabs. Actions live on shifted letters (⇧R restart, ⇧X kill …) or symbols.

  const probeSelected = () => {
    if (!isLocal) {
      probeOne(machine.id)
      setStatus({ ok: true, message: `probing ${machine.id}` })
    } else {
      refreshJobs()
      setLocalSessions(src.localSessions())
      setLocalProcsState(src.localProcs())
      setLocalPortsState(src.localPorts())
      setStatus({ ok: true, message: "refreshed local" })
    }
  }
  const probeFloor = () => {
    probeAll()
    setLocalProcsState(src.localProcs())
    setLocalPortsState(src.localPorts())
    setStatus({ ok: true, message: "probing the whole floor" })
  }

  useKeyboard((key) => {
    // while typing a filter, only the closing keys are ours
    if (filterOpen) {
      if (key.name === "escape" || key.name === "return" || key.name === "linefeed") setFilterOpen(false)
      return
    }

    if ((key.ctrl && key.name === "c") || (key.name === "q" && key.shift)) quit()

    if (themesOpen) {
      if (key.name === "escape") {
        setThemeName(loadSavedThemeName())
        setThemesOpen(false)
      }
      return
    }
    if (key.name === "t" && key.shift && !logOpen) {
      setThemesOpen(true)
      return
    }

    if (logOpen) {
      if (key.name === "escape" || (key.name === "l" && key.shift)) setLogOpen(false)
      return
    }

    // ---- type-ahead ----
    const plain = !key.ctrl && !key.meta && !key.shift
    if (plain && /^[a-z]$/.test(key.name)) return jumpTo(jump + key.name)
    if (jump && (key.name === "-" || key.name === "_" || key.name === ".")) return jumpTo(jump + key.name)
    if (jump && key.name === "backspace") return jumpTo(jump.slice(0, -1))
    if (jump && key.name === "escape") return jumpTo("")
    if (jump && (key.name === "return" || key.name === "linefeed")) jumpTo("") // confirm, then enter acts as usual

    // ---- tabs: digits and tab, from anywhere ----
    if (key.name === "tab") {
      setSection(SECTIONS[(SECTIONS.indexOf(section) + 1) % SECTIONS.length]!)
      setPendingKill(null)
      setPendingSudo(null)
      return
    }
    const digit = SECTIONS[Number(key.name)]
    if (digit && /^[0-4]$/.test(key.name)) {
      setSection(digit)
      setPendingKill(null)
      setPendingSudo(null)
      return
    }

    // ---- machine-wide actions, from anywhere ----
    if (key.name === "o" && key.shift) {
      if (isLocal) shellOut([process.env.SHELL ?? "/bin/zsh", "-l"])
      else if (machine.host) shellOut(sshCommand(machine.host))
      return
    }
    if (key.name === "c" && key.shift && !isLocal) {
      const cmd = `ssh ${machine.id}`
      let copied = renderer.copyToClipboardOSC52(cmd)
      if (!copied) {
        try {
          if (process.platform === "darwin") execFileSync("pbcopy", { input: cmd })
          else execFileSync("xclip", ["-selection", "clipboard"], { input: cmd })
          copied = true
        } catch {}
      }
      setStatus(copied ? { ok: true, message: `copied "${cmd}"` } : { ok: false, message: "clipboard unavailable" })
      return
    }
    if (key.name === "p" && key.shift) return probeFloor()

    if (section === "floor") {
      // walk the street: ←→ along it, ↑↓ to the building nearest in the
      // street below/above; enter steps into the machine's agents
      const layout = floorLayout.current
      const here = layout?.buildings.find((b) => b.m.id === machine.id)
      if (key.name === "left") return selectMachine(machineIdx - 1)
      if (key.name === "right") return selectMachine(machineIdx + 1)
      if ((key.name === "down" || key.name === "up") && layout && here) {
        const to = neighborStreet(layout, here, key.name === "down" ? 1 : -1)
        if (to) selectMachine(machines.findIndex((m) => m.id === to.m.id))
        return
      }
      if (key.name === "return" || key.name === "linefeed") {
        setSection("agents")
        setFocus("section")
        return
      }
      if (key.name === "r" && key.shift) probeSelected()
      return
    }

    if (focus === "machines") {
      if (key.name === "escape") return setSection("floor")
      if (key.name === "up") return selectMachine(machineIdx - 1)
      if (key.name === "down") return selectMachine(machineIdx + 1)
      if (key.name === "return" || key.name === "linefeed" || key.name === "right") return setFocus("section")
      if (key.name === "r" && key.shift) probeSelected()
      return
    }

    // focus === "section"
    if (key.name === "escape" || key.name === "left") {
      setFocus("machines")
      setPendingKill(null)
      setPendingSudo(null)
      return
    }

    if (section === "agents") {
      if (key.name === "/") return setFilterOpen(true)
      if (key.name === "r" && key.shift) {
        if (isLocal) {
          const job = agentRow?.job
          if (job) act(`would restart ${job.label}`, () => restartJob(job))
          return
        }
        const agent = probeData?.agents?.find((a) => a.name === agentRow?.id)
        if (!agent) return
        if (pendingSudo?.key === agent.name) {
          // second ⇧R: the plain restart bounced — hand the terminal to sudo
          setPendingSudo(null)
          shellOut(pendingSudo.cmd)
          probeOne(machine.id, { quiet: true })
          return
        }
        const host = machine.id
        if (demoNoop(`would restart ${agent.name} on ${host}`)) return
        setStatus({ ok: true, message: `restarting ${agent.name} on ${host}…` })
        restartRemoteAgent(host, agent).then((res) => {
          if (res.ok) {
            setStatus(res)
            probeOne(host, { quiet: true })
          } else if (res.fallback) {
            setPendingSudo({ key: agent.name, cmd: res.fallback })
            setStatus({ ok: false, message: `${res.message} — ⇧R again to retry with sudo` })
          } else {
            setStatus(res)
          }
        })
        return
      }
      if (key.name === "a" && key.shift) return setShowAllAgents((v) => !v)
      const job = agentRow?.job
      if (isLocal && job && key.shift) {
        if (key.name === "u") act(`would ${job.loaded ? "unload" : "load"} ${job.label}`, () => toggleLoad(job))
        if (key.name === "l") {
          setLogText(src.readLog(job))
          setLogOpen(true)
        }
      }
      return
    }

    // kills are armed on the first press and fired on the second, so a stray
    // key never takes a process down
    const armKill = (rowKey: string, describe: string, fire: () => void) => {
      if (pendingKill === rowKey) {
        setPendingKill(null)
        fire()
      } else {
        setPendingKill(rowKey)
        setStatus({ ok: false, message: describe })
      }
    }

    if (section === "procs") {
      if (key.name === "r" && key.shift) {
        if (isLocal) setLocalProcsState(src.localProcs())
        else probeOne(machine.id, { quiet: true })
        setStatus({ ok: true, message: "refreshing procs" })
        return
      }
      const p = procRows[Math.min(procIdx, Math.max(procRows.length - 1, 0))]
      if ((key.name === "x" || key.name === "k") && key.shift && p) {
        const force = key.name === "k"
        const name = p.comm.split("/").pop()
        return armKill(
          `p:${machine.id}:${p.pid}${force ? ":9" : ""}`,
          `press ${force ? "⇧K" : "⇧X"} again to ${force ? "force kill" : "kill"} ${name} (pid ${p.pid})`,
          () => killProc(p, force),
        )
      }
      setPendingKill(null)
      return
    }

    if (section === "ports") {
      if (key.name === "r" && key.shift) {
        if (isLocal) setLocalPortsState(src.localPorts())
        else probeOne(machine.id, { quiet: true })
        setStatus({ ok: true, message: "refreshing ports" })
        return
      }
      const p = portRows[Math.min(portIdx, Math.max(portRows.length - 1, 0))]
      if ((key.name === "x" || key.name === "k") && key.shift && p) {
        if (p.pid === undefined) {
          setStatus({ ok: false, message: `:${p.port} — owner pid unknown (another user's process; needs root)` })
          return
        }
        const force = key.name === "k"
        const pid = p.pid
        return armKill(
          `port:${machine.id}:${p.port}:${pid}${force ? ":9" : ""}`,
          `press ${force ? "⇧K" : "⇧X"} again to ${force ? "force kill" : "kill"} ${p.comm} (pid ${pid}) holding :${p.port}`,
          () => killProc({ pid, comm: p.comm, cpu: 0, mem: 0 }, force),
        )
      }
      setPendingKill(null)
      return
    }

    if (section === "tmux" && sessRow) {
      if (key.name === "x" && key.shift) {
        if (sessRow.kind !== "session") return
        const rowKey = `${sessRow.session.host}:${sessRow.session.name}`
        return armKill(rowKey, `press ⇧X again to kill ${rowKey}`, () => killSession(sessRow.session))
      }
      setPendingKill(null)
    }
  })

  // ---- options -------------------------------------------------------------

  // machines list rows — custom-rendered so each machine gets its own colored
  // state light and per-fragment colors (a red "4 failed" inside a muted line)
  const localVisJobs = jobs.filter((j) => !hideList.some((h) => j.label.includes(h)))
  const localVisAlive = localVisJobs.filter((j) => j.pid !== undefined).length
  const localVisFailed = localVisJobs.filter((j) => !!j.lastExit).length
  const machineRows: Array<{ id: string } & MachineStatus> = machines.map((m) => {
    if (m.id === "local") {
      const frags: Frag[] = [[`${localSessions.length} sesh · ${localVisAlive} alive`, T.dim]]
      if (localVisFailed) frags.push([` · ${localVisFailed} failed`, T.bad])
      return { id: m.id, light: "●", lightColor: localVisFailed ? T.highlight : T.ok, frags }
    }
    return { id: m.id, ...machineStatus(probes.get(m.id), hideList, spinChar) }
  })
  // the floor: one snapshot per machine, in rail order
  const floorMachines: FloorMachine[] = machines.map((m) => {
    if (m.id === "local") {
      return {
        id: m.id,
        name: machineName,
        local: true,
        state: localVisFailed ? "warn" : "up",
        cores: src.cores,
        memGB: localHwState.memGB,
        gpu: localHwState.gpu,
        load: src.localLoad(),
        pulse: pulse("local"),
        sessions: localSessions.map((s) => ({ name: s.name, attached: s.attached })),
        alive: localVisAlive,
        failed: localVisFailed,
      }
    }
    const p = probes.get(m.id)
    const base = { id: m.id, name: m.id, pulse: pulse(m.id), sessions: [], alive: 0, failed: 0 }
    if (p === undefined) return { ...base, state: "unprobed" }
    if (p === "pending") return { ...base, state: "pending" }
    if (p.status === "fail") return { ...base, state: p.failKind === "auth" ? "auth" : "down", reason: p.reason, cores: p.hw?.cores, memGB: p.hw?.memGB, gpu: p.hw?.gpu }
    const vis = (p.agents ?? []).filter((a) => !hideList.some((h) => a.name.includes(h)))
    const failed = vis.filter((a) => a.failed).length
    const hwLoad = Number(p.hw?.load?.trim().split(/[\s,]+/)[0])
    return {
      ...base,
      state: failed ? "warn" : "up",
      cores: p.hw?.cores,
      memGB: p.hw?.memGB,
      gpu: p.hw?.gpu,
      load: liveLoads.get(m.id) ?? (Number.isFinite(hwLoad) ? hwLoad : undefined),
      sessions: p.sessions.map((s) => ({ name: s.name, attached: s.attached })),
      alive: vis.filter((a) => a.running).length,
      failed,
    }
  })
  const floorUp = floorMachines.filter((m) => m.state === "up" || m.state === "warn").length
  const floorDown = floorMachines.filter((m) => m.state === "down").length
  const floorBlocked = floorMachines.filter((m) => m.state === "auth").length
  const floorTitle = [
    `the floor · ${floorMachines.length} machine${floorMachines.length === 1 ? "" : "s"}`,
    `${floorUp} up`,
    floorDown ? `${floorDown} down` : "",
    floorBlocked ? `${floorBlocked} blocked` : "",
  ]
    .filter(Boolean)
    .join(" · ")

  // window the list around the selection when it outgrows the pane
  const visibleMachines = Math.max(3, Math.floor((renderer.terminalHeight - 8) / 2))
  const winStart =
    machineRows.length > visibleMachines
      ? Math.min(Math.max(0, machineIdx - Math.floor(visibleMachines / 2)), machineRows.length - visibleMachines)
      : 0
  const winRows = machineRows.slice(winStart, winStart + visibleMachines)
  const moreBelow = machineRows.length - winStart - winRows.length

  const agentOptions = useMemo(
    () =>
      agentRows.map((r) => ({
        name: `${agentGlyph(r).glyph} ${r.id}`,
        description: r.desc,
        value: r.id,
      })),
    [agentRows],
  )

  const sessOptions = useMemo(
    () =>
      sessRows.map((r) =>
        r.kind === "session"
          ? {
              name: r.session.name,
              description: `${r.session.windows} window${r.session.windows === 1 ? "" : "s"}${r.session.attached ? " · attached" : ""}`,
              value: `s:${r.session.name}`,
            }
          : r.kind === "new"
            ? { name: "+ new session", description: "tmux new", value: "new" }
            : { name: "$ plain shell", description: `ssh ${machine.id}`, value: "shell" },
      ),
    [sessRows, machine.id],
  )

  const themeOptions = useMemo(
    () => themes.map((t) => ({ name: t.name, description: t.description, value: t.name })),
    [themes],
  )

  const procOptions = useMemo(
    () =>
      procRows.map((p) => ({
        name: p.comm.split("/").pop() ?? p.comm,
        description: `${meter(p.cpu / 100, 8)} cpu ${p.cpu.toFixed(1)}% · mem ${p.mem.toFixed(1)}% · pid ${p.pid}`,
        value: String(p.pid),
      })),
    [procRows],
  )

  const portOptions = useMemo(
    () =>
      portRows.map((p) => ({
        name: `:${String(p.port).padEnd(5)} ${p.comm}`,
        description: `${p.pid !== undefined ? `pid ${p.pid}` : "pid ?"} · ${p.addr === "*" ? "* all interfaces" : p.addr}`,
        value: `${p.port}·${p.addr}`,
      })),
    [portRows],
  )

  const selectTheme = {
    keyBindings: SELECT_KEYS,
    textColor: T.fg,
    selectedBackgroundColor: T.selBg,
    selectedTextColor: T.selFg,
    descriptionColor: T.dim,
    selectedDescriptionColor: T.selFg,
  }

  const keybar: Array<[string, string]> = themesOpen
    ? [["enter", "save"], ["esc", "cancel"]]
    : section === "floor"
      ? [["a-z", "jump"], ["←→↑↓", "walk"], ["enter", "agents"], ["0-4", "tab"], ["⇧O", "shell"], ["⇧C", "copy"], ["⇧R", "probe"], ["⇧P", "probe all"]]
      : focus === "machines"
        ? [["a-z", "jump"], ["enter", "open"], ["esc", "floor"], ["0-4", "tab"], ["⇧O", "shell"], ["⇧C", "copy"], ["⇧R", "probe"], ["⇧P", "probe all"]]
        : section === "agents"
          ? isLocal
            ? [["enter", "run"], ["⇧R", "restart"], ["⇧U", "load/unload"], ["⇧L", "log"], ["/", "filter"], ["⇧A", "show all"], ["esc", "back"]]
            : [["⇧R", "restart"], ["/", "filter"], ["⇧A", "show all"], ["esc", "back"]]
          : section === "tmux"
            ? [["enter", "attach"], ["⇧X", "kill ×2"], ["esc", "back"]]
            : section === "procs"
              ? [["⇧X", "kill ×2"], ["⇧K", "kill -9 ×2"], ["⇧R", "refresh"], ["esc", "back"]]
              : [["⇧X", "kill owner ×2"], ["⇧K", "kill -9 ×2"], ["⇧R", "refresh"], ["esc", "back"]]

  const paneTitle = `${machine.id} · ${section}`

  // the selected machine's details — lives beside the street on the floor
  const panelW = Math.min(48, Math.max(34, Math.floor(renderer.terminalWidth * 0.3)))
  const chartW = panelW - 4 - 10
  const infoPanel = (
    <box border borderStyle="rounded" borderColor={T.muted} title={` ${machine.id} `} width={panelW} flexDirection="column" padding={1}>
      {isLocal ? (
        <>
          <text fg={T.highlight}>{machineName} (this machine)</text>
          <text> </text>
          <HwDetails hw={localHwState} />
          <Detail label="sessions" value={String(localSessions.length)} />
          <text>
            <span fg={T.muted}>{"agents".padEnd(10)}</span>
            <span fg="#FFFFFF">{localVisAlive} alive</span>
            <span fg={localVisFailed ? T.bad : T.muted}>{` · ${localVisFailed} failing`}</span>
            <span fg={T.muted}> · {jobs.length - localVisJobs.length} hidden (⇧A in agents)</span>
          </text>
          <PulseBlock id="local" load={src.localLoad()} cores={src.cores} width={chartW} />
        </>
      ) : machine.host ? (
        <>
          <text fg={T.highlight}>{machine.id}</text>
          <text> </text>
          <text>
            <span fg={T.muted}>{"state".padEnd(10)}</span>
            <span fg={remoteStatus.lightColor}>{remoteStatus.light} </span>
            {remoteStatus.frags.map(([txt, c], fi) => (
              <span key={fi} fg={c}>
                {txt}
              </span>
            ))}
            {remoteAt ? <span fg={T.muted}> · probed {ago(remoteAt, now.getTime())}</span> : null}
          </text>
          {remoteFail && (
            <>
              <Detail label="ssh said" value={remoteFail.error ?? "—"} color={T.muted} />
              <Detail label="hint" value={remoteFail.hint ?? `ssh ${machine.id}`} color={T.highlight} />
            </>
          )}
          <HwDetails hw={probeData?.hw} />
          {reachable && (
            <>
              <PulseBlock id={machine.id} load={remoteLoad} cores={probeData?.hw?.cores} live width={chartW} />
              <text> </text>
            </>
          )}
          <Detail label="hostname" value={machine.host.hostName ?? "—"} />
          <Detail label="user" value={machine.host.user ?? "(current user)"} />
          <Detail label="port" value={machine.host.port ?? "22"} color={T.muted} />
          {machine.host.proxyJump && <Detail label="proxy" value={machine.host.proxyJump} color={T.info} />}
          {probeData && probeData.sessions.length > 0 && (
            <>
              <text> </text>
              <text fg={T.muted}>tmux sessions:</text>
              {probeData.sessions.map((s) => (
                <text key={s.name} fg={T.soft}>
                  {"  "}{s.name} · {s.windows}w{s.attached ? " · attached" : ""}
                </text>
              ))}
            </>
          )}
        </>
      ) : null}
    </box>
  )


  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={T.bg}>
      <box height={2} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <ascii-font font="tiny" text="FLR" color={T.accent} />
          <box flexDirection="column" marginLeft={3}>
            <text>
              {SECTIONS.map((s, i) => (
                <span key={s}>
                  <span fg={section === s ? T.highlight : T.muted}>{i}</span>
                  <span fg={section === s ? T.selFg : T.dim} bg={section === s ? T.selBg : undefined}>
                    {` ${s} `}
                  </span>
                  <span> </span>
                </span>
              ))}
            </text>
            <text fg={T.muted}>the factory floor</text>
          </box>
        </box>
        <box flexDirection="column" alignItems="flex-end">
          <text>
            <span fg={src.localLoad() / src.cores >= 1 ? T.bad : src.localLoad() / src.cores >= 0.7 ? T.highlight : T.accent}>
              {stripChart(pulse("local"), 14)[0]}
            </span>
            <span fg={T.highlight}> {clock}</span>
          </text>
          <text>
            <span fg={T.soft}>{machineName}</span>
            <span fg={T.muted}> · {city}</span>
            {src.demo ? <span fg={T.highlight}> · demo</span> : null}
          </text>
        </box>
      </box>

      {themesOpen ? (
        <box flexDirection="row" flexGrow={1}>
          <box
            border
            borderStyle="rounded"
            borderColor={T.muted}
            focusedBorderColor={T.accent}
            title=" themes "
            width="38%"
            focused
          >
            <select
              focused
              options={themeOptions}
              selectedIndex={Math.min(themeIdx, Math.max(themes.length - 1, 0))}
              onChange={(i) => themes[i] && setThemeName(themes[i]!.name)}
              onSelect={(i) => {
                const t = themes[i]
                if (t) {
                  saveThemeName(t.name)
                  setThemesOpen(false)
                  setStatus({ ok: true, message: `theme saved: ${t.name}` })
                }
              }}
              showDescription
              {...selectTheme}
              flexGrow={1}
            />
          </box>
          <Pane title="preview">
            <text fg={T.highlight}>{themeName}</text>
            <text> </text>
            {(
              [
                ["bg", T.bg],
                ["fg", T.fg],
                ["dim", T.dim],
                ["muted", T.muted],
                ["accent", T.accent],
                ["selection", T.selBg],
                ["highlight", T.highlight],
                ["info", T.info],
                ["ok", T.ok],
                ["bad", T.bad],
                ["soft", T.soft],
              ] as const
            ).map(([label, c]) => (
              <text key={label}>
                <span fg={T.muted}>{label.padEnd(11)}</span>
                <span bg={c}>{"      "}</span>
                <span> </span>
                <span fg={label === "bg" ? T.dim : c}>{c}</span>
              </text>
            ))}
            <text> </text>
            <text>
              <span fg={T.muted}>{"pulse".padEnd(11)}</span>
              <span fg={T.accent}>{stripChart(DEMO_PULSE, 18)[0]}</span>
            </text>
            <text>
              <span fg={T.muted}>{"meter".padEnd(11)}</span>
              <span fg={T.ok}>{meter(0.62, 10)}</span>
              <span fg={T.muted}> 62%</span>
            </text>
            <text> </text>
            <text>
              <span bg={T.selBg} fg={T.selFg}> forge · train </span>
              <span fg={T.muted}>  ← selection preview</span>
            </text>
          </Pane>
        </box>
      ) : section === "floor" ? (
        <box flexDirection="row" flexGrow={1}>
          <box border borderStyle="rounded" borderColor={T.accent} title={` ${floorTitle} `} flexGrow={1} flexDirection="column">
            {(() => {
              const frame = renderFloor(
                floorMachines,
                Math.max(20, renderer.terminalWidth - panelW - 2),
                Math.max(6, renderer.terminalHeight - 6),
                T,
                { selected: machine.id, tick, spin: spinChar },
              )
              floorLayout.current = frame.layout
              return frame.rows.map((row, y) => (
                <text key={y} wrapMode="none">
                  {row.map((sp, i) => (
                    <span key={i} fg={sp.fg} bg={sp.bg}>
                      {sp.text}
                    </span>
                  ))}
                </text>
              ))
            })()}
          </box>
          {infoPanel}
        </box>
      ) : (
        <box flexDirection="row" flexGrow={1}>
          <box
            border
            borderStyle="rounded"
            borderColor={T.muted}
            focusedBorderColor={T.accent}
            title=" machines "
            width="34%"
            flexDirection="column"
            focused={focus === "machines"}
          >
            {winStart > 0 && <text fg={T.muted}>   ↑ {winStart} more</text>}
            {winRows.map((row, wi) => {
              const i = winStart + wi
              const sel = i === machineIdx
              const hist = pulse(row.id)
              const trace = hist.length ? stripChart(hist, 8)[0]! : null
              const lastFrac = hist.length ? hist[hist.length - 1]! : 0
              const traceColor = sel ? T.selFg : lastFrac >= 1 ? T.bad : lastFrac >= 0.7 ? T.highlight : T.accent
              return (
                <box
                  key={row.id}
                  flexDirection="column"
                  backgroundColor={sel ? T.selBg : undefined}
                  onMouseDown={() => selectMachine(i)}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text wrapMode="none">
                      <span fg={sel ? T.selFg : row.lightColor}> {row.light} </span>
                      <span fg={sel ? T.selFg : T.fg}>{row.id}</span>
                    </text>
                    {trace && (
                      <text wrapMode="none">
                        <span fg={traceColor}>{trace}</span>
                        <span> </span>
                      </text>
                    )}
                  </box>
                  <text wrapMode="none">
                    <span>   </span>
                    {row.frags.map(([txt, c], fi) => (
                      <span key={fi} fg={sel ? T.selFg : c}>
                        {txt}
                      </span>
                    ))}
                  </text>
                </box>
              )
            })}
            {moreBelow > 0 && <text fg={T.muted}>   ↓ {moreBelow} more</text>}
          </box>

          {logOpen ? (
            <box
              border
              borderStyle="rounded"
              borderColor={T.accent}
              title={` log · ${agentRow?.id ?? ""} `}
              flexGrow={1}
              focused
            >
              <scrollbox focused flexGrow={1}>
                <text fg={T.fg}>{logText}</text>
              </scrollbox>
            </box>
          ) : section === "agents" ? (
            <box
              border
              borderStyle="rounded"
              borderColor={T.muted}
              focusedBorderColor={T.accent}
              title={` ${paneTitle}${agentFilter ? ` · /${agentFilter}` : ""}${showAllAgents ? " · all" : ""} `}
              flexGrow={1}
              flexDirection="column"
              focused={focus === "section"}
            >
              {agentRows.length > 0 ? (
                <select
                  focused={focus === "section" && !filterOpen}
                  options={agentOptions}
                  selectedIndex={Math.min(agentIdx, Math.max(agentRows.length - 1, 0))}
                  onChange={(i) => agentRows[i] && setAgentKey(agentRows[i]!.id)}
                  onSelect={(i) => {
                    const row = agentRows[i]
                    const job = row?.job
                    if (isLocal && job) act(`would run ${job.label} now`, () => runNow(job))
                  }}
                  showDescription
                  {...selectTheme}
                  flexGrow={1}
                />
              ) : (
                <text fg={T.dim}>
                  {isLocal || reachable
                    ? agentFilter
                      ? ` nothing matches /${agentFilter} · / edits the filter`
                      : showAllAgents
                        ? " no agents at all"
                        : " none to show · ⇧A reveals hidden agents"
                    : remoteEmpty(" no agents found")}
                </text>
              )}
              {(filterOpen || agentFilter) && (
                <box height={1} flexDirection="row">
                  <text fg={T.highlight}> / </text>
                  <input
                    focused={filterOpen}
                    placeholder="filter agents…"
                    onInput={(v: string) => setAgentFilter(v)}
                    onSubmit={() => setFilterOpen(false)}
                    flexGrow={1}
                  />
                </box>
              )}
            </box>
          ) : section === "procs" ? (
            <box
              border
              borderStyle="rounded"
              borderColor={T.muted}
              focusedBorderColor={T.accent}
              title={` ${paneTitle} · top by cpu `}
              flexGrow={1}
              flexDirection="column"
              focused={focus === "section"}
            >
              {procRows.length > 0 ? (
                <select
                  focused={focus === "section"}
                  options={procOptions}
                  selectedIndex={Math.min(procIdx, Math.max(procRows.length - 1, 0))}
                  onChange={(i) => setProcIdx(i)}
                  showDescription
                  {...selectTheme}
                  flexGrow={1}
                />
              ) : (
                <text fg={T.dim}>{isLocal ? " no process data" : remoteEmpty(" no process data in the probe")}</text>
              )}
            </box>
          ) : section === "ports" ? (
            <box
              border
              borderStyle="rounded"
              borderColor={T.muted}
              focusedBorderColor={T.accent}
              title={` ${paneTitle} · listening tcp `}
              flexGrow={1}
              flexDirection="column"
              focused={focus === "section"}
            >
              {portRows.length > 0 ? (
                <select
                  focused={focus === "section"}
                  options={portOptions}
                  selectedIndex={Math.min(portIdx, Math.max(portRows.length - 1, 0))}
                  onChange={(i) => setPortIdx(i)}
                  showDescription
                  {...selectTheme}
                  flexGrow={1}
                />
              ) : (
                <text fg={T.dim}>{isLocal ? " nothing listening" : remoteEmpty(" nothing listening on tcp")}</text>
              )}
            </box>
          ) : (
            <box
              border
              borderStyle="rounded"
              borderColor={T.muted}
              focusedBorderColor={T.accent}
              title={` ${paneTitle} `}
              flexGrow={1}
              flexDirection="column"
              focused={focus === "section"}
            >
              {sessRows.length > 0 ? (
                <select
                  focused={focus === "section"}
                  options={sessOptions}
                  selectedIndex={Math.min(sessIdx, Math.max(sessRows.length - 1, 0))}
                  onChange={(i) => sessRows[i] && setSessKey(sessKeyOf(sessRows[i]!))}
                  onSelect={(i) => sessRows[i] && runSessRow(sessRows[i]!)}
                  showDescription
                  {...selectTheme}
                  flexGrow={1}
                />
              ) : (
                <text fg={T.dim}>
                  {isLocal ? " no tmux sessions running · start one from a shell (⇧O)" : remoteEmpty(" no sessions")}
                </text>
              )}
            </box>
          )}
        </box>
      )}

      <box height={2} flexDirection="column">
        <text>
          {jump ? (
            <>
              <span fg={T.highlight}> ▌⌕ </span>
              <span fg={T.fg}>{jump}</span>
              <span fg={T.highlight}>▏</span>
              <span fg={jumpMatch ? T.soft : T.bad}>{jumpMatch ? ` → ${jumpMatch}` : "  no such host"}</span>
              <span fg={T.muted}>{jumpMatch ? "  · same letter again cycles" : ""}</span>
            </>
          ) : status ? (
            <>
              <span fg={status.ok ? T.ok : T.bad}> ▌{status.ok ? "✓" : "✗"} </span>
              <span fg={status.ok ? T.soft : T.bad}>{status.message}</span>
            </>
          ) : (
            <span> </span>
          )}
        </text>
        <text>
          {keybar.map(([k, label]) => (
            <span key={k}>
              <b fg={T.highlight}> {k}</b>
              <span fg={T.dim}> {label} </span>
            </span>
          ))}
          <b fg={T.highlight}> ⇧T</b>
          <span fg={T.dim}> themes </span>
          <b fg={T.highlight}> ⇧Q</b>
          <span fg={T.dim}> quit</span>
        </text>
      </box>
    </box>
  )
}

// only boot when run directly — tests import App and bring their own renderer
if (import.meta.main) {
  initCrashLog()
  log("flr starting")
  const renderer = await createCliRenderer()

  // Last-resort terminal restore, runs on EVERY exit path (quit, crash, kill
  // signals): disable all mouse tracking + bracketed paste, leave the alt
  // screen, show the cursor.
  const RESTORE_TERMINAL = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1049l\x1b[?25h"
  process.on("exit", () => {
    try {
      process.stdout.write(RESTORE_TERMINAL)
    } catch {}
  })
  // opentui's own signal handler destroys the renderer but never exits the
  // process — without these, `kill -INT` leaves a headless zombie
  process.on("SIGTERM", () => process.exit(0))
  process.on("SIGHUP", () => process.exit(0))
  process.on("SIGINT", () => {
    if (!suspended) process.exit(0)
  })
  process.on("SIGQUIT", () => {
    if (!suspended) process.exit(0)
  })

  const demo = process.argv.includes("--demo") || !!process.env.FLR_DEMO
  if (demo) log("demo mode: a fictional fleet, nothing real is touched")
  createRoot(renderer).render(<App source={demo ? demoSource() : undefined} />)
}
