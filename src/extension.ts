import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { LlmClient } from './llm/client';
import { DEFAULT_RESULTS_DIRECTORY, runTests, TestRunResult } from './testRunner';
import { renderWebview, WebviewState } from './ui/webview';

interface AssistantConfiguration {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  autoRunTests: boolean;
  testsCommand: string;
  runTestsOnSave: boolean;
  showTestOutputPanel: boolean;
  contextLines: number;
  promptTemplatePath: string;
  maxConcurrentRequests: number;
  useChatApi: boolean;
}

const CHANNEL_NAME = 'DeepSeek C# Assistant';
const DEFAULT_TESTS_COMMAND = `dotnet test --logger "trx;LogFileName=results.trx" --results-directory ./${DEFAULT_RESULTS_DIRECTORY}`;
let diagnostics: vscode.DiagnosticCollection | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(CHANNEL_NAME);
  diagnostics = vscode.languages.createDiagnosticCollection('deepseek-csharp-assistant');

  context.subscriptions.push(output, diagnostics);

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekCSharp.assist', async () => {
      await handleAssistCommand(output);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const config = readConfiguration();
      if (!config.runTestsOnSave || document.languageId !== 'csharp') {
        return;
      }
      await executeTests(config, output, `Save: ${path.basename(document.uri.fsPath)}`);
    })
  );
}

export function deactivate(): void {
  diagnostics?.dispose();
}

async function handleAssistCommand(output: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a C# file to use DeepSeek C# Assistant.');
    return;
  }

  const { document, selection } = editor;
  if (document.languageId !== 'csharp') {
    vscode.window.showWarningMessage('DeepSeek C# Assistant only works with C# files.');
    return;
  }

  const config = readConfiguration();
  const panel = vscode.window.createWebviewPanel(
    'deepseekCSharpAssistant',
    'DeepSeek C# Assistant',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  const contextSnippet = buildContextSnippet(document, selection, config.contextLines);
  const prompt = await buildPrompt(contextSnippet, config);

  updateWebview(panel, {
    status: 'Requesting code from DeepSeek...',
    promptPreview: prompt
  });

  const client = new LlmClient(
    {
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      maxConcurrentRequests: config.maxConcurrentRequests,
      useChatApi: config.useChatApi
    },
    output
  );

  let generated: string;
  try {
    const result = await client.generate(prompt);
    generated = result.content || '// No content returned from LLM';
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    vscode.window.showErrorMessage(`DeepSeek request failed: ${message}`);
    updateWebview(panel, {
      status: 'LLM request failed',
      promptPreview: prompt,
      error: message
    });
    return;
  }

  updateWebview(panel, {
    status: 'Review generated code',
    promptPreview: prompt,
    generation: generated
  });

  const previewDoc = await vscode.workspace.openTextDocument({ language: 'csharp', content: generated });
  await vscode.window.showTextDocument(previewDoc, { preview: true });

  const accept = await vscode.window.showInformationMessage(
    'Insert generated code into the current document?',
    { modal: true },
    'Insert',
    'Skip'
  );

  if (accept !== 'Insert') {
    return;
  }

  await applyGeneratedCode(editor, generated);
  vscode.window.showInformationMessage('Inserted generated code.');

  if (config.autoRunTests) {
    const result = await executeTests(config, output, 'Generation');
    updateWebview(panel, {
      status: 'Test run completed',
      promptPreview: prompt,
      generation: generated,
      testResult: result
    });
  }
}

async function applyGeneratedCode(editor: vscode.TextEditor, content: string): Promise<void> {
  const targetEditor = await vscode.window.showTextDocument(
    editor.document,
    editor.viewColumn ?? vscode.ViewColumn.One
  );

  const selection = targetEditor.selection;
  await targetEditor.edit((editBuilder) => {
    if (selection && !selection.isEmpty) {
      editBuilder.replace(selection, content);
    } else {
      editBuilder.insert(selection.start, content);
    }
  });
  await targetEditor.document.save();
}

async function executeTests(
  config: AssistantConfiguration,
  output: vscode.OutputChannel,
  reason: string
): Promise<TestRunResult | undefined> {
  if (!config.testsCommand) {
    vscode.window.showWarningMessage('Tests command is not configured.');
    return undefined;
  }

  const cwd = getWorkingDirectory();

  if (config.showTestOutputPanel) {
    output.show(true);
  }

  output.appendLine(`[DeepSeek] Running tests (${reason}) with command: ${config.testsCommand}`);
  const result = await runTests(config.testsCommand, cwd, output);
  publishDiagnostics(result);

  const summary = result.summary;
  vscode.window.showInformationMessage(
    result.success
      ? `Tests passed (Passed: ${summary.passed}, Skipped: ${summary.skipped}).`
      : `Tests finished with failures (Failed: ${summary.failed}, Passed: ${summary.passed}).`
  );

  return result;
}

function publishDiagnostics(result: TestRunResult | undefined): void {
  diagnostics?.clear();
  if (!result || result.failures.length === 0) {
    return;
  }

  const targetUri = vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    return;
  }

  const entries = result.failures.map(
    (failure) =>
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        `${failure.testName}: ${failure.message ?? 'Test failed'}`,
        vscode.DiagnosticSeverity.Error
      )
  );
  diagnostics?.set(targetUri, entries);
}

function getWorkingDirectory(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) {
    return workspaceFolder;
  }

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activeFile) {
    return path.dirname(activeFile);
  }

  return process.cwd();
}

function readConfiguration(): AssistantConfiguration {
  const config = vscode.workspace.getConfiguration('deepseekCSharp.assistant');
  return {
    apiUrl: config.get<string>('apiUrl', 'https://api.deepseek.com/v1/chat/completions'),
    apiKey: config.get<string>('apiKey', ''),
    model: config.get<string>('model', 'deepseek-chat'),
    useChatApi: config.get<boolean>('useChatApi', true),
    timeoutMs: config.get<number>('timeoutMs', 30000),
    maxTokens: config.get<number>('maxTokens', 1024),
    temperature: config.get<number>('temperature', 0),
    autoRunTests: config.get<boolean>('autoRunTests', true),
    testsCommand: config.get<string>('testsCommand', DEFAULT_TESTS_COMMAND),
    runTestsOnSave: config.get<boolean>('runTestsOnSave', false),
    showTestOutputPanel: config.get<boolean>('showTestOutputPanel', true),
    contextLines: config.get<number>('contextLines', 30),
    promptTemplatePath: config.get<string>('promptTemplatePath', ''),
    maxConcurrentRequests: config.get<number>('maxConcurrentRequests', 2)
  };
}

function buildContextSnippet(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  contextLines: number
): string {
  const startLine = Math.max(0, selection.start.line - contextLines);
  const endLine = Math.min(document.lineCount - 1, selection.end.line + contextLines);
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    lines.push(document.lineAt(line).text);
  }
  return lines.join('\n');
}

async function buildPrompt(contextSnippet: string, config: AssistantConfiguration): Promise<string> {
  const template =
    (await readTemplateFile(config.promptTemplatePath)) ??
    `You are a helpful, precise C# coding assistant. Given the following context and related unit tests, produce only the C# code required that passes the tests.

Context:
<CODE_BLOCK>
<CODE_BLOCK_CONTENT>

Tests Summary:
<TEST_SUMMARY>

Constraints:
- Target framework: net6.0
- Only return code, no explanation or comments
- Follow existing naming conventions and styling in the file
- Do not introduce secrets or hard-coded credentials
`;

  const testSummary =
    'Tests will be executed via the configured command and validated automatically after code is inserted.';

  return template
    .replace('<CODE_BLOCK_CONTENT>', contextSnippet)
    .replace('<CODE_BLOCK>', 'Current file context')
    .replace('<TEST_SUMMARY>', testSummary);
}

async function readTemplateFile(templatePath: string): Promise<string | undefined> {
  if (!templatePath) {
    return undefined;
  }
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const resolved = path.isAbsolute(templatePath) ? templatePath : path.join(workspaceFolder, templatePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return undefined;
    }
    return await fs.readFile(resolved, 'utf8');
  } catch {
    return undefined;
  }
}

function updateWebview(panel: vscode.WebviewPanel, state: WebviewState): void {
  panel.webview.html = renderWebview(state);
}
