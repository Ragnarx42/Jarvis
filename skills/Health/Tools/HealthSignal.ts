#!/usr/bin/env bun
/**
 * HealthSignal — write a cross-agent signal file to Brain/12 Queue/.
 *
 * Privacy routing: local. No inference.
 *
 * Usage:
 *   bun HealthSignal.ts --signal "Low HRV sustained 3 days" --severity moderate
 *   bun HealthSignal.ts --signal "..." --severity high --recommendation "Block recovery time"
 */

import { writeFile } from "fs/promises"
import { mkdirSync } from "fs"
import path from "path"

const VAULT = `${process.env.HOME}/Brain`
const QUEUE = `${VAULT}/12 Queue`
const LOG = `${VAULT}/14 System/logs/health-signal.log.md`

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

async function main() {
  const signal = arg("signal")
  const severity = (arg("severity") ?? "moderate") as "low" | "moderate" | "high"
  const recommendation = arg("recommendation") ?? "Review health protocol and adjust training load."

  if (!signal) {
    console.error("Usage: bun HealthSignal.ts --signal <message> [--severity low|moderate|high] [--recommendation <text>]")
    process.exit(1)
  }

  const today = new Date().toISOString().slice(0, 10)
  const slug = signal.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40)
  const filename = `${today}_health-signal-${slug}.md`
  const filePath = path.join(QUEUE, filename)

  mkdirSync(QUEUE, { recursive: true })

  const content = `---
source: health-agent
date: ${today}
type: health-signal
severity: ${severity}
domain: 04 Health
privacy-routing: local
status: pending
---
Signal: ${signal}
Recommendation: ${recommendation}
`

  await writeFile(filePath, content, "utf-8")
  console.log(`Signal written: ${filename} [${severity}]`)

  const { appendFile } = await import("fs/promises")
  const logLine = `## [${today}] health-agent | signal | ${filename} | pending\n`
  await appendFile(LOG, logLine, "utf-8")
}

main().catch((err) => {
  console.error(`HealthSignal error: ${err}`)
  process.exit(1)
})
