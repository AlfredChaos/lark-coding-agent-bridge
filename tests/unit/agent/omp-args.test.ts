import { describe, expect, it } from 'vitest';
import { buildOmpArgs, ompApprovalModeFor } from '../../../src/agent/omp/args.js';

describe('OMP argv contract', () => {
  it('always pins RPC transport and headless UI', () => {
    expect(buildOmpArgs({ sessionDir: '/tmp/omp' })).toEqual([
      '--mode',
      'rpc',
      '--no-title',
      '--no-ui',
      '--session-dir',
      '/tmp/omp',
      '--approval-mode',
      'yolo',
    ]);
  });

  it('forwards resume, model, thinking and the tool allowlist', () => {
    const args = buildOmpArgs({
      sessionDir: '/tmp/omp',
      sessionId: 'sess-1',
      model: 'opencode-go/deepseek-v4.1-flash',
      thinking: 'max',
      tools: ['bash', 'read', 'grep'],
      permissionMode: 'acceptEdits',
    });

    expect(args).toEqual([
      '--mode',
      'rpc',
      '--no-title',
      '--no-ui',
      '--session-dir',
      '/tmp/omp',
      '--resume',
      'sess-1',
      '--model',
      'opencode-go/deepseek-v4.1-flash',
      '--thinking',
      'max',
      '--tools',
      'bash,read,grep',
      '--approval-mode',
      'write',
    ]);
  });

  it('drops blank option values instead of passing empty flags', () => {
    const args = buildOmpArgs({
      sessionDir: ' /tmp/omp ',
      sessionId: '   ',
      model: '',
      thinking: '  ',
      tools: ['  ', 'bash'],
    });

    expect(args).toContain('--session-dir');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--thinking');
    expect(args[args.indexOf('--tools') + 1]).toBe('bash');
  });

  it('never widens approval beyond the policy mode', () => {
    expect(ompApprovalModeFor('plan')).toBe('always-ask');
    expect(ompApprovalModeFor('default')).toBe('write');
    expect(ompApprovalModeFor('acceptEdits')).toBe('write');
    expect(ompApprovalModeFor('bypassPermissions')).toBe('yolo');
    expect(ompApprovalModeFor(undefined)).toBe('yolo');
  });
});
