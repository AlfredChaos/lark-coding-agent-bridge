import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

/**
 * OMP RPC frame helpers and the JSONL -> AgentEvent translator.
 *
 * Protocol reference: https://omp.sh/docs/rpc
 * Every stdout line is one complete JSON object. Diagnostics belong on stderr.
 */

interface OmpModel {
  provider?: string;
  id?: string;
  name?: string;
}

interface OmpUsage {
  input?: number;
  inputTokens?: number;
  output?: number;
  outputTokens?: number;
  cacheRead?: number;
  reasoningTokens?: number;
  cost?: { total?: number };
}

interface OmpMessage {
  role?: string;
  usage?: OmpUsage;
  stopReason?: string;
  errorMessage?: unknown;
  error?: unknown;
}

interface OmpAssistantEvent {
  type?: string;
  delta?: string;
  error?: unknown;
}

interface OmpFrame {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { sessionId?: string; model?: OmpModel; agentInvoked?: boolean };
  assistantMessageEvent?: OmpAssistantEvent;
  /** OMP sends false while an async continuation will resume the session. */
  isTerminal?: boolean;
  messages?: unknown[];
  message?: OmpMessage | string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  level?: string;
  method?: string;
  agentInvoked?: boolean;
}

export function parseOmpJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function isReadyFrame(raw: unknown): boolean {
  return isRecord(raw) && raw.type === 'ready';
}

/** UI methods that block the agent until the host answers. */
const UI_METHODS_NEEDING_RESPONSE: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
};

export interface OmpUiRequest {
  id: string;
  method: string;
}

export function uiRequestNeedingResponse(raw: unknown): OmpUiRequest | undefined {
  if (!isRecord(raw) || raw.type !== 'extension_ui_request') return undefined;
  if (typeof raw.id !== 'string' || typeof raw.method !== 'string') return undefined;
  if (UI_METHODS_NEEDING_RESPONSE[raw.method] !== true) return undefined;
  return { id: raw.id, method: raw.method };
}

export function uiCancelledFrame(requestId: string): Record<string, unknown> {
  return { type: 'extension_ui_response', id: requestId, cancelled: true };
}

export interface OmpHostToolCall {
  id: string;
  toolCallId: string;
  toolName: string;
}

export function hostToolCall(raw: unknown): OmpHostToolCall | undefined {
  if (!isRecord(raw) || raw.type !== 'host_tool_call') return undefined;
  if (typeof raw.id !== 'string' || typeof raw.toolName !== 'string') return undefined;
  return {
    id: raw.id,
    toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : raw.id,
    toolName: raw.toolName,
  };
}

export function hostToolErrorFrame(requestId: string, message: string): Record<string, unknown> {
  return {
    type: 'host_tool_result',
    id: requestId,
    isError: true,
    result: { content: [{ type: 'text', text: message }] },
  };
}

export function hostUriRequest(raw: unknown): { id: string; url: string } | undefined {
  if (!isRecord(raw) || raw.type !== 'host_uri_request') return undefined;
  if (typeof raw.id !== 'string' || typeof raw.url !== 'string') return undefined;
  return { id: raw.id, url: raw.url };
}

export function hostUriErrorFrame(requestId: string, message: string): Record<string, unknown> {
  return { type: 'host_uri_result', id: requestId, isError: true, error: message };
}

/**
 * Stateful translator. Terminal frames are reported exactly once; provider
 * errors seen on streamed messages are retained until the terminal `agent_end`
 * so a compacted `agent_end` cannot turn a failed turn into a successful one.
 */
export class OmpJsonlTranslator {
  private terminal = false;
  private stopRequested = false;
  private latestAssistantError: string | undefined;

  markStopRequested(): void {
    this.stopRequested = true;
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  lastAssistantError(): string | undefined {
    return this.latestAssistantError;
  }

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal || !isRecord(raw)) return [];
    const frame = raw as OmpFrame;

    switch (frame.type) {
      case 'response':
        return this.translateResponse(frame);
      case 'message_update':
        return translateMessageUpdate(frame.assistantMessageEvent);
      case 'message_start':
        if (isRecord(frame.message) && frame.message.role === 'assistant') {
          this.latestAssistantError = undefined;
        }
        return [];
      case 'message_end':
      case 'turn_end': {
        const message = isRecord(frame.message) ? (frame.message as OmpMessage) : undefined;
        this.captureAssistantError(message);
        return frame.type === 'turn_end' ? usageEvents(message?.usage) : [];
      }
      case 'tool_execution_start':
        if (typeof frame.toolCallId !== 'string' || typeof frame.toolName !== 'string') return [];
        return [
          {
            type: 'tool_use',
            id: frame.toolCallId,
            name: frame.toolName,
            input: frame.args ?? {},
          },
        ];
      case 'tool_execution_update':
        if (typeof frame.toolCallId !== 'string') return [];
        return [
          { type: 'tool_update', id: frame.toolCallId, output: renderToolResult(frame.partialResult) },
        ];
      case 'tool_execution_end':
        if (typeof frame.toolCallId !== 'string') return [];
        return [
          {
            type: 'tool_result',
            id: frame.toolCallId,
            output: renderToolResult(frame.result),
            isError: frame.isError === true,
          },
        ];
      case 'prompt_result':
        if (frame.agentInvoked === false) return this.finishNormal();
        return [];
      case 'agent_end':
        return this.translateAgentEnd(frame);
      case 'extension_error':
        log.warn('agent', 'omp-extension-error', {
          error: typeof frame.error === 'string' ? frame.error : undefined,
        });
        return [];
      case 'notice':
        if (frame.level === 'error') {
          log.warn('agent', 'omp-notice-error', {
            message: typeof frame.message === 'string' ? frame.message : undefined,
          });
        }
        return [];
      default:
        return [];
    }
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    if (this.stopRequested) return this.finishInterrupted();
    this.terminal = true;
    return [{ type: 'error', message, terminationReason: 'failed' }];
  }

  finishInterrupted(): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'done', terminationReason: 'interrupted' }];
  }

  finishNormal(): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'done', terminationReason: 'normal' }];
  }

  private translateResponse(frame: OmpFrame): AgentEvent[] {
    if (frame.success === false) {
      const message = frame.error || `omp ${frame.command ?? 'command'} failed`;
      if (frame.command === 'prompt' || frame.command === 'abort_and_prompt') {
        return this.finishWithError(message);
      }
      log.warn('agent', 'omp-command-failed', { command: frame.command, error: frame.error });
      return [];
    }

    if (frame.command === 'prompt' && frame.data?.agentInvoked === false) {
      return this.finishNormal();
    }
    if (frame.command !== 'get_state' || frame.success !== true || !frame.data) return [];

    const sessionId = typeof frame.data.sessionId === 'string' ? frame.data.sessionId : undefined;
    const model = formatModel(frame.data.model);
    if (!sessionId && !model) return [];
    return [
      {
        type: 'system',
        ...(sessionId ? { sessionId } : {}),
        ...(model ? { model } : {}),
      },
    ];
  }

  private translateAgentEnd(frame: OmpFrame): AgentEvent[] {
    // Only a terminal agent_end finishes the run. `isTerminal: false` means an
    // async continuation will resume the session; older OMP versions omit the
    // field entirely, which is terminal-compatible.
    if (frame.isTerminal === false) return [];

    const error = terminalAssistantError(frame.messages) ?? this.latestAssistantError;
    if (this.stopRequested) {
      if (error) log.info('agent', 'omp-stopped', { error });
      return this.finishInterrupted();
    }
    if (error) return this.finishWithError(error);
    return this.finishNormal();
  }

  private finishWithError(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'error', message, terminationReason: 'failed' }];
  }

  private captureAssistantError(message: OmpMessage | undefined): void {
    if (!isRecord(message) || message.role !== 'assistant') return;
    this.latestAssistantError = assistantMessageError(message);
  }
}

function translateMessageUpdate(evt: OmpAssistantEvent | undefined): AgentEvent[] {
  if (!isRecord(evt)) return [];
  if (evt.type === 'text_delta' && typeof evt.delta === 'string') {
    return [{ type: 'text', delta: evt.delta }];
  }
  if (evt.type === 'thinking_delta' && typeof evt.delta === 'string') {
    return [{ type: 'thinking', delta: evt.delta }];
  }
  return [];
}

export function assistantMessageError(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== 'assistant') return undefined;
  const errorMessage = message.errorMessage;
  if (typeof errorMessage === 'string' && errorMessage.trim()) return errorMessage;
  const nested = message.error;
  if (typeof nested === 'string' && nested.trim()) return nested;
  if (isRecord(nested) && typeof nested.message === 'string' && nested.message.trim()) {
    return nested.message;
  }
  if (message.stopReason === 'error') return 'omp assistant turn failed';
  if (message.stopReason === 'aborted') return 'omp assistant turn aborted';
  return undefined;
}

function terminalAssistantError(messages: unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'assistant') continue;
    return assistantMessageError(message);
  }
  return undefined;
}

function usageEvents(usage: OmpUsage | undefined): AgentEvent[] {
  if (!isRecord(usage)) return [];
  const inputTokens = numberValue(usage.input) ?? numberValue(usage.inputTokens);
  const outputTokens = numberValue(usage.output) ?? numberValue(usage.outputTokens);
  const cachedInputTokens = numberValue(usage.cacheRead);
  const reasoningOutputTokens = numberValue(usage.reasoningTokens);
  const costUsd = isRecord(usage.cost) ? numberValue(usage.cost.total) : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningOutputTokens === undefined &&
    costUsd === undefined
  ) {
    return [];
  }
  return [
    {
      type: 'usage',
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
  ];
}

function renderToolResult(result: unknown): string {
  if (!isRecord(result)) return result === undefined ? '' : String(result);
  const content = result.content;
  if (!Array.isArray(content)) return stableStringify(result);
  return content.map(renderContentBlock).filter(Boolean).join('\n');
}

function renderContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!isRecord(block)) return stableStringify(block);
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'image') return '[image]';
  if (block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
  return stableStringify(block);
}

function formatModel(model: OmpModel | undefined): string | undefined {
  if (!model) return undefined;
  const id = model.id || model.name;
  if (!id) return undefined;
  return model.provider ? `${model.provider}/${id}` : id;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
