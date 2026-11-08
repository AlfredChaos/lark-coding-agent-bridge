import type { ClaudePermissionMode } from '../types';

/**
 * OMP approval modes this adapter can request. Derived from the bridge's
 * permission policy — never configured directly, so a profile cannot widen
 * its own access ceiling.
 */
export type OmpApprovalMode = 'always-ask' | 'always-ask-cached' | 'write' | 'yolo';

export interface BuildOmpArgsOptions {
  sessionDir: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  tools?: readonly string[];
  permissionMode?: ClaudePermissionMode;
}

/**
 * Map the bridge's canonical permission mode onto OMP's approval modes.
 *
 * OMP has no OS-level sandbox, so approval prompts are the only gate. Tools
 * that would need an interactive confirmation are auto-denied by the adapter
 * (see `rpc.ts`), which keeps `read-only` and `workspace` profiles from
 * silently escalating while still running headless.
 */
export function ompApprovalModeFor(permissionMode: ClaudePermissionMode | undefined): OmpApprovalMode {
  switch (permissionMode) {
    case 'plan':
      return 'always-ask';
    case 'default':
    case 'acceptEdits':
      return 'write';
    case 'bypassPermissions':
    default:
      return 'yolo';
  }
}

export function buildOmpArgs(opts: BuildOmpArgsOptions): string[] {
  const args = ['--mode', 'rpc', '--no-title', '--no-ui'];

  const sessionDir = clean(opts.sessionDir);
  if (sessionDir) args.push('--session-dir', sessionDir);

  const sessionId = clean(opts.sessionId);
  if (sessionId) args.push('--resume', sessionId);

  const model = clean(opts.model);
  if (model) args.push('--model', model);

  const thinking = clean(opts.thinking);
  if (thinking) args.push('--thinking', thinking);

  const tools = (opts.tools ?? []).map(clean).filter((tool): tool is string => Boolean(tool));
  if (tools.length > 0) args.push('--tools', tools.join(','));

  args.push('--approval-mode', ompApprovalModeFor(opts.permissionMode));

  return args;
}

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
