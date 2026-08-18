/**
 * Agent 驱动层：把微信消息送进 harness 的 agent 会话并接收事件回流。
 *
 * 三种驱动（config.driver）：
 *
 * 1. in-process（推荐，harness 内插件场景）
 *    注入 `ctx.apiProxy`（网关服务本体，dsh-host-apiproxy 提供），直接调用
 *    sessions.create / sessions.prompt / events.mux / respond —— 与 Web 客户端
 *    完全相同的契约，但没有 HTTP/WS 传输层，也没有端口与信任围栏问题。
 *    事件流：`for await (const frame of ctx.apiProxy.events.mux(...))`，
 *    帧结构与 WS 下行一致（{rpcId, payload: MuxFrame}）。
 *
 * 2. http-api（独立桥进程 / 跨机器场景）
 *    走 harness 公开 HTTP API（POST /api/<method> + /api/events.mux WS 下行）。
 *    注意：本构建中 /api 的 unary fallback 因上下文隔离拿不到 apiProxy，
 *    直接 HTTP 调会话接口可能 404（浏览器侧走内核内部传输，不受影响）。
 *    该驱动保留用于"插件不装进 harness、独立进程桥接"的部署形态。
 *
 * 3. headless-cli（最稳、零耦合；非流式）
 *    每条消息 spawn 一个 `dsh --profile headless` 子进程。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

/* ------------------------------------------------------------------ */
/* 公共工具                                                            */
/* ------------------------------------------------------------------ */

/** 从 assistant 消息 content 里提取纯文本（兼容字符串/块数组/块对象）。 */
export function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join('')
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
  }
  return ''
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 把 RpcResponse 折叠成 value 或抛出（RpcError → Error，带上 code）。
 * @param {{rpcId: string, result: {ok: boolean, value?: unknown, error?: {code?: string, message?: string}}}} resp
 */
function unwrap(resp) {
  if (resp?.result?.ok) return resp.result.value
  const err = resp?.result?.error ?? {}
  throw new Error(`${err.code ?? 'internal'}: ${err.message ?? '未知错误'}`)
}

/* ------------------------------------------------------------------ */
/* in-process 驱动（推荐）                                             */
/* ------------------------------------------------------------------ */

export class InProcessDriver {
  #sessionByContact = new Map()
  #contactBySession = new Map()
  #handlers = []
  #abort = null
  #loopPromise = null

  constructor({ ctx, config }) {
    this.ctx = ctx
    this.config = config
    this.log = ctx.logger('wechat-remote')
  }

  onEvent(handler) {
    this.#handlers.push(handler)
  }

  #emit(evt) {
    for (const h of this.#handlers) {
      try {
        h(evt)
      } catch (err) {
        this.log.warn(`事件处理异常: ${err.message}`)
      }
    }
  }

  /** 每个联系人一个持久会话（首次创建，之后复用）。 */
  async ensureSession(contact) {
    let sessionId = this.#sessionByContact.get(contact)
    if (sessionId) return sessionId
    const payload = {}
    if (this.config.agentPreset) payload.agentPreset = this.config.agentPreset
    if (this.config.cwd) payload.cwd = this.config.cwd
    const value = unwrap(await this.ctx.apiProxy.sessions.create({
      rpcId: randomUUID(),
      payload,
    }))
    sessionId = value.sessionId
    this.#sessionByContact.set(contact, sessionId)
    this.#contactBySession.set(sessionId, contact)
    this.log.info(`为 ${contact} 创建会话 ${sessionId}`)
    return sessionId
  }

  /** 提交用户消息（mode: 'queue'，agent 空闲即开始处理）。 */
  async prompt(contact, text) {
    const sessionId = await this.ensureSession(contact)
    await unwrap(await this.ctx.apiProxy.sessions.prompt({
      rpcId: randomUUID(),
      payload: {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }))
    this.log.info(`微信用户 ${contact} → 会话 ${sessionId} 已提交`)
  }

  /** 把微信用户对问题的回答送回 harness（client-response → respond）。 */
  async answerQuestion(contact, { text, rpcId, sessionId }) {
    const sid = sessionId ?? (await this.ensureSession(contact))
    await this.ctx.apiProxy.respond({
      type: 'client-response',
      rpcId,
      result: {
        ok: true,
        value: { sessionId: sid, answer: { answers: [{ id: 'wechat', selected: [text] }] } },
      },
    })
  }

  /** 同意/拒绝工具审批（approval 帧）。 */
  async answerApproval(contact, { allow, rpcId, sessionId, approvalId }) {
    const sid = sessionId ?? (await this.ensureSession(contact))
    await this.ctx.apiProxy.respond({
      type: 'client-response',
      rpcId,
      result: {
        ok: true,
        value: { sessionId: sid, approvalId, outcome: allow ? 'allowed-once' : 'rejected' },
      },
    })
  }

  start() {
    this.#abort = new AbortController()
    this.#loopPromise = this.#stream()
    return () => {
      this.#abort?.abort()
      this.#loopPromise?.catch(() => {})
    }
  }

  /** 进程内事件流：for-await 消费 mux（帧 = {rpcId, payload: MuxFrame}）。 */
  async #stream() {
    const signal = this.#abort.signal
    while (!signal.aborted) {
      try {
        const frames = this.ctx.apiProxy.events.mux({ rpcId: randomUUID(), payload: {} }, signal)
        this.log.info('事件流已连接（in-process）')
        for await (const frame of frames) {
          this.#dispatch(frame)
        }
      } catch (err) {
        if (signal.aborted) break
        this.log.warn(`事件流异常，2s 后重连: ${err.message}`)
        await sleep(2000)
      }
    }
  }

  /** 帧分发：payload.type 决定事件种类（对照 api/events.d.ts 的 MuxFrame）。 */
  #dispatch(frame) {
    const payload = frame?.payload
    if (!payload) return
    switch (payload.type) {
      case 'session/event': {
        this.#handleSessionEvent(payload.sessionId, payload.event)
        break
      }
      case 'question/requested': {
        const q = payload.questions?.[0]
        if (q) {
          const options = q.options?.length
            ? '\n选项：' + q.options.map((o) => o.label).join(' / ')
            : ''
          this.#emit({
            kind: 'question',
            sessionId: payload.sessionId,
            rpcId: frame.rpcId,
            text: `${q.question}${options}`,
          })
        }
        break
      }
      case 'approval/requested': {
        this.#emit({
          kind: 'question',
          sessionId: payload.sessionId,
          rpcId: frame.rpcId,
          approvalId: payload.approvalId,
          text: `⚠️ agent 请求执行工具「${payload.toolName}」${payload.reason ? `：${payload.reason}` : ''}\n回复「同意」继续，回复「拒绝」取消。`,
        })
        break
      }
      default:
        break
    }
  }

  /** 会话事件 → 桥事件（线上信封为 {type, seq, time, data}，负载在 data 下）。 */
  #handleSessionEvent(sessionId, event) {
    const data = event?.data ?? event
    switch (event?.type) {
      case 'assistant/message': {
        const text = extractText(data.message?.content)
        if (text) this.#emit({ kind: 'text', sessionId, text })
        break
      }
      case 'tool/call': {
        this.#emit({ kind: 'tool', sessionId, text: data.name })
        break
      }
      case 'turn/end': {
        this.#emit({ kind: 'done', sessionId })
        break
      }
      default:
        break
    }
  }
}

/* ------------------------------------------------------------------ */
/* http-api 驱动（独立桥进程场景；WS 事件下行）                        */
/* ------------------------------------------------------------------ */

export class HttpApiDriver {
  #sessionByContact = new Map()
  #handlers = []
  #alive = false
  #loopPromise = null
  #socket = null

  constructor({ config, ctx }) {
    this.config = config
    this.ctx = ctx
    this.log = ctx.logger('wechat-remote')
    this.baseUrl = (config.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '')
  }

  onEvent(handler) {
    this.#handlers.push(handler)
  }

  #emit(evt) {
    for (const h of this.#handlers) {
      try {
        h(evt)
      } catch (err) {
        this.log.warn(`事件处理异常: ${err.message}`)
      }
    }
  }

  /**
   * 通用 RPC：POST /api/<method>，信封与 Web 客户端一致。
   * 注意：本构建中该路径可能因网关隔离返回 404，独立桥进程部署时请先验证。
   */
  async rpc(method, payload) {
    const rpcId = randomUUID()
    const res = await fetch(new URL(`/api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    if (!res.ok) throw new Error(`/api/${method} 传输失败 HTTP ${res.status}`)
    const full = await res.json()
    if (full.rpcId !== rpcId) throw new Error(`/api/${method} rpcId 不匹配`)
    if (!full.result?.ok) {
      const err = full.result?.error ?? {}
      throw new Error(`${err.code ?? 'internal'}: ${err.message ?? '未知错误'}`)
    }
    return full.result.value
  }

  /** 回答 question/approval 帧：client-response 信封 → POST /api/respond。 */
  async respond(rpcId, value) {
    const res = await fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
    })
    if (!res.ok) throw new Error(`/api/respond 传输失败 HTTP ${res.status}`)
  }

  async ensureSession(contact) {
    let sessionId = this.#sessionByContact.get(contact)
    if (sessionId) return sessionId
    const payload = {}
    if (this.config.agentPreset) payload.agentPreset = this.config.agentPreset
    if (this.config.cwd) payload.cwd = this.config.cwd
    const created = await this.rpc('session/create', payload)
    sessionId = created.sessionId
    this.#sessionByContact.set(contact, sessionId)
    this.log.info(`为 ${contact} 创建会话 ${sessionId}`)
    return sessionId
  }

  async prompt(contact, text) {
    const sessionId = await this.ensureSession(contact)
    await this.rpc('session/prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }

  async answerQuestion(contact, { text, rpcId, sessionId }) {
    const sid = sessionId ?? (await this.ensureSession(contact))
    await this.respond(rpcId, {
      sessionId: sid,
      answer: { answers: [{ id: 'wechat', selected: [text] }] },
    })
  }

  async answerApproval(contact, { allow, rpcId, sessionId, approvalId }) {
    const sid = sessionId ?? (await this.ensureSession(contact))
    await this.respond(rpcId, {
      sessionId: sid,
      approvalId,
      outcome: allow ? 'allowed-once' : 'rejected',
    })
  }

  start() {
    this.#alive = true
    this.#loopPromise = this.#eventLoop()
    return () => {
      this.#alive = false
      try {
        this.#socket?.close()
      } catch {
        /* 已关闭 */
      }
      this.#loopPromise?.catch(() => {})
    }
  }

  /**
   * 事件流：/api/events.mux 是 WebSocket 下行（普通 GET 回 426），
   * 每条消息是 {type:'server-request', rpcId, method, payload} JSON。
   */
  async #eventLoop() {
    while (this.#alive) {
      try {
        await this.#connectAndPump()
      } catch (err) {
        if (!this.#alive) break
        this.log.warn(`事件流异常，2s 后重连: ${err.message}`)
      }
      if (this.#alive) await sleep(2000)
    }
  }

  #connectAndPump() {
    return new Promise((resolve) => {
      const url = `${this.baseUrl.replace(/^http/, 'ws')}/api/events.mux`
      let socket
      try {
        socket = new WebSocket(url)
      } catch (err) {
        this.log.warn(`无法连接事件流: ${err.message}`)
        resolve()
        return
      }
      this.#socket = socket
      socket.addEventListener('open', () => {
        this.log.info('事件流已连接')
      })
      socket.addEventListener('message', (ev) => {
        try {
          this.#dispatch(JSON.parse(String(ev.data)))
        } catch (err) {
          this.log.warn(`无法解析事件帧: ${err.message}`)
        }
      })
      const settle = () => {
        this.#socket = null
        resolve()
      }
      socket.addEventListener('close', settle)
      socket.addEventListener('error', () => {
        try {
          socket.close()
        } catch {
          /* 已关闭 */
        }
      })
    })
  }

  #dispatch(frame) {
    const payload = frame?.payload
    if (!payload) return
    switch (payload.type) {
      case 'session/event': {
        this.#handleSessionEvent(payload.sessionId, payload.event)
        break
      }
      case 'question/requested': {
        const q = payload.questions?.[0]
        if (q) {
          const options = q.options?.length
            ? '\n选项：' + q.options.map((o) => o.label).join(' / ')
            : ''
          this.#emit({
            kind: 'question',
            sessionId: payload.sessionId,
            rpcId: frame.rpcId,
            text: `${q.question}${options}`,
          })
        }
        break
      }
      case 'approval/requested': {
        this.#emit({
          kind: 'question',
          sessionId: payload.sessionId,
          rpcId: frame.rpcId,
          approvalId: payload.approvalId,
          text: `⚠️ agent 请求执行工具「${payload.toolName}」${payload.reason ? `：${payload.reason}` : ''}\n回复「同意」继续，回复「拒绝」取消。`,
        })
        break
      }
      default:
        break
    }
  }

  #handleSessionEvent(sessionId, event) {
    const data = event?.data ?? event
    switch (event?.type) {
      case 'assistant/message': {
        const text = extractText(data.message?.content)
        if (text) this.#emit({ kind: 'text', sessionId, text })
        break
      }
      case 'tool/call': {
        this.#emit({ kind: 'tool', sessionId, text: data.name })
        break
      }
      case 'turn/end': {
        this.#emit({ kind: 'done', sessionId })
        break
      }
      default:
        break
    }
  }
}

/* ------------------------------------------------------------------ */
/* headless-cli 驱动（最稳、零耦合；非流式）                           */
/* ------------------------------------------------------------------ */

export class HeadlessCliDriver {
  #handlers = []

  constructor({ config, ctx }) {
    this.config = config
    this.ctx = ctx
    this.log = ctx.logger('wechat-remote')
  }

  onEvent(handler) {
    this.#handlers.push(handler)
  }

  start() {
    return () => {}
  }

  async ensureSession() {
    // headless 模式每条消息独立跑；如需跨消息上下文，可解析子进程输出的
    // 会话 id 并用 --resume <id> 续跑（TODO：v2 支持）。
    return `one-shot`
  }

  async prompt(contact, text) {
    const result = await this.#runHeadless(text)
    for (const h of this.#handlers) {
      h({ kind: 'text', contact, text: result })
      h({ kind: 'done', contact })
    }
  }

  async answerQuestion(contact, { text }) {
    // headless 单轮模式没有挂起问题；直接把回答作为新任务提交
    await this.prompt(contact, text)
  }

  #runHeadless(text) {
    return new Promise((resolve, reject) => {
      const args = ['--profile', 'headless', text]
      const child = spawn('dsh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`dsh headless 退出码 ${code}: ${err.trim().slice(-500)}`))
      })
    })
  }
}

/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */

export function createDriver(kind, config, ctx) {
  switch (kind) {
    case 'in-process':
      return new InProcessDriver({ ctx, config })
    case 'http-api':
      return new HttpApiDriver({ ctx, config })
    case 'headless-cli':
      return new HeadlessCliDriver({ ctx, config })
    default:
      throw new Error(`未知驱动: ${kind}`)
  }
}
