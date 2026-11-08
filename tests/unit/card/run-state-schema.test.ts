import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' }).terminal).toBe(
      'idle_timeout',
    );
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }).terminal,
    ).toBe('idle_timeout');
  });
});

describe('run state tool streaming', () => {
  it('renders partial tool output without finishing the tool', () => {
    const running = reduce(initialState, {
      type: 'tool_use',
      id: 'call-1',
      name: 'bash',
      input: { command: 'echo hi' },
    });
    const updated = reduce(running, { type: 'tool_update', id: 'call-1', output: 'hi\n' });

    expect(updated.blocks).toEqual([
      {
        kind: 'tool',
        tool: {
          id: 'call-1',
          name: 'bash',
          input: { command: 'echo hi' },
          status: 'running',
          output: 'hi\n',
        },
      },
    ]);
    expect(updated.footer).toBe('tool_running');

    const done = reduce(updated, {
      type: 'tool_result',
      id: 'call-1',
      output: 'hi\n',
      isError: false,
    });
    expect(done.blocks[0]).toMatchObject({ tool: { status: 'done', output: 'hi\n' } });
  });
});
