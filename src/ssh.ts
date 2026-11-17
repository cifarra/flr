import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"

export interface SshHost {
  alias: string
  hostName?: string
  user?: string
  port?: string
  proxyJump?: string
  identityFile?: string
}

export interface TmuxSession {
  host: string // ssh alias, or "local"
  name: string
  windows: number
  attached: boolean
}

export interface HostHw {
  os?: string
  cpu?: string
  cores?: number
  memGB?: number
  diskFreeGB?: number
  gpu?: string
  load?: string
}

export interface RemoteAgent {
  name: string
  kind: "systemd" | "launchd"
  running: boolean
  failed: boolean
  pid?: number
  detail: string
}

export interface ProcInfo {
  pid: number
  cpu: number
  mem: number
  comm: string
}

export interface PortInfo {
  port: number
  addr: string // normalized bind address: "*", "localhost", or the literal ip
  pid?: number // unknown when the socket belongs to another user (needs root)
  comm: string
}

export interface HostProbe {
  status: "ok" | "fail"
  sessions: TmuxSession[]
  /** raw ssh error, last line — shown in the info pane, never in the list */
  error?: string
  /** classified short reason for the list, e.g. "timed out" */
  reason?: string
  /** "net" = host unreachable; "auth" = host may be up but ssh is blocked */
  failKind?: "net" | "auth"
  /** actionable next step for the info pane */
  hint?: string
  /** when this result landed — remote data is a snapshot, show its age */
  at?: number
  hw?: HostHw
  agents?: RemoteAgent[]
  procs?: ProcInfo[]
  ports?: PortInfo[]
}

/**
 * Turn ssh's stderr into an operator-readable diagnosis. "net" failures mean
 * the host is likely down or unreachable; "auth" failures mean ssh answered
 * but refused us — the machine itself may be fine.
 */
export function classifySshError(raw: string, alias: string): { reason: string; failKind: "net" | "auth"; hint: string } {
  const s = raw.toLowerCase()
  if (s.includes("host key verification failed"))
    return { reason: "host key mismatch", failKind: "auth", hint: `ssh ${alias} to inspect & accept the new key` }
  if (s.includes("permission denied"))
    return { reason: "auth refused", failKind: "auth", hint: `ssh ${alias} to see which key it wants` }
  if (s.includes("could not resolve") || s.includes("name or service not known") || s.includes("nodename nor servname"))
    return { reason: "name not resolving", failKind: "net", hint: `check HostName for ${alias} in ~/.ssh/config` }
  if (s.includes("connection refused"))
    return { reason: "ssh refused", failKind: "net", hint: "host is up but sshd isn't listening" }
  if (s.includes("timed out") || s.includes("timeout"))
    return { reason: "timed out", failKind: "net", hint: "down, asleep, or off the network" }
  if (s.includes("no route to host"))
    return { reason: "no route", failKind: "net", hint: "network path is gone — vpn? different lan?" }
  if (s.includes("connection closed") || s.includes("connection reset") || s.includes("broken pipe"))
    return { reason: "connection dropped", failKind: "net", hint: `ssh ${alias} to see why it hangs up` }
  return { reason: "unreachable", failKind: "net", hint: `ssh ${alias} to investigate` }
}

const TMUX_FMT = "#{session_name}\t#{session_windows}\t#{session_attached}"
const OK_MARKER = "__FLR_OK__"
const TMUX_LIST = `tmux list-sessions -F '${TMUX_FMT}' 2>/dev/null`

// connection multiplexing: first connection opens a master that lingers 60s,
// so follow-up probes/attaches/kills skip the handshake (~50ms instead of ~1s+)
const MUX_OPTS = ["-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/flr-%C", "-o", "ControlPersist=60"]

// ssh's ConnectTimeout bounds the whole wait for the remote banner. Behind a
// ProxyJump chain that wait includes every hop's full handshake (~0.8s each),
// and a sleeping Mac (pmset sleep + womp) first has to wake on the incoming
// packet before sshd answers (measured: ~10s cold vs ~65ms warm, ~12.5s end
// to end through two hops). At 5s, a two-hop host that was napping read as
// "timed out" even though plain `ssh` (no timeout) got in fine.
const CONNECT_TIMEOUT_S = 20

// Hardware snapshot as KEY=VALUE lines. Deliberately a FLAT command list — no
// if/else — so it parses under sh, bash, zsh AND fish (fish rejects the whole
// command buffer on a POSIX-ism, which made fish-shell hosts read as down).
// Wrong-platform commands fail silently into 2>/dev/null.
const HW_SCRIPT = [
  `uname -sm | sed 's/^/OS=/'`,
  `sysctl -n machdep.cpu.brand_string 2>/dev/null | sed 's/^/CPU=/'`, // macOS
  `grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//;s/^/CPU=/'`, // Linux
  `sysctl -n hw.ncpu 2>/dev/null | sed 's/^/CORES=/'`,
  `nproc 2>/dev/null | sed 's/^/CORES=/'`,
  `sysctl -n hw.memsize 2>/dev/null | sed 's/^/MEMB=/'`,
  `awk '/MemTotal/{print "MEMKB="$2}' /proc/meminfo 2>/dev/null`,
  `sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | sed 's/^ */LOAD=/'`,
  `cut -d' ' -f1-3 /proc/loadavg 2>/dev/null | sed 's/^/LOAD=/'`,
  `df -k / 2>/dev/null | awk 'NR==2{print "DISKKB="$4}'`,
  `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1 | sed 's/^/GPU=/'`,
].join("; ")

// Remote agents: systemd services (Linux) or launchd jobs (macOS) — both
// attempted, the wrong-platform one fails silently. Flat commands, bounded.
const AGENTS_SCRIPT = [
  `echo __FLR_SYSTEMD__`,
  `systemctl list-units --type=service --state=running,failed --no-legend --plain 2>/dev/null | head -150`,
  `echo __FLR_LAUNCHD__`,
  `launchctl list 2>/dev/null | head -300`,
].join("; ")

function parseAgents(out: string): RemoteAgent[] {
  const agents: RemoteAgent[] = []
  const sysPart = out.split("__FLR_SYSTEMD__")[1]?.split("__FLR_LAUNCHD__")[0] ?? ""
  for (const line of sysPart.split("\n")) {
    const m = line.trim().match(/^(\S+)\.service\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/)
    if (!m) continue
    const [, name, , active, sub, desc] = m
    agents.push({
      name: name!,
      kind: "systemd",
      running: sub === "running",
      failed: active === "failed" || sub === "failed",
      detail: desc?.trim() || sub!,
    })
  }
  const ldPart = out.split("__FLR_LAUNCHD__")[1]?.split("__FLR_PS_GNU__")[0] ?? ""
  for (const line of ldPart.split("\n")) {
    const parts = line.split("\t")
    if (parts.length !== 3 || parts[2] === "Label" || !parts[2]) continue
    const pid = parts[0] === "-" ? undefined : Number(parts[0])
    const exit = Number(parts[1]) || 0
    agents.push({
      name: parts[2]!,
      kind: "launchd",
      running: pid !== undefined && !Number.isNaN(pid),
      failed: exit !== 0,
      pid,
      detail: pid !== undefined ? `pid ${pid}` : exit !== 0 ? `last exit ${exit}` : "loaded",
    })
  }
  return agents
}

// Top processes by CPU. GNU ps sorts with --sort, BSD/macOS ps with -r —
// emit both under distinct markers (the wrong variant errors silently on
// macOS; on Linux both succeed, so the parser prefers the GNU section).
const PS_FIELDS = "pid,pcpu,pmem,comm"
const PROCS_SCRIPT = [
  `echo __FLR_PS_GNU__`,
  `ps axo ${PS_FIELDS} --sort=-pcpu 2>/dev/null | head -21`,
  `echo __FLR_PS_BSD__`,
  `ps axo ${PS_FIELDS} -r 2>/dev/null | head -21`,
].join("; ")

export function parseProcs(out: string): ProcInfo[] {
  const gnu = out.split("__FLR_PS_GNU__")[1]?.split("__FLR_PS_BSD__")[0] ?? ""
  const bsd = out.split("__FLR_PS_BSD__")[1]?.split("__FLR_SS__")[0] ?? ""
  const parseLines = (part: string) =>
    part
      .split("\n")
      .map((l) => l.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]), comm: m[4]!.trim() }))
  const fromGnu = parseLines(gnu)
  return fromGnu.length > 0 ? fromGnu : parseLines(bsd)
}

// Listening TCP sockets. ss (Linux) and lsof (macOS) under distinct markers —
// the wrong-platform one fails silently, same trick as the ps probe. Without
// root, both only reveal owning pids for the connecting user's own processes.
const PORTS_SCRIPT = [
  `echo __FLR_SS__`,
  `ss -ltnp 2>/dev/null | head -100`,
  `echo __FLR_LSOF__`,
  `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -100`,
].join("; ")

function normAddr(a: string): string {
  const s = a.replace(/^\[|\]$/g, "")
  if (s === "0.0.0.0" || s === "::" || s === "*") return "*"
  if (s === "127.0.0.1" || s === "::1") return "localhost"
  return s
}

export function parsePorts(out: string): PortInfo[] {
  const ssPart = out.split("__FLR_SS__")[1]?.split("__FLR_LSOF__")[0] ?? ""
  const lsofPart = out.split("__FLR_LSOF__")[1] ?? ""
  const found: PortInfo[] = []
  for (const line of ssPart.split("\n")) {
    // LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=123,fd=3))
    const f = line.trim().split(/\s+/)
    if (f[0] !== "LISTEN" || f.length < 5) continue
    const local = f[3]!
    const i = local.lastIndexOf(":")
    const port = Number(local.slice(i + 1))
    if (i < 0 || !Number.isFinite(port)) continue
    const m = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
    found.push({ port, addr: normAddr(local.slice(0, i)), comm: m?.[1] ?? "?", pid: m ? Number(m[2]) : undefined })
  }
  if (found.length === 0) {
    for (const line of lsofPart.split("\n")) {
      // command may contain spaces ("Google Ch"), so anchor on the pid column
      const m = line.match(/^(\S.*?)\s+(\d+)\s+.*\s(\S+)\s+\(LISTEN\)/)
      if (!m) continue
      const name = m[3]!
      const i = name.lastIndexOf(":")
      const port = Number(name.slice(i + 1))
      if (i < 0 || !Number.isFinite(port)) continue
      // lsof escapes spaces in command names as \x20
      found.push({ port, addr: normAddr(name.slice(0, i)), comm: m[1]!.replace(/\\x20/g, " ").trim(), pid: Number(m[2]) })
    }
  }
  // collapse the v4/v6 twin rows of one listener into a single row
  const seen = new Map<string, PortInfo>()
  for (const p of found) seen.set(`${p.port}·${p.addr}·${p.pid ?? p.comm}`, p)
  return [...seen.values()].sort((a, b) => a.port - b.port || a.addr.localeCompare(b.addr))
}

/** Listening TCP sockets on THIS machine. */
export function localPorts(): PortInfo[] {
  try {
    const out = execFileSync("sh", ["-c", PORTS_SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return parsePorts(out)
  } catch {
    return []
  }
}

/** Top processes on THIS machine, by CPU. */
export function localProcs(): ProcInfo[] {
  try {
    const out = execFileSync("sh", ["-c", PROCS_SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return parseProcs(out)
  } catch {
    return []
  }
}

function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
}

function globToRegExp(pattern: string): RegExp {
  // escape regex specials EXCEPT * and ?, then translate the glob wildcards
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

function resolveInclude(pattern: string, baseDir: string): string[] {
  let p = expandTilde(pattern)
  if (!isAbsolute(p)) p = join(baseDir, p)
  const base = basename(p)
  if (!/[*?]/.test(base)) return existsSync(p) ? [p] : []
  const dir = dirname(p)
  // globs are only supported in the filename part
  if (/[*?]/.test(dir) || !existsSync(dir)) return []
  const re = globToRegExp(base)
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => join(dir, f))
}

/** ssh semantics: for each option the FIRST obtained value wins. */
function assignFirst(hosts: SshHost[], field: Exclude<keyof SshHost, "alias">, value: string) {
  for (const h of hosts) h[field] ??= value
}

export function parseSshConfig(
  path: string = join(homedir(), ".ssh", "config"),
  seen: Set<string> = new Set(),
): SshHost[] {
  if (!existsSync(path) || seen.has(path)) return []
  seen.add(path)
  const hosts: SshHost[] = []
  let current: SshHost[] = []

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    // ssh_config accepts both "Key value" and "Key=value"
    const m = line.match(/^(\S+?)(?:\s+|\s*=\s*)(.+)$/)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim()
    switch (key) {
      case "include":
        for (const inc of value.split(/\s+/).flatMap((p) => resolveInclude(p, dirname(path)))) {
          hosts.push(...parseSshConfig(inc, seen))
        }
        break
      case "host":
        current = value
          .split(/\s+/)
          .filter((alias) => !/[*?!]/.test(alias))
          .map((alias) => {
            const h: SshHost = { alias }
            hosts.push(h)
            return h
          })
        break
      case "match":
        current = []
        break
      case "hostname":
        assignFirst(current, "hostName", value)
        break
      case "user":
        assignFirst(current, "user", value)
        break
      case "port":
        assignFirst(current, "port", value)
        break
      case "proxyjump":
        assignFirst(current, "proxyJump", value)
        break
      case "identityfile":
        assignFirst(current, "identityFile", value)
        break
    }
  }

  // merge duplicate aliases (split-config pattern): first block wins per field
  const merged = new Map<string, SshHost>()
  for (const h of hosts) {
    const ex = merged.get(h.alias)
    if (!ex) merged.set(h.alias, h)
    else {
      ex.hostName ??= h.hostName
      ex.user ??= h.user
      ex.port ??= h.port
      ex.proxyJump ??= h.proxyJump
      ex.identityFile ??= h.identityFile
    }
  }
  return [...merged.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

function parseTmuxLines(out: string, host: string): TmuxSession[] {
  // strict: exactly 3 tab-separated fields with numeric counters, so stray
  // tab-containing output from remote rc files can't become phantom sessions
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length === 3 && p[0]!.length > 0 && /^\d+$/.test(p[1]!) && /^\d+$/.test(p[2]!))
    .map(([name, windows, attached]) => ({
      host,
      name: name!,
      windows: Number(windows),
      attached: Number(attached) > 0,
    }))
}

function grab(out: string, key: string): string | undefined {
  const m = out.match(new RegExp(`^${key}=(.+)$`, "m"))
  return m?.[1]?.trim() || undefined
}

function parseHw(out: string): HostHw {
  const memB = Number(grab(out, "MEMB"))
  const memKB = Number(grab(out, "MEMKB"))
  const diskKB = Number(grab(out, "DISKKB"))
  return {
    os: grab(out, "OS"),
    cpu: grab(out, "CPU"),
    cores: Number(grab(out, "CORES")) || undefined,
    memGB: memB ? Math.round(memB / 2 ** 30) : memKB ? Math.round(memKB / 2 ** 20) : undefined,
    diskFreeGB: diskKB ? Math.round(diskKB / 2 ** 20) : undefined,
    // nvidia-smi reports driver trouble on stdout ("NVIDIA-SMI has failed…")
    gpu: (() => {
      const g = grab(out, "GPU")
      return g && !/has failed|couldn't communicate|not found|error/i.test(g) ? g : undefined
    })(),
    load: grab(out, "LOAD"),
  }
}

export function fmtGB(gb: number): string {
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)}T` : `${gb}G`
}

/**
 * Run a command on a host and capture output. Never throws, never prompts.
 * workMs is how long the remote command itself may run once connected; the
 * hard kill lands after the connect budget plus that, so ssh's own (more
 * descriptive) timeout error always wins the race.
 */
async function sshCapture(
  alias: string,
  remoteCmd: string,
  workMs: number,
): Promise<{ ok: boolean; out: string; err: string }> {
  const timeoutMs = CONNECT_TIMEOUT_S * 1000 + workMs
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({
      cmd: ["ssh", ...MUX_OPTS, "-o", "BatchMode=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`, alias, remoteCmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (e: any) {
    return { ok: false, out: "", err: e?.message ?? "failed to spawn ssh" }
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ])
    await proc.exited
    return { ok: out.includes(OK_MARKER), out, err }
  } catch (e: any) {
    return { ok: false, out: "", err: e?.message ?? "ssh capture failed" }
  } finally {
    clearTimeout(timer)
  }
}

export function failProbe(alias: string, err: string): HostProbe {
  const error = err.trim().split("\n").pop() || "no answer within the timeout"
  return { status: "fail", sessions: [], error, ...classifySshError(error, alias), at: Date.now() }
}

/** Full probe: reachability + tmux sessions + hardware snapshot + agents. */
export async function probeHost(alias: string): Promise<HostProbe> {
  const r = await sshCapture(
    alias,
    `${TMUX_LIST}; echo ${OK_MARKER}; ${HW_SCRIPT}; ${AGENTS_SCRIPT}; ${PROCS_SCRIPT}; ${PORTS_SCRIPT}`,
    7000,
  )
  if (!r.ok) return failProbe(alias, r.err)
  return {
    status: "ok",
    at: Date.now(),
    sessions: parseTmuxLines(r.out.split(OK_MARKER)[0]!, alias),
    hw: parseHw(r.out),
    agents: parseAgents(r.out),
    procs: parseProcs(r.out),
    ports: parsePorts(r.out),
  }
}

/** Fast probe: sessions only, no hardware sweep — for post-attach/kill refreshes. */
export async function probeSessions(alias: string): Promise<HostProbe> {
  const r = await sshCapture(alias, `${TMUX_LIST}; echo ${OK_MARKER}`, 3000)
  if (!r.ok) return failProbe(alias, r.err)
  return { status: "ok", at: Date.now(), sessions: parseTmuxLines(r.out.split(OK_MARKER)[0]!, alias) }
}

// One load-average number, cheap enough to poll — rides the ssh mux, so after
// the first probe each sample is a ~50ms round trip, not a fresh handshake.
const LOAD_SCRIPT = [
  `cut -d' ' -f1 /proc/loadavg 2>/dev/null`,
  `sysctl -n vm.loadavg 2>/dev/null | tr -d '{}'`,
].join("; ")

/** Current 1-minute load average of a remote host, or undefined if unreachable. */
export async function probeLoad(alias: string): Promise<number | undefined> {
  const r = await sshCapture(alias, `${LOAD_SCRIPT}; echo ${OK_MARKER}`, 1000)
  if (!r.ok) return undefined
  const first = Number(r.out.split(OK_MARKER)[0]?.trim().split(/[\s,]+/)[0])
  return Number.isFinite(first) ? first : undefined
}

/** Hardware snapshot of THIS machine, via the same script the probe ships. */
export function localHw(): HostHw {
  try {
    const out = execFileSync("sh", ["-c", HW_SCRIPT], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return parseHw(out)
  } catch {
    return {}
  }
}

export function localTmuxSessions(): TmuxSession[] {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", TMUX_FMT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return parseTmuxLines(out, "local")
  } catch {
    return [] // tmux not installed or no server running
  }
}

export function shellCommand(alias: string): string[] {
  return ["ssh", ...MUX_OPTS, alias]
}

export function sshCommand(host: SshHost): string[] {
  return shellCommand(host.alias)
}

// Remote hosts often lack terminfo for niche terminals (xterm-ghostty etc.),
// which makes tmux exit immediately with "missing or unsuitable terminal".
// `env` (a real binary) sets it portably — VAR=x prefixes are a POSIX-ism
// that csh-family remote shells reject.
const REMOTE_TERM = ["env", "TERM=xterm-256color"]

/**
 * Remote commands go through ssh, which joins argv with spaces and hands the
 * result to the remote shell — so tmux targets must be shell-quoted or names
 * with spaces break. "=" forces exact session-name matching (no prefix magic).
 */
function remoteTarget(name: string): string {
  return `'=${name.replace(/'/g, `'\\''`)}'`
}

export function attachCommand(session: TmuxSession): string[] {
  if (session.host === "local") {
    // inside tmux, attach refuses to nest — switch the current client instead
    return process.env.TMUX
      ? ["tmux", "switch-client", "-t", `=${session.name}`]
      : ["tmux", "attach", "-t", `=${session.name}`]
  }
  return ["ssh", ...MUX_OPTS, "-t", session.host, ...REMOTE_TERM, "tmux", "attach", "-t", remoteTarget(session.name)]
}

export function newSessionCommand(alias: string): string[] {
  return ["ssh", ...MUX_OPTS, "-t", alias, ...REMOTE_TERM, "tmux", "new"]
}

export function killSessionCommand(session: TmuxSession): string[] {
  return session.host === "local"
    ? ["tmux", "kill-session", "-t", `=${session.name}`]
    : ["ssh", ...MUX_OPTS, session.host, "tmux", "kill-session", "-t", remoteTarget(session.name)]
}

/** kill a process by pid — local `kill`, remote over ssh. TERM by default, KILL when force. */
export function killProcCommand(host: string, pid: number, force: boolean): string[] {
  const sig = force ? "-KILL" : "-TERM"
  return host === "local" ? ["kill", sig, String(pid)] : ["ssh", ...MUX_OPTS, host, `kill ${sig} ${pid}`]
}

export interface RestartResult {
  ok: boolean
  message: string
  /** interactive retry (sudo over ssh -t) for when the plain attempt lacked privileges */
  fallback?: string[]
}

/**
 * Restart a remote agent without a tty: `systemctl restart` (Linux) or
 * `launchctl kickstart -k` in the user's gui domain (macOS). Root-owned units
 * fail here ("authentication required") — the returned fallback re-runs the
 * restart through `ssh -t … sudo` so the password prompt can reach the user.
 */
export async function restartRemoteAgent(alias: string, agent: RemoteAgent): Promise<RestartResult> {
  const q = `'${agent.name.replace(/'/g, `'\\''`)}'`
  const cmd =
    agent.kind === "systemd"
      ? `systemctl restart ${q} 2>&1 && echo ${OK_MARKER}`
      : `launchctl kickstart -k gui/$(id -u)/${q} 2>&1 && echo ${OK_MARKER}`
  const r = await sshCapture(alias, cmd, 15000)
  if (r.ok) return { ok: true, message: `restarted ${agent.name} on ${alias}` }
  const why = (r.out || r.err).trim().split("\n").pop() || "restart failed (timeout?)"
  const fallback =
    agent.kind === "systemd"
      ? ["ssh", ...MUX_OPTS, "-t", alias, "sudo", "systemctl", "restart", agent.name]
      : ["ssh", ...MUX_OPTS, "-t", alias, "sudo", "launchctl", "kickstart", "-k", `system/${agent.name}`]
  return { ok: false, message: why, fallback }
}
