import { TestRunResult } from '../testRunner';

export interface WebviewState {
  status: string;
  promptPreview?: string;
  generation?: string;
  testResult?: TestRunResult;
  error?: string;
}

export function renderWebview(state: WebviewState): string {
  const failures = state.testResult?.failures ?? [];
  const summary = state.testResult?.summary;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 12px; color: #e6e9ef; background: #0f172a; }
    h1 { font-size: 18px; margin-bottom: 8px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
    pre { white-space: pre-wrap; background: #0b1220; padding: 8px; border-radius: 6px; border: 1px solid #1f2937; }
    .status { color: #a5b4fc; }
    .error { color: #fca5a5; }
    .success { color: #34d399; }
    .failures { color: #f87171; }
    table { width: 100%; border-collapse: collapse; }
    td, th { border-bottom: 1px solid #1f2937; padding: 6px; text-align: left; }
  </style>
</head>
<body>
  <h1>DeepSeek C# Assistant</h1>
  <div class="card">
    <div class="status">Status: ${escapeHtml(state.status)}</div>
    ${state.error ? `<div class="error">Error: ${escapeHtml(state.error)}</div>` : ''}
  </div>
  ${state.promptPreview ? `<div class="card"><strong>Prompt</strong><pre>${escapeHtml(state.promptPreview)}</pre></div>` : ''}
  ${state.generation ? `<div class="card"><strong>Generated Code</strong><pre>${escapeHtml(state.generation)}</pre></div>` : ''}
  ${
    state.testResult
      ? `<div class="card">
          <strong>Test Results</strong>
          ${
            summary
              ? `<div class="${state.testResult.success ? 'success' : 'failures'}">
                   Passed: ${summary.passed}, Failed: ${summary.failed}, Skipped: ${summary.skipped}, Total: ${summary.total}
                 </div>`
              : ''
          }
          ${
            failures.length > 0
              ? `<table>
                  <thead><tr><th>Test</th><th>Message</th></tr></thead>
                  <tbody>${failures
                    .map(
                      (f) =>
                        `<tr><td>${escapeHtml(f.testName)}</td><td>${escapeHtml(f.message ?? '')}</td></tr>`
                    )
                    .join('')}</tbody>
                </table>`
              : '<div class="success">No failing tests.</div>'
          }
        </div>`
      : ''
  }
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
