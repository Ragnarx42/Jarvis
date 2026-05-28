# Jarvis

Private autonomous multi-agent AI system. Runs on owner-controlled hardware in Copenhagen.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun, TypeScript |
| Orchestration | PAI v5 |
| Primary reasoning | Claude API (Opus) |
| Local inference | Ollama — Qwen family |
| Memory | Obsidian vault |

## Privacy routing

Sensitive domains never leave the machine. Finance, health, legal, and family data route to local Ollama only. Claude API is permitted for non-sensitive domains.

## Agents

**Current build — Health Agent**
Ingests Apple Health XML exports. Analyses HRV, classifies severity, writes synthesised notes to the vault. Includes retry mechanism for Ollama recovery and an evaluation harness (2/2 regression cases passing).

**Planned**
- Biohacking
- Stocks Investing
- Personal Assistant
- LinkedIn Editorial

## Structure

```
skills/Health/Tools/    Health agent tools (HealthIngest, HealthRetry, HealthUtils)
brain/14_System/        Evaluation harness, fixtures, suites
src/health/             processHealthExport wrapper
```

## Hard limits

- Nothing deploys without explicit confirmation.
- No autonomous publishing.
- No execution on employer-issued devices.
- Nothing deletes — archive only.
