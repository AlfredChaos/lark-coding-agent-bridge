import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOmpArgs } from '../../src/agent/omp/args.js';
import { OmpAdapter } from '../../src/agent/omp/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeOmp {
  path: string;
  dir: string;
  recordPath: string;
  sessionDir: string;
}

interface FakeOmpScenario {
  ready?: boolean;
  afterPrompt?: unknown[];
  exitAfterPrompt?: boolean;
  exitCode?: number;
  exitOnEnd?: boolean;
  exitOnAbort?: boolean;
  stderr?: string;
}

interface FakeOmpRecord {
  argv: string[];
  cwd: string;
  commands: Array<Record<string, unknown>>;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    PATH?: string;
  };
}

describe('OmpAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('drives omp --mode rpc: ready, prompt, text deltas, tools, usage, agent_end', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [
        { type: 'agent_start' },
        { type: 'turn_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Checking. ' } },
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'echo hi' },
        },
        {
          type: 'tool_execution_update',
          toolCallId: 'call-1',
          toolName: 'bash',
          partialResult: { content: [{ type: 'text', text: 'hi\n' }] },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'hi\n' }] },
          isError: false,
        },
        {
          type: 'turn_end',
          message: {
            role: 'assistant',
            stopReason: 'toolUse',
            usage: { input: 10, output: 5, cacheRead: 2, reasoningTokens: 1, cost: { total: 0.01 } },
          },
        },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done.' } },
        { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }], isTerminal: true },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new OmpAdapter({
      binary: fake.path,
      sessionDir: fake.sessionDir,
      model: 'test/model-1',
      thinking: 'high',
      tools: ['bash', 'read'],
      larkChannel: { profile: 'omp-dev', rootDir: join(fake.dir, 'channel-home') },
    }).run({
      runId: 'run-happy',
      prompt: 'hello from lark',
      cwd,
      permissionMode: 'bypassPermissions',
    });

    expect(run.runId).toBe('run-happy');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-1', model: 'test/model-1' },
      { type: 'text', delta: 'Checking. ' },
      { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'echo hi' } },
      { type: 'tool_update', id: 'call-1', output: 'hi\n' },
      { type: 'tool_result', id: 'call-1', output: 'hi\n', isError: false },
      { type: 'usage', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningOutputTokens: 1, costUsd: 0.01 },
      { type: 'thinking', delta: 'pondering' },
      { type: 'text', delta: 'Done.' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(
      buildOmpArgs({
        sessionDir: fake.sessionDir,
        model: 'test/model-1',
        thinking: 'high',
        tools: ['bash', 'read'],
        permissionMode: 'bypassPermissions',
      }),
    );
    expect(record.argv).toContain('--mode');
    expect(record.argv).toContain('rpc');
    expect(record.argv).toContain('--tools');
    expect(record.argv).toContain('bash,read');

    const prompt = record.commands.find((command) => command.type === 'prompt');
    const message = typeof prompt?.message === 'string' ? prompt.message : '';
    expect(message).toContain('lark-channel-bridge 运行约定');
    expect(message).toContain('hello from lark');
    expect(record.commands.map((command) => command.type)).toEqual(['get_state', 'prompt']);
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'omp-dev',
    });
  });

  it('resumes the stored session id through --resume and emits the get_state system frame', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [
        { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }], isTerminal: true },
      ],
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: await realpath(fake.dir),
      sessionId: 'sess-old',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-1', model: 'test/model-1' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--resume');
    expect(record.argv).toContain('sess-old');
  });

  it('keeps reading after a non-terminal agent_end and finishes on the terminal one', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [
        { type: 'agent_end', isTerminal: false, messages: [{ role: 'assistant', stopReason: 'stop' }] },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'continued' } },
        { type: 'agent_end', isTerminal: true, messages: [{ role: 'assistant', stopReason: 'stop' }] },
      ],
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-non-terminal',
      prompt: 'go on',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-1', model: 'test/model-1' },
      { type: 'text', delta: 'continued' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('reports a provider error from the terminal agent_end as a failed run', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [
        { type: 'agent_start' },
        { type: 'message_start', message: { role: 'assistant' } },
        {
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'quota exceeded' },
        },
        {
          type: 'agent_end',
          isTerminal: true,
          messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'quota exceeded' }],
        },
      ],
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-provider-error',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'quota exceeded',
      terminationReason: 'failed',
    });
  });

  it('reports a failed prompt command as an error instead of an empty reply', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [
        {
          type: 'response',
          id: 'prompt_1',
          command: 'prompt',
          success: false,
          error: 'Model not found: test/missing',
        },
      ],
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-prompt-rejected',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Model not found: test/missing',
      terminationReason: 'failed',
    });
  });

  it('treats a locally handled prompt (agentInvoked false) as a completed run', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [{ type: 'prompt_result', id: 'prompt_1', agentInvoked: false }],
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-local-command',
      prompt: '/help',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events.at(-1)).toEqual({ type: 'done', terminationReason: 'normal' });
  });

  it('fails when the process exits before sending the ready frame', async () => {
    const fake = await createFakeOmp({ ready: false });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-no-ready',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'error', message: 'omp exited before sending ready frame', terminationReason: 'failed' },
    ]);
  });

  it('fails when EOF arrives after the prompt was accepted without a terminal agent_end', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } },
        { type: 'agent_end', isTerminal: false },
      ],
      exitAfterPrompt: true,
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-eof',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events[0]).toEqual({ type: 'system', sessionId: 'sess-1', model: 'test/model-1' });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'omp exited before terminal agent_end',
      terminationReason: 'failed',
    });
  });

  it('reports a non-zero exit with stderr detail before any terminal event', async () => {
    const fake = await createFakeOmp({
      ready: false,
      exitCode: 42,
      stderr: 'config parse failed\n',
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, sessionDir: fake.sessionDir }).run({
      runId: 'run-nonzero',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      {
        type: 'error',
        message: 'omp exited with code 42: config parse failed',
        terminationReason: 'failed',
      },
    ]);
  });

  it('stops the run as interrupted by aborting the RPC process', async () => {
    const fake = await createFakeOmp({
      afterPrompt: [{ type: 'agent_start' }],
      exitOnAbort: true,
    });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({
      binary: fake.path,
      sessionDir: fake.sessionDir,
      stopGraceMs: 2000,
    }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', sessionId: 'sess-1', model: 'test/model-1' },
    });
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-omp-${Date.now()}`);
    const run = new OmpAdapter({ binary: missing, sessionDir: tmpdir() }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.type).toBe('error');
    if (event?.type !== 'error') throw new Error('expected an error event');
    expect(event.message).toMatch(/failed to spawn omp|spawn returned no pid|omp exited with code/);
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new OmpAdapter({ binary: 'unused', sessionDir: tmpdir() }).run({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeOmp(scenario: FakeOmpScenario): Promise<FakeOmp> {
  const dir = await mkdtemp(join(tmpdir(), 'omp-adapter-test-'));
  const path = join(dir, 'fake-omp.mjs');
  const recordPath = join(dir, 'record.json');
  const sessionDir = join(dir, 'sessions');
  const scenarioJson = JSON.stringify(scenario);

  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      `const scenario = ${scenarioJson};`,
      'const commands = [];',
      'let buffered = "";',
      'const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");',
      'const record = () => {',
      '  writeFileSync(' + JSON.stringify(recordPath) + ', JSON.stringify({',
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    commands,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      '};',
      'process.on("exit", record);',
      'const handle = (command) => {',
      '  commands.push(command);',
      '  if (command.type === "get_state") {',
      '    emit({ type: "response", id: command.id, command: "get_state", success: true,',
      '      data: { sessionId: "sess-1", model: { provider: "test", id: "model-1" } } });',
      '  }',
      '  if (command.type === "prompt") {',
      '    emit({ type: "response", id: command.id, command: "prompt", success: true });',
      '    for (const frame of scenario.afterPrompt ?? []) emit(frame);',
      '    if (scenario.exitAfterPrompt) process.stdin.destroy();',
      '  }',
      '  if (command.type === "abort") {',
      '    emit({ type: "response", id: command.id, command: "abort", success: true });',
      '    if (scenario.exitOnAbort) process.exit(0);',
      '  }',
      '};',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      '  buffered += chunk;',
      '  let index = buffered.indexOf("\\n");',
      '  while (index !== -1) {',
      '    const line = buffered.slice(0, index);',
      '    buffered = buffered.slice(index + 1);',
      '    if (line.trim()) handle(JSON.parse(line));',
      '    index = buffered.indexOf("\\n");',
      '  }',
      '});',
      'process.stdin.on("end", () => {',
      '  // Mirrors omp: EOF is a deliberate disconnect once commands are drained.',
      '  if (scenario.exitCode !== undefined) process.exit(scenario.exitCode);',
      '  process.exit(0);',
      '});',
      'if (scenario.ready !== false) {',
      '  emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });',
      '} else {',
      '  const stderr = ' + JSON.stringify(scenario.stderr ?? '') + ';',
      '  if (stderr) process.stderr.write(stderr, () => process.exit(scenario.exitCode ?? 0));',
      '  else process.exit(scenario.exitCode ?? 0);',
      '}',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath, sessionDir };
}

async function readRecord(path: string): Promise<FakeOmpRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as FakeOmpRecord;
}
