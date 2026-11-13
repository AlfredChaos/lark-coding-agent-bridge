# OMP adapter

本桥接支持把飞书消息接到本地 OMP（`omp --mode rpc`）。该适配器在 `src/agent/omp/`，通过 JSONL RPC 驱动 OMP，不解析 `omp -p` 的文本输出。

## 结论

- 选择 OMP：profile 配 `agentKind: "omp"`，或新建 profile 时传 `--agent omp`。
- OMP 二进制：`omp.binaryPath`，默认取 `omp` 或环境变量 `LARK_CHANNEL_OMP_BIN`。
- 模型、思考等级、工具白名单：`omp.model`、`omp.thinking`、`omp.tools`。
- 会话连续性：按会话作用域保存 OMP session id，下一轮用 `--resume <id>` 续上。
- 运行需要一次 RPC 握手：桥先发 `get_state`，再发 `prompt`。只有 `isTerminal != false` 的 `agent_end` 算结束。

## 配置

profile 配置示例（`~/.lark-channel/profiles/omp-dev/config.json` 的 `profiles["omp-dev"]` 段）：

```json
{
  "schemaVersion": 2,
  "agentKind": "omp",
  "omp": {
    "binaryPath": "/Users/you/.local/bin/omp",
    "model": "opencode-go/deepseek-v4.1-flash",
    "thinking": "high",
    "tools": ["bash", "read", "write", "edit", "grep", "glob"]
  },
  "accounts": {
    "app": {
      "id": "cli_xxx",
      "secret": { "source": "env", "id": "FEISHU_APP_SECRET" },
      "tenant": "feishu"
    }
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `agentKind` | 是 | 固定为 `"omp"`。桥内部沿用它，语义等同需求里的 `agent.type`。 |
| `omp.binaryPath` | 是 | OMP 可执行文件路径。新建 profile 时自动解析并写入。 |
| `omp.model` | 否 | 传给 `omp --model`。OMP 模型目录随账号变化，桥不硬编码。 |
| `omp.thinking` | 否 | 传给 `omp --thinking`。取值：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`auto`。 |
| `omp.tools` | 否 | 工具白名单，传给 `omp --tools`，逗号分隔。不配置时用 OMP 默认值，桥不扩大权限。 |

`preferences.model` 的模型选择器只提供「跟随 omp 配置」。OMP 的模型写到 `omp.model`。

### 新建 profile

```bash
lark-channel-bridge profile create omp-dev --agent omp
# 或首次初始化
lark-channel-bridge run --agent omp
```

新建时桥用 `resolveExecutablePath` 校验二进制。找不到时抛 `agent-binary-not-found`，不会写入半个 profile。

## 运行方式

每次对话轮次启动一个 `omp --mode rpc` 进程。桥按会话作用域保存 session id，后续轮次加 `--resume <sessionId>`。

这与桥接的 Claude、Codex 适配器一致：上游的进程模型是「一轮一进程」，会话连续性靠 resume 参数，不靠常驻进程。OMP 的 RPC 协议本身支持长驻，但常驻进程会绕过桥的进程池、空闲看门狗和停止语义。

启动参数：

```text
omp --mode rpc --no-title --no-ui \
    --session-dir <profileDir>/omp-sessions \
    [--resume <sessionId>] \
    [--model <model>] \
    [--thinking <level>] \
    [--tools a,b,c] \
    --approval-mode <yolo|write|always-ask>
```

- `--no-title`：标题由桥的会话目录管理，避免 OMP 另生成标题。
- `--no-ui`：扩展以无头方式运行，减少 UI 帧。
- `--approval-mode`：由桥的权限策略推导，profile 不能自行放宽。

## RPC 协议要点

协议来源：<https://omp.sh/docs/rpc>。stdout 每行一个 JSON 对象，stderr 只当诊断。

### 握手

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576}
```

收到 `ready` 后，桥依次发送：

```json
{"id":"state_1","type":"get_state"}
{"id":"prompt_1","type":"prompt","message":"<bridge prompt + 用户消息>"}
```

`get_state` 的响应给出 session id 和模型：

```json
{"type":"response","command":"get_state","success":true,"data":{"sessionId":"01a1...","model":{"provider":"opencode-go","id":"deepseek-v4.1-flash"}}}
```

`prompt` 的响应只表示「已受理」，不表示完成：

```json
{"type":"response","id":"prompt_1","command":"prompt","success":true}
```

### 事件映射

| OMP 帧 | 桥的 `AgentEvent` | 说明 |
| --- | --- | --- |
| `response` / `command=get_state` | `system` | 带 `sessionId` 与 `provider/model`。 |
| `message_update` 且 `assistantMessageEvent.type=text_delta` | `text` | 正文增量。 |
| `message_update` 且 `assistantMessageEvent.type=thinking_delta` | `thinking` | 思考增量。 |
| `tool_execution_start` | `tool_use` | 工具 id、名字、参数。 |
| `tool_execution_update` | `tool_update` | 工具流式输出，卡片保留「运行中」状态。 |
| `tool_execution_end` | `tool_result` | 输出与 `isError`。 |
| `turn_end` | `usage` | `input`、`output`、`cacheRead`、`reasoningTokens`、`cost.total`。 |
| `agent_end`（`isTerminal != false`） | `done` 或 `error` | 唯一的正常结束条件。 |
| `prompt_result` 且 `agentInvoked=false` | `done` | 斜杠命令本地处理，没有 agent 轮次。 |
| `response` / `command=prompt` 且 `success=false` | `error` | provider 或调度失败。 |

其余帧（`available_commands_update`、`config_update`、`session_settled` 等）忽略或记日志，不当作结束信号。

### 终止判定

- `agent_end.isTerminal === false`：中间帧。异步续跑后还会再发一个 `agent_end`。
- `agent_end` 缺 `isTerminal`：按终止处理，兼容旧版本 OMP。
- 出错时优先取最后一条 assistant 消息的 `errorMessage`。流式的 `message_end` 也会保留错误，防止精简后的 `agent_end` 丢掉 provider 错误。
- 进程提前退出、stdout EOF、非零退出码、spawn 失败：都转成 `error`，不会变成空回复。
- 停止运行：先发 `abort`，再关 stdin；进程不退才升级到 SIGTERM、SIGKILL。停止后的事件是 `done`，`terminationReason` 为 `interrupted`。

### 权限与交互

OMP 没有操作系统级沙箱，审批模式是唯一闸门。桥把 Claude 权限模式映射为 OMP 审批模式：

| 桥的权限模式 | OMP `--approval-mode` | 效果 |
| --- | --- | --- |
| `plan` | `always-ask` | 只自动批准只读工具。 |
| `default` / `acceptEdits` | `write` | 自动批准读和写，执行类工具需要确认。 |
| `bypassPermissions` | `yolo` | 全部自动批准。 |

无头运行没有交互界面。对 `select`、`confirm`、`input`、`editor` 四类请求，适配器回 `cancelled`，让被阻塞的操作立刻失败，不挂住整轮。`notify`、`setWidget` 这类无需回复的请求直接忽略。这不是权限放宽；可同时用 `omp.tools` 收紧工具集合。

## 会话连续性

- 作用域与 Claude 相同：私聊、群、话题各自一个 scope。
- 桥收到 `system` 事件后写入 session 存储和会话目录，并按工作区路径、策略指纹做隔离。
- `/new` 清空当前 scope 的会话；下一轮起新会话。
- `/cd` 换工作区后会重新起新会话。
- `/resume` 对 OMP 只列出会话目录里的当前会话。OMP 的历史会话文件不由桥扫描。

会话文件放在 `<profileDir>/omp-sessions`。这样多个 profile 的 OMP 会话互不干扰。

## 图片附件

飞书里发给机器人的图片会随 `prompt` 帧的 `images` 字段传给 OMP：

```text
{ id, type: "prompt", message, images: [{ type: "image", mimeType, data }] }
```

`data` 是 base64。桥把下载到 `media/` 的文件读出来编码，路径仍然出现在 prompt 的 `<user_input>.attachments` 里。

传输预算：OMP 的 `maxFrameBytes` 是 1 MiB，且服务端不重组入站分片，所以单帧必须自己控制。桥给整轮图片留 720 KiB 的 base64 预算（`OMP_IMAGE_BUDGET_BYTES`），超出预算的图片不会发送——它仍然以本地路径留在 prompt 里，模型可以用 `read` 工具自己打开。所以这种情况不算丢图，只是多一轮工具调用。

同样的原因，桥不做图片缩放：没有内置图像处理依赖，也没有跨平台的等比压缩路径。想省带宽就在飞书侧压缩，或者接受超出预算的图走 `read` 路径。

支持的扩展名：`png`、`jpg`、`jpeg`、`webp`、`gif`、`heic`。其它扩展名跳过并记 `omp-image-skipped` 日志。

图片最终能不能被理解取决于模型：给 `omp.model` 配纯文本模型时，OMP 会用视觉模型转成描述再注入。

## 已知限制

- 不协商 RPC v2。出站单行超过 1 MiB 时 OMP 会拆分或省略字段，超大工具输出可能丢失（正文增量不受影响）；入站帧不分片重组，因此桥自己控制图片预算。
- 不注册 host tools 和 host URI scheme。收到这类请求时回错误，让调用方失败而不是挂起。
- 不支持 OMP 的交互式登录流程。OMP 的 provider 认证要先在终端完成。
- OMP 的历史会话不参与 `/resume` 列表。
- 群聊、评论、会议都复用同一适配器；行为与 Claude 路径一致，没有 OMP 专属卡片。

## 本地测试

适配器测试分两层，不发真实飞书消息。

```bash
# 协议翻译与参数构造
pnpm vitest run tests/unit/agent/omp-rpc.test.ts tests/unit/agent/omp-args.test.ts tests/unit/agent/omp-images.test.ts

# 假 OMP 进程：ready、prompt 响应、文本增量、工具、agent_end、错误、EOF
pnpm vitest run tests/process/omp-adapter.test.ts

# 全量
pnpm test
```

假进程是一个 Node 脚本。它按场景输出 JSONL，记录 argv、cwd 和收到的命令，供断言使用。覆盖的场景：

- `ready` 后发 `get_state` 和 `prompt`，以及 `--resume`、`--model`、`--thinking`、`--tools` 参数。
- 文本增量、思考增量、工具开始/更新/结束、usage、终止 `agent_end`。
- 非终止 `agent_end` 后续跑。
- provider 错误、`prompt` 命令失败、本地处理命令。
- 未发 `ready` 就退出、受理后 EOF、非零退出码。
- `stop()` 触发 `abort`，得到 `interrupted`。

真实二进制冒烟测试不提交，按需临时运行：用 `OmpAdapter` 直接连接本机 `omp`，跑一轮带工具的对话，再 `--resume` 同一会话提问。

## 凭据

示例里的 App Secret 用 `SecretRef`，文档、测试、日志都不出现真实密钥。OMP 的 provider 密钥由 OMP 自己的配置和登录流程管理，桥不读取。
