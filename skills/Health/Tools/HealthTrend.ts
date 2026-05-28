#!/usr/bin/env bun
/**
 * HealthTrend — read 30-day wiki notes, compare against thresholds,
 * write signal to 12 Queue/ if any metric is in sustained breach.
 *
 * Privacy routing: local Ollama only. Never calls Claude API.
 *
 * Usage:
 *   bun HealthTrend.ts
 */

import { readdir, readFile, writeFile, appendFile } from "fs/promises"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { execSync } from "child_process"

const VAULT = `${process.env.HOME}/Brain`
const HEALTH_WIKI = `${VAULT}/04 Health/wiki`
const HEALTH_CONFIG = `${VAULT}/14 System/health-agent-config.yaml`
const LOG = `${VAULT}/log.md`
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434"
const MODEL = "qwen3.5:4b"
const PAI_STATE = `${process.env.HOME}/.claude/PAI/USER/TELOS/PAI_STATE.json`
const CURRENT_STATE_HEALTH = `${process.env.HOME}/.claude/PAI/USER/TELOS/CURRENT_STATE/Health.md`
const COMPUTE_GAP = `${process.env.HOME}/.claude/PAI/TOOLS/ComputeGap.ts`

interface ThresholdConfig {
  hrv?: { low_threshold: number; sustained_days: number; severity: string }
  resting_hr?: { high_threshold: number; sustained_days: number; severity: string }
  sleep?: { deficit_hours_per_night: number; sustained_days: number; severity: string }
  activity?: { low_steps: number; sustained_days: number; severity: string }
}

interface DayMetrics {
  date: string
  hrv?: number
  resting_hr?: number
  sleep_total_hours?: number
  steps?: number
}

function parseSimpleYaml(content: string): ThresholdConfig {
  // Minimal YAML parser for the flat health-agent-config.yaml structure
  const config: ThresholdConfig = {}
  let currentKey: string | null = null
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (!line.startsWith(" ") && trimmed.endsWith(":")) {
      currentKey = trimmed.slice(0, -1)
      ;(config as Record<string, Record<string, unknown>>)[currentKey] = {}
      continue
    }
    if (currentKey && trimmed.includes(":")) {
      const [k, v] = trimmed.split(":").map((s) => s.trim())
      const section = (config as Record<string, Record<string, unknown>>)[currentKey]
      section[k] = isNaN(Number(v)) ? v : Number(v)
    }
  }
  return config
}

function extractMetricFromNote(content: string, metric: string): number | undefined {
  // Extract numeric values from lines like "- HRV: 42 ms"
  const patterns: Record<string, RegExp> = {
    hrv: /HRV:\s*([\d.]+)\s*ms/i,
    resting_hr: /Resting HR:\s*([\d.]+)\s*bpm/i,
    sleep_total_hours: /Sleep total:\s*([\d.]+)\s*h/i,
    steps: /Steps:\s*([\d,]+)/i,
  }
  const pattern = patterns[metric]
  if (!pattern) return undefined
  const match = content.match(pattern)
  if (!match) return undefined
  return parseFloat(match[1].replace(",", ""))
}

async function loadLast30DaysMetrics(): Promise<DayMetrics[]> {
  if (!existsSync(HEALTH_WIKI)) return []
  const files = (await readdir(HEALTH_WIKI))
    .filter((f) => f.endsWith("_health-summary.md"))
    .sort()
    .reverse()
    .slice(0, 30)

  const metrics: DayMetrics[] = []
  for (const f of files) {
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/)
    if (!dateMatch) continue
    const content = await readFile(path.join(HEALTH_WIKI, f), "utf-8")
    metrics.push({
      date: dateMatch[1],
      hrv: extractMetricFromNote(content, "hrv"),
      resting_hr: extractMetricFromNote(content, "resting_hr"),
      sleep_total_hours: extractMetricFromNote(content, "sleep_total_hours"),
      steps: extractMetricFromNote(content, "steps"),
    })
  }
  return metrics
}

interface Breach {
  metric: string
  sustained_days: number
  severity: string
  values: number[]
  threshold: number
  direction: "below" | "above"
}

function detectBreaches(metrics: DayMetrics[], config: ThresholdConfig): Breach[] {
  const breaches: Breach[] = []

  if (config.hrv) {
    const { low_threshold, sustained_days, severity } = config.hrv
    const recentValues = metrics.slice(0, sustained_days).map((m) => m.hrv).filter((v) => v !== undefined) as number[]
    if (recentValues.length >= sustained_days && recentValues.every((v) => v < low_threshold)) {
      breaches.push({ metric: "HRV", sustained_days, severity, values: recentValues, threshold: low_threshold, direction: "below" })
    }
  }

  if (config.resting_hr) {
    const { high_threshold, sustained_days, severity } = config.resting_hr
    const recentValues = metrics.slice(0, sustained_days).map((m) => m.resting_hr).filter((v) => v !== undefined) as number[]
    if (recentValues.length >= sustained_days && recentValues.every((v) => v > high_threshold)) {
      breaches.push({ metric: "Resting HR", sustained_days, severity, values: recentValues, threshold: high_threshold, direction: "above" })
    }
  }

  if (config.sleep) {
    const { deficit_hours_per_night, sustained_days, severity } = config.sleep
    const recentValues = metrics.slice(0, sustained_days).map((m) => m.sleep_total_hours).filter((v) => v !== undefined) as number[]
    if (recentValues.length >= sustained_days && recentValues.every((v) => v < deficit_hours_per_night)) {
      breaches.push({ metric: "Sleep", sustained_days, severity, values: recentValues, threshold: deficit_hours_per_night, direction: "below" })
    }
  }

  if (config.activity) {
    const { low_steps, sustained_days, severity } = config.activity
    const recentValues = metrics.slice(0, sustained_days).map((m) => m.steps).filter((v) => v !== undefined) as number[]
    if (recentValues.length >= sustained_days && recentValues.every((v) => v < low_steps)) {
      breaches.push({ metric: "Steps", sustained_days, severity, values: recentValues, threshold: low_steps, direction: "below" })
    }
  }

  return breaches
}

async function callOllama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are a health analyst writing one-line recommendations for a personal health monitoring system. " +
            "Be direct, specific, and actionable. One sentence maximum per recommendation.",
        },
        { role: "user", content: prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`)
  const json = (await res.json()) as { message: { content: string } }
  return json.message.content.trim()
}

function meanOf(arr: (number | undefined)[]): number | undefined {
  const vals = arr.filter((v): v is number => v !== undefined)
  if (vals.length === 0) return undefined
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

function computeWearableBonus(metrics: DayMetrics[]): number {
  // Score 0–20: fraction of wearable targets met over last 30 days
  let points = 0
  let maxPoints = 0

  const hrv = meanOf(metrics.map((m) => m.hrv))
  if (hrv !== undefined) {
    maxPoints += 5
    if (hrv >= 45) points += 5
    else if (hrv >= 35) points += 2
  }

  const hr = meanOf(metrics.map((m) => m.resting_hr))
  if (hr !== undefined) {
    maxPoints += 5
    if (hr <= 62) points += 5
    else if (hr <= 70) points += 2
  }

  const sleep = meanOf(metrics.map((m) => m.sleep_total_hours))
  if (sleep !== undefined) {
    maxPoints += 5
    if (sleep >= 7.5) points += 5
    else if (sleep >= 6.5) points += 3
    else if (sleep >= 5.5) points += 1
  }

  const steps = meanOf(metrics.map((m) => m.steps))
  if (steps !== undefined) {
    maxPoints += 5
    if (steps >= 8000) points += 5
    else if (steps >= 5000) points += 3
    else if (steps >= 3000) points += 1
  }

  if (maxPoints === 0) return 0
  return Math.round((points / maxPoints) * 20)
}

async function updateCurrentState(today: string, metrics: DayMetrics[]): Promise<void> {
  if (!existsSync(CURRENT_STATE_HEALTH)) return

  const hrv = meanOf(metrics.map((m) => m.hrv))
  const hr = meanOf(metrics.map((m) => m.resting_hr))
  const sleep = meanOf(metrics.map((m) => m.sleep_total_hours))
  const steps = meanOf(metrics.map((m) => m.steps))

  const section = [
    `## Wearable Metrics (30-day rolling average, auto-updated by health-agent)`,
    ``,
    `> Last updated: ${today}`,
    ``,
    hrv !== undefined ? `- HRV: ${hrv.toFixed(1)} ms (target: ≥45)` : null,
    hr !== undefined ? `- Resting HR: ${hr.toFixed(1)} bpm (target: ≤62)` : null,
    sleep !== undefined ? `- Sleep total: ${sleep.toFixed(1)} h (target: ≥7.5)` : null,
    steps !== undefined ? `- Steps: ${Math.round(steps).toLocaleString()} /day (target: ≥5,000)` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")

  const existing = await readFile(CURRENT_STATE_HEALTH, "utf-8")
  const MARKER = "## Wearable Metrics (30-day rolling average, auto-updated by health-agent)"

  let updated: string
  if (existing.includes(MARKER)) {
    updated = existing.replace(/## Wearable Metrics \(30-day rolling average.*?(?=\n##|\n$|$)/s, section)
  } else {
    updated = existing.trimEnd() + "\n\n" + section + "\n"
  }

  await writeFile(CURRENT_STATE_HEALTH, updated, "utf-8")
}

async function updatePaiState(today: string, wearableBonus: number): Promise<void> {
  if (!existsSync(PAI_STATE)) return

  const raw = readFileSync(PAI_STATE, "utf-8")
  const state = JSON.parse(raw)

  const base: number = state.dimensions?.health?.base ?? state.dimensions?.health?.pct ?? 32
  const pct = Math.min(100, base + wearableBonus)
  const manualNote: string =
    state.dimensions?.health?.manual_note ?? state.dimensions?.health?.note ?? ""

  state.dimensions = state.dimensions ?? {}
  state.dimensions.health = {
    ...state.dimensions.health,
    pct,
    base,
    wearable_bonus: wearableBonus,
    wearable_last_updated: today,
    manual_note: manualNote,
    note: `Base ${base}% (manual, ${state._meta?.generated ?? "unknown"}) + wearable ${wearableBonus}/20 pts. Auto-updated ${today}.`,
  }

  await writeFile(PAI_STATE, JSON.stringify(state, null, 2) + "\n", "utf-8")
  console.log(`PAI health score updated: ${base} base + ${wearableBonus} wearable = ${pct}%`)
}

async function main() {
  const today = new Date().toISOString().slice(0, 10)

  if (!existsSync(HEALTH_CONFIG)) {
    console.error(`Config not found: ${HEALTH_CONFIG}`)
    process.exit(1)
  }

  const configContent = await readFile(HEALTH_CONFIG, "utf-8")
  const config = parseSimpleYaml(configContent)
  const metrics = await loadLast30DaysMetrics()

  if (metrics.length === 0) {
    console.log("NO_ACTION: no health wiki notes found")
    return
  }

  const breaches = detectBreaches(metrics, config)

  if (breaches.length === 0) {
    console.log(`NO_ACTION: all metrics within thresholds (${metrics.length} days checked)`)
    const logLine = `## [${today}] health-agent | trend-analysis | no-breach | clean\n`
    await appendFile(LOG, logLine, "utf-8")
  } else {
    for (const breach of breaches) {
      const avgValue = breach.values.reduce((a, b) => a + b, 0) / breach.values.length
      const dir = breach.direction === "below" ? "below" : "above"
      const prompt =
        `${breach.metric} has been ${dir} threshold for ${breach.sustained_days} days. ` +
        `Threshold: ${breach.threshold}. Recent values: ${breach.values.join(", ")}. ` +
        `Average: ${avgValue.toFixed(1)}. Write one actionable recommendation.`

      let recommendation: string
      try {
        recommendation = await callOllama(prompt)
      } catch {
        recommendation = `${breach.metric} ${dir} threshold for ${breach.sustained_days} days — review protocol.`
      }

      const signalFilename = `${today}_health-signal-${breach.metric.toLowerCase().replace(/\s+/g, "-")}.md`
      const signalPath = path.join(`${VAULT}/12 Queue`, signalFilename)
      const signalContent = `---
source: health-agent
date: ${today}
type: health-signal
severity: ${breach.severity}
domain: 04 Health
privacy-routing: local
status: pending
---
Signal: ${breach.metric} ${dir} threshold (${breach.threshold}) for ${breach.sustained_days} consecutive days. Values: ${breach.values.join(", ")}.
Recommendation: ${recommendation}
`
      execSync(`mkdir -p "${VAULT}/12 Queue"`)
      await appendFile(signalPath, signalContent, "utf-8")
      console.log(`Signal written: ${signalFilename} [${breach.severity}]`)

      const logLine = `## [${today}] health-agent | trend-analysis | ${signalFilename} | queued to 12 Queue\n`
      await appendFile(LOG, logLine, "utf-8")
    }
  }

  // Update CURRENT_STATE/Health.md wearable section
  await updateCurrentState(today, metrics)

  // Compute wearable bonus and update PAI_STATE.json
  const wearableBonus = computeWearableBonus(metrics)
  await updatePaiState(today, wearableBonus)

  // Trigger ComputeGap for full gap log
  if (existsSync(COMPUTE_GAP)) {
    try {
      execSync(`bun "${COMPUTE_GAP}" --dimension health --log`, { timeout: 60_000 })
    } catch {
      // Non-fatal — ComputeGap failure does not block health agent
    }
  }
}

main().catch((err) => {
  console.error(`HealthTrend error: ${err}`)
  process.exit(1)
})
