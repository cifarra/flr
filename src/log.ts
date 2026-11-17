import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const LOG_PATH =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Logs", "flr.log")
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "flr", "flr.log")

try {
  mkdirSync(dirname(LOG_PATH), { recursive: true })
} catch {}

export function log(msg: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // never let logging take the app down
  }
}

export function initCrashLog() {
  process.on("uncaughtException", (e: any) => {
    log(`CRASH uncaughtException: ${e?.stack ?? e}`)
    process.exit(1)
  })
  process.on("unhandledRejection", (e: any) => {
    log(`CRASH unhandledRejection: ${e?.stack ?? e}`)
  })
}
