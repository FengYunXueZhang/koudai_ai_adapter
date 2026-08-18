# dsh-plugin-wechat-remote — 微信远程控制 DSH 插件（设计 + 骨架实现）

> 目标：在 **DeepSeek Harness（DSH）** 中作为一个 bundle 插件安装，让微信消息能够
> 远程驱动 harness 里的 agent —— 你在微信里发一句话，agent 在沙箱内执行（跑命令、
> 读写文件、搜索、调度等），把结果发回微信。附带一套可直接落地的骨架代码。

---

## 1. 总体架构

```
┌────────────┐   ① 消息    ┌──────────────┐   ② 归一化    ┌──────────────────────┐
│  微信客户端  │ ─────────▶ │ 接入适配器层   │ ────────────▶ │  WechatRemoteBridge   │
│ (手机/PC)   │ ◀───────── │  (adapter)   │ ◀──────────── │  (插件核心: 鉴权/路由) │
└────────────┘   ⑧ 回复    └──────────────┘   ⑦ 渲染      └──────────┬───────────┘
     ▲                                                                │ ③ session/prompt
     │                                                                ▼
     │                 ┌────────────────────────────────────────────────────┐
     │                 │            DSH Harness（agent 会话）               │
     │                 │  agent 在沙箱内调用工具：pwsh/fs/搜索/调度/子代理…   │
     │                 └────────────────────────┬───────────────────────────┘
     │                                          │ ④ 事件流（assistant 消息 /
     │       ⑥ 回复组装（分片/图片/问题桥接）     │    工具调用 / 提问帧）
     └──────────────────────────────────────────┴───────────────────────────┘
```

- **接入层（adapter）**：负责"连微信"，把微信协议归一化成统一消息（`{from, text, images?}`）。
- **桥核心（bridge）**：鉴权白名单 → 会话路由 → 提交 prompt → 事件回流渲染。与具体微信协议、具体驱动方式完全解耦。
- **驱动层（driver）**：负责"把消息送进 harness 并收回流"，三种实现见 §4。

## 2. 插件形态：与 DSH 插件体系的对应关系

本仓库调研确认，DSH 的插件机制是 **Cordis 应用 + 分层 bundle patch**：

| 概念 | 说明 |
|---|---|
| Profile | `~/.dsh/profiles/<name>/`，`package.json` 里 `dsh.profile.bundles` 列出 bundle 层 |
| Bundle | 一个 npm 包，`package.json` 声明 `dsh.bundle.patch` → 指向 `cordis.patch.yml` |
| Patch | YAML 数组：`insert` 行（`id/name/config/inject/disabled`）或按 id 覆盖 config；支持 `!!js` 表达式 |
| 组合顺序 | dsh-base → dsh-web-app → …你装的 bundle → 用户 `cordis.patch.yml`（后写胜出，用户层热更新） |
| 安装 | `dsh plugin --profile web add <包名|路径>`（转发 pnpm，并自动对账 `dsh.profile.bundles`） |
| 客户端插件 | 包声明 `dsh.client`（`platform:'web'`）+ 导出 `./client`，浏览器侧由 `dsh-client-modules` 扫描、以 `/plugins/<id>/client.js` 提供 |

**本插件包完全遵循这套格式**：`package.json` 声明 `dsh.bundle.patch`，
`cordis.patch.yml` 用 `insert` 插入一行 `wechat-remote`，Loader 按 `name`
（即本包名）装配 `lib/index.js` 导出的 Cordis 插件。

## 3. 消息流设计（核心）

1. **入站归一化**：adapter 收到微信消息 → `{from, text, images?, ts}`。
2. **鉴权**：`from` 必须在 `allowlist` 白名单，否则直接拒绝；可选 `passphrase` 口令前缀（如 `robot `）。
3. **会话路由**：`sessionPerContact: true` 时每个联系人绑定一个持久会话（复用 harness 的 JSONL 持久化，上下文连续）；agent 预设/工作目录可配置。
4. **提交**：driver 调 `session/prompt`（`mode:'queue'`）把文本投给 agent。
5. **事件回流**：driver 订阅 `/api/events.mux` SSE 流，桥核心渲染：
   - `assistant/message` → 提取文本，按 `maxReplyChars` 分片发回微信；
   - `tool/call` → 可选 `previewTools` 预览"正在执行 xxx"；
   - `question/requested` / `approval/requested` → 转成微信文本问题，**缓存 rpcId，用户下一条回复自动回填**（通过 `POST /api/respond` 的 client-response 信封）；
   - 断线自动重连（2s 退避）。
6. **出站限流**：企业微信主动消息有频控，单条消息按字符分片。

## 4. 三种驱动方式（怎么把消息送进 harness）

| driver | 做法 | 优点 | 缺点 |
|---|---|---|---|
| `in-process`（推荐，已实测通过） | 插件注入 `ctx.apiProxy`（网关服务本体），直接调 `sessions.create/prompt`、`events.mux`、`respond` | 与 Web 客户端同契约、无传输层/端口/信任围栏；断线重连最简 | 只能随 harness 一起运行 |
| `http-api` | 走 harness 公开 HTTP API：`POST /api/session/create` + WS `events.mux` | 可异地部署（LAN 需 `--trusted-host`） | 本构建中 /api unary fallback 因上下文隔离拿不到 apiProxy，直接 HTTP 调用可能 404（浏览器走内核内部传输不受影响），适合独立桥进程场景 |
| `headless-cli` | 每条消息 spawn `dsh --profile headless "<msg>"` | 零耦合、最不容易坏 | 启动开销；v1 非流式 |

> **已验证的线上协议细节**（本仓库逐字段核实）：
> - 网关方法信封：`sessions.create({rpcId, payload})` → `{rpcId, result:{ok,value}}`；
> - 事件流帧：`{rpcId, payload:{type:'session/event', sessionId, event, ...}}`；
> - **线上 SessionEvent 信封是 `{type, seq, time, data, ...}`，业务负载在 `event.data` 下**
>   （`assistant/message` 的文本在 `event.data.message.content`，`tool/call` 的名字在 `event.data.name`）；
> - 挂起问题/审批帧：`question/requested`（含 questions）、`approval/requested`（含 approvalId），
>   回答走 `respond({type:'client-response', rpcId, result:{ok:true, value}})`。

## 5. 微信接入适配器（合规性权衡）

| 适配器 | 接入方式 | 合规/风险 | 建议 |
|---|---|---|---|
| `webhook` | 无真实微信，注册测试 HTTP 入口 | ✅ 无风险 | 本地干跑/联调 |
| `wecom` | 企业微信自建应用（回调 + 主动消息 API） | ✅ 官方 API，合规 | **生产推荐**（骨架已完整实现：URL 验证、验签、AES 解密、发消息） |
| `wechatferry` | 个人微信 PC Hook（仅 Windows） | ⚠️ 违反个人微信《软件许可及服务协议》，有封号风险 | 谨慎，仅供学习；骨架留 TODO |

> 新增接入方式（公众号、机器人框架等）只需实现 `onMessage/send/start` 三件套，
> 并在 `createAdapter` 注册工厂 —— 桥核心零改动。

## 6. 安全设计

- **默认拒绝**：`allowlist` 为空 = 全部拒绝，显式配置才放行。
- **口令前缀**：可选 `passphrase`，降低误触发。
- **沙箱天然生效**：agent 调用工具走 harness 既有的 fs-sandbox / pwsh sandbox，微信侧不可能越权。
- **审批桥接**：需要用户确认的工具调用，把 harness 的 approval 机制桥到微信（"同意/拒绝"）。
- **回环绑定**：web 默认绑定 `127.0.0.1:3080`；跨机器需显式 `--trusted-host` + 企业微信白名单 IP。
- **回调验签**：企业微信服务器模式强制校验 `msg_signature` 并解密 `Encrypt`，防伪造消息。

## 7. 在本 harness 上安装与运行

> 本仓库已在你的机器上完成安装与端到端验证（见 §7.4），剩余只有"重启生效"。

### 7.1 准备 pnpm（`dsh plugin` 需要）
```powershell
corepack prepare pnpm@9 --activate
# 或：npm i -g pnpm
pnpm --version
```

### 7.2 安装插件到 web profile
```powershell
dsh plugin --profile web add E:\SwTools\wechat_deepseek_harness_plugin -w
```
pnpm 会把本包链接进 `~/.dsh/profiles/web/node_modules`，`dsh` 自动把它加入
`dsh.profile.bundles`。**bundle 层在启动时组合，装完需重启 `dsh web` 生效。**

### 7.3 配置
默认 `adapter: webhook`（本地干跑）+ `allowlist: []`（全部拒绝），安全保守。
放行联系人等配置写在用户层（热更新，无需重启）：
```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 里加：
- id: wechat-remote
  config:
    allowlist: ['你的微信userid']   # 企业微信为 userid，个人微信为 wxid
    adapter: wecom                  # 换真实微信时改为 wecom 并填下方参数
    wecom:
      corpid: '...'
      secret: '...'
      agentid: 1000002
      token: '...'
      encodingAESKey: '...'
```

### 7.4 端到端冒烟测试（已通过）
起一个旁路实例（不碰线上 GUI）：
```powershell
dsh --patch E:\SwTools\wechat_deepseek_harness_plugin\examples\test-patch.yml --profile web --port 3081
```
模拟微信消息：
```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3081/wechat-remote/test `
  -ContentType application/json `
  -Body '{"from":"tester","text":"请运行 node -e \"console.log(21*2)\" 并把输出数字告诉我"}'
```
实测结果（`wechat-trace.log`）：agent 在沙箱内运行命令 → 事件流回流 →
微信侧收到「命令已运行，输出数字是：**42**」以及工具预览「🔧 正在执行 pwsh」。

### 7.4 验证安装
```powershell
dsh --profile web --dump-config | Select-String -Pattern "wechat"
# Web 界面 设置 → 插件清单（plugin inventory）也应能看到 wechat-remote 行
```

## 8. 可选：Web 界面客户端插件（给微信桥加 UI）

如果想在 harness Web 界面看到微信桥状态/开关/最近消息，按 `dsh.client` 双面插件格式补一个
浏览器半：
```json
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"], "immediately": false } }
```
- 浏览器半导出 `./client`（模块表由 shell kernel 构造，经 `/plugins/<id>/client.js` 提供）；
- 通过 `ctx.wechatRemote.getStatus()`（本插件已暴露的 host 服务）读状态；
- 注意：client 包改完需 `pnpm run dev:web` 的 watcher 重新打包才热更新。

## 9. 常见问题

- **装好了吗？** 本机已安装（`dsh.profile.bundles` 已含 `dsh-plugin-wechat-remote`），端到端冒烟已通过；**重启 `dsh web` 后插件即在线上 GUI 生效**（默认 webhook + 全部拒绝，安全）。
- **重启才生效？** bundle 层启动时组合，装新插件后需重启；改 `config` 写用户层 `cordis.patch.yml`（热更新）。
- **为什么默认不启用真实微信？** 个人微信自动化违反 ToS 且有封号风险；企业微信是官方合规路径。
- **agent 用哪个模型/预设？** `agentPreset` 走 harness 既有的预设与模型配置（设置页可改）。
- **消息太长？** 自动按 `maxReplyChars` 分片；图片/文件转发是 v2 项（`assistant/message` 里图片块转存后调 adapter 发图）。
- **联调怎么看回流？** 配置 `tracePath` 把入站/出站事件写入文件（本次冒烟即用它验证）。

## 10. 目录结构

```
wechat-remote/
├── package.json            # dsh.bundle.patch 声明（成为 profile bundle 层）
├── cordis.patch.yml        # insert wechat-remote 插件行（id/name/config）
├── lib/
│   ├── index.js            # Cordis 插件入口：配置解析 + 装配 + 生命周期
│   ├── bridge.js           # 桥核心：鉴权/会话路由/事件渲染/问题桥接
│   ├── adapters.js         # webhook | wecom | wechatferry 适配器
│   ├── wecom-crypto.js     # 企业微信回调验签 + AES 解密
│   └── drivers.js          # http-api | headless-cli | in-process 驱动
└── README.md               # 本设计文档
```
