#!/usr/bin/env bun
/**
 * HealthRetry — Re-synthesises notes marked status: synthesis-pending.
 * Safe to run at any time; exits with NO_ACTION when Ollama is unreachable.
 *
 * Privacy routing: local Ollama only. Never calls Claude API.
 *
 * Usage:
 *   bun HealthRetry.ts
 */

import { readFile, writeFile, readdir } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { updateIndex } from "./HealthUtils.ts"

const VAULT = process.env.VAULT_ROOT ?? `${process.env.HOME}/Brain`
const HEALTH_WIKI = path.join(VAULT, "04 Health/wiki")
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434"
const MODEL = "qwen3.5:4b"

async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
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

async function retryNote(filePath: string): Promise<void> {
  const content = await readFile(filePath, "utf-8")

  const dateMatch = content.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m)
  if (!dateMatch) return
  const date = dateMatch[1]

  const sourceMatch = content.match(/^source:\s*(.+)/m)
  const source = sourceMatch ? sourceMatch[1].trim() : "unknown"

  const metricsMatch = content.match(/## Metrics\n\n([\s\S]+?)(?:\n##|$)/)
  if (!metricsMatch) return
  const metrics = metricsMatch[1].trim()

  const prompt =
    `Write a concise 2-3 sentence health summary for ${date} based on these metrics:\n\n` +
    `${metrics}\n\n` +
    `Focus on recovery quality and readiness. Do not give advice.`

  const synthesis = await callOllama(prompt)

  const note = `---
source: ${source}
date: ${date}
domain: 04 Health
status: processed
privacy-routing: local
route-to: ${HEALTH_WIKI}
---

# Health Summary — ${date}

## Metrics

${metrics}

## Summary

${synthesis}
`

  await writeFile(filePath, note, "utf-8")
  await updateIndex(date, synthesis, VAULT)
  console.log(`Retried: ${path.basename(filePath)}`)
}

async function main() {
  if (!(await isOllamaReachable())) {
    console.log("NO_ACTION: Ollama unreachable")
    return
  }

  if (!existsSync(HEALTH_WIKI)) {
    console.log("NO_ACTION: wiki directory not found")
    return
  }

  const files = await readdir(HEALTH_WIKI)
  const candidates = files.filter(f => f.endsWith("_health-summary.md"))

  let retried = 0
  let failed = 0
  for (const file of candidates) {
    const filePath = path.join(HEALTH_WIKI, file)
    const content = await readFile(filePath, "utf-8")
    const needsRetry = content.includes("status: synthesis-pending") ||
      content.includes("Synthesis unavailable")
    if (!needsRetry) continue
    try {
      await retryNote(filePath)
      retried++
    } catch (err: unknown) {
      console.error(`Failed to retry ${file}: ${err instanceof Error ? err.message : err}`)
      failed++
    }
  }

  if (retried === 0 && failed === 0) {
    console.log("NO_ACTION: no pending notes found")
    return
  }

  console.log(`Retry complete: ${retried} synthesised, ${failed} failed`)
}

main().catch(err => {
  console.error(`HealthRetry error: ${err}`)
  process.exit(1)
})
