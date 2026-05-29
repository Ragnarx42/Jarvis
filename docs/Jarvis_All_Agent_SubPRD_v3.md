---
version: "3.0"
status: draft
date: 2026-06-01
parent_prd: "[[Jarvis PAI Foundation PRD v5]]"
owner: Michael Wolff
classification: Private
---

# JARVIS — All-Agent Sub-PRD v3.0

## Introduction

This document defines the requirements for all 20 agents in the Jarvis Private AI Stack. It is a companion to [[Jarvis PAI Foundation PRD v5]]. Foundation-level concerns — vault architecture, NATS topics, queue contract, skill security gate, hard gates, evaluation harness, tracing, and HardGateEnforcer — are defined there and not repeated here.

Each agent section covers: purpose, inputs, outputs, vault contract, inference routing, Discord channel, sub-agents, cross-agent dependencies, success criteria, latency requirements, evaluation strategy, gate implementation, and open issues.

All agents are Supervisors. All capable of spawning sub-agents. No flat worker patterns. Evaluation harness and observability instrumentation are required before any agent build starts.

> Evaluation, tracing, and hard gate implementation are defined in Foundation PRD v5 Sections 15, 16, and 13.3. All agents must conform to those specifications.

---

## Agent 19 — Router Agent

| Field | Value |
|---|---|
| Domain | System |
| Discord | #system |
| Inference Routing | Layer 1: no inference. Layer 2: local embedding model. Layer 3: local Ollama. |
| Phase | 0 — Build now. |
| Readiness | All five questions: YES. Build now. |

### Purpose

The Router Agent is the confidence-scored intermediary between Alfred and all domain agents. No domain agent receives a raw voice command or unrouted signal directly. The Router Agent processes all incoming signals, assigns them to the correct agent with a confidence score, and enforces the routing decision schema.

### Inputs

- NATS event `jarvis.voice.command` from VoiceIn Agent, with `queue_file_path` and transcription.
- NATS events `jarvis.health.signals`, `jarvis.finance.signals`, `jarvis.pa.events` for cross-domain routing.
- `14 System/router/agent-embeddings.json` for embedding similarity matching.
- Routing rules in `14 System/router/rules.yaml` for Layer 1 deterministic matching.

### Outputs

- Routing decision YAML written to `14 System/traces/{trace_id}.yaml` (for confidence below 1.0).
- NATS event `jarvis.routing.decision` with `queue_file_path`, `selected_agent`, `confidence`, `trace_id`.
- For confidence below 0.6: Alfred requests owner clarification. Entry written to `14 System/router/low-confidence-log.md`.

### Vault Contract

- Read: `14 System/router/rules.yaml`, `14 System/router/agent-embeddings.json`, incoming queue files.
- Write: `14 System/traces/`, `14 System/router/low-confidence-log.md`.
- Never writes to domain folders directly.

### Routing Rules — `14 System/router/rules.yaml`

```yaml
rules:
  - pattern: 'hrv|sleep|biometric|health|recovery'
    agent: health-agent
    confidence: 0.99
  - pattern: 'tsmc|stock|position|portfolio|thesis|ticker'
    agent: stocks-investing-agent
    confidence: 0.99
  - pattern: 'calendar|meeting|schedule|email|reminder'
    agent: personal-assistant-agent
    confidence: 0.99
  - pattern: 'linkedin|post|draft|publish|content'
    agent: linkedin-editorial-agent
    confidence: 0.99
  - pattern: 'goal|telos|growth|ideal state|isa'
    agent: growth-agent
    confidence: 0.99
```

### Success Criteria

- Routes every signal to the correct agent with confidence above 0.9 for 95% of production signals.
- Logs every routing decision to `14 System/traces/` with a valid `routing_decision` YAML (for confidence below 1.0).
- Produces clarification request for all signals below 0.6 confidence. Zero silent misroutes.
- Latency p99 below 100ms for Layer 1 rules. Below 500ms for Layer 2 embedding.

### Latency Requirements

- Layer 1 rules: p99 < 100ms.
- Layer 2 embedding similarity: p99 < 500ms.
- Layer 3 Ollama reasoning: p99 < 3000ms.
- End-to-end routing decision (any layer): p99 < 3000ms.

### Evaluation Strategy

- Harness runs 1000 routing decisions using a fixed fixture set covering all Layer 1 rules and 50 ambiguous Layer 2 cases.
- Deterministic mode: embeddings computed offline. No live inference needed for regression runs.
- Assert: confidence >= 0.9 for all Layer 1 fixtures. Assert: `selected_agent` matches `expected_agent`. Assert: trace file written for confidence below 1.0.
- 1000 runs complete in under 2 minutes using 16 parallel workers.

### Gate Implementation

Router Agent has no actions on the hard gate list. No `@hardGate` decorators required. All output is routing metadata written to `14 System/`. No vault domain writes.

---

## Agent 1 — Health Agent

| Field | Value |
|---|---|
| Domain | 04 Health |
| Discord | #health |
| Inference Routing | Local only. Ollama Qwen 3. No data leaves 127.0.0.1. |
| Phase | 1 — Deterministic first. BUG-006 must be resolved before build starts. |
| Readiness | Q1 partial, Q2 partial, Q3 partial, Q4 yes, Q5 missing. Fix before Phase 1 build. |

> See detailed success criteria in [[health-agent-success-criteria]]

### Purpose

Monitors the owner's physiological state, correlates signals across data sources, recommends interventions, and maintains a structured health knowledge base in the vault.

### Inputs

- Apple Health JSON exports from iCloud Drive to `04 Health/raw/`.
- `health-agent-config.yaml` in `14 System/` for baseline thresholds.
- WHOOP API — deferred to Phase 1 sub-build.
- CGM provider API — deferred to Phase 1 sub-build.
- Blood panel PDF exports — deferred to Phase 1 sub-build.

### Outputs

- Wiki notes written to `04 Health/wiki/`. One note per metric type per day.
- Cross-agent signals written to `12 Queue/` with severity tags, `trace_id`, and `confidence`.
- NATS event `jarvis.health.signals` fired after each queue write.
- Proactive alerts to Discord #health and Pulse voice for moderate and high severity.
- Intervention log written to `04 Health/wiki/intervention-log.md`.

### Vault Contract

- Read: `04 Health/raw/`, `14 System/health-agent-config.yaml`.
- Write: `04 Health/wiki/`, `12 Queue/`, `14 System/logs/log.md`, `14 System/traces/`.
- Never write to `04 Health/raw/`. Never read raw data through Claude API.

### Sub-Agents

- Biohacking Correlation Agent (Agent 11). Spawned when three or more data sources have new readings within 24 hours.
- WHOOP Ingest Sub-Agent. Deferred.
- CGM Ingest Sub-Agent. Deferred.

### Cross-Agent Dependencies

- PA Agent reads high severity health signals for schedule adjustments.
- Stocks Agent reads health signals for decision-quality context.
- Morning Digest aggregates digest-only low severity signals.
- Post-Action Evaluator reads `intervention-log.md` to score recommendation quality.

### Open Bugs

| ID | Severity | Description | Resolution Path |
|---|---|---|---|
| BUG-001 | HIGH | Ollama truncates on large exports. | bun/TypeScript pre-processor aggregates by metric type before Ollama. Resolves BUG-002. |
| BUG-002 | MEDIUM | Inconsistent wiki schema. | Resolved by BUG-001 fix. |
| BUG-003 | MEDIUM | wikilink integrity. | kepano enforcement in synthesis prompt plus post-write validator. |
| BUG-004 | MEDIUM | iCloud sync latency. | File size stability check before ingest trigger. |
| BUG-005 | LOW | Silent Ollama timeout. | Try/catch with backoff and #system alert. |
| BUG-006 | HIGH | No deterministic success criteria. Blocks Phase 1. | See `14 System/docs/health-agent-success-criteria.md`. |

### BUG-006 Success Criteria

| Metric | Required Value | Measurement Method |
|---|---|---|
| Schema compliance rate | Above 95% of wiki notes have all required frontmatter fields | Evaluation harness scans wiki notes written during the test run. Counts missing fields. |
| HRV anomaly detection latency | p99 below 2 seconds from synthesis trigger to queue file written | Harness measures time from ingest trigger to queue file fsync confirmation. 1000 runs. |
| trace_id completeness | 100% of queue files include `trace_id` and `confidence`. Zero missing across any 7-day window. | QueueValidator scans all `12 Queue/` files from the prior 7 days and counts missing `trace_id` fields. |

### Success Criteria

- Writes wiki note for every Apple Health export within 60 seconds of confirmed file arrival. Schema compliance above 95%.
- Writes severity-tagged signal to `12 Queue/` for HRV changes above 10% from personal baseline within 2 seconds of synthesis.
- All queue files include `trace_id` and `confidence`. Zero missing `trace_id` across any 7-day window.
- Pre-processor reduces Apple Health JSON to structured summary. No raw JSON with more than 500 entries passed to inference.

### Latency Requirements

- HRV anomaly detection: p99 < 2 seconds.
- Daily wiki note synthesis: p99 < 10 seconds.
- Batch correlation spawn: p99 < 30 seconds.
- iCloud file arrival to queue signal: p99 < 60 seconds.

### Evaluation Strategy

- Use response caching for Ollama synthesis. First run live. Subsequent regression runs use cached responses keyed on `{input_hash, model_version}`.
- 16 parallel workers for regression suite.
- Deterministic test mode: mock vault I/O. Agent code runs unchanged.
- Test fixtures: 10 Apple Health JSON samples of varying size (50 to 1000 entries).

### Gate Implementation

All methods writing to `12 Queue/` after a signal detection must carry `@hardGate` decorator checking that the write domain is `04 Health` or `12 Queue` only. Missing decorators are a Gate 1 static check failure.

---

## Agent 2 — LinkedIn Editorial Agent

| Field | Value |
|---|---|
| Domain | 02 Career |
| Discord | #linkedin |
| Inference Routing | Claude API. No sensitive personal data in prompts. |
| Phase | 2 — Fix success criteria before build. 1-hour task, not a deferral. |
| Readiness | Q1 Partial, Q2 Partial, Q3 Partial (cacheable), Q4 No, Q5 No. Fix metrics then build Phase 2 as planned. |

### Purpose

Researches content angles, maintains the owner's voice corpus, drafts posts, and queues them for human review. Never publishes autonomously.

### Inputs

- LinkedIn post archive seeded into `02 Career/wiki/voice-corpus/`.
- Research triggers from owner or Stocks Agent via `12 Queue/`.
- Macro Signal Sub-Agent outputs for topic angles.

### Outputs

- Draft posts written to `02 Career/drafts/` with frontmatter including `status: draft` and `assistance-level`.
- Voice corpus updates written to `02 Career/wiki/voice-corpus/`.
- Content opportunity signals written to `12 Queue/`.
- Alert to Discord #linkedin with draft summary.

### Vault Contract

- Read: `02 Career/`, `12 Queue/` for incoming signals.
- Write: `02 Career/drafts/`, `02 Career/wiki/voice-corpus/`, `12 Queue/`.
- Never auto-publish to LinkedIn.

### Disclosure Footer Convention

- Lightly assisted: footer reads `Written with light AI assistance.`
- Heavily drafted: footer reads `Drafted with AI, reviewed and approved by me.`
- Assistance level tagged in frontmatter. Footer inserted automatically.

> No AI-generated images. The agent must not suggest, source, or reference AI image generation for any LinkedIn content.

### Sub-Agents

- Voice Corpus Researcher (Agent 10). Runs on schedule and on demand before drafting.
- Research Sub-Agent. Searches for supporting data per post angle. Spawned per draft.

### Open Issues

- Voice corpus seeding not started. Requires manual import of LinkedIn post archive. Blocking Phase 2.
- Research sub-agent source list not defined. Needs approved list before build.

### Success Criteria

- Produces draft post within 30 minutes of a content trigger. Draft frontmatter schema compliance 100%.
- Voice alignment score above 0.75 on cosine similarity check between draft embedding and voice corpus profile embedding.
- Disclosure footer present in every draft. Correct tier based on `assistance-level` tag.
- Zero autonomous publishes. Every draft has `status: draft` when written.

### Latency Requirements

- Content trigger to draft written: p99 < 30 minutes.
- Voice alignment check: p99 < 5 seconds.
- Voice corpus update on new post: p99 < 60 seconds.

### Evaluation Strategy

- Voice alignment is deterministic and cacheable. 1000 regression runs in under 5 minutes using cached Claude API responses.
- Fixture set: 20 draft stubs with known expected voice alignment scores. Assert score above 0.75.
- Gate violation test: attempt to write `status: published` without owner confirmation. Assert `HardGateViolationError` thrown.

### Gate Implementation

The `@hardGate` decorator is required on the `publishPost` method and any method that writes `status: published` to a draft file.

---

## Agent 3 — Stocks Investing Agent

| Field | Value |
|---|---|
| Domain | 03 Finance |
| Discord | #stocks |
| Inference Routing | Claude API with web search. Raw position data stays local. |
| Phase | 4 — Blocked on broker API decision. |
| Readiness | Q1 No, Q2 No, Q3 Partial, Q4 No, Q5 No. Defer to Phase 4. Blocked. |

### Purpose

Maintains position awareness, monitors signals against the owner's investment thesis, surfaces research insights, and flags divergence. Never executes trades.

### Inputs

- Nordnet API or Plaid bridge for current position data. Decision outstanding.
- Investment thesis documents in `03 Finance/wiki/`.
- SEC filings via Claude API web search on demand.
- Macro Signal Sub-Agent outputs. Health Agent signals for decision-quality context.

### Outputs

- Research memos written to `03 Finance/wiki/research/`.
- Signal log entries written to `03 Finance/wiki/signal-log.md`.
- Monitor log entries written to `03 Finance/wiki/monitor-log.md`.
- Content opportunity signals to `12 Queue/` for LinkedIn Editorial Agent.
- NATS event `jarvis.finance.signals` fired after each queue write.

### Vault Contract

- Read: `03 Finance/wiki/`, `03 Finance/raw/`.
- Write: `03 Finance/wiki/research/`, `signal-log.md`, `monitor-log.md`, `12 Queue/`.
- Never write raw position data to any file routed through Claude API.

### Sub-Agents

- Stock Research Sub-Agent (Agent 8). Deep single-company research. Spawned per request.
- Macro Signal Sub-Agent (Agent 9). 4-hour cron macro monitoring.
- Portfolio Monitor Agent (Agent 12). Continuous position watch.

### Open Issues — Blocks Phase 4

- Broker API decision: Nordnet direct vs Plaid bridge. Priority: HIGH. Hard deadline: if not decided by end of Phase 2, Plaid bridge read-only is the default. This unblocks Phase 4 build.
- Investment thesis documents need defined frontmatter schema before agent can parse them.
- Position data stripping logic for Claude API calls needs design before build.
- Success criteria and `@hardGate` decorators must be defined before build. Specifically: trade execution gate.

### Success Criteria

- Writes research memo within 10 minutes of a research trigger. Memo frontmatter schema compliance 100%.
- Detects thesis divergence for any position within 60 minutes of a macro signal or price move above threshold.
- Zero trade execution actions. `@hardGate` decorator on any method touching Nordnet or Plaid write endpoints.
- All queue files include `trace_id` and `confidence`.

### Latency Requirements

- Thesis divergence detection: p99 < 60 minutes from macro signal.
- Research memo synthesis: p99 < 10 minutes.
- Position data read from broker API: p99 < 5 seconds.

### Evaluation Strategy

- Mock broker API for all regression runs. Position data fixtures in `14 System/evaluation/suites/stocks/fixtures/`.
- 16 parallel workers. 1000 runs in under 5 minutes using cached Claude API responses.
- Gate violation test: attempt to call broker write endpoint. Assert `HardGateViolationError`.

### Gate Implementation

The `@hardGate` decorator is required on any method that touches Nordnet or Plaid write endpoints, any method writing `status: execute-order` to a queue file, and any method that moves money.

---

## Agent 4 — Personal Assistant Agent

| Field | Value |
|---|---|
| Domain | Multiple |
| Discord | #assistant |
| Inference Routing | Mixed. Legal and family context via local Ollama. Calendar and scheduling via Claude API. |
| Phase | 4 — Planned. |
| Readiness | Q1 Partial, Q2 Partial, Q3 Yes, Q4 No, Q5 No. Defer to Phase 4. |

### Purpose

Manages calendar, email, messaging, reminders, and document handling. Full autonomy on routine tasks within standing rules.

### Standing Rules — Full Autonomy

- Calendar changes not conflicting with existing blocks within 08:00 to 19:00 Copenhagen.
- Email drafts queued for review. Never sent autonomously.
- Reminders and notifications set per owner preferences.

### Inputs

- Calendar events via Google Calendar MCP.
- Email via Protonmail Bridge (primary) and Gmail read-only (fallback).
- Incoming signals from `12 Queue/` from Health and Stocks Agents.
- WhatsApp and Telegram messages via PAI messaging skills.

### Outputs

- Calendar events created or modified under standing rules.
- Email drafts written to outbox queue in `14 System/`.
- Cross-agent signals to `12 Queue/` when calendar events affect other domains.
- NATS event `jarvis.pa.events` after each queue write.
- Alerts to Discord #assistant for pending owner decisions.

### Vault Contract

- Read: all domain folders for context. Never reads `03 Finance` raw data through Claude API.
- Write: `11 Daily/`, `05 Legal/wiki/` (local routing), `07 Family/` (local routing), `12 Queue/`.
- Never autonomously delete emails, calendar events, or vault files.

### Sub-Agents

- Calendar Orchestrator (Agent 13). Scheduling logic and conflict resolution.
- Document Handler Sub-Agent. Processes incoming documents and routes to vault.

### Open Issues

- WhatsApp vs Telegram primary channel. Decision outstanding.
- Protonmail Bridge token refresh strategy not designed.
- p99 latency not defined. Must be defined before Phase 4 build.

### Success Criteria

- Creates or modifies calendar event within 30 seconds of a standing-rule-eligible scheduling request.
- Email drafts written with correct frontmatter and `status: draft` within 2 minutes of email trigger.
- Zero autonomous email sends. Zero autonomous LinkedIn publishes. `@hardGate` on all send and publish methods.
- Cross-agent queue signals include `trace_id` and `confidence`.

### Latency Requirements

- Calendar event creation under standing rules: p99 < 30 seconds.
- Email draft writing: p99 < 2 minutes.
- Queue signal propagation after calendar change: p99 < 5 seconds.

### Evaluation Strategy

- Mock Google Calendar MCP for regression runs.
- Mock Protonmail Bridge for email draft tests.
- 16 parallel workers. Fixture set: 50 scheduling requests, 20 email triggers.
- Gate violation test: attempt to call send method directly. Assert `HardGateViolationError`.

### Gate Implementation

The `@hardGate` decorator is required on any method that sends an email, publishes any content, or deletes a vault file.

---

## Agent 5 — Morning Digest Agent

| Field | Value |
|---|---|
| Domain | Cross-domain |
| Discord | #morning-digest |
| Inference Routing | Claude API. Synthesis from vault summaries only. No raw sensitive data in prompts. |
| Phase | 2 — Build after Health Agent Phase 1 complete. |
| Readiness | All five questions: YES. Build after Health Agent. |

### Purpose

Synthesises signals from all three domains into a single daily briefing at 06:00. Aggregates all low severity digest-only signals from the prior 24 hours.

### Inputs

- NATS event `jarvis.digest.trigger` at 06:00.
- All `12 Queue/` files with `status: digest-only` from the prior 24 hours.
- `04 Health/wiki/`, `03 Finance/wiki/monitor-log.md`, `02 Career/drafts/`, `11 Daily/`.
- `14 System/signal-state.json` for suppressed signal inventory.

### Outputs

- Structured Markdown briefing written to `11 Daily/digest-YYYY-MM-DD.md`.
- Digest log entry written to `11 Daily/digest-log.md`.
- Posted to Discord #morning-digest.
- Alfred reads condensed spoken version via Pulse at 06:00.

### Briefing Structure

1. Health summary. Key overnight metrics. Readiness score. Suppressed nudges.
2. Portfolio status. Positions vs thesis. Open monitor flags.
3. LinkedIn. Pending drafts. Content opportunities from prior day.
4. Calendar. First three events of the day.
5. Suppressed signals. All low severity from prior 24 hours, one line each.
6. ISA score. Current score and 7-day trend direction.

### Success Criteria

- Briefing delivered to Discord #morning-digest by 06:05. Zero missed deliveries across any 30-day window.
- Briefing Markdown written to `11 Daily/digest-YYYY-MM-DD.md` with all six sections present. Schema compliance 100%.
- All digest-only queue signals from the prior 24 hours included. Zero missed suppressed signals.
- Pulse voice delivery confirmed by Pulse daemon acknowledgement within 60 seconds of 06:00.

### Latency Requirements

- Full briefing synthesis: p99 < 5 seconds.
- Queue file aggregation: p99 < 2 seconds.
- Discord post delivery: p99 < 10 seconds.

### Evaluation Strategy

- Evaluation harness runs 1000 briefing syntheses using cached Claude API responses. 16 workers. Under 3 minutes.
- Fixture set: 30 days of simulated queue files with varying suppressed signal counts. Assert all six sections present.
- No gate violations possible: Morning Digest has no irreversible actions.

### Gate Implementation

No `@hardGate` decorators required. Morning Digest has no irreversible actions. All output is vault writes and Discord posts.

---

## Agent 6 — Hermes / Autonomous Curator Agent

| Field | Value |
|---|---|
| Domain | System |
| Discord | #system |
| Inference Routing | Local Ollama for gap detection. Claude API for skill writing. |
| Phase | 1 — Deterministic post-action evaluation first. Autonomy deferred. |
| Readiness | Q1 No, Q2 No, Q3 No, Q4 No, Q5 Partial. Build deterministic sub-skills first. |

### Purpose

Detects skill gaps post-session, runs constitutional critique loops, writes or improves skills autonomously, and evaluates agent actions against outcomes. Autonomy is deferred until deterministic post-action evaluation is proven.

### Build Sequence for Phase 1

1. Build Post-Action Evaluator sub-skill (Agent 18 — deterministic, testable, no autonomy). Prove it works before any autonomous capability is added to the Curator.
2. Build Skill Quality Reviewer gate (Agent 14 — deterministic, testable).
3. Add constitutional critique loop (LLM-based, after Steps 1 and 2 are stable).
4. Add autonomous skill writing (highest risk, last).

### Inputs

- NATS event `jarvis.session.end` with `session_id`, agent name, and `log_path`.
- `14 System/skills/manifest.json`. `ERRORS.md` files in each agent project.
- Post-action evaluation outputs from domain wiki logs.

### Outputs

- New or improved skill files staged to `14 System/skills/active/` pending gate review.
- Skill improvement proposals written to `14 System/proposals/`.
- Post-action evaluation scores written to domain wiki logs.
- Alerts to #system when a skill gap is detected or proposal is ready.

### Sub-Agents

- Post-Action Evaluator (Agent 18). Nightly cron. Scores agent signal quality.
- Skill Quality Reviewer (Agent 14). Runs both security gates.
- Cursor Coding Agent (Agent 20). Spawned for code generation tasks.

### Success Criteria

- Post-Action Evaluator sub-skill scores 100% of agent signals with a corresponding outcome within the evaluation window.
- Skill gap detection fires within 60 minutes of `jarvis.session.end` for sessions where the log shows a repeated error pattern.
- Zero skills deployed to active directory without both gate passes.

### Latency Requirements

- Post-action evaluation nightly run: p99 < 30 seconds.
- Skill gap detection per session: p99 < 60 minutes.
- Skill Quality Reviewer full gate cycle: p99 < 10 seconds.

### Gate Implementation

The `@hardGate` decorator is required on any Hermes method that writes to `14 System/skills/active/` directly. All skill deployment must pass through Skill Quality Reviewer. Direct writes to `active/` without gate pass are a hard gate violation.

---

## Agent 7 — File Ingest Agent

| Field | Value |
|---|---|
| Domain | 00 Inbox |
| Discord | #system |
| Inference Routing | Local Ollama. Classification inference stays on device. |
| Phase | 0 — Active. |
| Readiness | All five questions: YES. Operational. |

### Purpose

Classifies incoming files, generates frontmatter, routes to the correct vault domain, updates `index.md`, and appends to `log.md`. Primary intake for all unstructured documents entering the vault.

### Inputs

- Files arriving in `00 Inbox/raw/` from iCloud Drive, Google Drive, or manual drop.
- File metadata: name, extension, size, creation date.

### Outputs

- File moved from `00 Inbox/raw/` to correct domain `raw/` folder.
- Wiki note generated and written to correct domain `wiki/` folder.
- Domain `index.md` updated. Domain `log.md` appended.
- Low confidence: pending note to `00 Inbox/wiki/` tagged `status: unclassified`.

### Open Issues

- Low confidence threshold not yet calibrated. Needs 30 days of real ingest data.
- Scanned PDFs without OCR layer will fail classification.

### Success Criteria

- Classifies and routes 100% of files arriving in `00 Inbox/raw/` within 2 seconds of file size stability confirmation.
- Wiki note written with correct frontmatter schema compliance above 98%.
- Low confidence files written to `00 Inbox/wiki/` as `status: unclassified` within 2 seconds. Zero silent failures.
- Domain `index.md` updated for every ingest. Zero orphaned wiki notes without an index entry.

### Latency Requirements

- File classification: p99 < 2 seconds.
- Wiki note generation: p99 < 5 seconds.
- Full pipeline (arrival to index update): p99 < 10 seconds.

### Evaluation Strategy

- Mock filesystem for all regression runs. Fixture set: 50 files of varying type, size, and domain.
- 16 parallel workers. 1000 classification runs in under 2 minutes.
- No LLM calls in happy path for simple file types. Ollama only for ambiguous content.

### Gate Implementation

No `@hardGate` decorators required. File Ingest has no irreversible actions.

---

## Agent 8 — Stock Research Sub-Agent

| Field | Value |
|---|---|
| Domain | 03 Finance |
| Discord | #stocks |
| Inference Routing | Claude API with web search. No raw position data in prompts. |
| Phase | 4 — Planned under Stocks Agent. |
| Readiness | Blocked by Stocks Agent broker API decision. |

### Purpose

Deep single-company research on demand. SEC filings, earnings transcripts, analyst reports, competitive landscape. Spawned by the Stocks Investing Agent per research request.

### Inputs

- Research request from Stocks Agent via `12 Queue/` with ticker, research type, and context.
- Investment thesis for the target from `03 Finance/wiki/`.
- Claude API web search for SEC filings, earnings, recent news.

### Outputs

- Research memo written to `03 Finance/wiki/research/{ticker}-YYYY-MM-DD.md`.
- Signal entry written to `03 Finance/wiki/signal-log.md`.
- Summary alert to Discord #stocks.

### Vault Contract

- Read: `03 Finance/wiki/` for thesis context.
- Write: `03 Finance/wiki/research/`, `03 Finance/wiki/signal-log.md`.
- Never writes raw position data. Memos contain analysis only.

### Success Criteria

- Memo written within 10 minutes of research trigger. Schema compliance 100%.
- Signal log entry written with `trace_id` and `confidence`.

### Latency Requirements

- Research memo synthesis: p99 < 10 minutes.

### Evaluation Strategy

- Mock Claude API web search responses. Cache for regression. 1000 runs under 5 minutes.
- Gate violation test: attempt to write position data to memo. Assert `HardGateViolationError`.

### Gate Implementation

No trade execution actions. No `@hardGate` required beyond Stocks Agent parent gates.

---

## Agent 9 — Macro Signal Sub-Agent

| Field | Value |
|---|---|
| Domain | 03 Finance |
| Discord | #stocks |
| Inference Routing | Claude API with web search. |
| Phase | 4 — Planned. |
| Readiness | Q1 Yes, Q2 Yes, Q3 Partial (cache), Q4 Yes (30s). Deterministic first. |

### Purpose

Monitors geopolitical developments, trade policy, central bank decisions, and technology shifts. Maps macro signals to specific equities and sectors in the owner's portfolio. Runs on a 4-hour cron and on demand when high severity news breaks.

### Inputs

- Claude API web search on a rotating topic list derived from the investment thesis.
- Portfolio and watchlist from `03 Finance/wiki/`.
- Prior macro signal notes in `03 Finance/wiki/macro/` for context continuity.

### Outputs

- Macro signal notes written to `03 Finance/wiki/macro/YYYY-MM-DD-{topic}.md`.
- Queue signals written to `12 Queue/`. NATS event `jarvis.finance.signals`.
- Discord #stocks alert for moderate and high severity macro signals.

### Vault Contract

- Read: `03 Finance/wiki/` for thesis and watchlist context.
- Write: `03 Finance/wiki/macro/`, `12 Queue/`.

### Success Criteria

- Completes one full macro scan in under 30 seconds per 4-hour cron. All notes written with correct frontmatter.
- Signals written to `12 Queue/` with `trace_id` and `confidence` for every macro finding above low severity.

### Latency Requirements

- Full macro scan: p99 < 30 seconds.
- Queue signal write: p99 < 2 seconds.

### Evaluation Strategy

- Mock Claude API web search. Cache per topic-date. 1000 cron simulations in under 5 minutes.

### Gate Implementation

No irreversible actions. No `@hardGate` required beyond Stocks Agent parent gates.

---

## Agent 10 — Voice Corpus Researcher

| Field | Value |
|---|---|
| Domain | 02 Career |
| Discord | #linkedin |
| Inference Routing | Claude API. |
| Phase | 2 — Sub-agent under LinkedIn Editorial. |
| Readiness | Blocked by voice corpus import. Owner action required. |

### Purpose

Builds and maintains a structured voice profile from the owner's existing LinkedIn posts and long-form writing samples. Used by LinkedIn Editorial to ensure all drafted content matches the owner's authentic voice.

### Inputs

- LinkedIn post archive in `02 Career/wiki/voice-corpus/raw/`.
- Long-form writing samples: articles, reports, presentations.
- New posts added to archive after publication.

### Outputs

- Voice profile at `02 Career/wiki/voice-corpus/profile.md`.
- Version history in `02 Career/wiki/voice-corpus/history/`.
- Discord #linkedin alert when profile is updated.

### Voice Profile Schema

- Signature phrases. High-frequency phrases in authentic writing.
- Structural patterns. Average post length, typical opening and closing structures.
- Topic clusters. Subjects written about with authority and frequency.
- Tone markers. Direct challenge style, absence of hedging language.
- Anti-patterns. Phrases appearing in generic AI content but never in authentic writing.

### Vault Contract

- Read: `02 Career/wiki/voice-corpus/raw/`.
- Write: `02 Career/wiki/voice-corpus/profile.md`, `history/`.

### Success Criteria

- Voice profile updated within 60 seconds of a new post added to archive.
- Cosine similarity between profile embedding and new post above 0.70 for authentic posts.
- Anti-patterns list updated with at least one new pattern per 10 posts analysed.

### Latency Requirements

- Profile update from new post: p99 < 60 seconds.

### Gate Implementation

No irreversible actions. No `@hardGate` required.

---

## Agent 11 — Biohacking Correlation Agent

| Field | Value |
|---|---|
| Domain | 04 Health |
| Discord | #health |
| Inference Routing | Local Ollama only. All biometric data stays on device. |
| Phase | 4 sub-build. After Health Agent Phase 1 stable. |

### Purpose

Multi-signal analysis across HRV, sleep, CGM readings, blood panel markers, and training load. Identifies patterns that single-signal monitoring misses. Recommends targeted interventions. Builds a longitudinal physiological model.

### Inputs

- `04 Health/wiki/` daily notes from the Health Agent.
- `04 Health/raw/` for direct metric access.
- `health-agent-config.yaml` for personal baselines.

### Outputs

- Correlation analysis notes to `04 Health/wiki/correlations/YYYY-MM-DD.md`.
- Intervention recommendations to `04 Health/wiki/interventions/`.
- High confidence patterns to `04 Health/wiki/patterns/`.
- Moderate and high severity signals to `12 Queue/`.
- Discord #health alerts for significant correlation findings.

### Example Correlations

- HRV below 45ms AND CGM overnight excursions above 7.0 mmol/L: next-day cognitive performance likely impaired. Flag to PA Agent.
- Three nights sleep efficiency below 80% AND elevated resting HR: reduce training load 48 hours.

### Vault Contract

- Read: `04 Health/wiki/`, `04 Health/raw/`, `14 System/health-agent-config.yaml`.
- Write: `04 Health/wiki/correlations/`, `interventions/`, `patterns/`, `12 Queue/`.
- All inference strictly local. No biometric data through Claude API.

### Success Criteria

- Produces correlation analysis note within 30 seconds of a three-source data trigger.
- Correlation notes written with correct frontmatter and `trace_id`. Schema compliance above 95%.
- Intervention recommendations written within 60 seconds of high-confidence correlation.

### Latency Requirements

- Three-source correlation trigger to analysis note: p99 < 30 seconds.
- Batch correlation on full 7-day history: p99 < 60 seconds.

### Gate Implementation

No irreversible actions. No `@hardGate` required. All inference strictly local.

---

## Agent 12 — Portfolio Monitor Agent

| Field | Value |
|---|---|
| Domain | 03 Finance |
| Discord | #stocks |
| Inference Routing | Claude API. Raw position data stripped before API calls. |
| Phase | 4 — Planned. |
| Readiness | Q1 Yes, Q2 Yes, Q3 Yes (mock API), Q4 Yes (5s). Deterministic first. |

### Purpose

Continuous position watch against the owner's investment thesis. Flags when a position moves outside thesis parameters, when new information materially changes the thesis case, or when a holding crosses defined price thresholds.

### Inputs

- Position data from Nordnet API or Plaid bridge. Local read only.
- Investment thesis documents from `03 Finance/wiki/`.
- Macro Signal Sub-Agent outputs from `12 Queue/`.
- Stock Research memos from `03 Finance/wiki/research/`.

### Outputs

- Monitor log entries in `03 Finance/wiki/monitor-log.md`.
- Moderate severity signals to `12 Queue/` for review.
- High severity signals to Discord #stocks and WhatsApp immediately.
- NATS event `jarvis.finance.signals` after each queue write.

### Threshold Configuration — `14 System/finance-monitor-config.yaml`

- Default: flag on 5% single-day move in any holding.
- Thesis divergence: triggered when macro signal directly contradicts thesis for a holding.
- Time-based review: flag any holding not reviewed in vault within 30 days.

### Vault Contract

- Read: `03 Finance/wiki/`, `12 Queue/` for macro signals.
- Write: `03 Finance/wiki/monitor-log.md`, `12 Queue/`.
- Raw position data never written to vault in identifiable form.

### Success Criteria

- Detects any position move above threshold within 5 seconds of position data refresh.
- Flags thesis divergence within 60 minutes of a relevant macro signal.
- Monitor log entry written with `trace_id` and `confidence`. Schema compliance 100%.

### Latency Requirements

- Price move detection: p99 < 5 seconds.
- Thesis divergence flag: p99 < 60 minutes.

### Evaluation Strategy

- Mock Nordnet or Plaid API with position fixtures. 1000 monitoring cycles in under 5 minutes.
- Gate violation test: attempt to write `execute-order` to queue. Assert `HardGateViolationError`.

### Gate Implementation

The `@hardGate` decorator is required on any method that writes to a queue file with `type: trade` or `type: execute-order`. Position reads have no gate.

---

## Agent 13 — Calendar Orchestrator

| Field | Value |
|---|---|
| Domain | Multiple |
| Discord | #assistant |
| Inference Routing | Claude API for scheduling logic. Health context read locally. |
| Phase | 4 — Sub-agent under PA Agent. |
| Readiness | Q1 Yes, Q2 Yes, Q3 Yes, Q4 Yes (2s), Q5 Yes. Build when PA Agent starts. |

### Purpose

Manages scheduling decisions. Reads health signals before booking intensive work or exercise. Resolves conflicts under standing rules. Flags genuine ambiguities to the owner.

### Inputs

- Calendar state via Google Calendar MCP.
- Health signals from `12 Queue/` for energy and readiness context.
- Standing rules from `14 System/calendar-rules.yaml`.
- Incoming scheduling requests from PA Agent and VoiceIn Agent.

### Outputs

- Calendar events created or modified under standing rules.
- Conflict alerts to `12 Queue/` and Discord #assistant when rules do not resolve a conflict.
- Schedule adjustment recommendations to Health Agent when calendar pressure correlates with poor recovery data.

### Standing Rules — `14 System/calendar-rules.yaml`

- No intensive cognitive work before 08:00 or after 20:00 Copenhagen.
- Deep work blocks: minimum 90 minutes. No meetings within them.
- If HRV below personal baseline, defer optional high-intensity exercise 24 hours.
- Travel days: no same-day meetings on arrival day unless pre-existing.

### Vault Contract

- Read: `12 Queue/` for health signals, `14 System/calendar-rules.yaml`.
- Write: `12 Queue/` for conflict flags, `11 Daily/` for schedule notes.

### Success Criteria

- Resolves 100% of standing-rule-eligible scheduling requests within 2 seconds.
- Conflict alerts written to `12 Queue/` with `trace_id` for any request it cannot resolve under standing rules.
- Zero scheduled events outside defined working hours without explicit owner confirmation.

### Latency Requirements

- Standing rule resolution: p99 < 2 seconds.
- Conflict detection: p99 < 500ms.

### Evaluation Strategy

- Mock Google Calendar MCP. Fixture set: 50 scheduling scenarios including conflicts.
- Assert correct resolution or conflict alert. 1000 runs under 2 minutes.

### Gate Implementation

The `@hardGate` decorator is required on any scheduling method that creates events outside standing hours or overrides existing blocks without explicit confirmation.

---

## Agent 14 — Skill Quality Reviewer

| Field | Value |
|---|---|
| Domain | System |
| Discord | #system |
| Inference Routing | Gate 1: static AST scan. Gate 2: local Ollama Qwen 3. |
| Phase | 1 — Build in Phase 1. |
| Readiness | All five questions: YES. Build in Phase 1. |

### Purpose

Gating mechanism for all skill installation and updates. Runs Gate 1 static check and Gate 2 Ollama reasoning. Registers passing skills in the manifest. Blocks and quarantines failing skills. No skill reaches the active directory without passing through it.

### Gate 1 — Static Check

- AST scan of `index.ts`. Runs in under one second.
- Checks: no writes outside declared vault paths, no employer domain strings, no hardcoded secrets, no unapproved outbound network calls, all irreversible methods carry `@hardGate` decorator.
- Pass: proceed to Gate 2. Fail: quarantine and alert.

### Gate 2 — Ollama Reasoning Gate

- Qwen 3 reads full skill source and `skill.yaml`.
- Three binary questions: privacy routing violation, hard gate action attempt, out-of-scope writes.
- All three must return no. Any yes quarantines the skill.

### On Pass

- Skill registered in `14 System/skills/manifest.json` with checksum and gate date.
- Skillcheck log written to `14 System/Skillchecks/YYYY-MM-DD-{skill}-pass.md`.
- Discord #system notification.

### On Failure

- Skill moved to `14 System/skills/quarantine/`.
- Skillcheck log written with failure reason.
- Discord #system alert. Alfred alerts via Pulse.
- Owner reviews quarantine. No automated override path.

### Vault Contract

- Read: `14 System/skills/active/` pending directory, `manifest.json`.
- Write: `14 System/skills/active/` (on pass), `quarantine/` (on fail), `Skillchecks/`, `manifest.json`.

### Success Criteria

- Gate 1 static check completes in under 1 second for any skill under 2000 lines.
- Gate 2 Ollama reasoning completes in under 10 seconds.
- Zero skills promoted to `active/` without both gates passing. Verified by `manifest.json` `gate-status` field.
- Every gate outcome writes a Skillcheck log.

### Latency Requirements

- Gate 1: p99 < 1 second.
- Gate 2: p99 < 10 seconds.
- Full gate cycle: p99 < 12 seconds.

### Evaluation Strategy

- Fixture set: 20 valid skills, 10 privacy-violating skills, 5 hard-gate-violating skills. Assert correct pass/fail for each.
- All 35 fixtures run in under 1 minute.
- Gate 2 responses cached for regression after first live run.

### Gate Implementation

The Skill Quality Reviewer itself cannot be modified by any skill that has not already passed its own gate. Circular dependency prevention enforced at the PAI session level.

---

## Agent 15 — Growth Agent

| Field | Value |
|---|---|
| Domain | 16 Growth |
| Discord | #growth |
| Inference Routing | Claude API. Telos files are not sensitive personal data. |
| Phase | 5 — Planned. |
| Readiness | Q1 Yes (weekly report), Q2 Yes, Q3 Yes, Q4 Yes (60s), Q5 Yes. |

### Purpose

Tracks personal development, learning, and goal completion against the owner's Telos. Authors the weekly ISA delta report. Surfaces insights about movement toward or away from the Ideal State.

### Inputs

- Telos files from `~/.claude/PAI/USER/TELOS/`.
- `16 Growth/` vault notes for logged progress entries.
- Post-action evaluation outputs from Hermes Curator.
- ISA score history from NATS topic `jarvis.isa.score`.
- `14 System/logs/log.md` for session activity volume.

### Outputs

- Weekly ISA delta report written to `16 Growth/weekly-deltas/YYYY-MM-DD.md` every Sunday at 07:00.
- Goal progress notes to `16 Growth/`.
- Telos drift alert to `12 Queue/` and Discord #growth when a stated goal is neglected for more than 14 days.
- Alfred reads condensed weekly report via Pulse on Sunday at 07:00.

### Weekly Delta Report Structure

1. ISA score trend for the week. Score delta from prior Sunday.
2. Per-Telos-goal summary. Progress, regression, or no change.
3. Dimension breakdown. Which ISA dimensions moved and in which direction.
4. Recommended focus area for the coming week. One specific actionable suggestion.
5. System performance note. Whether agents are operating within expected parameters.

### ISA Score Dimensions

| Dimension | Data Source | Weight | Calculation |
|---|---|---|---|
| Sleep quality | `04 Health/wiki/` | 25% | 7-day rolling average vs personal baseline |
| Portfolio vs thesis | `03 Finance/wiki/monitor-log.md` | 25% | Fraction of positions matching active thesis |
| LinkedIn engagement | `02 Career/wiki/` | 20% | 3-post rolling average vs 90-day baseline |
| Telos goal completion | `16 Growth/GOALS.md` | 30% | Fraction of active goals with progress note in last 7 days |

> ISA score weights are initial defaults. Review and tune after 90 days of real data at Phase 5.

### Vault Contract

- Read: `16 Growth/`, `~/.claude/PAI/USER/TELOS/`, `04 Health/wiki/`, `03 Finance/wiki/monitor-log.md`, `02 Career/wiki/`, `14 System/logs/log.md`.
- Write: `16 Growth/weekly-deltas/`, `16 Growth/` (goal progress notes), `12 Queue/`.

### Success Criteria

- Weekly ISA delta report written to `16 Growth/weekly-deltas/YYYY-MM-DD.md` by 07:05 every Sunday. Zero missed reports across any 30-day window.
- Report contains all five sections.
- Alfred reads report aloud via Pulse by 07:10 Sunday.
- Telos drift alert fires within 24 hours of a goal reaching 14 days of vault inactivity.

### Latency Requirements

- Weekly report synthesis: p99 < 60 seconds.
- ISA score calculation: p99 < 5 seconds.
- Telos drift detection: p99 < 10 seconds.

### Evaluation Strategy

- Mock vault data covering 30 days of simulated activity. 1000 ISA score calculations in under 2 minutes.
- Cache Claude API responses for report synthesis regression runs.
- Assert all five report sections present, ISA score within expected range, drift alerts fire on correct schedule.

### Gate Implementation

No irreversible actions. No `@hardGate` required. All output is vault writes and Discord posts.

---

## Agent 16 — VoiceIn Agent

| Field | Value |
|---|---|
| Domain | System |
| Discord | #system |
| Inference Routing | Local. openWakeWord and faster-whisper on-device. |
| Phase | 1 — Build in Phase 1. |
| Readiness | All five questions: YES. |

### Purpose

Captures spoken commands after wake word detection. Transcribes via faster-whisper. Writes to `12 Queue/` as VoiceCommand. Fires NATS event to Router Agent.

### Inputs

- openWakeWord wake phrase detection on Apple Silicon audio input.
- faster-whisper transcription via WebSocket on localhost:31339.

### Outputs

- VoiceCommand queue file written to `12 Queue/` with transcription, `priority: high`, `trace_id`.
- NATS event `jarvis.voice.command` fired to Router Agent.
- Alfred spoken acknowledgement via Pulse.

### Success Criteria

- Wake word detected and transcription written to queue within 500ms of spoken command completion.
- Queue file includes `trace_id`, `confidence`, and correct `priority: high` frontmatter.
- Zero silent failures. All timeout and transcription errors written to `14 System/logs/log.md` and alerted to #system.

### Latency Requirements

- Wake word detection to queue write: p99 < 500ms.
- Pulse acknowledgement: p99 < 1 second.

### Evaluation Strategy

- Fixture audio files for regression. Assert queue file schema compliance. Assert NATS event fired after queue write (not before).
- No LLM calls in this agent. All inference local. 1000 runs under 1 minute.

### Gate Implementation

No irreversible actions. No `@hardGate` required.

---

## Agent 17 — QueueValidator Agent

| Field | Value |
|---|---|
| Domain | System |
| Discord | #system |
| Phase | 0 — Build now. |
| Readiness | All five questions: YES. |

### Purpose

Hourly reconciliation of NATS event logs against `12 Queue/` files and `14 System/traces/`. Flags contract violations. Enforces queue-first write contract and `trace_id` completeness.

### Checks

- Every NATS event has a corresponding queue file with matching `trace_id`.
- Every queue file has a corresponding trace file in `14 System/traces/`.
- Every NATS event includes `trace_id` field. Missing `trace_id` is flagged HIGH.
- Orphaned NATS event (no queue file after grace period): HIGH severity to #system.
- Orphaned queue file (no NATS event): MODERATE.
- NATS event with no trace file: MODERATE.

> The 90-second grace period is configurable in `14 System/queue-validator-config.yaml` under `grace_period_seconds`. Set to 90 for the transition period. Set to 0 once all agents conform to queue-first contract.

### Success Criteria

- Completes full 60-minute window reconciliation in under 60 seconds.
- Flags 100% of contract violations within the reconciliation window. Zero missed violations.
- All discrepancies written to `14 System/logs/queue-reconciliation.md` with `trace_id`, agent, and violation type.

### Latency Requirements

- Full 60-minute window reconciliation: p99 < 60 seconds.
- Individual event check: p99 < 100ms.

### Evaluation Strategy

- Fixture set: 50 NATS event logs with injected violations. Assert 100% detection rate.
- 1000 validation runs under 2 minutes.

### Gate Implementation

No irreversible actions. No `@hardGate` required. Read-only access to NATS logs and queue files.

---

## Agent 18 — Post-Action Evaluator

| Field | Value |
|---|---|
| Domain | Cross-domain |
| Discord | #stocks + #growth |
| Phase | 2 — Build after Health Agent stable. |
| Readiness | All five questions: YES. Deterministic. |

### Purpose

Nightly sub-skill under Hermes Curator. Scores agent actions against measurable outcomes. Deterministic. Feeds ISA score and Curator improvement loop.

| Agent | Action Type | Outcome Measured | Window | Output |
|---|---|---|---|---|
| Stocks Agent | Research signal | Position P/L since signal | 7 and 30 days | `03 Finance/wiki/signal-log.md` |
| Portfolio Monitor | Thesis divergence flag | Position reviewed and change made | 7 days | `03 Finance/wiki/monitor-log.md` |
| Morning Digest | Briefing delivery | Vault activity in 24 hours after | 24 hours | `11 Daily/digest-log.md` |
| Health Agent | Intervention recommendation | Next-day HRV and sleep change | 24-48 hours | `04 Health/wiki/intervention-log.md` |

### Success Criteria

- Scores 100% of agent signals with a resolvable outcome within the evaluation window. Zero unscored signals where an outcome exists.
- Evaluation log entries written with `trace_id`, `action_trace_id`, `outcome_value`, and `quality_score` fields.
- Nightly run completes by 02:00. Zero missed nightly runs.

### Latency Requirements

- Full nightly evaluation run: p99 < 30 seconds.
- Single signal evaluation: p99 < 500ms.

### Evaluation Strategy

- Fixture set: 100 past signals with known outcomes. Assert correct quality scores. Assert 100% coverage of scoreable signals.
- 1000 evaluation runs in under 3 minutes. Deterministic: no LLM calls needed for outcome scoring.

### Gate Implementation

No irreversible actions. No `@hardGate` required. Read-only access to domain wiki logs.

---

## Agent 20 — Cursor Coding Agent

| Field | Value |
|---|---|
| Domain | System / 08 IT |
| Discord | #system |
| Inference Routing | Claude API with Privacy Mode enabled. Never used for 04 Health, 05 Legal, or 07 Family. |
| Phase | 7 — After self-coding patterns proven in Phase 6. |
| Invocation | Queue-first. Spawned by Hermes Curator (6) or Skill Quality Reviewer (14). |
| Readiness | Q1 Yes (staged output), Q2 Yes, Q3 Yes, Q4 TBD, Q5 Yes. Build in Phase 7. |

### Purpose

Executes approved code generation, refactoring, and test writing tasks within the Jarvis skill and agent codebase. All output staged. Never deploys autonomously.

### Invocation Contract

1. Hermes or Skill Quality Reviewer writes CodingTask entry to `12 Queue/` with `task_type`, `target_path`, `specification`, and `context`.
2. Queue file written and fsynced. NATS event `jarvis.system.coding-task` fired.
3. Cursor Coding Agent reads queue file. Executes via Cursor CLI: `cursor-agent -p <spec-file>`.
4. Result written to `08 IT/output/{task-id}/`. Completion entry written to `12 Queue/`.
5. Hermes routes result through Skill Quality Reviewer before any file reaches active skills directory.

### Privacy Routing Rules

- Claude API with Privacy Mode enabled for all inference.
- Never invoked for tasks involving `04 Health`, `05 Legal`, or `07 Family` domain code or data.
- Task specification passed to Cursor CLI must not include raw health data, position data, or legal documents as context.
- If a CodingTask queue file specifies a `privacy-routing: local` domain, the agent rejects the task and writes an error entry to `12 Queue/`. Hermes routes the task to local Ollama instead.

### Hard Gates

| Action | Gate | Rationale |
|---|---|---|
| Merging generated code without inline human review | BLOCKED | All changes require owner approval before merge. |
| Generating code that executes trade orders or money movement | BLOCKED | Hard gate list from Foundation PRD. |
| Generating code that publishes to LinkedIn without human gate | BLOCKED | Autonomous publishing rejected at all layers. |
| Writing generated output directly to `14 System/skills/active/` | BLOCKED | All output staged to `08 IT/output/`. Skill Quality Reviewer controls promotion. |
| Using context from 04 Health, 05 Legal, or 07 Family domains | BLOCKED | Privacy Mode does not guarantee these domains are safe for API routing. |

### Code Quality Requirements

- TypeScript only. Never Python unless explicitly approved per session.
- `bun/bunx` as the runtime. Never `npm` or `node` directly.
- Queue-first comment present in any generated skill that writes to `12 Queue/` before a NATS call.
- Minimum code that solves the specification. No speculative abstractions.
- Generated test files must cover: the happy path, at least one edge case, and the gate violation scenario.

### Open Issues

- `cursor-agent --help` must be run on the M5 Pro before Phase 7 build to confirm `-p` flag availability. If the flag is unavailable in the installed version, identify the correct invocation before writing any Phase 7 code.
- `CODING_TASK_SCHEMA.md` needs to be written to `14 System/docs/` before Phase 7.
- Context file size limits for Cursor CLI need testing.

### Success Criteria

- Generated code passes Gate 1 static check on first submission for 90% of tasks.
- Generated code includes `trace_id` in all queue file writes and queue-first comment before NATS calls.
- Zero autonomous deployments. All output staged to `08 IT/output/{task-id}/` only.
- Generated test suites run 1000 simulations in under 5 minutes.

### Latency Requirements

- Code generation per task: p99 TBD. Measure in Phase 7 build.
- Gate 1 check on generated code: p99 < 1 second.
- Full review and gate cycle: p99 < 15 minutes.

### Gate Implementation

The `@hardGate` decorator is required on `generateTradeCode`, `generatePublishCode`, and `writeToActiveSkills` methods.

---

## Agent Readiness Checklist — Full Summary

> Scores reflect actual build state as of June 2026. Based on PRD content and conversation history.

| Agent | Q1 Testable | Q2 Minimal | Q3 1000<5min | Q4 p99 Known | Q5 Code Gates | Build Decision |
|---|---|---|---|---|---|---|
| File Ingest (7) | Yes | Yes | Yes | Yes — 2s | Yes | Build now |
| QueueValidator (17) | Yes | Yes | Yes | Yes — 60s | Yes | Build now |
| Router Agent (19) | Yes | Yes | Yes | Yes — 100ms | Yes | Build now |
| VoiceIn Agent (16) | Yes | Yes | Yes | Yes — 500ms | Yes | Phase 1 |
| Skill Quality Reviewer (14) | Yes | Yes | Yes | Yes — 12s | Yes | Phase 1 |
| Morning Digest (5) | Yes | Yes | Yes | Yes — 5s | Yes | Phase 2 |
| Post-Action Evaluator (18) | Yes | Yes | Yes | Yes — 30s | Yes | Phase 2 |
| Macro Signal Sub-Agent (9) | Yes | Yes | Partial — cache | Yes — 30s | Yes | Phase 4 |
| Portfolio Monitor (12) | Yes | Yes | Yes | Yes — 5s | Yes | Phase 4 |
| Calendar Orchestrator (13) | Yes | Yes | Yes | Yes — 2s | Yes | Phase 4 |
| Biohacking Correlation (11) | Yes | Yes | Yes | Yes — 30s | Yes | Phase 4 sub-build |
| Growth Agent (15) | Yes | Yes | Yes | Yes — 60s | Yes | Phase 5 |
| Voice Corpus Researcher (10) | Yes | Yes | Yes — cache | Yes — 60s | Yes | Phase 2 — blocked by import |
| Health Agent (1) | Partial | Partial | Partial — cache | Yes — 2s | Missing @hardGate | Deterministic first. Fix BUG-006. |
| Personal Assistant (4) | Partial | Partial | Yes | No | Missing @hardGate | Defer to Phase 4. |
| Hermes Curator (6) | No | No | No | No | Partial | Build deterministic sub-skills first (Agent 18, then Agent 14). |
| LinkedIn Editorial (2) | Partial | Partial | Partial — cacheable | No | No — publish gate missing | Fix success criteria (1 hour), then Phase 2. |
| Stock Research Sub-Agent (8) | Yes | Yes | Yes — cache | Yes — 10min | Yes | Phase 4 — blocked by broker API. |
| Stocks Investing (3) | No | No | Partial | No | No — trade gate missing | Defer to Phase 4. Blocked. |
| Cursor Coding Agent (20) | Yes | Yes | Yes | TBD — Phase 7 | Yes | Phase 7. |

### Clearing a Readiness Flag

Every no answer is a tracked defect with a resolution task. The Hermes Curator surfaces unresolved readiness flags in the weekly ISA delta report until they are cleared.

- Health Agent BUG-006: define success criteria before Phase 1 build. Estimated effort: 1 hour. **Done — see [[health-agent-success-criteria]].**
- LinkedIn Editorial: define deterministic draft quality metrics. Estimated effort: 1 hour. Not a deferral.
- Personal Assistant: define p99 latency and `@hardGate` decorators. Prerequisite for Phase 4 start.
- Stocks Investing: broker API decision required. Hard deadline: end of Phase 2, then Plaid bridge is default.
- Hermes Curator: build Post-Action Evaluator sub-skill first. Prove deterministic pipeline. Then unlock autonomy.

---

## Agent Build Sequence Summary

| Phase | Agents Built | Dependency |
|---|---|---|
| 0 — Complete + In Progress | File Ingest (7). Router Agent (19). QueueValidator (17). Evaluation Harness skeleton. HardGateEnforcer spec. | Foundation Phase 0. |
| 1 | Health Agent (1) — deterministic first, BUG-006 resolved. VoiceIn Agent (16). Hermes Curator (6) — deterministic sub-skills only: Post-Action Evaluator (Agent 18) first, then Skill Quality Reviewer (Agent 14). Full Curator autonomy deferred. | Phase 0 infrastructure live. Health Agent success criteria defined. |
| 2 | LinkedIn Editorial (2) — success criteria updated. Voice Corpus Researcher (10) — blocked until import done. Morning Digest (5). Post-Action Evaluator (18). | Phase 1 agents producing signals. LinkedIn post archive imported. |
| 3 | NATS validated. QueueValidator grace period removed. Langfuse decision made. | All Phase 0-2 agents conforming to queue-first and trace contracts. |
| 4 | Stocks Investing (3). Stock Research Sub-Agent (8). Macro Signal Sub-Agent (9). Portfolio Monitor (12). Biohacking Correlation (11). Personal Assistant (4). Calendar Orchestrator (13). | Broker API decision made (or Plaid bridge default applied). All Phase 4 success criteria and @hardGate decorators defined before build. |
| 5 | Growth Agent (15). Full proactive activation. M5 Pro migration. | All prior agents producing data. 90 days of vault history. |
| 6 | Self-coding agents. ERRORS.md accumulation. Improvement proposals. | All agents stable. Curator autonomy unlocked. |
| 7 | Cursor Coding Agent (20). | CODING_TASK_SCHEMA.md written. Cursor CLI -p flag verified on M5 Pro. |
| 8 — Reserved | Multi-machine orchestration. NATS namespaces `jarvis.node.{id}.*` and `jarvis.sync.*` reserved only. | Not designed. Not implemented. |

---

*Living document. Update each agent section when its sub-build begins.*
