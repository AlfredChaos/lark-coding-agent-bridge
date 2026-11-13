import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildOmpArgs } from './args';
import { loadOmpImages } from './images';
import {
  hostToolCall,
  hostToolErrorFrame,
  hostUriErrorFrame,
  hostUriRequest,
  isReadyFrame,
  OmpJsonlTranslator,
  parseOmpJsonLine,
  uiCancelledFrame,
  uiRequestNeedingResponse,
} from './rpc';

export interface OmpAdapterOptions {
  binary: string;
  /** Profile-scoped directory for OMP session files and resume lookups. */
  sessionDir: string;
  model?: string;
  thinking?: string;
  tools?: readonly string[];
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type OmpChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const PROMPT_ID = 'prompt_1';
const STATE_ID = 'state_1';
const ABORT_ID = 'abort_1';

export class OmpAdapter implements AgentAdapter {
  readonly id = 'omp';
  readonly displayName = 'Oh My Pi';

  private readonly binary: string;
  private readonly sessionDir: string;
  private readonly model: string | undefined;
  private readonly thinking: string | undefined;
  private readonly tools: readonly string[] | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OmpAdapterOptions) {
    this.binary = opts.binary;
    this.sessionDir = opts.sessionDir;
    this.model = opts.model;
    this.thinking = opts.thinking;
    this.tools = opts.tools;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'omp',
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for OmpAdapter.run');
    }

    const args = buildOmpArgs({
      sessionDir: this.sessionDir,
      sessionId: opts.sessionId,
      model: opts.model ?? this.model,
      thinking: this.thinking,
      tools: this.tools,
      permissionMode: opts.permissionMode,
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as OmpChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      sessionDir: this.sessionDir,
      promptChars: opts.prompt.length,
      model: opts.model ?? this.model,
      thinking: this.thinking,
      tools: this.tools?.length ?? 0,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });

    const translator = new OmpJsonlTranslator();
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);

    return {
      runId: opts.runId,
      events: createEventStream({
        child,
        prompt,
        images: opts.images,
        translator,
        stderrChunks,
        getError: () => runtimeError,
      }),
      async stop() {
        translator.markStopRequested();
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'omp-abort', { pid: child.pid ?? null, graceMs: stopGraceMs });
        writeFrame(child, { id: ABORT_ID, type: 'abort' });
        endInput(child);
        if (await waitForExitWithin(child, Math.min(1000, stopGraceMs))) return;

        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        if (await waitForExitWithin(child, stopGraceMs)) return;

        log.warn('agent', 'stop-sigkill', {
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
          reason: 'grace-period-expired',
        });
        child.kill('SIGKILL');
        await waitForExit(child);
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return waitForExitWithin(child, timeoutMs);
      },
    };
  }
}

interface EventStreamInput {
  child: OmpChild;
  prompt: string;
  images?: readonly string[];
  translator: OmpJsonlTranslator;
  stderrChunks: Buffer[];
  getError: () => Error | null;
}

async function* createEventStream(input: EventStreamInput): AsyncGenerator<AgentEvent> {
  const { child, prompt, translator, stderrChunks, getError } = input;
  if (!child.pid) {
    const err = getError();
    yield* translator.fail(
      err ? `failed to spawn omp: ${err.message}` : 'spawn returned no pid',
    );
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawReady = false;
  let promptSent = false;
  try {
    for await (const line of rl) {
      const parsed = parseOmpJsonLine(line);
      if (parsed === undefined) {
        if (line.trim()) log.warn('agent', 'non-json-stdout', { line });
        continue;
      }

      if (isReadyFrame(parsed)) {
        if (sawReady) continue;
        sawReady = true;
        try {
          const images = await loadOmpImages(input.images);
          writeFrameOrThrow(child, { id: STATE_ID, type: 'get_state' });
          writeFrameOrThrow(child, {
            id: PROMPT_ID,
            type: 'prompt',
            message: prompt,
            ...(images.length > 0 ? { images } : {}),
          });
          promptSent = true;
        } catch (err) {
          yield* translator.fail(`failed to start omp prompt: ${errorText(err)}`);
          endInput(child);
          break;
        }
        continue;
      }

      const ui = uiRequestNeedingResponse(parsed);
      if (ui) {
        // RPC mode blocks the requesting operation until the host answers.
        // The bridge has no interactive surface, so deny instead of hanging.
        log.info('agent', 'omp-ui-cancelled', { method: ui.method });
        writeFrame(child, uiCancelledFrame(ui.id));
        continue;
      }
      const tool = hostToolCall(parsed);
      if (tool) {
        writeFrame(child, hostToolErrorFrame(tool.id, `host tool not registered: ${tool.toolName}`));
        continue;
      }
      const uri = hostUriRequest(parsed);
      if (uri) {
        writeFrame(child, hostUriErrorFrame(uri.id, `host URI scheme not registered: ${uri.url}`));
        continue;
      }

      for (const event of translator.translate(parsed)) {
        yield event;
      }
      if (translator.terminalEmitted()) {
        endInput(child);
        break;
      }
    }
  } finally {
    rl.close();
  }

  const exited = await waitForExit(child);
  if (translator.terminalEmitted()) return;

  if (exited.code !== 0 && exited.code !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield* translator.fail(`omp exited with code ${exited.code}${detail}`);
    return;
  }

  const runtimeError = getError();
  if (runtimeError && exited.code === null) {
    yield* translator.fail(`omp runtime error: ${runtimeError.message}`);
    return;
  }
  if (!sawReady) {
    yield* translator.fail('omp exited before sending ready frame');
    return;
  }
  if (!promptSent) {
    yield* translator.fail('omp exited before prompt was accepted');
    return;
  }
  // A clean EOF after the prompt was accepted is not a successful run: OMP
  // never emitted a terminal agent_end, so the reply would silently be empty.
  yield* translator.fail(translator.lastAssistantError() ?? 'omp exited before terminal agent_end');
}

function writeFrameOrThrow(child: OmpChild, frame: Record<string, unknown>): void {
  if (!writeFrame(child, frame)) throw new Error('stdin is closed');
}

function writeFrame(child: OmpChild, frame: Record<string, unknown>): boolean {
  if (child.stdin.destroyed || child.stdin.writableEnded) return false;
  child.stdin.write(`${JSON.stringify(frame)}\n`);
  return true;
}

function endInput(child: OmpChild): void {
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
}

function waitForExit(
  child: OmpChild,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForExitWithin(child: OmpChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
