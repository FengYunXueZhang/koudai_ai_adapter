/**
 * dsh-plugin-wechat-remote — host 侧 Cordis 插件入口。
 *
 * 角色：把微信消息桥接进 DeepSeek Harness 的 agent 会话。
 *  微信 ──▶ [adapter] ──▶ [bridge] ──▶ [driver] ──▶ harness agent（沙箱内执行）
 *  微信 ◀── [adapter] ◀── [bridge] ◀── [driver 事件流] ◀── harness
 *
 * 本文件只做装配（解析配置 → 创建 adapter/driver → 启动 bridge → 注册 HTTP 回调），
 * 业务逻辑在 bridge.js / adapters.js / drivers.js 中，便于独立测试。
 *
 * 插件形态说明（与 DSH 插件体系的对应关系）：
 *  - package.json 声明 `dsh.bundle.patch` → 本包成为 profile bundle 层；
 *  - cordis.patch.yml 里的 `insert` 行就是本插件在 Loader 中的条目；
 *  - 本文件默认导出即 Loader 装配的 Cordis 插件。
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { WechatRemoteBridge } from './bridge.js'
import { createAdapter } from './adapters.js'
import { createDriver } from './drivers.js'

export const name = 'wechat-remote'

/** 必填服务：webServer（注册回调路由）+ apiProxy（in-process 驱动调网关）。 */
export const inject = ['webServer', 'apiProxy']

/** schemastery 配置 schema；与 cordis.patch.yml 的默认值保持一致。
 * 注意 schemastery 语义：字段默认即可选，`.required()` 才是必填；没有 `.optional()`。 */
export const Config = z.object({
  adapter: z.union([z.const('webhook'), z.const('wecom'), z.const('wechatferry')]).default('webhook'),
  driver: z.union([z.const('in-process'), z.const('http-api'), z.const('headless-cli')]).default('in-process'),
  allowlist: z.array(z.string()).default([]),
  passphrase: z.string().default(''),
  sessionPerContact: z.boolean().default(true),
  baseUrl: z.string().default('http://127.0.0.1:3080'),
  agentPreset: z.string().default('standard'),
  cwd: z.string().default(''),
  maxReplyChars: z.natural().max(4000).default(1500),
  previewTools: z.boolean().default(false),
  /** 出站消息审计文件（绝对路径）；留空则不落盘。调试/联调时很有用。 */
  tracePath: z.string().default(''),
  wecom: z.object({
    corpid: z.string(),
    secret: z.string(),
    agentid: z.natural(),
    token: z.string(),
    encodingAESKey: z.string(),
    callbackPath: z.string(),
  }),
  webhook: z.object({
    callbackPath: z.string(),
  }),
}).default({})

/**
 * Cordis 插件主体（Loader 以 `name` 解析本包，默认导出即插件）。
 * @param ctx  Cordis Context：ctx.webServer 可注册 HTTP 路由（可选注入）
 * @param cfg  来自 cordis.patch.yml / 用户 patch 层的合并配置
 */
export function apply(ctx, cfg) {
  const config = Config(cfg ?? {})
  // 1. 装配适配器与驱动（失败快速暴露，而不是静默降级）
  const adapter = createAdapter(config.adapter, config, ctx)
  const driver = createDriver(config.driver, config, ctx)

  // 2. 桥核心：白名单鉴权 → 会话路由 → prompt → 事件回流渲染
  const bridge = new WechatRemoteBridge({ ctx, config, adapter, driver })

  // 3. 暴露服务（new Service(ctx, name) 即注册 ctx.wechatRemote），
  //    便于 Web 侧 client 插件 / 其它 host 插件查询状态
  const service = new Service(ctx, 'wechatRemote')
  service.getStatus = () => bridge.status()
  service.send = (contact, payload) => adapter.send(contact, payload)

  // 4. 生命周期：注册 → 启动 → 卸载
  const disposers = []
  disposers.push(bridge.start())
  ctx.on('dispose', () => {
    for (const dispose of disposers.reverse()) dispose()
  })

  ctx.logger('wechat-remote').info(
    `微信桥已启动 adapter=${config.adapter} driver=${config.driver} allowlist=${config.allowlist.length} 人`
  )
}

// Loader 只取 default 导出，因此把 inject / Config 挂到插件函数本体上
// （cordis 的 registry.plugin 从 plugin.inject / plugin.Config 读取）。
apply.inject = inject
apply.Config = Config

export default apply
