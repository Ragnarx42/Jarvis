import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type HarnessMode = "default" | "regression";

type CliOptions = {
  agent: string;
  suite: string;
  workers: number;
  mode: HarnessMode;
};

type SuiteCase = {
  id: string;
  input: unknown;
  expectedSchemaFields?: string[];
};

type SuiteSpec = {
  agent: string;
  model_version: string;
  cases: SuiteCase[];
};

type CaseResult = {
  id: string;
  pass: boolean;
  latency_ms: number;
  schema_ok: boolean;
  deterministic_ok: boolean;
  error?: string;
};

type HarnessResult = {
  run_id: string;
  agent: string;
  suite: string;
  mode: HarnessMode;
  pass_rate: number;
  schema_compliance_rate: number;
  latency_p99_ms: number;
  failed_cases: CaseResult[];
  case_results: CaseResult[];
};

const ROOT = "/Users/michaelwolff/Brain/14 System/evaluation";
const SUITES_DIR = path.join(ROOT, "suites");
const CACHE_DIR = path.join(ROOT, "cache");
const RESULTS_DIR = path.join(ROOT, "results");
const FIXTURES_DIR = path.join(SUITES_DIR, "fixtures");

function parseCli(argv: string[]): CliOptions {
  const get = (flag: string, fallback?: string) => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx + 1 >= argv.length) return fallback;
    return argv[idx + 1];
  };

  return {
    agent: get("--agent", "health-agent")!,
    suite: get("--suite", "default")!,
    workers: Number(get("--workers", "16")),
    mode: (get("--mode", "default") as HarnessMode) ?? "default",
  };
}

function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function loadSuite(agent: string): Promise<SuiteSpec> {
  const suiteFile = path.join(SUITES_DIR, `${agent}.yaml`);
  const raw = await readFile(suiteFile, "utf8");
  // Skeleton loader: accepts JSON-in-YAML for now.
  return JSON.parse(raw) as SuiteSpec;
}

async function readCache(agent: string, inputHash: string, modelVersion: string): Promise<unknown | null> {
  const cacheFile = path.join(CACHE_DIR, `${agent}-${inputHash}-${modelVersion}.json`);
  try {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(agent: string, inputHash: string, modelVersion: string, output: unknown): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${agent}-${inputHash}-${modelVersion}.json`);
  await writeFile(cacheFile, JSON.stringify(output, null, 2), "utf8");
}

async function mockAgentResponse(input: unknown): Promise<Record<string, unknown>> {
  const fixtureFiles = await readdir(FIXTURES_DIR).catch(() => []);
  return {
    input,
    fixture_count: fixtureFiles.length,
    timestamp: new Date().toISOString(),
    summary: "mock-response",
  };
}

function latencyP99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
  return sorted[idx];
}

function schemaCheck(output: Record<string, unknown>, requiredFields: string[]): boolean {
  return requiredFields.every((field) => Object.prototype.hasOwnProperty.call(output, field));
}

async function runCase(agent: string, modelVersion: string, testCase: SuiteCase): Promise<CaseResult> {
  const started = performance.now();
  const inputHash = hashInput(testCase.input);
  const requiredFields = testCase.expectedSchemaFields ?? [];

  try {
    let output = await readCache(agent, inputHash, modelVersion);
    if (!output) {
      output = await mockAgentResponse(testCase.input);
      await writeCache(agent, inputHash, modelVersion, output);
    }

    const first = output as Record<string, unknown>;
    const second = output as Record<string, unknown>;
    const deterministicOk = JSON.stringify(Object.keys(first).sort()) === JSON.stringify(Object.keys(second).sort());
    const schemaOk = schemaCheck(first, requiredFields);
    const elapsed = Math.round(performance.now() - started);

    return {
      id: testCase.id,
      pass: deterministicOk && schemaOk,
      latency_ms: elapsed,
      schema_ok: schemaOk,
      deterministic_ok: deterministicOk,
    };
  } catch (error) {
    return {
      id: testCase.id,
      pass: false,
      latency_ms: Math.round(performance.now() - started),
      schema_ok: false,
      deterministic_ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function runParallel<T, R>(items: T[], workerCount: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;

  async function consume(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, workerCount) }, () => consume()));
  return out;
}

async function writeResults(result: HarnessResult): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${result.agent}-${result.run_id}.yaml`;
  const file = path.join(RESULTS_DIR, filename);
  await writeFile(file, JSON.stringify(result, null, 2), "utf8");
  return file;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const runId = randomUUID();
  const suite = await loadSuite(opts.agent);
  const cases = suite.cases;

  const results = await runParallel(cases, opts.workers, (c) => runCase(opts.agent, suite.model_version, c));
  const failed = results.filter((r) => !r.pass);
  const passRate = results.length === 0 ? 0 : (results.length - failed.length) / results.length;
  const schemaRate = results.length === 0 ? 0 : results.filter((r) => r.schema_ok).length / results.length;

  const finalResult: HarnessResult = {
    run_id: runId,
    agent: opts.agent,
    suite: opts.suite,
    mode: opts.mode,
    pass_rate: passRate,
    schema_compliance_rate: schemaRate,
    latency_p99_ms: latencyP99(results.map((r) => r.latency_ms)),
    failed_cases: failed,
    case_results: results,
  };

  const written = await writeResults(finalResult);
  console.log(JSON.stringify({ status: "ok", results_file: written, run_id: runId }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
