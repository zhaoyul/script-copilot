import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';

export interface TestFailure {
  testName: string;
  message?: string;
  stackTrace?: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
}

export interface TestRunResult {
  success: boolean;
  failures: TestFailure[];
  summary: TestSummary;
  resultsFile?: string;
}

export async function runTests(
  command: string,
  cwd: string,
  output: vscode.OutputChannel
): Promise<TestRunResult> {
  const resultsDir = parseResultsDirectory(command) ?? path.join(cwd, 'deepseek_test_results');
  await ensureDirectory(resultsDir);

  return new Promise<TestRunResult>((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    const logs: Array<string> = [];

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      logs.push(text);
      output.append(text);
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      logs.push(text);
      output.append(text);
    });

    child.on('close', async (code) => {
      const trx = await findLatestTrx(resultsDir);
      if (trx) {
        try {
          const parsed = await parseTrx(trx);
          parsed.success = parsed.failures.length === 0 && (code === 0 || code === null);
          resolve(parsed);
          return;
        } catch (err) {
          output.appendLine(`Failed to parse TRX: ${(err as Error).message}`);
        }
      }

      resolve({
        success: code === 0,
        failures: [],
        summary: {
          passed: 0,
          failed: code && code !== 0 ? 1 : 0,
          skipped: 0,
          total: code && code !== 0 ? 1 : 0,
          durationMs: 0
        }
      });
    });
  });
}

async function ensureDirectory(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function parseResultsDirectory(command: string): string | undefined {
  const match = command.match(/--results-directory\s+((?:\"[^\"]+\")|(?:'[^']+')|[^\\s]+)/);
  if (!match) {
    return undefined;
  }
  const raw = match[1];
  return raw.replace(/^['"]|['"]$/g, '');
}

async function findLatestTrx(resultsDir: string): Promise<string | undefined> {
  try {
    const files = await fs.readdir(resultsDir);
    const trxFiles = files.filter((f) => f.toLowerCase().endsWith('.trx'));
    if (trxFiles.length === 0) {
      return undefined;
    }
    const stats = await Promise.all(
      trxFiles.map(async (file) => ({
        file,
        time: (await fs.stat(path.join(resultsDir, file))).mtimeMs
      }))
    );
    const latest = stats.sort((a, b) => b.time - a.time)[0];
    return path.join(resultsDir, latest.file);
  } catch {
    return undefined;
  }
}

async function parseTrx(trxPath: string): Promise<TestRunResult> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const content = await fs.readFile(trxPath, 'utf8');
  const json = parser.parse(content) as {
    TestRun?: {
      Results?: { UnitTestResult?: unknown };
    };
  };

  const results = toArray(json.TestRun?.Results?.UnitTestResult) as Array<Record<string, unknown>>;
  const failures: TestFailure[] = [];
  let passed = 0;
  let skipped = 0;
  let durationMs = 0;

  for (const result of results) {
    const outcome = String(result['@_outcome'] ?? '').toLowerCase();
    const testName = String(result['@_testName'] ?? 'Unknown test');
    const duration = parseDuration(String(result['@_duration'] ?? ''));

    if (duration) {
      durationMs += duration;
    }

    if (outcome === 'passed') {
      passed += 1;
    } else if (outcome === 'notexecuted' || outcome === 'skipped') {
      skipped += 1;
    } else {
      failures.push({
        testName,
        message: (result.Output as { ErrorInfo?: { Message?: string } })?.ErrorInfo?.Message,
        stackTrace: (result.Output as { ErrorInfo?: { StackTrace?: string } })?.ErrorInfo?.StackTrace
      });
    }
  }

  const total = results.length;
  const summary: TestSummary = {
    passed,
    failed: failures.length,
    skipped,
    total,
    durationMs
  };

  return { success: failures.length === 0, failures, summary, resultsFile: trxPath };
}

function parseDuration(duration: string): number {
  // Format: HH:MM:SS.mmmmmm
  const match = duration.match(/(?<h>\\d+):(?<m>\\d+):(?<s>\\d+)(?:\\.(?<ms>\\d+))?/);
  if (!match || !match.groups) {
    return 0;
  }
  const hours = Number(match.groups.h);
  const minutes = Number(match.groups.m);
  const seconds = Number(match.groups.s);
  const milliseconds = Number((match.groups.ms ?? '0').slice(0, 3));
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + milliseconds;
}

function toArray<T>(value: unknown): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value as T];
}
