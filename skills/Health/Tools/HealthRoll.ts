#!/usr/bin/env bun
/**
 * HealthRoll — aggregate daily wiki notes into weekly, bi-weekly, and monthly summaries.
 *
 * Privacy routing: local Ollama only. Never calls Claude API.
 *
 * Usage:
 *   bun HealthRoll.ts           # generate all layers, only writes what is stale or missing
 *   bun HealthRoll.ts --week    # weekly layer only
 *   bun HealthRoll.ts --biweek  # bi-weekly layer only
 *   bun HealthRoll.ts --month   # monthly layer only
 *
 * Hierarchy:
 *   daily note  →  [[YYYY-Www health week]]   in wiki/
 *   weekly note →  [[YYYY-BWnn health biweek]] in weekly/
 *   biweekly    →  [[YYYY-MM health month]]    in biweekly/
 *   monthly     →  [[Health]]                  in monthly/
 */

import { readFile, writeFile, readdir, mkdir } from "fs/promises"
import { existsSync, statSync } from "fs"
import path from "path"

const VAULT        = `${process.env.HOME}/Brain`
const HEALTH_WIKI  = `${VAULT}/04 Health/wiki`
const HEALTH_WEEK  = `${VAULT}/04 Health/weekly`
const HEALTH_BW    = `${VAULT}/04 Health/biweekly`
const HEALTH_MON   = `${VAULT}/04 Health/monthly`

// ─── Types ───────────────────────────────────────────────────────────────────

interface DayMetrics {
  date: string          // YYYY-MM-DD
  hrv?: number
  resting_hr?: number
  sleep_total?: number
  sleep_deep?: number
  sleep_rem?: number
  steps?: number
  active_energy?: number
  respiratory?: number
}

interface WeekMetrics {
  isoYear: number
  isoWeek: number
  label: string         // e.g. "2026-W21"
  dateRange: string     // e.g. "19–25 May 2026"
  days: DayMetrics[]
  avg: Partial<DayMetrics>
  totals: { steps: number; active_energy: number }
}

interface BiweekMetrics {
  label: string         // e.g. "2026-BW11"
  weeks: [WeekMetrics, WeekMetrics]
  dateRange: string
}

interface MonthMetrics {
  label: string         // e.g. "2026-05"
  monthName: string     // e.g. "May 2026"
  days: DayMetrics[]
  weeks: WeekMetrics[]
  avg: Partial<DayMetrics>
  totals: { steps: number; active_energy: number }
}

// ─── Extraction ──────────────────────────────────────────────────────────────

const PATTERNS: Record<keyof Omit<DayMetrics, "date">, RegExp> = {
  hrv:           /HRV:\s*([\d.]+)\s*ms/i,
  resting_hr:    /Resting HR:\s*([\d.]+)\s*bpm/i,
  sleep_total:   /Sleep total:\s*([\d.]+)\s*h/i,
  sleep_deep:    /Deep sleep:\s*([\d.]+)\s*h/i,
  sleep_rem:     /REM sleep:\s*([\d.]+)\s*h/i,
  steps:         /Steps:\s*([\d,]+)/i,
  active_energy: /Active energy:\s*([\d,]+)/i,
  respiratory:   /Respiratory rate:\s*([\d.]+)/i,
}

function extractMetrics(content: string, date: string): DayMetrics {
  const m: DayMetrics = { date }
  for (const [key, re] of Object.entries(PATTERNS) as [keyof typeof PATTERNS, RegExp][]) {
    const match = content.match(re)
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ""))
      if (!isNaN(val)) (m as Record<string, number>)[key] = val
    }
  }
  return m
}

async function loadDailyNotes(): Promise<DayMetrics[]> {
  if (!existsSync(HEALTH_WIKI)) return []
  const files = (await readdir(HEALTH_WIKI))
    .filter(f => /^\d{4}-\d{2}-\d{2}_health-summary\.md$/.test(f))
    .sort()
  const results: DayMetrics[] = []
  for (const f of files) {
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/)
    if (!dateMatch) continue
    const content = await readFile(path.join(HEALTH_WIKI, f), "utf-8")
    results.push(extractMetrics(content, dateMatch[1]))
  }
  return results
}

// ─── ISO week helpers ─────────────────────────────────────────────────────────

function getISOWeek(dateStr: string): { year: number; week: number } {
  const d = new Date(dateStr + "T12:00:00Z")
  const day = d.getUTCDay() || 7          // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day) // nearest Thursday
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + 1) / 7)
  return { year: d.getUTCFullYear(), week }
}

function isoWeekLabel(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`
}

function isoWeekStart(year: number, week: number): Date {
  // Jan 4 is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const day = jan4.getUTCDay() || 7
  const weekStart = new Date(jan4)
  weekStart.setUTCDate(jan4.getUTCDate() - (day - 1) + (week - 1) * 7)
  return weekStart
}

function formatDateRange(start: Date, end: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  const s = start.getUTCDate()
  const e = end.getUTCDate()
  const sm = months[start.getUTCMonth()]
  const em = months[end.getUTCMonth()]
  const ey = end.getUTCFullYear()
  return sm === em ? `${s}–${e} ${em} ${ey}` : `${s} ${sm}–${e} ${em} ${ey}`
}

// ─── Averaging ────────────────────────────────────────────────────────────────

function meanOf(vals: (number | undefined)[]): number | undefined {
  const v = vals.filter((x): x is number => x !== undefined)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined
}

function avgMetrics(days: DayMetrics[]): Partial<DayMetrics> {
  return {
    hrv:           meanOf(days.map(d => d.hrv)),
    resting_hr:    meanOf(days.map(d => d.resting_hr)),
    sleep_total:   meanOf(days.map(d => d.sleep_total)),
    sleep_deep:    meanOf(days.map(d => d.sleep_deep)),
    sleep_rem:     meanOf(days.map(d => d.sleep_rem)),
    steps:         meanOf(days.map(d => d.steps)),
    active_energy: meanOf(days.map(d => d.active_energy)),
    respiratory:   meanOf(days.map(d => d.respiratory)),
  }
}

function sumMetrics(days: DayMetrics[]) {
  return {
    steps:         days.reduce((a, d) => a + (d.steps ?? 0), 0),
    active_energy: days.reduce((a, d) => a + (d.active_energy ?? 0), 0),
  }
}

// ─── Trend direction ──────────────────────────────────────────────────────────

function trend(current?: number, prior?: number, higherIsBetter = true): string {
  if (current === undefined || prior === undefined || prior === 0) return ""
  const delta = (current - prior) / prior
  const improving = higherIsBetter ? delta > 0.05 : delta < -0.05
  const worsening = higherIsBetter ? delta < -0.05 : delta > 0.05
  return improving ? " ↑" : worsening ? " ↓" : " →"
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

function groupByISOWeek(days: DayMetrics[]): WeekMetrics[] {
  const map = new Map<string, DayMetrics[]>()
  for (const d of days) {
    const { year, week } = getISOWeek(d.date)
    const label = isoWeekLabel(year, week)
    if (!map.has(label)) map.set(label, [])
    map.get(label)!.push(d)
  }
  const weeks: WeekMetrics[] = []
  for (const [label, wdays] of [...map.entries()].sort()) {
    const [yearStr, wStr] = label.split("-W")
    const year = parseInt(yearStr), week = parseInt(wStr)
    const start = isoWeekStart(year, week)
    const end = new Date(start)
    end.setUTCDate(start.getUTCDate() + 6)
    weeks.push({
      isoYear: year, isoWeek: week, label,
      dateRange: formatDateRange(start, end),
      days: wdays,
      avg: avgMetrics(wdays),
      totals: sumMetrics(wdays),
    })
  }
  return weeks
}

function groupByBiweek(weeks: WeekMetrics[]): BiweekMetrics[] {
  // Pair consecutive ISO weeks: W01+W02 = BW01, W03+W04 = BW02, …
  // Keyed by year + biweek index
  const map = new Map<string, WeekMetrics[]>()
  for (const w of weeks) {
    const bwNum = Math.ceil(w.isoWeek / 2)
    const label = `${w.isoYear}-BW${String(bwNum).padStart(2, "0")}`
    if (!map.has(label)) map.set(label, [])
    map.get(label)!.push(w)
  }
  const biweeks: BiweekMetrics[] = []
  for (const [label, bwWeeks] of [...map.entries()].sort()) {
    if (bwWeeks.length < 2) continue // incomplete pair — skip
    const sorted = bwWeeks.sort((a, b) => a.isoWeek - b.isoWeek) as [WeekMetrics, WeekMetrics]
    const allDays = [...sorted[0].days, ...sorted[1].days]
    const startDate = allDays.map(d => d.date).sort()[0]
    const endDate = allDays.map(d => d.date).sort().at(-1)!
    biweeks.push({
      label,
      weeks: sorted,
      dateRange: `${startDate} – ${endDate}`,
    })
  }
  return biweeks
}

function groupByMonth(days: DayMetrics[], weeks: WeekMetrics[]): MonthMetrics[] {
  const map = new Map<string, DayMetrics[]>()
  for (const d of days) {
    const label = d.date.slice(0, 7) // YYYY-MM
    if (!map.has(label)) map.set(label, [])
    map.get(label)!.push(d)
  }
  const months: MonthMetrics[] = []
  const monthNames = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"]
  for (const [label, mdays] of [...map.entries()].sort()) {
    const [y, m] = label.split("-").map(Number)
    const monthWeeks = weeks.filter(w =>
      w.days.some(d => d.date.startsWith(label))
    )
    months.push({
      label,
      monthName: `${monthNames[m - 1]} ${y}`,
      days: mdays,
      weeks: monthWeeks,
      avg: avgMetrics(mdays),
      totals: sumMetrics(mdays),
    })
  }
  return months
}

// ─── Deterministic synthesis ─────────────────────────────────────────────────

function synthesiseWeek(w: WeekMetrics, prior?: WeekMetrics): string {
  const parts: string[] = []
  const a = w.avg

  // Sleep
  if (a.sleep_total !== undefined) {
    const q = a.sleep_total >= 7.5 ? "good" : a.sleep_total >= 6 ? "moderate" : "poor"
    const vs = prior?.avg.sleep_total !== undefined
      ? ` (${a.sleep_total >= prior.avg.sleep_total ? "up" : "down"} from ${prior.avg.sleep_total.toFixed(1)} h prior week)`
      : ""
    parts.push(`Average sleep was ${a.sleep_total.toFixed(1)} h — ${q}${vs}.`)
  }

  // HRV
  if (a.hrv !== undefined) {
    const q = a.hrv >= 60 ? "strong" : a.hrv >= 40 ? "adequate" : "suppressed"
    const vs = prior?.avg.hrv !== undefined
      ? `, ${a.hrv >= prior.avg.hrv ? "improving" : "declining"} from ${prior.avg.hrv.toFixed(0)} ms`
      : ""
    parts.push(`HRV averaged ${a.hrv.toFixed(0)} ms — ${q} recovery signal${vs}.`)
  }

  // Steps
  if (a.steps !== undefined) {
    const q = a.steps >= 10000 ? "active" : a.steps >= 6000 ? "moderate activity" : "low activity"
    parts.push(`Daily steps averaged ${Math.round(a.steps).toLocaleString()} — ${q}.`)
  }

  return parts.length ? parts.join(" ") : "Insufficient data for this week."
}

function synthesiseBiweek(w1: WeekMetrics, w2: WeekMetrics): string {
  const parts: string[] = []

  if (w1.avg.sleep_total !== undefined && w2.avg.sleep_total !== undefined) {
    const delta = w2.avg.sleep_total - w1.avg.sleep_total
    const dir = Math.abs(delta) < 0.2 ? "stable" : delta > 0 ? `up ${delta.toFixed(1)} h` : `down ${Math.abs(delta).toFixed(1)} h`
    parts.push(`Sleep trended ${dir} across the two weeks (${w1.avg.sleep_total.toFixed(1)} h → ${w2.avg.sleep_total.toFixed(1)} h).`)
  }

  if (w1.avg.hrv !== undefined && w2.avg.hrv !== undefined) {
    const delta = w2.avg.hrv - w1.avg.hrv
    const dir = Math.abs(delta) < 3 ? "held steady" : delta > 0 ? `rose ${delta.toFixed(0)} ms` : `fell ${Math.abs(delta).toFixed(0)} ms`
    parts.push(`HRV ${dir} (${w1.avg.hrv.toFixed(0)} → ${w2.avg.hrv.toFixed(0)} ms).`)
  }

  if (w1.avg.steps !== undefined && w2.avg.steps !== undefined) {
    const delta = w2.avg.steps - w1.avg.steps
    const dir = Math.abs(delta) < 500 ? "consistent" : delta > 0 ? "increased" : "decreased"
    parts.push(`Daily step count was ${dir} week-over-week.`)
  }

  return parts.length ? parts.join(" ") : "Insufficient data to compare these two weeks."
}

function synthesiseMonth(mon: MonthMetrics): string {
  const parts: string[] = []
  const a = mon.avg

  if (a.sleep_total !== undefined)
    parts.push(`Monthly sleep averaged ${a.sleep_total.toFixed(1)} h/night.`)
  if (a.hrv !== undefined)
    parts.push(`HRV held at ${a.hrv.toFixed(0)} ms average.`)
  if (a.steps !== undefined)
    parts.push(`Daily steps averaged ${Math.round(a.steps).toLocaleString()}.`)
  if (a.resting_hr !== undefined)
    parts.push(`Resting HR was ${a.resting_hr.toFixed(0)} bpm.`)

  return parts.length ? parts.join(" ") : "Insufficient data for this month."
}

// ─── Note builders ────────────────────────────────────────────────────────────

function fmtAvg(val: number | undefined, decimals = 1): string {
  return val !== undefined ? val.toFixed(decimals) : "—"
}

function metricsBlock(avg: Partial<DayMetrics>, priorAvg?: Partial<DayMetrics>): string {
  const lines: string[] = []
  if (avg.hrv !== undefined)
    lines.push(`- HRV: ${fmtAvg(avg.hrv)} ms${trend(avg.hrv, priorAvg?.hrv, true)}`)
  if (avg.resting_hr !== undefined)
    lines.push(`- Resting HR: ${fmtAvg(avg.resting_hr)} bpm${trend(avg.resting_hr, priorAvg?.resting_hr, false)}`)
  if (avg.sleep_total !== undefined)
    lines.push(`- Sleep: ${fmtAvg(avg.sleep_total)} h${trend(avg.sleep_total, priorAvg?.sleep_total, true)}`)
  if (avg.sleep_deep !== undefined)
    lines.push(`- Deep sleep: ${fmtAvg(avg.sleep_deep)} h`)
  if (avg.sleep_rem !== undefined)
    lines.push(`- REM sleep: ${fmtAvg(avg.sleep_rem)} h`)
  if (avg.steps !== undefined)
    lines.push(`- Steps: ${Math.round(avg.steps!).toLocaleString()} /day${trend(avg.steps, priorAvg?.steps, true)}`)
  if (avg.active_energy !== undefined)
    lines.push(`- Active energy: ${Math.round(avg.active_energy!)} kcal/day`)
  if (avg.respiratory !== undefined)
    lines.push(`- Respiratory rate: ${fmtAvg(avg.respiratory)} breaths/min`)
  return lines.join("\n") || "No metrics available."
}

// ─── Weekly notes ─────────────────────────────────────────────────────────────

async function writeWeeklyNote(w: WeekMetrics, priorWeek?: WeekMetrics): Promise<void> {
  await mkdir(HEALTH_WEEK, { recursive: true })
  const filePath = path.join(HEALTH_WEEK, `${w.label}_health-week.md`)

  // Only regenerate if stale (newest daily note newer than weekly note)
  const newestDaily = w.days.map(d => d.date).sort().at(-1)!
  const dailyMtime = statSync(path.join(HEALTH_WIKI, `${newestDaily}_health-summary.md`)).mtimeMs
  if (existsSync(filePath) && statSync(filePath).mtimeMs >= dailyMtime) return

  const bwNum = Math.ceil(w.isoWeek / 2)
  const bwLabel = `${w.isoYear}-BW${String(bwNum).padStart(2, "0")}`
  const metricsText = metricsBlock(w.avg, priorWeek?.avg)

  const synthesis = synthesiseWeek(w, priorWeek)

  const dailyLinks = w.days
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => `- [[${d.date}_health-summary]]`)
    .join("\n")

  const note = `---
date: ${w.label}
domain: 04 Health
type: weekly-health
tags: [health, weekly-health]
privacy-routing: local
---

# Health Week — ${w.label} (${w.dateRange})

[[Health]] | [[${bwLabel} health biweek]]

## Weekly Averages

${metricsText}

## Daily Notes

${dailyLinks}

## Summary

${synthesis}
`
  await writeFile(filePath, note, "utf-8")
  console.log(`Weekly: ${w.label}`)
}

// ─── Bi-weekly notes ──────────────────────────────────────────────────────────

async function writeBiweeklyNote(bw: BiweekMetrics): Promise<void> {
  await mkdir(HEALTH_BW, { recursive: true })
  const filePath = path.join(HEALTH_BW, `${bw.label}_health-biweek.md`)

  // Stale check: newer than both weekly notes
  const w1Path = path.join(HEALTH_WEEK, `${bw.weeks[0].label}_health-week.md`)
  const w2Path = path.join(HEALTH_WEEK, `${bw.weeks[1].label}_health-week.md`)
  if (!existsSync(w1Path) || !existsSync(w2Path)) return
  const newerWeekMtime = Math.max(statSync(w1Path).mtimeMs, statSync(w2Path).mtimeMs)
  if (existsSync(filePath) && statSync(filePath).mtimeMs >= newerWeekMtime) return

  const [w1, w2] = bw.weeks
  const allDays = [...w1.days, ...w2.days]
  const avg = avgMetrics(allDays)
  const [yearStr] = bw.label.split("-BW")
  const monthLabel = allDays.map(d => d.date.slice(0, 7)).sort().at(-1)!

  const synthesis = synthesiseBiweek(w1, w2)

  const note = `---
date: ${bw.label}
domain: 04 Health
type: biweekly-health
tags: [health, biweekly-health]
privacy-routing: local
---

# Health Bi-Week — ${bw.label} (${bw.dateRange})

[[Health]] | [[${monthLabel} health month]]

## Week 1 — ${w1.label} (${w1.dateRange})

${metricsBlock(w1.avg)}

## Week 2 — ${w2.label} (${w2.dateRange})

${metricsBlock(w2.avg, w1.avg)}

## Weekly Notes

- [[${w1.label}_health-week]]
- [[${w2.label}_health-week]]

## Summary

${synthesis}
`
  await writeFile(filePath, note, "utf-8")
  console.log(`Biweekly: ${bw.label}`)
}

// ─── Monthly notes ────────────────────────────────────────────────────────────

async function writeMonthlyNote(mon: MonthMetrics): Promise<void> {
  await mkdir(HEALTH_MON, { recursive: true })
  const filePath = path.join(HEALTH_MON, `${mon.label}_health-month.md`)

  // Stale check: newer than any biweekly note for this month
  const bwFiles = existsSync(HEALTH_BW)
    ? (await readdir(HEALTH_BW)).filter(f => f.endsWith("_health-biweek.md"))
    : []
  const relevantBWFiles = bwFiles.filter(f => {
    // Include if it overlaps this month
    return mon.weeks.some(w => f.includes(
      `${w.isoYear}-BW${String(Math.ceil(w.isoWeek / 2)).padStart(2, "0")}`
    ))
  })
  if (relevantBWFiles.length > 0) {
    const newestBW = Math.max(...relevantBWFiles.map(f =>
      statSync(path.join(HEALTH_BW, f)).mtimeMs
    ))
    if (existsSync(filePath) && statSync(filePath).mtimeMs >= newestBW) return
  } else if (existsSync(filePath)) {
    return
  }

  const metricsText = metricsBlock(mon.avg)

  // Best and worst week by composite (sleep + steps, normalised)
  const scoredWeeks = mon.weeks
    .filter(w => w.avg.steps !== undefined || w.avg.sleep_total !== undefined)
    .map(w => ({
      w,
      score: (w.avg.steps ?? 0) / 10000 + (w.avg.sleep_total ?? 0) / 8,
    }))
    .sort((a, b) => b.score - a.score)
  const bestWeek  = scoredWeeks[0]?.w
  const worstWeek = scoredWeeks.at(-1)?.w

  const synthesis = synthesiseMonth(mon)

  const weekLinks = mon.weeks
    .sort((a, b) => a.isoWeek - b.isoWeek)
    .map(w => `- [[${w.label}_health-week]] (${w.dateRange})`)
    .join("\n")

  const note = `---
date: ${mon.label}
domain: 04 Health
type: monthly-health
tags: [health, monthly-health]
privacy-routing: local
---

# Health Month — ${mon.monthName}

[[Health]]

## Monthly Averages

${metricsText}

${bestWeek ? `**Best week:** [[${bestWeek.label}_health-week]] (${bestWeek.dateRange})` : ""}
${worstWeek && worstWeek.label !== bestWeek?.label ? `**Lowest week:** [[${worstWeek.label}_health-week]] (${worstWeek.dateRange})` : ""}

## Weeks

${weekLinks}

## Summary

${synthesis}
`
  await writeFile(filePath, note, "utf-8")
  console.log(`Monthly: ${mon.label}`)
}

// ─── Daily note patching ──────────────────────────────────────────────────────

async function patchDailyNotes(weeks: WeekMetrics[]): Promise<void> {
  // Build date → week label map
  const dateToWeek = new Map<string, string>()
  for (const w of weeks) {
    for (const d of w.days) dateToWeek.set(d.date, w.label)
  }

  const files = (await readdir(HEALTH_WIKI))
    .filter(f => /^\d{4}-\d{2}-\d{2}_health-summary\.md$/.test(f))

  let patched = 0
  for (const f of files) {
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/)
    if (!dateMatch) continue
    const date = dateMatch[1]
    const weekLabel = dateToWeek.get(date)
    if (!weekLabel) continue

    const filePath = path.join(HEALTH_WIKI, f)
    let content = await readFile(filePath, "utf-8")

    const linkLine = `[[${weekLabel} health week]] | [[Health]]`
    const tagLine  = "tags: [health, daily-health]"

    // Patch tags in frontmatter if not present
    if (!content.includes("tags:")) {
      content = content.replace(
        /^(---\n[\s\S]+?)(---)/m,
        (_, front, close) => `${front}${tagLine}\n${close}`
      )
    }

    // Add link line after the H1 heading if not present
    if (!content.includes("[[Health]]")) {
      content = content.replace(
        /(# Health Summary — .+\n)/,
        `$1\n${linkLine}\n`
      )
      patched++
    }

    await writeFile(filePath, content, "utf-8")
  }
  if (patched > 0) console.log(`Patched ${patched} daily notes with wikilinks and tags`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const doWeek   = args.length === 0 || args.includes("--week")
  const doBiweek = args.length === 0 || args.includes("--biweek")
  const doMonth  = args.length === 0 || args.includes("--month")

  const allDays = await loadDailyNotes()
  if (allDays.length === 0) {
    console.log("NO_ACTION: no daily health notes found")
    return
  }

  const weeks    = groupByISOWeek(allDays)
  const biweeks  = groupByBiweek(weeks)
  const months   = groupByMonth(allDays, weeks)

  // Always patch daily notes first (idempotent)
  await patchDailyNotes(weeks)

  if (doWeek) {
    for (let i = 0; i < weeks.length; i++) {
      await writeWeeklyNote(weeks[i], weeks[i - 1])
    }
  }

  if (doBiweek) {
    for (const bw of biweeks) {
      await writeBiweeklyNote(bw)
    }
  }

  if (doMonth) {
    for (const mon of months) {
      await writeMonthlyNote(mon)
    }
  }

  console.log(`HealthRoll complete — ${weeks.length} weeks, ${biweeks.length} bi-weeks, ${months.length} months`)
}

main().catch(err => {
  console.error(`HealthRoll error: ${err}`)
  process.exit(1)
})
