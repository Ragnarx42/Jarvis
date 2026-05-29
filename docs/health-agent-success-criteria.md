# Health Agent (Agent 1) – Deterministic Success Criteria

As defined in All-Agent Sub-PRD v3.0, BUG-006 resolution.

All criteria are enforced by the evaluation harness (`~/Brain/14 System/evaluation/harness/runner.ts`) and QueueValidator (Agent 17).

| Criterion | Target | Measurement method |
|-----------|--------|--------------------|
| **Schema compliance** | ≥95% of wiki notes contain all required frontmatter fields | Harness reads generated wiki note and checks for fields: `date`, `source`, `metric_type`, `value`, `baseline`, `delta`, `trace_id`, `confidence`. Run on 10 different export fixtures. |
| **HRV anomaly detection latency** | p99 < 2 seconds | Harness measures time from ingest trigger to queue file write. 1000 runs (cached Ollama responses). |
| **trace_id completeness** | 100% of queue files include `trace_id` and `confidence` | `QueueValidator` scans all `12 Queue/` files from prior 7 days. Zero missing fields. |
| **Wiki note write success** | 100% of Apple Health exports produce a wiki note (or a placeholder with `status: synthesis-pending`) | Harness runs on a fixed set of export files (including large exports). No crash or missing note. |
| **Retry mechanism** | Failed notes (Ollama unreachable) are retried within 10 minutes and eventually become real notes | Simulate Ollama down, run ingest → placeholder created. Bring Ollama up, run `HealthRetry.ts` manually → note updated to `status: processed`. |

**Phase 1A completion:** All criteria are green. Health Agent is deterministic and production‑ready.
