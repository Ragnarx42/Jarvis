#!/usr/bin/env bun
/**
 * HealthIngest — stream Apple Health XML export, write daily vault wiki notes.
 *
 * Privacy routing: local Ollama only. Never calls Claude API.
 * Processes last 90 days only. Skips days already in wiki/.
 *
 * Usage:
 *   bun HealthIngest.ts          # auto-detect export.xml in raw/
 *   bun HealthIngest.ts --file <path/to/export.xml>
 */

import { createReadStream } from "fs"
import { createInterface } from "readline"
import { writeFile, readFile, readdir, appendFile, mkdir } from "fs/promises"
import { existsSync, mkdirSync, statSync } from "fs"
import path from "path"
import { updateIndex } from "./HealthUtils.ts"

const VAULT = process.env.VAULT_ROOT ?? `${process.env.HOME}/Brain`
const HEALTH_RAW = `${VAULT}/04 Health/raw`
const HEALTH_WIKI = `${VAULT}/04 Health/wiki`
const METRICS_FILE = `${process.env.HOME}/.claude/PAI/USER/HEALTH/METRICS.md`
const LOG = `${VAULT}/log.md`
const SYSTEM_LOG = path.join(VAULT, "14 System/logs/log.md")
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434"
const MODEL = "qwen3.5:4b"

// Sleep source priority: higher index = higher priority
const SLEEP_SOURCE_PRIORITY: Record<string, number> = {
  "Apple Watch": 1,
  "Connect": 2,
  "Oura": 3,
}

function sleepSourcePriority(source: string): number {
  return SLEEP_SOURCE_PRIORITY[source] ?? 0
}

type DayAccumulator = {
  hrv_values: number[]
  resting_hr: number | undefined
  sleep_minutes: number
  sleep_deep_minutes: number
  sleep_rem_minutes: number
  sleep_source: string | undefined
  steps: number
  active_energy: number
  respiratory_values: number[]
}

function makeDayAcc(): DayAccumulator {
  return {
    hrv_values: [],
    resting_hr: undefined,
    sleep_minutes: 0,
    sleep_deep_minutes: 0,
    sleep_rem_minutes: 0,
    sleep_source: undefined,
    steps: 0,
    active_energy: 0,
    respiratory_values: [],
  }
}

function attr(line: string, name: string): string | undefined {
  const m = line.match(new RegExp(` ${name}="([^"]*?)"`))
  return m ? m[1] : undefined
}

function dateOnly(s: string): string {
  return s.slice(0, 10)
}

function parseHealthDate(s: string): Date {
  return new Date(s.replace(" ", "T").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2"))
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

const SLEEP_ASLEEP = new Set([
  "HKCategoryValueSleepAnalysisAsleepUnspecified",
  "HKCategoryValueSleepAnalysisAsleepCore",
  "HKCategoryValueSleepAnalysisAsleepDeep",
  "HKCategoryValueSleepAnalysisAsleepREM",
])

async function streamXml(xmlPath: string, cutoffStr: string): Promise<Map<string, DayAccumulator>> {
  const days = new Map<string, DayAccumulator>()

  const rl = createInterface({
    input: createReadStream(xmlPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.includes("<Record ")) continue

    const type = attr(line, "type")
    if (!type) continue

    const startDateFull = attr(line, "startDate")
    if (!startDateFull) continue
    const startDay = dateOnly(startDateFull)

    switch (type) {
      case "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": {
        if (startDay < cutoffStr) continue
        const val = parseFloat(attr(line, "value") ?? "")
        if (isNaN(val) || val <= 0) continue
        const acc = days.get(startDay) ?? makeDayAcc()
        acc.hrv_values.push(val)
        days.set(startDay, acc)
        break
      }
      case "HKQuantityTypeIdentifierRestingHeartRate": {
        if (startDay < cutoffStr) continue
        const val = parseFloat(attr(line, "value") ?? "")
        if (isNaN(val) || val <= 0) continue
        const acc = days.get(startDay) ?? makeDayAcc()
        acc.resting_hr = val
        days.set(startDay, acc)
        break
      }
      case "HKCategoryTypeIdentifierSleepAnalysis": {
        const endDateFull = attr(line, "endDate")
        if (!endDateFull) continue
        const endDay = dateOnly(endDateFull)
        if (endDay < cutoffStr) continue
        const value = attr(line, "value") ?? ""
        if (!SLEEP_ASLEEP.has(value)) continue
        const source = attr(line, "sourceName") ?? ""
        const start = parseHealthDate(startDateFull)
        const end = parseHealthDate(endDateFull)
        const minutes = (end.getTime() - start.getTime()) / 60000
        if (isNaN(minutes) || minutes <= 0) continue
        const acc = days.get(endDay) ?? makeDayAcc()
        // Accept only from highest-priority source seen for this day
        const incomingPriority = sleepSourcePriority(source)
        const existingPriority = sleepSourcePriority(acc.sleep_source ?? "")
        if (incomingPriority > existingPriority) {
          // Higher-priority source found — reset and start fresh
          acc.sleep_minutes = 0
          acc.sleep_deep_minutes = 0
          acc.sleep_rem_minutes = 0
          acc.sleep_source = source
        } else if (incomingPriority < existingPriority) {
          days.set(endDay, acc)
          break
        }
        acc.sleep_source = acc.sleep_source ?? source
        acc.sleep_minutes += minutes
        if (value === "HKCategoryValueSleepAnalysisAsleepDeep") acc.sleep_deep_minutes += minutes
        if (value === "HKCategoryValueSleepAnalysisAsleepREM") acc.sleep_rem_minutes += minutes
        days.set(endDay, acc)
        break
      }
      case "HKQuantityTypeIdentifierStepCount": {
        if (startDay < cutoffStr) continue
        const val = parseFloat(attr(line, "value") ?? "")
        if (isNaN(val) || val < 0) continue
        const acc = days.get(startDay) ?? makeDayAcc()
        acc.steps += val
        days.set(startDay, acc)
        break
      }
      case "HKQuantityTypeIdentifierActiveEnergyBurned": {
        if (startDay < cutoffStr) continue
        const val = parseFloat(attr(line, "value") ?? "")
        if (isNaN(val) || val < 0) continue
        const acc = days.get(startDay) ?? makeDayAcc()
        acc.active_energy += val
        days.set(startDay, acc)
        break
      }
      case "HKQuantityTypeIdentifierRespiratoryRate": {
        if (startDay < cutoffStr) continue
        const val = parseFloat(attr(line, "value") ?? "")
        if (isNaN(val) || val <= 0) continue
        const acc = days.get(startDay) ?? makeDayAcc()
        acc.respiratory_values.push(val)
        days.set(startDay, acc)
        break
      }
    }
  }

  return days
}

function buildMetricsSummary(date: string, acc: DayAccumulator): string {
  const lines: string[] = []
  if (acc.hrv_values.length > 0) lines.push(`- HRV: ${median(acc.hrv_values).toFixed(1)} ms`)
  if (acc.resting_hr !== undefined) lines.push(`- Resting HR: ${acc.resting_hr} bpm`)
  if (acc.sleep_minutes > 0) {
    lines.push(`- Sleep total: ${(acc.sleep_minutes / 60).toFixed(1)} h`)
    if (acc.sleep_deep_minutes > 0) lines.push(`- Deep sleep: ${(acc.sleep_deep_minutes / 60).toFixed(1)} h`)
    if (acc.sleep_rem_minutes > 0) lines.push(`- REM sleep: ${(acc.sleep_rem_minutes / 60).toFixed(1)} h`)
  }
  if (acc.steps > 0) lines.push(`- Steps: ${Math.round(acc.steps).toLocaleString()}`)
  if (acc.active_energy > 0) lines.push(`- Active energy: ${Math.round(acc.active_energy)} kcal`)
  if (acc.respiratory_values.length > 0) lines.push(`- Respiratory rate: ${avg(acc.respiratory_values).toFixed(1)} breaths/min`)
  return lines.join("\n") || "No standard metrics found for this date."
}

function convertToWikilinks(content: string): string {
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/)
  const frontmatter = fmMatch ? fmMatch[0] : ""
  const body = content.slice(frontmatter.length)
  const converted = body.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    text === url ? `[[${url}]]` : `[[${url}|${text}]]`
  )
  return frontmatter + converted
}

async function callOllama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are a health data analyst writing concise Obsidian vault notes. " +
            "Write in plain prose, no markdown headers. Be factual, precise, and brief. " +
            "Focus on what the numbers mean for recovery and readiness. No advice.",
        },
        { role: "user", content: prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Ollama ${res.status}`)
  const json = (await res.json()) as { message: { content: string } }
  return json.message.content.trim()
}

async function writeWikiNote(date: string, acc: DayAccumulator, xmlPath: string): Promise<boolean> {
  const wikiPath = path.join(HEALTH_WIKI, `${date}_health-summary.md`)
  if (existsSync(wikiPath)) return false

  const metricsSummary = buildMetricsSummary(date, acc)

  const cutoff90 = new Date()
  cutoff90.setDate(cutoff90.getDate() - 90)
  const isRecent = date >= cutoff90.toISOString().slice(0, 10)

  let synthesis: string
  if (process.env.JARVIS_TEST_MODE === 'true') {
    synthesis = "Test mode — synthesis skipped."
  } else if (isRecent) {
    const prompt =
      `Write a concise 2-3 sentence health summary for ${date} based on these metrics:\n\n` +
      `${metricsSummary}\n\n` +
      `Focus on recovery quality and readiness. Do not give advice.`
    const retryDelays = [1000, 2000, 4000]
    let lastError: unknown
    let result: string | undefined
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        result = await callOllama(prompt)
        break
      } catch (err) {
        lastError = err
        if (attempt < retryDelays.length) {
          await new Promise(r => setTimeout(r, retryDelays[attempt]))
        }
      }
    }
    if (result === undefined) {
      const errorMsg = lastError instanceof Error ? lastError.message : String(lastError)
      const now = new Date().toISOString()
      const placeholder = `---
source: ${xmlPath}
date: ${date}
domain: 04 Health
status: synthesis-pending
privacy-routing: local
error: ${errorMsg} at ${now}
---

# Health Summary — ${date}

## Metrics

${metricsSummary}

## Summary

⚠️ Synthesis pending — Ollama was unreachable at time of ingest.
`
      await mkdir(HEALTH_WIKI, { recursive: true })
      await writeFile(wikiPath, placeholder, "utf-8")
      await appendFile(path.join(HEALTH_WIKI, "failed-synthesis.log"), `${date}\n`, "utf-8")
      await mkdir(path.dirname(SYSTEM_LOG), { recursive: true })
      await appendFile(SYSTEM_LOG, `## [${now.slice(0, 10)}] health-agent | ingest | ERROR: Ollama timeout after 3 retries — ${errorMsg}\n`, "utf-8")
      await mkdir(path.join(VAULT, "12 Queue"), { recursive: true })
      await writeFile(path.join(VAULT, "12 Queue", `health-ollama-timeout-${date}.md`), `---\ndate: ${date}\ndomain: 04 Health\nseverity: moderate\nstatus: pending\nprivacy-routing: local\n---\n\nOllama synthesis timed out for ${date} after 3 retries. Last error: ${errorMsg}\n`, "utf-8")
      console.log(`Pending: ${date}_health-summary.md (Ollama timeout after retries)`)
      return false
    }
    synthesis = convertToWikilinks(result)
  } else {
    synthesis = "Historical record. Metrics only."
  }

  const note = `---
source: ${xmlPath}
date: ${date}
domain: 04 Health
status: processed
privacy-routing: local
route-to: ${HEALTH_WIKI}
---

# Health Summary — ${date}

## Metrics

${metricsSummary}

## Summary

${synthesis}
`

  await mkdir(HEALTH_WIKI, { recursive: true })
  await writeFile(wikiPath, note, "utf-8")
  await updateIndex(date, synthesis, VAULT)
  console.log(`Written: ${date}_health-summary.md`)

  const logLine = `## [${date}] health-agent | ingest | export.xml | processed\n`
  await appendFile(LOG, logLine, "utf-8")
  return true
}

async function writeMetricsFile(sortedDays: [string, DayAccumulator][]): Promise<void> {
  if (sortedDays.length === 0) return
  const [latestDate, latestAcc] = sortedDays[sortedDays.length - 1]
  const summary = buildMetricsSummary(latestDate, latestAcc)

  const content = `# Health Metrics — Latest Day\n\n> Last updated: ${latestDate} (auto-written by HealthIngest)\n\n${summary}\n`
  mkdirSync(path.dirname(METRICS_FILE), { recursive: true })
  await writeFile(METRICS_FILE, content, "utf-8")
}

async function findExportXml(): Promise<string | null> {
  const candidates = [
    path.join(HEALTH_RAW, "apple_health_export", "export.xml"),
    path.join(HEALTH_RAW, "export.xml"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

async function main() {
  if (process.env.JARVIS_TEST_MODE === 'true') {
    process.env.VAULT_ROOT = '/tmp/jarvis-test-vault'
    await mkdir(path.join('/tmp/jarvis-test-vault', '04 Health/wiki'), { recursive: true })
    await mkdir(path.join('/tmp/jarvis-test-vault', '12 Queue'), { recursive: true })
  }

  const fileArg = process.argv.indexOf("--file")
  const xmlPath = fileArg !== -1 ? process.argv[fileArg + 1] : await findExportXml()

  if (!xmlPath || !existsSync(xmlPath)) {
    console.log("NO_ACTION: no export.xml found in raw/")
    return
  }

  // BUG-004: iCloud sync stability check — only for auto-detected files, not test fixtures
  if (fileArg === -1 && process.env.JARVIS_TEST_MODE !== 'true') {
    const MAX_STABILITY_RETRIES = 3
    let stable = false
    for (let i = 0; i < MAX_STABILITY_RETRIES; i++) {
      const size1 = statSync(xmlPath).size
      await new Promise(r => setTimeout(r, 5000))
      const size2 = statSync(xmlPath).size
      if (size1 === size2) { stable = true; break }
    }
    if (!stable) {
      await appendFile(LOG, `## [${new Date().toISOString().slice(0, 10)}] health-agent | ingest | WARN: export.xml still syncing from iCloud, skipping\n`, "utf-8")
      console.log("NO_ACTION: export.xml still syncing from iCloud")
      return
    }
  }

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 90)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  console.log(`Streaming ${xmlPath} (from ${cutoffStr})…`)
  const days = await streamXml(xmlPath, cutoffStr)

  const sortedDays = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))

  if (process.env.JARVIS_TEST_MODE === 'true') {
    const hrvDays = sortedDays.filter(([, acc]) => acc.hrv_values.length > 0)
    let severity: 'low' | 'moderate' | 'high' = 'low'
    if (hrvDays.length >= 2) {
      const prev = median(hrvDays[hrvDays.length - 2][1].hrv_values)
      const curr = median(hrvDays[hrvDays.length - 1][1].hrv_values)
      const drop = (prev - curr) / prev
      if (drop > 0.1) severity = 'moderate'
    }
    console.log(`SEVERITY: ${severity}`)
  }

  let processed = 0
  for (const [date, acc] of sortedDays) {
    const wikiPath = path.join(HEALTH_WIKI, `${date}_health-summary.md`)
    if (existsSync(wikiPath)) continue
    // Skip days with no meaningful data
    if (buildMetricsSummary(date, acc) === "No standard metrics found for this date.") continue
    if (await writeWikiNote(date, acc, xmlPath)) processed++
  }

  // Backfill index.md for any existing wiki notes not yet indexed
  if (existsSync(HEALTH_WIKI)) {
    const allNotes = (await readdir(HEALTH_WIKI))
      .filter(f => f.endsWith("_health-summary.md"))
      .sort()
    for (const f of allNotes) {
      const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/)
      if (!dateMatch) continue
      const noteContent = await readFile(path.join(HEALTH_WIKI, f), "utf-8")
      const summaryMatch = noteContent.match(/## Summary\n\n([\s\S]+?)(?:\n##|$)/)
      const summary = summaryMatch ? summaryMatch[1].trim() : "Health data processed."
      await updateIndex(dateMatch[1], summary, VAULT)
    }
  }

  if (processed === 0) {
    console.log("NO_ACTION: all days already processed")
    return
  }

  await writeMetricsFile(sortedDays)
  console.log(`Ingest complete: ${processed} wiki notes written`)
}

main().catch((err) => {
  console.error(`HealthIngest error: ${err}`)
  process.exit(1)
})
