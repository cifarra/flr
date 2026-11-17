// Where flr's data comes from. The live source reads this machine and probes
// every Host in ~/.ssh/config; the demo source (src/demo.ts) serves a
// fictional fleet so flr can be tried — and screenshotted — without touching
// a real machine. App takes one of these; nothing else in the UI reaches for
// ssh, tmux or launchctl to *read* state.
import { hostname } from "node:os"
import { CORES, localLoad, sampleLocalPulse } from "./instruments"
import { discoverJobs, readLogTail, type LaunchdJob } from "./launchd"
import { log } from "./log"
import {
  localHw,
  localPorts,
  localProcs,
  localTmuxSessions,
  parseSshConfig,
  probeHost,
  probeLoad,
  probeSessions,
  type HostHw,
  type HostProbe,
  type PortInfo,
  type ProcInfo,
  type SshHost,
  type TmuxSession,
} from "./ssh"

export interface Source {
  /** a demo source never acts — attaches, kills and restarts only say what they'd do */
  demo: boolean
  /** this machine's short name, for the masthead and type-ahead */
  machineName: string
  /** shown beside the clock */
  city: string
  /** this machine's core count — the pulse is load / cores */
  cores: number
  hosts(): SshHost[]
  jobs(): LaunchdJob[]
  localSessions(): TmuxSession[]
  localHw(): HostHw
  localProcs(): ProcInfo[]
  localPorts(): PortInfo[]
  /** take one local load reading into the "local" pulse history */
  sampleLocal(): void
  /** the latest local 1-minute load average */
  localLoad(): number
  probeHost(alias: string): Promise<HostProbe>
  probeSessions(alias: string): Promise<HostProbe>
  probeLoad(alias: string): Promise<number | undefined>
  readLog(job: LaunchdJob): string
}

export function liveSource(): Source {
  return {
    demo: false,
    machineName: hostname().replace(/\.(local|lan|home)$/, ""),
    city: (Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop() ?? "").replace(/_/g, " "),
    cores: CORES,
    hosts: () => {
      try {
        return parseSshConfig()
      } catch (e: any) {
        log(`parseSshConfig failed: ${e?.stack ?? e}`)
        return []
      }
    },
    jobs: () => discoverJobs(true),
    localSessions: localTmuxSessions,
    localHw,
    localProcs,
    localPorts,
    sampleLocal: sampleLocalPulse,
    localLoad,
    probeHost,
    probeSessions,
    probeLoad,
    readLog: (job) => readLogTail(job),
  }
}
