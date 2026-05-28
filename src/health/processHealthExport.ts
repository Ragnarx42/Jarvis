import { exec } from "child_process";
import { promisify } from "util";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);
const VAULT_ROOT = process.env.VAULT_ROOT ?? "/Users/michaelwolff/Brain";

type Severity = "low" | "moderate" | "high";

export type ProcessHealthExportResult = {
  severity: Severity;
  trace_id: string;
  wiki_note_path: string;
  queue_signal_path?: string;
};

/**
 * Wrapper for the existing HealthIngest.ts CLI.
 * Runs the script on a given export file and returns structured results.
 */
export async function processHealthExport(filePath: string): Promise<ProcessHealthExportResult> {
  const trace_id = randomUUID();

  const { stdout, stderr } = await execAsync(
    `bun run ${process.env.HOME}/Projects/Jarvis/skills/Health/Tools/HealthIngest.ts --file "${filePath}"`,
    { env: { ...process.env, TRACE_ID: trace_id, JARVIS_TEST_MODE: 'true', VAULT_ROOT: '/tmp/jarvis-test-vault' } },
  );

  const wikiMatch = stdout.match(/Written:\s+(.+\.md)/);
  const wiki_note_path = wikiMatch ? wikiMatch[1] : "";
  const severity = inferSeverity(stdout, stderr);
  const queue_signal_path = await findLatestQueueSignalByTraceId(trace_id);

  return { severity, trace_id, wiki_note_path, queue_signal_path };
}

export function inferSeverity(stdout: string, stderr: string): Severity {
  const structuredMatch = stdout.match(/SEVERITY:\s*(low|moderate|high)/);
  if (structuredMatch) return structuredMatch[1] as Severity;
  const blob = `${stdout}\n${stderr}`.toLowerCase();
  if (blob.includes("severity: high") || blob.includes("critical") || blob.includes("fatal")) return "high";
  if (blob.includes("severity: moderate") || blob.includes("alert") || blob.includes("warning")) return "moderate";
  return "low";
}

export async function findLatestQueueSignalByTraceId(traceId: string): Promise<string | undefined> {
  const queueDir = join(process.env.VAULT_ROOT ?? VAULT_ROOT, "12 Queue");
  let entries: string[];
  try {
    entries = await readdir(queueDir);
  } catch {
    return undefined;
  }

  const markdownFiles = entries.filter((name) => name.endsWith(".md"));
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const filename of markdownFiles) {
    const fullPath = join(queueDir, filename);
    try {
      const content = await readFile(fullPath, "utf8");
      if (!content.includes(traceId)) continue;
      const info = await stat(fullPath);
      candidates.push({ path: fullPath, mtimeMs: info.mtimeMs });
    } catch {
      // Skip unreadable files and continue searching.
    }
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].path;
}
