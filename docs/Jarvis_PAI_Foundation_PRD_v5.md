---
title: Jarvis PAI Foundation Layer PRD
version: "5.0"
status: Draft — For Dev Team Review
date: 2026-06-01
owner: Michael Wolff, Copenhagen
audience: AI Product Manager and Dev Team
classification: Private — Not for Distribution
---

# JARVIS — Private AI Stack
## PAI Foundation Layer — Product Requirements Document v5.0

---

## 1. Purpose

This document defines the requirements, architecture, agent inventory, observability, evaluation, and delivery phases for the Jarvis Private AI Stack PAI foundation layer. Separate PRDs cover each domain agent. The companion All-Agent Sub-PRD covers agent-level success criteria, latency requirements, and readiness scores.

Jarvis is a private, owner-operated, three-domain autonomous AI system running on owner-controlled hardware in Copenhagen. No component touches employer infrastructure. No sensitive data leaves the machine without explicit routing approval.

The system is not a productivity tool. It is a recursive intelligence layer that models the owner across health, finance, and professional domains, acts autonomously within defined hard gates, surfaces proactive insights without being asked, evaluates its own past actions against outcomes, and measures movement toward the owner's Ideal State.

---

## 2. Alfred — Autonomous Intelligence Behaviour

### 2.1 Design Intent

Alfred is not a reactive assistant. Alfred observes, correlates, and speaks first. Suggestions carry no hard gate. Actions do.

Alfred thinks continuously across all three domains. A drop in HRV overnight influences morning trading posture, the energy budget for the day, and the quality of any LinkedIn content drafted before noon. Alfred makes those connections and says so.

### 2.2 Proactive Behaviour Classes

| Class | Example | Trigger | Channel | Gate |
|---|---|---|---|---|
| Health nudge | "Your HRV dropped 15% overnight. Consider skipping the heavy session tomorrow." | Health Agent, moderate | Pulse + #health | None |
| Context flag | "Three consecutive nights under 7 hours. Focus window today is 09:00 to 12:00." | Sleep trend 3 days | Pulse + HUD | None |
| Market alert | "TSMC dropped 4% pre-market. Thesis intact. Worth 10 minutes." | Portfolio Monitor | #stocks + WhatsApp | None |
| Schedule conflict | "Data suggests crash window at 13:30. Move the 14:00 call to 15:30?" | PA + Health | Pulse + Telegram | Confirm before write |
| Post-action insight | "TSMC signal from Monday. Position up 3.1%. Signal quality: good." | Post-Action Evaluator | #stocks | None |
| ISA movement | "ISA score moved 68 to 74 this week. Sleep and LinkedIn driving it." | Growth Agent, weekly | Pulse + #growth | None |
| System health | "Ollama synthesis failed twice this hour." | Error monitor | #system + Pulse | None |

#### 2.2.1 Proactive Delivery Throttling

| Severity | Rule | Exception | Overflow |
|---|---|---|---|
| **high** | Always delivered. No suppression. | None | N/A |
| **moderate** | Same signal type fires at most once per 6 hours. | Lifted if magnitude increased. | 12 Queue/ digest-only |
| **low** | Suppressed from all real-time channels within 12 hours. | None | 12 Queue/ digest-only |

Deduplication state lives in `14 System/signal-state.json`. Alfred reads it before dispatching any notification.

### 2.3 Delivery Channels

| Channel | Use Case | Min Severity | Status |
|---|---|---|---|
| Pulse daemon voice | Ambient spoken alerts | moderate | Active |
| HUD dashboard | Live agent status, ISA score, queue signals, banners | All | Phase 1–2 |
| Telegram | Mobile push for health and PA signals | moderate | Planned |
| WhatsApp | Mobile push for stocks and urgent PA | high | Planned |
| Discord #health | Health alerts and nudges | moderate | Phase 1 |
| Discord #stocks | Portfolio and macro alerts | moderate | Phase 3 |
| Discord #linkedin | Content opportunities | moderate | Phase 2 |
| Discord #assistant | Calendar and PA events | moderate | Phase 4 |
| Discord #morning-digest | Daily 06:00 briefing | Daily | Phase 2 |
| Discord #system | System health, skill gates, queue reconciliation | moderate | Phase 0 |
| Discord #growth | ISA deltas and Telos drift | moderate | Phase 5 |

### 2.4 Wake Word Engine — openWakeWord

Fully MIT licensed. ONNX runtime on Apple Silicon. No API key. No audio egress. Prebuilt `hey_jarvis` model used. Porcupine evaluated and rejected: commercial licence risk.

- openWakeWord detects wake phrase on Apple Silicon audio input
- faster-whisper captures command via WebSocket bridge on `localhost:31339`
- Transcription writes to `12 Queue/` as VoiceCommand, high priority
- VoiceIn Agent reads entry and routes via NATS

### 2.5 Voice Model Configuration — `14 System/voice-config.yaml`

```yaml
voice:
  wake-word-model: hey_jarvis
  wake-word-engine: openWakeWord
  stt-model-size: tiny    # Start here. Upgrade to small if accuracy suffers.
  stt-engine: faster-whisper
  tts-voice-id: <elevenlabs_id>
  pulse-port: 31337
  voice-in-port: 31339
```

| Model | RAM | Accuracy | Recommendation |
|---|---|---|---|
| tiny | ~390MB | Good for clear speech | Default. Review at Phase 5. |
| small | ~967MB | Better on accents and noise | Upgrade if tiny misses commands. |
| medium | ~3GB | High | Not recommended. RAM cost too high on single-model Ollama machine. |

### 2.6 Routing Architecture

Alfred does not route commands directly to agents. Router Agent (Agent 19) sits between Alfred and all domain agents and assigns a confidence-scored routing decision.

#### 2.6.1 Three-Layer Routing Model

- **Layer 1 — Rules engine.** Deterministic pattern matching on signal type, domain tag, and privacy-routing frontmatter. Executes in under 10ms. Handles 70% of routing decisions.
- **Layer 2 — Embedding similarity.** Sentence embedding of the incoming signal compared against agent capability vectors in `14 System/router/agent-embeddings.json`.
- **Layer 3 — Lightweight model.** Local Ollama reasoning on full signal context for novel or cross-domain signals.

#### 2.6.2 Confidence Thresholds

| Confidence Band | Action | Logging |
|---|---|---|
| 1.0 (exact rule match) | Route automatically. No trace file written (reduces noise). Logged to NATS payload only. | NATS payload only |
| Above 0.9 | Route automatically. | Trace written to `14 System/traces/`. No alert. |
| 0.6 to 0.9 | Route automatically. Flag for review. | Trace written. Entry in `14 System/router/low-confidence-log.md`. Alert to #system if pattern repeats. |
| Below 0.6 | Do not route. Alfred requests owner clarification. | Trace written. Entry in low-confidence-log.md. Alert to #system. |

#### 2.6.3 Routing Decision Output Schema

```yaml
routing_decision:
  trace_id: <uuid>
  timestamp: <ISO 8601>
  input_signal: <queue_file_path>
  selected_agent: <agent_name>
  confidence: <0.0 to 1.0>
  routing_layer: rules | embedding | model
  reasoning: <one sentence>
  fallback_agents: [<agent_name>, ...]
  status: routed | clarification_required | rejected
```

> The routing decision is written to `14 System/traces/` as a YAML file named `{trace_id}.yaml`. Every NATS event and queue file includes the `trace_id` from the routing decision that spawned it.

---

## 3. Ideal State Measurement and Post-Action Evaluation

### 3.1 Design Scope

Alfred measures two things: whether the system's own actions were good, and whether those actions are moving the owner toward his Ideal State. User-behaviour tracking is out of scope for v5.0.

### 3.2 Post-Action Evaluation

| Agent | Action Type | Outcome Measured | Window | Output |
|---|---|---|---|---|
| Stocks Agent | Research signal | Position P/L since signal | 7 and 30 days | `03 Finance/wiki/signal-log.md` |
| Portfolio Monitor | Thesis divergence flag | Position reviewed and change made | 7 days | `03 Finance/wiki/monitor-log.md` |
| Morning Digest | Briefing delivery | Vault activity in 24 hours after | 24 hours | `11 Daily/digest-log.md` |
| Health Agent | Intervention recommendation | Next-day HRV and sleep change | 24–48 hours | `04 Health/wiki/intervention-log.md` |

### 3.3 Ideal State Articulation Score

| Dimension | Data Source | Weight | Calculation |
|---|---|---|---|
| Sleep quality | `04 Health/wiki/` | 25% | 7-day rolling average vs personal baseline |
| Portfolio vs thesis | `03 Finance/wiki/monitor-log.md` | 25% | Fraction of positions matching active thesis |
| LinkedIn engagement | `02 Career/wiki/` | 20% | 3-post rolling average vs 90-day baseline |
| Telos goal completion | `16 Growth/GOALS.md` | 30% | Fraction of active goals with progress note in last 7 days |

ISA score script runs as a daily bun cron. Pushes result to NATS topic `jarvis.isa.score`. HUD subscribes and renders live. Falling score triggers moderate severity alert to `#growth` and Pulse.

> ISA score weights are initial defaults. Review and tune at Phase 5.

---

## 4. System Vision and Design Principles

### 4.1 North Star

Every agent is a Supervisor. No passive workers. No concentration agent patterns. Each agent capable of spawning sub-agents.

### 4.2 Core Principles

- Recursive over flat. Build Supervisors from day one.
- Deterministic first. Prove deterministic pipelines before adding autonomy.
- Proactive over reactive. Alfred observes and speaks.
- Privacy by routing. Sensitive data stays local.
- Obsidian as the contract. The vault is the single source of truth.
- Queue file before NATS. Write persisted state first. Broadcast second.
- Trace everything. Every agent action emits a trace with a `trace_id`.
- Human gates on irreversible actions only.
- Skill security before capability. No skill installs without passing both gates.
- Measure outcomes. Every agent action that can be evaluated, will be.

### 4.3 Multi-Machine Architecture

Not required for v5.0. NATS topic namespaces reserved for Phase 8.

| NATS Topic Namespace | Reserved For | Phase |
|---|---|---|
| `jarvis.*` | All current single-node topics | Active |
| `jarvis.node.{id}.*` | Future multi-machine routing | Phase 8 — not implemented |
| `jarvis.sync.*` | Future cross-node state sync | Phase 8 — not implemented |

### 4.4 Anti-Patterns Explicitly Rejected

- Concentration agent topology
- Perplexity in any form
- Any component on employer hardware or tenant
- Autonomous publishing
- AI-generated images on LinkedIn
- Skill installation without security gate
- NATS as source of truth (queue file is truth)
- Building autonomy before deterministic pipelines are proven

---

## 5. Hardware Floor

| Component | Specification | Status |
|---|---|---|
| Production node | Mac mini M5 Pro, 48GB unified memory, 1TB SSD | Incoming |
| Staging node | Mac mini M4, current operational build | Active |
| Access | Always on, headless, Tailscale VPN | Stable |
| Isolation | Personal hardware only. MDM employer device excluded. | Enforced |

---

## 6. Software Stack

| Layer | Component | Role | Status |
|---|---|---|---|
| Orchestration | PAI v5 via Claude Code | Session runtime, DA identity, skills, memory, hooks | Active |
| Skill Library | OpenClaw | Imported skill catalogue consumed by PAI sessions | Active |
| Primary Reasoning | Claude API, Opus model | Deep reasoning, web search, non-sensitive inference | Active |
| Local Inference | Ollama, Qwen 3 32B Q4 | Privacy-sensitive inference. Single model loaded. | Active |
| Memory | Obsidian vault + local RAG | Canonical knowledge store | Active |
| Event Bus | NATS | Cross-agent broadcast after queue write | Configured |
| Routing | Router Agent (Agent 19) | Confidence-scored routing layer | Phase 0 |
| Observability | OpenTelemetry | Required. Standard trace export. Library only. | Phase 0 |
| Observability | Langfuse (self-hosted) | Optional. Add in Phase 3. Must run on separate hardware or container to avoid interfering with M5 Pro agent workloads. | Phase 3 optional |
| Evaluation | Evaluation Harness | Required. Parallel runner, response cache, deterministic test mode, mock vault. | Phase 0 |
| Voice Output | ElevenLabs + Pulse daemon | DA voice output on `localhost:31337` | Active |
| Voice Input | openWakeWord + faster-whisper | Wake word detection and STT. Config in `voice-config.yaml`. | Phase 1 |
| HUD | React + Bun + NATS WebSocket client | Live agent status, ISA score, queue signals on `localhost:31338` | Phase 1 |
| Notifications | Discord, Telegram, WhatsApp | Proactive alerts. Throttled by `signal-state.json`. | Phase 0–4 |
| Email | Protonmail via Bridge | Primary. Gmail read-only fallback. | Active |
| Brokerage | Nordnet API or Plaid bridge | Read access, position awareness only | Pending decision |

### 6.1 Privacy Routing Rules

- Domains routing through local Ollama only: `04 Health`, `03 Finance`, `05 Legal`, `07 Family`, `06 Vehicle`
- Domains routing through Claude API: `02 Career`, `09 Travel`, `11 Daily`, `16 Growth`
- File frontmatter `privacy-routing` tag governs routing per document
- Raw health data, biometric readings, CGM values, HRV, blood panels never leave `127.0.0.1`

---

## 7. Obsidian Vault Architecture

**Vault root:** `/Users/michaelwolff/Brain`

| Folder | Domain | raw/wiki Split | Agent Write Access | Privacy Routing |
|---|---|---|---|---|
| 00 Inbox | Transit zone | raw/ only | File Ingest Agent | local |
| 01 Spiritual | Philosophy, reflection | flat | Growth Agent | local |
| 02 Career | Professional context, engagement data | flat | LinkedIn Agent, PA Agent | API (Claude) |
| 03 Finance | Positions, thesis, signal-log, monitor-log | raw/ + wiki/ | Stocks Agent | local |
| 04 Health | Biometrics, protocols, intervention-log | raw/ + wiki/ | Health Agent | local |
| 05 Legal | Contracts, compliance | raw/ + wiki/ | PA Agent | local |
| 06 Vehicle | Car logs, maintenance | flat | PA Agent | local |
| 07 Family | Family data | flat | PA Agent | local |
| 08 IT | System config, code, Cursor output | raw/ + wiki/ | All agents | local |
| 09 Travel | Itineraries, bookings | flat | PA Agent | API |
| 10 Templates | Note templates | read-only | None | N/A |
| 11 Daily | Daily notes, journal, digest log | flat | PA Agent, Morning Digest | API |
| 12 Queue | Cross-agent signal queue | flat, append-only | All agents | mixed |
| 13 Generated | AI-generated content (temp) | flat | Hermes Curator | API |
| 14 System | Logs, config, skill registry, traces, evaluation, router | flat | All agents | mixed |
| 15 Archive | Archived material | flat | None | N/A |
| 16 Growth | Telos, goals, weekly-deltas/ | flat | Growth Agent | API |

### 7.1 New System Subfolders

- `14 System/traces/` — Per-step execution traces. One YAML file per `trace_id`.
- `14 System/evaluation/` — Evaluation harness artefacts: `harness/`, `suites/`, `results/`, `cache/`
- `14 System/router/` — Router Agent state: `agent-embeddings.json`, `low-confidence-log.md`, `rules.yaml`
- `14 System/prd/` — Living PRD documents (this file and companions)
- `14 System/docs/` — Technical reference docs (success criteria, schemas, guides)

### 7.2 Queue File Frontmatter Schema

All queue files must include `trace_id` and `confidence` as of v5.0.

```yaml
---
source: <agent_name>
date: <ISO 8601>
type: <signal_type>
severity: low | moderate | high
domain: <vault_folder>
privacy-routing: local | api | mixed
status: pending | digest-only | processed
trace_id: <uuid>
confidence: <0.0 to 1.0>
---
```

### 7.3 Queue-First Write Contract

Queue file written and fsynced first. NATS event fired second. Every NATS payload includes `queue_file_path` and `trace_id`. Receiving agents resolve the queue file from the NATS payload.

> Any NATS event without a queue file after the QueueValidator grace period is a code defect in the publishing agent.

---

## 8. NATS Event Bus and QueueValidator

### 8.1 Event Topics

| Topic | Publisher | Subscriber | Required Payload Fields |
|---|---|---|---|
| `jarvis.health.signals` | Health Agent | Stocks Agent, PA Agent, Morning Digest, Alfred | `queue_file_path`, `severity`, `signal_type`, `trace_id` |
| `jarvis.finance.signals` | Stocks Agent | PA Agent, Morning Digest, Alfred | `queue_file_path`, `ticker`, `signal_type`, `trace_id` |
| `jarvis.pa.events` | PA Agent | Health Agent, Stocks Agent, Morning Digest | `queue_file_path`, `event_type`, `impact`, `trace_id` |
| `jarvis.routing.decision` | Router Agent | All domain agents, Alfred | `queue_file_path`, `selected_agent`, `confidence`, `trace_id` |
| `jarvis.session.end` | All agents | Hermes Curator | `session_id`, `agent`, `log_path`, `trace_id` |
| `jarvis.digest.trigger` | cron 06:00 | Morning Digest Agent | `date`, `domains`, `trace_id` |
| `jarvis.voice.command` | VoiceIn Agent | Router Agent | `queue_file_path`, `transcription`, `priority`, `trace_id` |
| `jarvis.isa.score` | ISA score script, daily | HUD | `score`, `dimension_breakdown`, `date`, `trace_id` |
| `jarvis.system.error` | Any agent | Alfred, #system | `queue_file_path`, `agent`, `error_type`, `trace_id` |
| `jarvis.node.{id}.*` | Reserved | Reserved | Phase 8 placeholder |
| `jarvis.sync.*` | Reserved | Reserved | Phase 8 placeholder |

> `trace_id` is required in every NATS event payload. Any event missing `trace_id` is rejected by QueueValidator and flagged to `#system`.

### 8.2 QueueValidator Agent

- Runs every 60 minutes as a scheduled PAI skill
- Verifies every NATS event has a corresponding queue file and a trace file in `14 System/traces/`
- **Transition period:** 90-second grace period before flagging missing queue file. Configurable in `14 System/queue-validator-config.yaml` under `grace_period_seconds`.
- **After all agents conform:** grace period set to 0
- Orphaned NATS event (no queue file): HIGH severity to `#system`
- NATS event with no trace file: MODERATE severity to `#system`
- Orphaned queue file (no NATS event): MODERATE flag
- All discrepancies written to `14 System/logs/queue-reconciliation.md`

---

## 9. Skill Registry and Security Gate

### 9.1 Local Skill Registry

All skills registered in `14 System/skills/manifest.json`. Manifest tracks: name, version, source URL, install date, SHA-256 checksum, last review date, gate results, `latency_p99_ms`, rollback history.

Rollback command: `jarvis skill rollback <name>`. Logs rollback reason to manifest.

### 9.2 Two-Gate Security Model

- **Gate 1 — Static AST check.** No writes outside vault paths. No employer domain URLs. No hardcoded secrets. No unapproved outbound HTTP. All methods touching irreversible actions carry `@hardGate` decorator. Runs in under one second.
- **Gate 2 — Ollama reasoning gate.** Qwen 3 answers: privacy routing violation, hard gate action attempt, out-of-scope writes. One yes blocks the skill.
- Both gates must pass. Failure quarantines to `14 System/skills/quarantine/`.

> The skill security gate is a blocking pre-hook. No agent can bypass it.

---

## 10. DA Identity — Alfred

Identity files: `~/.claude/PAI/USER/TELOS/` and `~/.claude/PAI/DA/`. ContainmentGuard configured. ElevenLabs voice IDs bound. Pulse daemon on `localhost:31337`.

- Alfred speaks first when signal severity warrants it
- Five counter-argument questions before any substantive answer on new ideas
- Queen's English. Active voice. No em dashes. No semicolons.
- One clarifying question per turn
- No unsolicited summaries, roadmaps, or project plans

---

## 11. Agent Inventory

All 20 agents are Supervisors. All capable of spawning sub-agents. Flat worker patterns are rejected at every layer.

| # | Agent | Domain | Discord | Status | Routing | Deterministic First | p99 Ceiling |
|---|---|---|---|---|---|---|---|
| 7 | File Ingest Agent | 00 Inbox | #system | Active | Local | Yes | 2s |
| 17 | QueueValidator | System | #system | Phase 0 | Local | Yes | 60s batch |
| 19 | Router Agent | System | #system | Phase 0 | Local | Yes | 100ms |
| 1 | Health Agent | 04 Health | #health | Phase 1 — deterministic first | Local | Yes — fix BUG-006 | 2s detect / 10s synthesis |
| 16 | VoiceIn Agent | System | #system | Phase 1 | Local | Yes | 500ms |
| 6 | Hermes Curator | System | #system | Phase 1 | Local + API | No — defer autonomy | TBD |
| 14 | Skill Quality Reviewer | System | #system | Phase 1 | Local | Yes | 10s |
| 2 | LinkedIn Editorial | 02 Career | #linkedin | Phase 2 — fix metrics first | API | No — fix success criteria | TBD |
| 10 | Voice Corpus Researcher | 02 Career | #linkedin | Phase 2 | API | No | TBD |
| 5 | Morning Digest | Cross-domain | #morning-digest | Phase 2 | API | Yes | 5s |
| 18 | Post-Action Evaluator | Cross-domain | #stocks + #growth | Phase 2 | Mixed | Yes | 30s nightly |
| 3 | Stocks Investing | 03 Finance | #stocks | Phase 4 — blocked broker API | API | No — deferred | TBD |
| 8 | Stock Research Sub-Agent | 03 Finance | #stocks | Phase 4 | API | No | TBD |
| 9 | Macro Signal Sub-Agent | 03 Finance | #stocks | Phase 4 | API | Yes | 30s per cron |
| 12 | Portfolio Monitor | 03 Finance | #stocks | Phase 4 | API | Yes | 5s |
| 11 | Biohacking Correlation | 04 Health | #health | Phase 4 sub-build | Local | Yes | 30s |
| 4 | Personal Assistant | Multiple | #assistant | Phase 4 | Mixed | No | TBD |
| 13 | Calendar Orchestrator | Multiple | #assistant | Phase 4 | Mixed | Yes | 2s |
| 15 | Growth Agent | 16 Growth | #growth | Phase 5 | API | Yes — weekly report | 60s weekly |
| 20 | Cursor Coding Agent | System / 08 IT | #system | Phase 7 | API (Privacy Mode) | Yes — staged output only | TBD |

---

## 12. Cross-Agent Contract

- Queue file first. NATS broadcast second. Receiving agents resolve queue file from NATS payload.
- Every NATS event and queue file carries a `trace_id` from the originating routing decision.
- Alfred applies throttling rules from Section 2.2.1 before dispatching any notification.
- All vault writes use wikilink format. Standard Markdown links are a defect.
- Router Agent sits between Alfred and all domain agents. No domain agent receives a raw voice command or unrouted signal directly.

---

## 13. Hard Gates

### 13.1 Gate Table

| Action | Gate | Rationale |
|---|---|---|
| Outbound trade execution | BLOCKED | Irreversible |
| Money movement | BLOCKED | Irreversible |
| LinkedIn post set to publish | BLOCKED | Requires human edit pass |
| Vault file deletion | BLOCKED | Potentially irreversible |
| Any action on employer device or tenant | BLOCKED | MDM wipe rights |
| Skill installation without both gates passing | BLOCKED | Security and privacy risk |
| NATS fire before queue file write confirmed | BLOCKED | Contract violation |
| NATS event missing `trace_id` | BLOCKED | Observability contract violation |
| Cursor Coding Agent: write directly to `active/` skills | BLOCKED | All output staged. Reviewer controls promotion. |
| External API calls not in defined stack | CONFIRM | Unvetted data routing |

### 13.2 Full Autonomy Actions

Calendar changes under standing rules, email drafts queued for review, reminders and notifications, file classification and vault writes, knowledge graph updates, all proactive suggestions and alerts.

### 13.3 Gate Implementation Specification

Hard gates are enforced in code, not in prompts.

```typescript
// 14 System/skills/active/hard-gate-enforcer/index.ts
export interface GateContext {
  agent: string;
  action: string;
  domain: string;
  trace_id: string;
  payload?: Record<string, unknown>;
}

export interface GateResult {
  allowed: boolean;
  gate_triggered?: string;
  reason?: string;
  logged_to: string;   // path in 14 System/logs/
}

export interface HardGateEnforcer {
  check(context: GateContext): Promise<GateResult>;
}

// Usage — decorator pattern
@hardGate({ action: 'trade_execution', domain: '03 Finance' })
async executeOrder(order: Order): Promise<void> {
  // This body is never reached if the gate blocks.
}
```

The `@hardGate` decorator calls `HardGateEnforcer.check()` before the method body executes. If the gate returns `allowed: false`, the method throws `HardGateViolationError`, writes a gate log to `14 System/logs/gate-violations.md`, and fires `jarvis.system.error` on NATS.

Every agent method touching the hard gate list must carry the `@hardGate` decorator. Gate 1 static scan checks for this decorator on all methods with names matching the predefined pattern list.

> After review and approval, record the SHA-256 checksum of `HardGateEnforcer.ts` in `14 System/skills/manifest.json`. Any drift from the approved checksum is a security event.

---

## 14. Health Agent — Build Status and Known Issues

### 14.1 What Is Built

- Apple Health JSON ingest pipeline from iCloud Drive to `04 Health/raw/`
- launchd watcher running headless
- Qwen 3 local model synthesises raw data into wiki notes in `04 Health/wiki/`
- `health-agent-config.yaml` in `14 System/` for threshold configuration
- Cross-agent queue contract defined. Signals written to `12 Queue/`.

### 14.2 Open Bugs

| ID | Description | Severity | Resolution Path |
|---|---|---|---|
| BUG-001 | Ollama synthesis degrades on large exports. Truncated wiki notes above 500 entries. | HIGH | bun/TypeScript pre-processor aggregates by metric type before Ollama sees it. Resolves BUG-002 as side effect. |
| BUG-002 | Inconsistent wiki note schema between runs. | MEDIUM | Resolved by BUG-001 fix. |
| BUG-003 | Ollama occasionally writes standard Markdown links, breaking Obsidian graph view. | MEDIUM | kepano/obsidian-skills wikilink enforcement in synthesis prompt. Post-write validator. |
| BUG-004 | iCloud sync latency. launchd fires before iCloud finishes syncing. | MEDIUM | File size stability check. Two reads 5 seconds apart must match. |
| BUG-005 | No error recovery on Ollama timeout. Silent failure. | LOW | Try/catch with exponential backoff. Alert to #system and Pulse. |
| BUG-006 | No deterministic success criteria. Blocks Phase 1 build start. | HIGH | See `14 System/docs/health-agent-success-criteria.md` |

---

## 15. Evaluation Harness

### 15.1 Purpose

Phase 0 deliverable. No agent build starts without it. Provides infrastructure for 1000 simulated agent actions in under 5 minutes.

### 15.2 Components

- **Parallel runner.** 16 worker threads. Reads test suite from `14 System/evaluation/suites/` and runs all cases in parallel.
- **Response cache layer.** First run against real LLM. Subsequent runs use cached responses. Cache keyed on `{agent, input_hash, model_version}`. Stored in `14 System/evaluation/cache/`.
- **Deterministic test mode.** Swaps real vault I/O for a mock vault. Agent code runs unchanged. Vault writes captured in memory for assertion.
- **Mock NATS.** In-process NATS-compatible bus for test runs. No real NATS server required.
- **Assertion library.** Checks schema compliance, latency p99, output determinism.
- **Zero external dependencies in test mode.** The harness must be able to run against mock NATS and mock vault without any external service running. External dependencies are only needed for the first live baseline run that populates the response cache.

### 15.3 Test Suite Definition — `14 System/evaluation/suites/{agent}.yaml`

```yaml
suite:
  agent: health-agent
  version: 1.0
  cases:
    - id: hrv-anomaly-detection
      input: fixtures/hrv-drop-15pct.json
      expected:
        schema_fields: [source, date, type, severity, domain, trace_id, confidence]
        severity: moderate
        latency_p99_ms: 2000
    - id: synthesis-schema-compliance
      input: fixtures/apple-health-100-entries.json
      expected:
        wiki_note_fields: [date, source, metric_type, value, baseline, delta]
        latency_p99_ms: 10000
```

### 15.4 Results

Each harness run writes to `14 System/evaluation/results/YYYY-MM-DD-{agent}-{run_id}.yaml`. Results failing any p99 ceiling block the agent build from proceeding.

### 15.5 Running the Harness

```bash
bun run harness --agent health-agent --suite default --workers 16
bun run harness --agent all --mode regression
```

---

## 16. Per-Step Tracing

### 16.1 Purpose

Every agent action emits a trace. Traces are the audit trail. OpenTelemetry is the standard export format.

### 16.2 Trace Schema — `14 System/traces/{trace_id}.yaml`

```yaml
trace_id: <uuid v4>
timestamp_start: <ISO 8601>
timestamp_end: <ISO 8601>
agent: <agent_name>
action: <action_name>
domain: <vault_folder>
routing_layer: rules | embedding | model
confidence: <0.0 to 1.0>
privacy_routing: local | api | mixed
input: <queue_file_path or description>
output: <queue_file_path or description>
nats_events_fired: [<topic>, ...]
latency_ms: <integer>
status: success | partial | failed
error: <error message if failed>
parent_trace_id: <uuid or null>
```

`parent_trace_id` is null for top-level agent actions. When one agent spawns another (e.g. Stocks Agent spawning Stock Research Sub-Agent, or Hermes Curator spawning Cursor Coding Agent), the spawned agent must set `parent_trace_id` to the `trace_id` of the spawning action. This creates a full call graph across nested agent invocations.

### 16.3 OpenTelemetry Export

```yaml
observability:
  otel_export: file           # file | langfuse | stdout
  otel_export_path: 14 System/traces/otlp/
  langfuse_host: null         # Set when Langfuse deployed in Phase 3
  trace_retention_days: 30
```

### 16.4 Required Trace Points

- Every NATS event published: `trace_id` attached to payload
- Every queue file written: `trace_id` written to frontmatter
- Every Ollama inference call: input token count, output token count, `latency_ms`
- Every Claude API call: model, input tokens, output tokens, `latency_ms`
- Every hard gate check: result (allowed/blocked), gate triggered, `latency_ms`
- Every routing decision by Router Agent: confidence, routing layer used, selected agent

---

## 17. Agent Readiness Checklist

### 17.1 Five Questions

Before any agent build begins, it must answer yes to all five questions. Three or more no answers means the agent is deferred.

1. **Q1 — Testable success criteria:** can you write a test that passes when the agent works and fails when it does not?
2. **Q2 — Minimal toolset:** does the agent use the fewest tools necessary?
3. **Q3 — 1000 runs in under 5 minutes:** can the evaluation harness run 1000 simulations in under 5 minutes?
4. **Q4 — p99 latency known:** is the p99 ceiling defined before build starts?
5. **Q5 — Code-level gates:** are all irreversible actions protected by `@hardGate` decorators?

### 17.2 Actual Readiness Scores — June 2026

| Agent | Q1 Testable | Q2 Minimal | Q3 1000<5min | Q4 p99 Known | Q5 Code Gates | Build Decision |
|---|---|---|---|---|---|---|
| File Ingest (7) | Yes | Yes | Yes — mock FS | Yes — 2s | Yes | Build now |
| QueueValidator (17) | Yes | Yes | Yes | Yes — 60s | Yes | Build now |
| Router Agent (19) | Yes | Yes | Yes | Yes — 100ms | Yes | Build now |
| VoiceIn Agent (16) | Yes | Yes | Yes | Yes — 500ms | Yes | Phase 1 |
| Skill Quality Reviewer (14) | Yes | Yes | Yes | Yes — 12s | Yes | Phase 1 |
| Morning Digest (5) | Yes | Yes | Yes | Yes — 5s | Yes | Phase 2 |
| Post-Action Evaluator (18) | Yes | Yes | Yes | Yes — 30s | Yes | Phase 2 |
| Health Agent (1) | Partial | Partial | Partial — cache | Yes — 2s | Missing @hardGate | Deterministic first. Fix BUG-006. |
| LinkedIn Editorial (2) | Partial | Partial | Partial — cacheable | No | No — publish gate missing | Fix criteria 1hr, then Phase 2 |
| Stocks Investing (3) | No | No | Partial | No | No — trade gate missing | Defer to Phase 4. Blocked. |
| Personal Assistant (4) | Partial | Partial | Yes | No | Missing @hardGate | Defer to Phase 4 |
| Hermes Curator (6) | No | No | No | No | Partial | Build deterministic sub-skills first |

### 17.3 Clearing a Readiness Flag

Every no answer is a tracked defect. The Hermes Curator surfaces unresolved readiness flags in the weekly ISA delta report.

---

## 18. Persistent HUD Dashboard

Built from scratch in React and Bun. No third-party forks. NATS WebSocket client streams events directly. Served on `localhost:31338`, accessible over Tailscale.

- Live agent status per agent: active, idle, error. Last activity timestamp.
- ISA score panel. Current score, 7-day trend sparkline, dimension breakdown.
- Router confidence feed. Live stream of routing decisions with confidence scores.
- 12 Queue/ live feed. Incoming signals, severity colour coded.
- NATS event stream. Real-time flow across all topics.
- Banner alerts. Non-blocking. Low severity auto-dismisses after 30 seconds.
- Signal deduplication state. Current cooldown per signal type.
- System health. Disk, memory, NATS uptime, Pulse status.
- Daily digest summary. Morning briefing pinned until 06:00 next day.

---

## 19. Delivery Phases

> **Phase 0 completion gate:** traces folder created, evaluation harness skeleton committed, HardGateEnforcer.ts reviewed and SHA-256 recorded, Router Agent built, QueueValidator built with trace verification, Discord #system wired.

### Phase 0 — Foundation and Observability

- PAI v5 installed. Alfred DA identity configured. TELOS files complete. — **DONE**
- Obsidian vault structured. raw/wiki split on high-volume domains. — **DONE**
- Ollama Qwen 3 with MCP bridge to Claude Code. — **DONE**
- ElevenLabs voice and Pulse daemon verified. — **DONE**
- CLAUDE.md files enforced. 60+ vault documents seeded. — **DONE**
- File Ingest Agent operational. — **DONE**
- Create `14 System/traces/`, `14 System/evaluation/`, `14 System/router/` — **IN PROGRESS**
- Write trace schema YAML and commit to `14 System/docs/trace_schema.yaml`
- Write evaluation harness skeleton in `14 System/evaluation/harness/`
- Write HardGateEnforcer TypeScript companion file. Review before Phase 1.
- Build Router Agent (19). Implement rules engine and embedding similarity layers.
- Build QueueValidator (17) with trace verification. Wire to Discord #system.
- Add `trace_id` to all existing NATS event publishers.

### Phase 1 — Health Stabilisation, Voice, Deduplication, HUD

> Complete Phase 0 before starting Phase 1.

- Resolve BUG-001 through BUG-006 in Health Agent. BUG-006 (success criteria) resolved first.
- Add `@hardGate` decorators to all Health Agent methods touching irreversible actions.
- Run evaluation harness against Health Agent before any new feature build.
- Create `14 System/voice-config.yaml`. Set `stt-model-size: tiny`.
- Deploy openWakeWord with `hey_jarvis` model. Verify no audio egress.
- Build faster-whisper WebSocket bridge on `localhost:31339`.
- Build VoiceIn Agent. Route to `jarvis.voice.command` via Router Agent.
- Build `14 System/signal-state.json` and deduplication logic.
- Enforce queue-first write contract in all existing agent code.
- Port Hermes Autonomous Curator as PAI skill. Deterministic evaluation sub-skill (Agent 18) first, then Skill Quality Reviewer (Agent 14). Full Curator autonomy deferred.
- Build skill registry in `14 System/skills/manifest.json` with rollback support.
- Build HUD in React and Bun on `localhost:31338`. Wire agent status, queue feed, router confidence.
- Write `14 System/docs/SKILL_AUTHORING.md` per Appendix A spec.

### Phase 2 — LinkedIn Editorial and Morning Digest

- Update LinkedIn Editorial handover document with deterministic success criteria before build.
- Build LinkedIn Editorial Supervisor with Voice Corpus Researcher sub-agent.
- Add `@hardGate` decorator to publish methods.
- Run evaluation harness against LinkedIn Editorial before Phase 2 launch.
- Build Morning Digest Agent. Schedule at 06:00. Wire to #morning-digest.
- Add ISA score panel to HUD. Wire `jarvis.isa.score` NATS topic.
- Build Post-Action Evaluator as Hermes sub-skill.

### Phase 3 — Cross-Agent Infrastructure and Observability Review

- Validate NATS across all Phase 0, 1, and 2 agents.
- QueueValidator grace period removed once all agents conform.
- Evaluate whether to deploy Langfuse. If yes, configure `14 System/observability-config.yaml`.
- Run full regression suite across all active agents.

### Phase 4 — Stocks, Personal Assistant, Finance Agents

- Broker API decision made before Phase 4 starts. Hard deadline: if not decided by end of Phase 2, default to Plaid bridge read-only.
- Add success criteria and `@hardGate` decorators to all Finance agents before build.
- Build Stocks Investing Agent, Stock Research Sub-Agent, Macro Signal Sub-Agent, Portfolio Monitor.
- Build Personal Assistant Agent and Calendar Orchestrator.
- Build Biohacking Correlation Agent.
- Wire Discord #stocks and #assistant channels.

### Phase 5 — Growth Agent and Full Proactive Activation

- Growth Agent built against `16 Growth` domain. Weekly delta report active.
- M5 Pro migration: validate full stack on production hardware.
- All 19 agents active (excluding Cursor Coding Agent).
- Alfred proactive behaviour reviewed against three months of real usage.
- ISA score dimension weights reviewed and tuned.
- `voice-config.yaml` `stt-model-size` reviewed.

### Phase 6 — Self-Coding Agents

- Agents accumulate `ERRORS.md` logs. Three repeated failures triggers improvement proposal to `14 System/proposals/`.
- Alfred surfaces proposals via #system and Pulse.
- Owner approves. Claude Code executes. Skill Quality Reviewer gate applies.

### Phase 7 — Cursor Coding Agent

- Cursor Coding Agent (20) built. `cursor-agent -p` flag verified on M5 Pro first.
- `CODING_TASK_SCHEMA.md` written to `14 System/docs/`.
- Full review and merge workflow validated end to end.

### Phase 8 — Multi-Machine (Reserved)

NATS topic namespaces `jarvis.node.{id}.*` and `jarvis.sync.*` reserved. No implementation.

---

## 20. Open Decisions

| Decision | Options | Blocker For | Priority |
|---|---|---|---|
| Broker API access | Nordnet direct vs Plaid bridge. Default: Plaid bridge if not decided by end of Phase 2. | Stocks Agent, Phase 4 | HIGH |
| LinkedIn Editorial success criteria | Define deterministic metrics for draft quality and voice alignment | Phase 2 start | HIGH |
| Health Agent success criteria (BUG-006) | See `14 System/docs/health-agent-success-criteria.md` | Phase 1 Health build | HIGH — resolved |
| Langfuse deployment | Deploy in Phase 3 vs skip. File export covers Phase 0–2. Must run on separate hardware. | Phase 3 observability | MEDIUM |
| WhatsApp vs Telegram primary mobile channel | WhatsApp via PAI skill vs Telegram bot | PA Agent, Phase 4 | MEDIUM |
| voice-config.yaml stt-model-size | Start tiny. Upgrade to small at Phase 5 review. | Voice accuracy | LOW |

---

## Appendix A — Skill Authoring Guide

> Canonical location: `14 System/docs/SKILL_AUTHORING.md`. This appendix is the source of truth. Hermes Autonomous Curator uses this as the constraint context for autonomous skill generation.

### A.1 Skill Folder Structure

```
14 System/skills/
  active/{skill-name}/
    skill.yaml          # Required
    index.ts            # Required. TypeScript only.
    README.md           # Required
    tests/              # Required
      suite.yaml
  quarantine/
  archive/
manifest.json
```

### A.2 skill.yaml — Required Metadata

```yaml
name: hello-world
version: 1.0.0
description: Reads 11 Daily/ and writes a greeting signal to 12 Queue/
domain: 11 Daily
privacy-routing: api
latency_p99_ms: 500
test_suite_path: tests/suite.yaml
permissions:
  read: ["11 Daily/"]
  write: ["12 Queue/"]
  network: none
  vault-delete: false
gate-manifest:
  static-check: required
  ollama-reasoning: required
  last-gate-date: null
  gate-status: pending
```

### A.3 Two-Gate Process

**Gate 1 — Static Check**
- No writes outside declared vault paths
- No employer domain strings
- No hardcoded secrets
- No unapproved outbound network calls
- All methods touching irreversible actions carry `@hardGate` decorator

**Gate 2 — Ollama Reasoning Gate**
Qwen 3 reads full source and `skill.yaml`. Three binary questions: privacy routing violation, hard gate action attempt, out-of-scope writes. One yes blocks the skill.

### A.4 Example Skill — hello-world

```typescript
// index.ts
import { readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const VAULT = process.env.VAULT_ROOT ?? '/Users/michaelwolff/Brain';
const DAILY = join(VAULT, '11 Daily');
const QUEUE = join(VAULT, '12 Queue');

async function run() {
  const files = (await readdir(DAILY)).sort().reverse();
  if (!files.length) return;
  const signal = [
    '---',
    'source: hello-world',
    `date: ${new Date().toISOString()}`,
    'type: greeting',
    'severity: low',
    'domain: 11 Daily',
    'privacy-routing: api',
    'status: pending',
    `trace_id: ${crypto.randomUUID()}`,
    'confidence: 1.0',
    '---',
    `Signal: Vault active. Latest note: ${files[0]}`,
  ].join('\n');
  const filename = `hello-world-${Date.now()}.md`;
  // Queue file written. Fire NATS after.
  await writeFile(join(QUEUE, filename), signal, 'utf-8');
  console.log(`Queue file written: ${filename}`);
}

run().catch(e => { console.error(e); process.exit(1); });
```

### A.5 Hermes Constraint Context

- `skill.yaml` complete before `index.ts` is written
- Minimum read and write paths declared. Over-declaration is a gate failure.
- `latency_p99_ms` must be declared
- `test_suite_path` must point to a valid suite definition
- Queue-first comment required before any NATS publish call
- `trace_id` and `confidence` written to every queue file frontmatter
- `@hardGate` decorator required on all methods touching the hard gate list

---

*Living document. Update at the end of every Phase.*
