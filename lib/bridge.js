/**
 * WechatRemoteBridge — 微信桥核心（与具体微信协议、具体驱动方式解耦）。
 *
 * 消息流：
 *   1) adapter 收到微信消息 → handleInbound()
 *   2) 白名单 / 口令鉴权（未授权直接拒绝）
 *   3) 会话路由：每个联系人绑定一个持久会话（sessionPerContact）
 *   4) driver.prompt() 把消息提交给 harness agent
 *   5) driver 事件流（SSE mux）→ handleEvent() 渲染 → adapter.send() 发回微信
 *   6) 挂起的问题（question/requested）由用户下一条消息作答
 *
 * 渲染策略（v1，可扩展）：
 *   - assistant/message → 提取文本块，按 maxReplyChars 分片发送
 *   - question/requested → 转成微信文本问题，缓存 rpcId，等用户回复
 *   - tool/call → 可选"正在执行 xxx"提示（开关 previewTools）
 *   - turn/end → 结束标记（可用于追加完成提示）
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

export class WechatRemoteBridge {
  /** @type {Map<string, string>} contact → sessionId */
  #sessionByContact = new Map()
  /** @type {Map<string, string>} sessionId → contact */
  #contactBySession = new Map()
  /** @type {Map<string, {rpcId?: string, frame?: object}>} 挂起问题：contact → 待答帧 */
  #pendingQuestion = new Map()
  /** @type {Array<() => void>} 停止回调 */
  #disposers = []

  constructor({ ctx, config, adapter, driver }) {
    this.ctx = ctx
    this.config = config
    this.adapter = adapter
    this.driver = driver
    this.log = ctx.logger('wechat-remote')
  }

  status() {
    return {
      adapter: this.config.adapter,
      driver: this.config.driver,
      contacts: [...this.#sessionByContact.keys()],
      pendingQuestions: this.#pendingQuestion.size,
    }
  }

  /**
   * 启动：挂事件回调并拉起 adapter/driver。
   * 返回一个 disposer（供 index.js 在 ctx dispose 时调用）。
   */
  start() {
    this.adapter.onMessage((msg) => {
      this.handleInbound(msg).catch((err) => {
        this.log.warn(`处理微信消息失败: ${err?.stack ?? err}`)
        this.adapter.send(msg.from, { text: `⚠️ 处理失败：${err?.message ?? err}` }).catch(() => {})
      })
    })
    this.driver.onEvent((evt) => this.handleEvent(evt))

    const disposers = [this.adapter.start(), this.driver.start()]
    this.#disposers.push(...disposers)
    return () => {
      for (const dispose of this.#disposers.reverse()) dispose()
      this.#disposers = []
    }
  }

  /**
   * 入站消息：鉴权 → 路由 → 提交。
   * @param {{from: string, text: string, images?: string[]}} msg 归一化微信消息
   */
  async handleInbound(msg) {
    const { from, text } = msg

    // 1) 白名单鉴权：空 allowlist = 安全默认（全部拒绝）
    const allowlist = this.config.allowlist ?? []
    if (!allowlist.includes(from)) {
      this.log.info(`拒绝未授权联系人 ${from}`)
      await this.#out(from, '未授权：该联系人不在控制白名单中。')
      return
    }

    // 2) 口令前缀：配置了 passphrase 时，消息必须以它开头
    let body = text.trim()
    if (this.config.passphrase) {
      if (!body.startsWith(this.config.passphrase)) {
        this.log.info(`忽略未带口令的消息 from=${from}`)
        return
      }
      body = body.slice(this.config.passphrase.length).trim()
    }
    if (!body) return

    // 3) 挂起问题/审批优先：上一条 agent 回复在等用户时，先作答
    const pending = this.#pendingQuestion.get(from)
    if (pending) {
      this.#pendingQuestion.delete(from)
      if (pending.approvalId) {
        const allow = /^(同意|允许|是|ok|yes|y)$/i.test(body)
        this.log.info(`微信用户 ${from} 审批（${allow ? '同意' : '拒绝'}）：${body}`)
        await this.driver.answerApproval(from, { allow, rpcId: pending.rpcId, sessionId: pending.sessionId, approvalId: pending.approvalId })
      } else {
        this.log.info(`微信用户 ${from} 作答：${body}`)
        await this.driver.answerQuestion(from, { text: body, rpcId: pending.rpcId, sessionId: pending.sessionId })
      }
      return
    }

    // 4) 路由并提交
    const sessionId = await this.driver.ensureSession(from)
    this.#sessionByContact.set(from, sessionId)
    this.#contactBySession.set(sessionId, from)
    this.log.info(`微信用户 ${from} → 会话 ${sessionId} 提交：${body.slice(0, 80)}`)
    await this.driver.prompt(from, body)
  }

  /**
   * driver 事件流回调（来自 apiProxy.events.mux 或 headless-cli 解析结果）。
   * @param {{kind: string, sessionId?: string, contact?: string, text?: string, frame?: object}} evt
   */
  async handleEvent(evt) {
    const contact = evt.contact ?? this.#contactBySession.get(evt.sessionId)
    if (!contact) return // 非本插件发起的会话事件，忽略
    this.#trace(`[driver] ${evt.kind}${evt.sessionId ? ` session=${evt.sessionId}` : ''}${evt.text ? ` text=${String(evt.text).slice(0, 60)}` : ''}`)
    switch (evt.kind) {
      case 'text': {
        await this.#sendChunked(contact, evt.text)
        break
      }
      case 'question': {
        this.#pendingQuestion.set(contact, { rpcId: evt.rpcId, sessionId: evt.sessionId, approvalId: evt.approvalId })
        await this.#sendChunked(contact, `❓ ${evt.text}`)
        break
      }
      case 'tool': {
        if (this.config.previewTools) {
          await this.#out(contact, `🔧 正在执行 ${evt.text}`)
        }
        break
      }
      case 'error': {
        await this.#out(contact, `⚠️ ${evt.text}`)
        break
      }
      case 'done': {
        break // v1：assistant/message 已包含完整回复；可在此追加完成提示
      }
      default:
        break
    }
  }

  /** 统一出站：先落审计日志，再交给适配器发送。 */
  async #out(contact, text) {
    this.#trace(`→ ${contact}: ${text}`)
    await this.adapter.send(contact, { text })
  }

  /** 按 maxReplyChars 分片发送（微信单条消息有长度上限）。 */
  async #sendChunked(contact, text) {
    if (!text) return
    const limit = this.config.maxReplyChars || 1500
    for (let i = 0; i < text.length; i += limit) {
      const chunk = text.slice(i, i + limit)
      await this.#out(contact, chunk)
    }
  }

  /** 审计/调试：把关键事件追加到 tracePath（存在时）。 */
  #trace(line) {
    const path = this.config.tracePath
    if (!path) return
    try {
      appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* 落盘失败不影响主链路 */
    }
  }
}
