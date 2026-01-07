import fetch, { Response } from 'node-fetch';
import * as vscode from 'vscode';

export interface LlmClientOptions {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  maxConcurrentRequests: number;
}

export interface GenerateResult {
  content: string;
  raw: unknown;
}

class Semaphore {
  private queue: Array<() => void> = [];
  private counter: number;

  constructor(count: number) {
    this.counter = Math.max(1, count);
  }

  async acquire(): Promise<void> {
    if (this.counter > 0) {
      this.counter -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.counter += 1;
    const next = this.queue.shift();
    if (next) {
      this.counter -= 1;
      next();
    }
  }
}

export class LlmClient {
  private semaphore: Semaphore;

  constructor(private readonly options: LlmClientOptions, private readonly output: vscode.OutputChannel) {
    this.semaphore = new Semaphore(options.maxConcurrentRequests || 1);
  }

  async generate(prompt: string): Promise<GenerateResult> {
    if (!this.options.apiUrl) {
      throw new Error('API URL is not configured (deepseekCSharp.assistant.apiUrl).');
    }
    if (!this.options.apiKey) {
      throw new Error('API key is not configured (deepseekCSharp.assistant.apiKey).');
    }

    await this.semaphore.acquire();
    try {
      return await this.callWithRetry(prompt);
    } finally {
      this.semaphore.release();
    }
  }

  private async callWithRetry(prompt: string): Promise<GenerateResult> {
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.call(prompt);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        this.output.appendLine(`[DeepSeek] Attempt ${attempt} failed: ${message}`);
        if (attempt === attempts) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error('Unexpected retry failure');
  }

  private async call(prompt: string): Promise<GenerateResult> {
    const payload = {
      model: this.options.model,
      prompt,
      max_tokens: this.options.maxTokens,
      temperature: this.options.temperature
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(this.options.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`
        },
        signal: controller.signal
      });

      this.ensureSuccess(response);
      const data = (await response.json()) as Record<string, unknown>;
      const content = this.extractContent(data);
      return { content, raw: data };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error('LLM request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private ensureSuccess(response: Response): void {
    if (!response.ok) {
      const status = `${response.status} ${response.statusText}`;
      throw new Error(`LLM request failed: ${status}`);
    }
  }

  private extractContent(data: Record<string, unknown>): string {
    const choices = (data as { choices?: Array<{ text?: string; message?: { content?: string } }> }).choices;
    if (choices && choices.length > 0) {
      const first = choices[0];
      if (first.message?.content) {
        return first.message.content;
      }
      if (first.text) {
        return first.text;
      }
    }

    const content = (data as { content?: string }).content ?? (data as { result?: string }).result;
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }
    return '';
  }
}
