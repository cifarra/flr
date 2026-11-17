import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface FlrConfig {
  theme?: string
  /** substring patterns; agents whose name contains any of these are hidden ("a" reveals) */
  agentHide?: string[]
}

export const DEFAULT_AGENT_HIDE = ["com.apple."]

const CONFIG_PATH = join(homedir(), ".config", "flr", "config.json")

export function loadConfig(): FlrConfig {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    return typeof cfg === "object" && cfg !== null ? cfg : {}
  } catch {
    return {}
  }
}

export function saveConfig(patch: Partial<FlrConfig>) {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2) + "\n")
  } catch {}
}

export function agentHideList(): string[] {
  return loadConfig().agentHide ?? DEFAULT_AGENT_HIDE
}
