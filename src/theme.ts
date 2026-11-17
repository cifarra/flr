import { loadConfig, saveConfig } from "./config"

// Every theme owns its canvas (bg) and a three-step text ramp (fg > dim >
// muted) so contrast is deterministic — flr no longer inherits whatever the
// terminal background happens to be. All tokens are WCAG-checked against bg:
// fg ≥ 9:1, soft ≥ 6.5, dim ≥ 4.6, muted 3–4.8 (chrome only), highlight ≥ 6,
// info/ok ≥ 4.5, bad ≥ 4, accent ≥ 3.5, selFg-on-selBg ≥ 4.5.
// theme.test.ts enforces these ratios — `bun test` after touching any value.
export interface Theme {
  name: string
  description: string
  bg: string // owned canvas — painted on the root, never the terminal's
  fg: string // primary text: names, values
  dim: string // secondary text: descriptions, details, key labels
  muted: string // chrome only: labels, separators, unfocused borders
  accent: string // header/focused borders, the pulse
  selBg: string // selection bed
  selFg: string // text on selection
  highlight: string // key hints, selected titles
  info: string // informational values
  ok: string
  bad: string
  soft: string // gentle emphasis (selected descriptions, session lists)
}

export const FALL: Theme = {
  name: "fall",
  description: "warm autumn — the original",
  bg: "#211A13",
  fg: "#F3EBDF",
  dim: "#B5A697",
  muted: "#877A6B",
  accent: "#E06A4E",
  selBg: "#DA5639",
  selFg: "#24100A",
  highlight: "#ECDF70",
  info: "#8FA9CF",
  ok: "#A9B86A",
  bad: "#F05B50",
  soft: "#F1E3D1",
}

const NORD: Theme = {
  name: "nord",
  description: "arctic, north-bluish, calm",
  bg: "#2E3440",
  fg: "#ECEFF4",
  dim: "#AEB9CE",
  muted: "#7C889F",
  accent: "#88C0D0",
  selBg: "#88C0D0",
  selFg: "#232831",
  highlight: "#EBCB8B",
  info: "#9CB4D4",
  ok: "#A3BE8C",
  bad: "#E0838D",
  soft: "#D8DEE9",
}

const PUNCHCARD: Theme = {
  name: "punchcard",
  description: "mid-century data processing",
  bg: "#1A1611",
  fg: "#F2E8DC",
  dim: "#B4A896",
  muted: "#83786A",
  accent: "#E8574A",
  selBg: "#F2E8DC",
  selFg: "#1A1611",
  highlight: "#F2E8DC",
  info: "#7FB0FF",
  ok: "#84B89D",
  bad: "#F0685C",
  soft: "#C9C1B4",
}

const GRUVBOX: Theme = {
  name: "gruvbox",
  description: "retro groove, warm dark",
  bg: "#282828",
  fg: "#EBDBB2",
  dim: "#A89984",
  muted: "#837C68",
  accent: "#FE8019",
  selBg: "#FE8019",
  selFg: "#282828",
  highlight: "#FABD2F",
  info: "#83A598",
  ok: "#B8BB26",
  bad: "#FB4934",
  soft: "#EBDBB2",
}

const CATPPUCCIN: Theme = {
  name: "catppuccin",
  description: "soothing mocha pastels",
  bg: "#1E1E2E",
  fg: "#CDD6F4",
  dim: "#A6ADC8",
  muted: "#7F849C",
  accent: "#CBA6F7",
  selBg: "#CBA6F7",
  selFg: "#1E1E2E",
  highlight: "#F9E2AF",
  info: "#89B4FA",
  ok: "#A6E3A1",
  bad: "#F38BA8",
  soft: "#F5E0DC",
}

const TOKYO_NIGHT: Theme = {
  name: "tokyo-night",
  description: "neon city after dark",
  bg: "#1A1B26",
  fg: "#C0CAF5",
  dim: "#9AA5CE",
  muted: "#6E779E",
  accent: "#7AA2F7",
  selBg: "#7AA2F7",
  selFg: "#15161E",
  highlight: "#E0AF68",
  info: "#7DCFFF",
  ok: "#9ECE6A",
  bad: "#F7768E",
  soft: "#C0CAF5",
}

const PHOSPHOR: Theme = {
  name: "phosphor",
  description: "green CRT afterglow",
  bg: "#08140B",
  fg: "#C9FFD6",
  dim: "#7FCC96",
  muted: "#4E8A63",
  accent: "#33FF66",
  selBg: "#1F3D28",
  selFg: "#B8FFC9",
  highlight: "#33FF66",
  info: "#2FBB55",
  ok: "#33FF66",
  bad: "#FF6B4A",
  soft: "#99DDAA",
}

const THEMES: Theme[] = [FALL, NORD, PUNCHCARD, GRUVBOX, CATPPUCCIN, TOKYO_NIGHT, PHOSPHOR]

export function allThemes(): Theme[] {
  return THEMES
}

// ---- persistence -----------------------------------------------------------

export function loadSavedThemeName(): string {
  return loadConfig().theme ?? FALL.name
}

export function saveThemeName(name: string) {
  saveConfig({ theme: name })
}

export function resolveTheme(name: string, themes: Theme[]): Theme {
  return themes.find((t) => t.name === name) ?? FALL
}
