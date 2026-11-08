import { describe, expect, it } from 'vitest';
import {
  assistantMessageError,
  isReadyFrame,
  OmpJsonlTranslator,
  parseOmpJsonLine,
  uiRequestNeedingResponse,
} from '../../../src/agent/omp/rpc.js';

describe('OMP RPC frame translation', () => {
  it('parses JSONL lines and ignores non-JSON diagnostics', () => {
    expect(parseOmpJsonLine('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseOmpJsonLine('   ')).toBeUndefined();
    expect(parseOmpJsonLine('Warning: built-in provider failed')).toBeUndefined();
    expect(isReadyFrame({ type: 'ready' })).toBe(true);
    expect(isReadyFrame({ type: 'agent_start' })).toBe(false);
  });

  it('maps get_state responses to a system event with a provider-qualified model', () => {
    const translator = new OmpJsonlTranslator();
    expect(
      translator.translate({
        type: 'response',
        id: 'state_1',
        command: 'get_state',
        success: true,
        data: { sessionId: 'sess-9', model: { provider: 'opencode-go', id: 'deepseek-v4.1-flash' } },
      }),
    ).toEqual([{ type: 'system', sessionId: 'sess-9', model: 'opencode-go/deepseek-v4.1-flash' }]);
  });

  it('treats a non-terminal agent_end as an intermediate frame', () => {
    const translator = new OmpJsonlTranslator();

    expect(
      translator.translate({
        type: 'agent_end',
        isTerminal: false,
        messages: [{ role: 'assistant', stopReason: 'stop' }],
      }),
    ).toEqual([]);
    expect(translator.terminalEmitted()).toBe(false);
    expect(
      translator.translate({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'stop' }],
      }),
    ).toEqual([{ type: 'done', terminationReason: 'normal' }]);
    expect(translator.terminalEmitted()).toBe(true);
  });

  it('retains a provider error streamed before a compacted agent_end', () => {
    const translator = new OmpJsonlTranslator();
    translator.translate({ type: 'message_start', message: { role: 'assistant' } });
    translator.translate({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' },
    });

    expect(translator.translate({ type: 'agent_end', isTerminal: true })).toEqual([
      { type: 'error', message: 'rate limited', terminationReason: 'failed' },
    ]);
  });

  it('maps tool lifecycle frames including partial updates', () => {
    const translator = new OmpJsonlTranslator();

    expect(
      translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    ).toEqual([{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls' } }]);
    expect(
      translator.translate({
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        partialResult: { content: [{ type: 'text', text: 'partial' }] },
      }),
    ).toEqual([{ type: 'tool_update', id: 'call-1', output: 'partial' }]);
    expect(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: true,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: 'done', isError: true }]);
  });

  it('finishes when omp handled the prompt locally', () => {
    const translator = new OmpJsonlTranslator();
    expect(translator.translate({ type: 'prompt_result', agentInvoked: false })).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('does not end the run on non-prompt command failures or error notices', () => {
    const translator = new OmpJsonlTranslator();
    expect(
      translator.translate({ type: 'response', command: 'set_model', success: false, error: 'nope' }),
    ).toEqual([]);
    expect(translator.translate({ type: 'notice', level: 'error', message: 'retrying' })).toEqual([]);
    expect(translator.translate({ type: 'available_commands_update', commands: [] })).toEqual([]);
    expect(translator.terminalEmitted()).toBe(false);
  });

  it('turns an aborted terminal frame into an interrupted done after stop()', () => {
    const translator = new OmpJsonlTranslator();
    translator.markStopRequested();

    expect(
      translator.translate({
        type: 'agent_end',
        isTerminal: true,
        messages: [{ role: 'assistant', stopReason: 'aborted' }],
      }),
    ).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
  });

  it('extracts provider error text from message shapes and stop reasons', () => {
    expect(assistantMessageError({ role: 'assistant', errorMessage: 'boom' })).toBe('boom');
    expect(assistantMessageError({ role: 'assistant', error: { message: 'nested boom' } })).toBe(
      'nested boom',
    );
    expect(assistantMessageError({ role: 'assistant', stopReason: 'error' })).toBe(
      'omp assistant turn failed',
    );
    expect(assistantMessageError({ role: 'user' })).toBeUndefined();
  });

  it('identifies blocking extension UI requests that need a cancellation reply', () => {
    expect(
      uiRequestNeedingResponse({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm' }),
    ).toEqual({ id: 'ui-1', method: 'confirm' });
    expect(
      uiRequestNeedingResponse({ type: 'extension_ui_request', id: 'ui-2', method: 'setWidget' }),
    ).toBeUndefined();
    expect(uiRequestNeedingResponse({ type: 'ready' })).toBeUndefined();
  });
});
