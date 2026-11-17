// Demo mode — a fictional fleet, so flr can be tried (and screenshotted)
// without an ssh config or a single real machine: `bun run demo`.
//
// Everything here is made up. Addresses come from the documentation ranges
// (RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and example.net,
// so nothing in the demo can ever resolve to someone's actual host. Load
// traces are seeded and deterministic: the same demo draws the same floor.
import { hash32, mix32, recordPulse } from "./instruments"
import type { LaunchdJob } from "./launchd"
import type { Source } from "./source"
import {
  classifySshError,
  type HostHw,
  type HostProbe,
  type PortInfo,
  type ProcInfo,
  type RemoteAgent,
  type SshHost,
  type TmuxSession,
} from "./ssh"

interface DemoHost {
  host: SshHost
  hw?: HostHw
  /** typical load as a fraction of cores — the trace wanders around it */
  base: number
  /** [name, windows, attached] */
  sessions: Array<[string, number, boolean]>
  agents: RemoteAgent[]
  procs: ProcInfo[]
  ports: PortInfo[]
  /** raw ssh stderr — the host fails its probe with this */
  fail?: string
  /** how long a probe takes to land, ms */
  latency: number
}

// ---- helpers ------------------------------------------------------------------

const svc = (name: string, detail: string, state: "running" | "failed" | "exited" = "running"): RemoteAgent => ({
  name,
  kind: "systemd",
  running: state === "running",
  failed: state === "failed",
  detail: state === "failed" ? `${detail} · failed` : detail,
})

const ld = (name: string, pid?: number, exit = 0): RemoteAgent => ({
  name,
  kind: "launchd",
  running: pid !== undefined,
  failed: exit !== 0,
  pid,
  detail: pid !== undefined ? `pid ${pid}` : exit !== 0 ? `last exit ${exit}` : "loaded",
})

const p = (pid: number, cpu: number, mem: number, comm: string): ProcInfo => ({ pid, cpu, mem, comm })
const port = (n: number, addr: string, comm: string, pid?: number): PortInfo => ({ port: n, addr, comm, pid })

// the boring-but-real services every Linux box runs — they make the agents
// pane look like an actual machine rather than a curated list
const LINUX_BASE = [
  svc("ssh", "OpenBSD Secure Shell server"),
  svc("cron", "Regular background program processing daemon"),
  svc("systemd-journald", "Journal Service"),
  svc("systemd-logind", "User Login Management"),
  svc("systemd-resolved", "Network Name Resolution"),
  svc("dbus", "D-Bus System Message Bus"),
]

// ---- the fleet -------------------------------------------------------------------

const LOCAL = {
  name: "anvil",
  city: "Lisbon",
  hw: { os: "Darwin arm64", cpu: "Apple M3 Max", cores: 16, memGB: 64, diskFreeGB: 412 } satisfies HostHw,
  base: 0.34,
  sessions: [
    ["flr", 1, true],
    ["notes", 2, false],
    ["dotfiles", 1, false],
  ] as Array<[string, number, boolean]>,
  jobs: [
    job("homebrew.mxcl.postgresql@16", "on demand", { pid: 812, flags: ["run-at-load", "keep-alive"] }),
    job("homebrew.mxcl.redis", "on demand", { pid: 815, flags: ["run-at-load", "keep-alive"] }),
    job("org.syncthing.syncthing", "on demand", { pid: 1022, flags: ["run-at-load", "keep-alive"] }),
    job("com.example.backup-photos", "daily 03:30", { lastExit: 1, log: "backup-photos" }),
    job("com.example.rss-digest", "daily 07:15", { log: "rss-digest" }),
    job("com.example.dotfiles-sync", "every 30m"),
    job("com.example.screenshot-tidy", "on change: ~/Desktop"),
    job("com.example.weekly-report", "Mon 09:00 weekly"),
    job("com.apple.Finder", "—", { pid: 655, scope: "runtime" }),
    job("com.apple.Spotlight", "—", { pid: 640, scope: "runtime" }),
    job("com.apple.WindowManager", "—", { pid: 701, scope: "runtime" }),
    job("com.apple.cloudd", "—", { pid: 590, scope: "runtime" }),
  ],
  procs: [
    p(4410, 96.3, 1.2, "/opt/homebrew/bin/ffmpeg"),
    p(388, 21.4, 0.9, "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"),
    p(2933, 14.8, 3.1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"),
    p(5120, 9.2, 2.4, "Code Helper (Renderer)"),
    p(6001, 4.1, 0.6, "bun"),
    p(812, 2.7, 0.8, "/opt/homebrew/opt/postgresql@16/bin/postgres"),
    p(1022, 1.9, 0.4, "/opt/homebrew/bin/syncthing"),
    p(0, 1.6, 0.1, "kernel_task"),
    p(815, 0.8, 0.1, "/opt/homebrew/opt/redis/bin/redis-server"),
    p(655, 0.4, 0.3, "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"),
  ],
  ports: [
    port(3000, "*", "bun", 6001),
    port(5000, "*", "ControlCenter", 702),
    port(5432, "localhost", "postgres", 812),
    port(6379, "localhost", "redis-server", 815),
    port(7000, "*", "ControlCenter", 702),
    port(8384, "localhost", "syncthing", 1022),
    port(22000, "*", "syncthing", 1022),
  ],
}

const FLEET: DemoHost[] = [
  {
    host: { alias: "forge", hostName: "192.0.2.10", user: "ops" },
    hw: {
      os: "Linux x86_64",
      cpu: "AMD Ryzen 9 7950X 16-Core Processor",
      cores: 32,
      memGB: 128,
      diskFreeGB: 1310,
      gpu: "NVIDIA GeForce RTX 4090, 24564 MiB",
    },
    base: 0.62,
    sessions: [
      ["train", 3, true],
      ["jupyter", 1, false],
      ["logs", 2, false],
    ],
    agents: [
      svc("ollama", "Ollama Service"),
      svc("jupyter-lab", "JupyterLab"),
      svc("tensorboard", "TensorBoard"),
      svc("train-sweep@14", "sweep worker 14", "failed"),
      svc("nightly-eval", "nightly eval suite", "failed"),
      svc("docker", "Docker Application Container Engine"),
      svc("containerd", "containerd container runtime"),
      svc("nvidia-persistenced", "NVIDIA Persistence Daemon"),
      svc("prometheus-node-exporter", "Prometheus exporter for machine metrics"),
      ...LINUX_BASE,
    ],
    procs: [
      p(30144, 312.4, 18.2, "python3"),
      p(2210, 88.1, 6.4, "ollama"),
      p(30160, 41.7, 2.2, "pt_data_worker"),
      p(30161, 39.9, 2.2, "pt_data_worker"),
      p(1877, 12.3, 1.1, "jupyter-lab"),
      p(1903, 6.2, 0.9, "tensorboard"),
      p(911, 2.8, 0.4, "dockerd"),
      p(1504, 1.1, 0.1, "nvidia-persistenced"),
      p(844, 0.6, 0.2, "containerd"),
      p(377, 0.3, 0.1, "systemd-journal"),
      p(1220, 0.2, 0.0, "sshd"),
    ],
    ports: [
      port(22, "*", "sshd"),
      port(6006, "*", "tensorboard", 1903),
      port(8888, "localhost", "jupyter-lab", 1877),
      port(9100, "*", "node_exporter"),
      port(11434, "localhost", "ollama"),
    ],
    latency: 420,
  },
  {
    host: { alias: "crane", hostName: "198.51.100.7", user: "ml", proxyJump: "bastion" },
    hw: {
      os: "Linux x86_64",
      cpu: "AMD EPYC 7763 64-Core Processor",
      cores: 64,
      memGB: 512,
      diskFreeGB: 6820,
      gpu: "NVIDIA A100-SXM4-80GB, 81920 MiB",
    },
    base: 0.97,
    sessions: [
      ["sweep-a", 4, true],
      ["sweep-b", 4, false],
      ["eval", 1, false],
      ["scratch", 1, false],
    ],
    agents: [
      svc("vllm", "vLLM OpenAI-compatible server"),
      svc("dcgm-exporter", "NVIDIA DCGM exporter"),
      svc("nvidia-fabricmanager", "NVIDIA fabric manager service"),
      svc("slurmd", "Slurm node daemon"),
      svc("munge", "MUNGE authentication service"),
      ...LINUX_BASE,
    ],
    procs: [
      p(81220, 2410.5, 31.0, "python3"),
      p(81345, 1980.2, 28.7, "python3"),
      p(7741, 288.0, 9.8, "vllm"),
      p(81399, 96.4, 1.4, "pt_data_worker"),
      p(2017, 3.2, 0.2, "dcgm-exporter"),
      p(1666, 1.0, 0.1, "slurmd"),
      p(1220, 0.4, 0.0, "sshd"),
    ],
    ports: [
      port(22, "*", "sshd"),
      port(6818, "*", "slurmd"),
      port(8000, "*", "vllm"),
      port(9400, "*", "dcgm-exporter"),
    ],
    latency: 900,
  },
  {
    host: { alias: "loom", hostName: "loom.example.net", user: "ci" },
    hw: { os: "Linux x86_64", cpu: "Intel(R) Xeon(R) E-2388G CPU @ 3.20GHz", cores: 16, memGB: 64, diskFreeGB: 742 },
    base: 0.41,
    sessions: [
      ["ci", 2, false],
      ["deploy", 1, true],
    ],
    agents: [
      svc("gitea", "Gitea (Git with a cup of tea)"),
      svc("act_runner", "Gitea Actions runner"),
      svc("postgresql@16-main", "PostgreSQL Cluster 16-main"),
      svc("redis-server", "Advanced key-value store"),
      svc("caddy", "Caddy"),
      svc("minio", "MinIO object storage"),
      svc("docker", "Docker Application Container Engine"),
      svc("containerd", "containerd container runtime"),
      ...LINUX_BASE,
    ],
    procs: [
      p(9120, 188.3, 4.2, "cc1plus"),
      p(9121, 97.5, 2.1, "cc1plus"),
      p(2201, 22.6, 3.3, "act_runner"),
      p(1410, 8.9, 5.6, "gitea"),
      p(1388, 4.4, 7.9, "postgres"),
      p(1501, 1.8, 2.0, "minio"),
      p(1366, 0.9, 0.3, "caddy"),
      p(1377, 0.5, 0.4, "redis-server"),
    ],
    ports: [
      port(22, "*", "sshd"),
      port(80, "*", "caddy"),
      port(443, "*", "caddy"),
      port(2019, "localhost", "caddy"),
      port(3000, "localhost", "gitea", 1410),
      port(5432, "localhost", "postgres"),
      port(6379, "localhost", "redis-server"),
      port(9000, "*", "minio", 1501),
      port(9001, "*", "minio", 1501),
    ],
    latency: 300,
  },
  {
    host: { alias: "kiln", hostName: "kiln.local", user: "studio" },
    hw: { os: "Darwin arm64", cpu: "Apple M2 Pro", cores: 12, memGB: 32, diskFreeGB: 288 },
    base: 0.14,
    sessions: [],
    agents: [
      ld("homebrew.mxcl.nginx", 431),
      ld("com.example.render-queue", 902),
      ld("com.example.photo-import"),
      ld("org.syncthing.syncthing", 512),
      ld("com.apple.Finder", 655),
      ld("com.apple.Spotlight", 640),
    ],
    procs: [
      p(902, 38.2, 4.4, "blender"),
      p(388, 6.1, 0.8, "WindowServer"),
      p(512, 1.2, 0.5, "syncthing"),
      p(431, 0.3, 0.1, "nginx"),
    ],
    ports: [port(80, "*", "nginx", 431), port(8384, "localhost", "syncthing", 512), port(22000, "*", "syncthing", 512)],
    latency: 650,
  },
  {
    host: { alias: "bastion", hostName: "203.0.113.4", user: "ops", port: "2222" },
    hw: { os: "Linux x86_64", cpu: "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz", cores: 2, memGB: 4, diskFreeGB: 18 },
    base: 0.06,
    sessions: [],
    agents: [svc("wg-quick@wg0", "WireGuard via wg-quick(8) for wg0"), svc("fail2ban", "Fail2Ban Service"), ...LINUX_BASE],
    procs: [p(1220, 0.6, 0.3, "sshd"), p(880, 0.4, 1.9, "fail2ban-server")],
    ports: [port(2222, "*", "sshd")],
    latency: 260,
  },
  {
    host: { alias: "lathe", hostName: "192.0.2.44", user: "ops" },
    base: 0,
    sessions: [],
    agents: [],
    procs: [],
    ports: [],
    fail: "ssh: connect to host 192.0.2.44 port 22: Operation timed out",
    latency: 1600,
  },
  {
    host: { alias: "rivet", hostName: "rivet.example.net", user: "ops" },
    base: 0,
    sessions: [],
    agents: [],
    procs: [],
    ports: [],
    fail: "Host key verification failed.",
    latency: 380,
  },
]

function job(
  label: string,
  schedule: string,
  o: { pid?: number; lastExit?: number; flags?: string[]; log?: string; scope?: LaunchdJob["scope"] } = {},
): LaunchdJob {
  return {
    label,
    scope: o.scope ?? "user",
    schedule,
    flags: o.flags ?? [],
    logPath: o.log ? `~/Library/Logs/${o.log}.log` : undefined,
    loaded: true,
    pid: o.pid,
    lastExit: o.lastExit ?? 0,
    isApple: label.startsWith("com.apple."),
  }
}

const LOGS: Record<string, string> = {
  "com.example.backup-photos": [
    "03:30:00 backup-photos: starting incremental run",
    "03:30:02 scanning ~/Pictures (48,211 files)",
    "03:31:47 1,204 new · 12 changed · 0 removed",
    "03:31:48 uploading to s3://example-backups/photos …",
    "03:44:09 error: upload stalled for 120s (connection reset by peer)",
    "03:44:09 retry 1/3 …",
    "03:46:11 error: upload stalled for 120s (connection reset by peer)",
    "03:46:11 giving up after 3 attempts — exit 1",
  ].join("\n"),
  "com.example.rss-digest": [
    "07:15:00 rss-digest: 41 feeds",
    "07:15:06 112 new items · 9 kept after filters",
    "07:15:07 wrote ~/Notes/digest/today.md",
  ].join("\n"),
}

// ---- deterministic load traces ---------------------------------------------------

/** one load sample (fraction of cores) for host `id` at step `i` */
function wave(id: string, base: number, i: number): number {
  const h = hash32(id)
  const phase = (h % 628) / 100
  const noise = (mix32(h, i) / 0xffffffff - 0.5) * 0.08
  const spike = mix32(h, i >> 3) % 23 === 0 ? 0.18 : 0
  return Math.max(0.01, base * (1 + 0.28 * Math.sin(i / 9 + phase) + 0.12 * Math.sin(i / 3.3 + phase * 2)) + noise + spike)
}

// ---- the source ------------------------------------------------------------------

export function demoSource(): Source {
  const steps = new Map<string, number>()
  const loads = new Map<string, number>()
  /** advance a host's trace one step and remember the reading. Remote samples
   *  are recorded by App's load sampler, exactly as live ones are — only the
   *  backfill and the local pulse record here. */
  const step = (id: string, base: number, cores: number, record = true): number => {
    const i = (steps.get(id) ?? 0) + 1
    steps.set(id, i)
    const frac = wave(id, base, i)
    if (record) recordPulse(id, frac)
    const load = Math.round(frac * cores * 100) / 100
    loads.set(id, load)
    return load
  }

  // backfill a few minutes of history so every trace is already drawn
  for (let i = 0; i < 180; i++) {
    step("local", LOCAL.base, LOCAL.hw.cores)
    for (const d of FLEET) if (!d.fail) step(d.host.alias, d.base, d.hw?.cores ?? 1)
  }

  const byAlias = new Map(FLEET.map((d) => [d.host.alias, d]))
  const sessionsOf = (d: DemoHost): TmuxSession[] =>
    d.sessions.map(([name, windows, attached]) => ({ host: d.host.alias, name, windows, attached }))

  const probe = (alias: string, full: boolean): Promise<HostProbe> => {
    const d = byAlias.get(alias)
    return new Promise((resolve) =>
      setTimeout(
        () => {
          if (!d) return resolve({ status: "fail", sessions: [], error: "no such demo host", reason: "unreachable" })
          if (d.fail) {
            const why = classifySshError(d.fail, alias)
            return resolve({ status: "fail", at: Date.now(), sessions: [], error: d.fail, ...why })
          }
          const load = loads.get(alias) ?? 0
          resolve({
            status: "ok",
            at: Date.now(),
            sessions: sessionsOf(d),
            ...(full && {
              hw: { ...d.hw, load: `${load.toFixed(2)} ${(load * 0.94).toFixed(2)} ${(load * 0.9).toFixed(2)}` },
              agents: d.agents,
              procs: d.procs,
              ports: d.ports,
            }),
          })
        },
        full ? d?.latency ?? 300 : 80,
      ),
    )
  }

  return {
    demo: true,
    machineName: LOCAL.name,
    city: LOCAL.city,
    cores: LOCAL.hw.cores,
    hosts: () => FLEET.map((d) => ({ ...d.host })),
    jobs: () => LOCAL.jobs.map((j) => ({ ...j })),
    localSessions: () =>
      LOCAL.sessions.map(([name, windows, attached]) => ({ host: "local", name, windows, attached })),
    localHw: () => ({ ...LOCAL.hw }),
    localProcs: () => LOCAL.procs.map((x) => ({ ...x })),
    localPorts: () => LOCAL.ports.map((x) => ({ ...x })),
    sampleLocal: () => void step("local", LOCAL.base, LOCAL.hw.cores),
    localLoad: () => loads.get("local") ?? 0,
    probeHost: (alias) => probe(alias, true),
    probeSessions: (alias) => probe(alias, false),
    probeLoad: async (alias) => {
      const d = byAlias.get(alias)
      if (!d || d.fail) return undefined
      return step(alias, d.base, d.hw?.cores ?? 1, false)
    },
    readLog: (j) => (LOGS[j.label] ? `── ${j.logPath}\n${LOGS[j.label]}` : "This job has no StandardOutPath/StandardErrorPath configured."),
  }
}
