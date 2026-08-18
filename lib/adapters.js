/**
 * WeChat 接入适配器层（可插拔）。
 *
 * 统一接口：
 *   start(): 连接并开始收消息；返回 disposer
 *   onMessage(handler): 注册入站回调，handler({ from, text, images?, ts? })
 *   send(contact, { text, imagePath?, filePath? }): 发消息给指定联系人
 *
 * 内置适配器：
 *   - webhook    ：无真实微信，本地干跑（在 harness Web 服务上注册测试入口，可 curl）
 *   - wecom      ：企业微信自建应用（官方 API，合规，生产推荐）
 *   - wechatferry：个人微信 PC Hook（仅 Windows，违反个人微信 ToS，有封号风险，谨慎）
 *
 * 新增接入方式（如公众号、微信读书群、其它机器人框架）只需实现上面的接口，
 * 并在 createAdapter 注册一个工厂。
 */
import { randomUUID } from 'node:crypto'
import { verifyWeComSignature, decryptWeComMessage } from './wecom-crypto.js'

/* ------------------------------------------------------------------ */
/* 路由注册（热重载安全）                                              */
/* ------------------------------------------------------------------ */

/**
 * 在 harness webServer 上注册 exact 路由，热重载/重复 apply 安全。
 *
 * Cordis 热重载时旧插件实例的路由可能未先注销，新实例 start() 再注册会
 * 触发 dsh-host-webserver 的 "duplicate exact route" 致命错误（整个
 * harness 崩溃退出，3080 随之失联）。模块级所有权表解决两个时序：
 *  - 注册时发现同 path 已有旧注册 → 先注销旧路由再注册新的（接管所有权）
 *  - 返回的 disposer 仅在仍是当前所有权人时才真正注销——旧实例迟到的
 *    dispose 不会误删新实例的路由（防"旧实例 dispose 晚到"竞态）
 */
const routeOwners = new Map() // path → { token, disposer }

function registerWebRoute(webServer, path, handler) {
  const stale = routeOwners.get(path)
  if (stale) {
    // 旧实例的路由还挂着（热重载未走完整 dispose）→ 摘掉再注册
    stale.disposer()
    routeOwners.delete(path)
  }
  const disposer = webServer.register({ kind: 'exact', path, handler })
  const token = Symbol('wechat-remote-route')
  routeOwners.set(path, { token, disposer })
  return () => {
    const cur = routeOwners.get(path)
    if (cur && cur.token === token) {
      routeOwners.delete(path)
      disposer()
    }
  }
}

/* ------------------------------------------------------------------ */
/* 接口（jsdoc 类型，不强制继承）                                      */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} InboundMessage
 * @property {string} from    联系人 id（微信/企业微信的 userid 或 wxid）
 * @property {string} text    消息文本
 * @property {string[]} [images] 图片临时路径（可选）
 * @property {number} [ts]    时间戳
 */

/**
 * @typedef {object} OutboundPayload
 * @property {string} text     文本内容
 * @property {string} [imagePath] 图片文件路径（可选）
 * @property {string} [filePath]  文件路径（可选）
 */

/* ------------------------------------------------------------------ */
/* webhook 干跑适配器                                                  */
/* ------------------------------------------------------------------ */

class WebhookAdapter {
  constructor(config, ctx) {
    this.config = config
    this.ctx = ctx
    this.handlers = []
  }

  async start() {
    // 优先注册到 harness 自带的 webServer（web profile 有），否则自起一个监听端口
    if (this.ctx.webServer) {
      const path = this.config.webhook?.callbackPath || '/wechat-remote/test'
      const disposer = registerWebRoute(this.ctx.webServer, path, (req, res) => this.#handleRequest(req, res))
      this.ctx.logger('wechat-remote').info(`webhook 干跑入口: POST http://127.0.0.1:3080${path}`)
      return disposer
    }
    // headless 等无 webServer 的 profile：自起 http 服务
    const { createServer } = await import('node:http')
    this.server = createServer((req, res) => this.#handleRequest(req, res))
    this.server.listen(0, '127.0.0.1')
    return () => this.server.close()
  }

  async #handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405).end('use POST')
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      res.writeHead(400).end('bad json')
      return
    }
    const { from = 'tester', text } = payload
    for (const h of this.handlers) {
      h({ from: String(from), text: String(text ?? ''), ts: Date.now() })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, received: { from, text } }))
  }

  onMessage(handler) {
    this.handlers.push(handler)
  }

  async send(contact, payload) {
    // 干跑模式：发回 harness 日志（可在 Web 界面看到）
    this.ctx.logger('wechat-remote').info(`[webhook→${contact}] ${payload.text}`)
  }
}

/* ------------------------------------------------------------------ */
/* 企业微信（WeCom）自建应用适配器 — 生产推荐                           */
/* ------------------------------------------------------------------ */

class WeComAdapter {
  constructor(config, ctx) {
    this.config = config
    this.ctx = ctx
    this.wecom = config.wecom ?? {}
    this.handlers = []
    this.tokenCache = { value: '', expiresAt: 0 }
  }

  start() {
    if (this.ctx.webServer) {
      const path = this.wecom.callbackPath || '/wechat/wecom'
      const disposer = registerWebRoute(this.ctx.webServer, path, (req, res) => this.#handleCallback(req, res))
      this.ctx.logger('wechat-remote').info(`企业微信回调: POST http://127.0.0.1:3080${path}`)
      return disposer
    }
    throw new Error('wecom 适配器需要 harness 的 webServer（请使用 web profile）')
  }

  onMessage(handler) {
    this.handlers.push(handler)
  }

  /**
   * 企业微信服务器模式回调：
   *  GET  = URL 验证（echostr 解密回显）
   *  POST = 消息推送（JSON 包 Encrypt 字段，验签 + AES 解密）
   */
  async #handleCallback(req, res) {
    const url = new URL(req.url, 'http://dsh.internal')
    const query = url.searchParams
    try {
      if (req.method === 'GET') {
        // URL 验证：msg_signature 校验 + echostr 解密
        const ok = verifyWeComSignature(
          this.wecom.token, query.get('timestamp'), query.get('nonce'), query.get('msg_signature'), query.get('echostr')
        )
        if (!ok) throw new Error('msg_signature 校验失败')
        const plain = decryptWeComMessage(this.wecom.encodingAESKey, query.get('echostr'))
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(plain)
        return
      }

      if (req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = JSON.parse(raw)
        const encrypt = body.Encrypt
        const ok = verifyWeComSignature(
          this.wecom.token, query.get('timestamp'), query.get('nonce'), query.get('msg_signature'), encrypt
        )
        if (!ok) throw new Error('msg_signature 校验失败')
        const xml = decryptWeComMessage(this.wecom.encodingAESKey, encrypt)
        const msg = parseWeComXml(xml)
        // 只处理文本消息（MsgType=text）；图片/文件可在此扩展
        if (msg.MsgType === 'text' && msg.Content) {
          for (const h of this.handlers) {
            h({ from: msg.FromUserName, text: msg.Content, ts: Number(msg.CreateTime ?? 0) * 1000 })
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
        return
      }

      res.writeHead(405).end()
    } catch (err) {
      this.ctx.logger('wechat-remote').warn(`企业微信回调失败: ${err.message}`)
      res.writeHead(200).end('') // 回 200 空串，避免企业微信重试风暴
    }
  }

  /** 主动发文本消息（应用消息 API）。 */
  async send(contact, payload) {
    const token = await this.#getToken()
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`
    const body = {
      touser: contact,
      msgtype: 'text',
      agentid: this.wecom.agentid,
      text: { content: payload.text },
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (json.errcode !== 0) {
      throw new Error(`企业微信发送失败 errcode=${json.errcode} errmsg=${json.errmsg}`)
    }
  }

  /** 应用 access_token（2 小时有效，进程内缓存）。 */
  async #getToken() {
    if (this.tokenCache.value && Date.now() < this.tokenCache.expiresAt) return this.tokenCache.value
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.wecom.corpid}&corpsecret=${this.wecom.secret}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.errcode !== 0) throw new Error(`企业微信 gettoken 失败 errcode=${json.errcode}`)
    this.tokenCache = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 }
    return json.access_token
  }
}

/** 极简企业微信 XML 解析（消息回调结构固定，仅取关键字段）。 */
function parseWeComXml(xml) {
  const get = (tag) => {
    const m = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
    return m ? (m[1] ?? m[2]) : undefined
  }
  return {
    ToUserName: get('ToUserName'),
    FromUserName: get('FromUserName'),
    MsgType: get('MsgType'),
    Content: get('Content'),
    CreateTime: get('CreateTime'),
  }
}

/* ------------------------------------------------------------------ */
/* 个人微信（WeChatFerry）适配器 — 仅 Windows，违反微信 ToS，风险自负   */
/* ------------------------------------------------------------------ */

class WeChatFerryAdapter {
  constructor(config, ctx) {
    this.config = config
    this.ctx = ctx
    this.wcfOptions = config.wechatferry ?? {}
    this.handlers = []
    this.wcf = null
    this.started = false
    this.log = ctx.logger('wechat-remote')
  }

  async start() {
    // 懒加载 @wechatferry/core：它是 Windows 原生依赖（自带 sdk dll），
    // 非 Windows / 未安装时优雅降级，不让整个插件挂掉。
    let Wechatferry
    try {
      ;({ Wechatferry } = await import('@wechatferry/core'))
    } catch (err) {
      this.log.warn(
        'wechatferry 适配器：@wechatferry/core 未安装。请在插件目录执行 `pnpm add @wechatferry/core`' +
          '（仅 Windows + 对应微信版本可用），或改用 wecom 适配器。'
      )
      return () => {}
    }
    try {
      this.wcf = new Wechatferry()
      this.wcf.start()
      this.started = true
      let self = '?'
      try {
        self = this.wcf.getSelfWxid() || '?'
      } catch {
        /* 未登录时 getSelfWxid 可能抛错 */
      }
      this.log.info(`微信已连接 self=${self}；获取联系人 wxid 可调用 ctx.wechatRemote 的 getContacts()`)
      this.wcf.startRecvMessage()
      this.wcf.on('message', (msg) => this.#handleWxMsg(msg))
      return () => {
        try {
          this.wcf?.stopRecvMessage()
          this.wcf?.stop()
        } catch {
          /* 已断开 */
        }
        this.started = false
      }
    } catch (err) {
      this.started = false
      this.log.warn(
        `wechatferry 启动失败：${err.message}。请确认：` +
          '1) 微信 PC 版本与 SDK（@wechatferry/core 内置 v39.4.5）匹配且已登录；' +
          '2) 微信进程已注入 wcf；3) 端口 10086 未被占用。详见 README「个人微信接入」。'
      )
      return () => {}
    }
  }

  /** wcf 消息 → 归一化入站消息（type=1 文本；单聊；群聊按 allowGroups 开关）。 */
  #handleWxMsg(msg) {
    try {
      if (!msg || msg.is_self) return
      if (msg.is_group && this.wcfOptions.allowGroups !== true) return
      if (msg.type !== 1 /* WechatMessageType.Text */) return // 图片/语音等 v2 扩展
      const from = msg.is_group ? msg.roomid : msg.sender
      const text = msg.content ?? ''
      for (const h of this.handlers) h({ from, text, ts: msg.ts })
    } catch (err) {
      this.log.warn(`处理微信消息异常: ${err.message}`)
    }
  }

  onMessage(handler) {
    this.handlers.push(handler)
  }

  async send(contact, payload) {
    if (!this.wcf || !this.started) throw new Error('wechatferry 未连接（微信未启动或未注入 wcf）')
    const ret = this.wcf.sendTxt(payload.text, contact)
    if (ret !== 0) throw new Error(`微信发送失败，返回码 ${ret}`)
  }

  /** 查询联系人（帮助用户拿到 wxid 填 allowlist）。 */
  getContacts() {
    if (!this.wcf || !this.started) return []
    try {
      return this.wcf.getContacts()
    } catch {
      return []
    }
  }
}

/* ------------------------------------------------------------------ */
/* 中继（relay）适配器 — 小程序通过中心服务器远控本机 harness          */
/* ------------------------------------------------------------------ */

class RelayAdapter {
  constructor(config, ctx) {
    this.config = config
    this.ctx = ctx
    this.relay = config.relay ?? {}
    this.handlers = []
    this.ws = null
    this.connected = false
    this.stopped = false
    this.log = ctx.logger('wechat-remote')
  }

  async start() {
    const { serverUrl, deviceId, token } = this.relay
    if (!serverUrl || !deviceId || !token) {
      this.log.warn('relay 适配器缺少配置（relay.serverUrl / relay.deviceId / relay.token），请在用户 patch 层补齐')
      return () => {}
    }
    this.url = `${serverUrl.replace(/\/+$/, '')}/relay`
    this.deviceId = deviceId
    this.token = token
    this.#connect()
    return () => {
      this.stopped = true
      try {
        this.ws?.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 出站长连接（断线自动重连，5s 退避）。 */
  #connect() {
    if (this.stopped) return
    let ws
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.log.warn(`relay 连接失败: ${err.message}，5s 后重连`)
      setTimeout(() => this.#connect(), 5000)
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.connected = true
      this.log.info(`relay 已连接 ${this.url} device=${this.deviceId}`)
      ws.send(JSON.stringify({ type: 'hello', deviceId: this.deviceId, token: this.token }))
    })
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data))
        if (msg?.type === 'chat') {
          const text = Array.isArray(msg.messages)
            ? msg.messages.map((m) => m?.content ?? '').filter(Boolean).join('\n')
            : String(msg.text ?? '')
          if (!text) return
          // from='relay'：需在 allowlist 中加入 relay 才会放行（token 已鉴权，仍走白名单双保险）
          for (const h of this.handlers) h({ from: 'relay', text, ts: Date.now() })
        }
      } catch (err) {
        this.log.warn(`relay 消息解析失败: ${err.message}`)
      }
    })
    const onGone = () => {
      this.connected = false
      this.ws = null
      if (!this.stopped) setTimeout(() => this.#connect(), 5000)
    }
    ws.addEventListener('close', onGone)
    ws.addEventListener('error', () => {
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
    })
  }

  onMessage(handler) {
    this.handlers.push(handler)
  }

  /** 回复走同一连接回传中心服务器 → 小程序。 */
  async send(contact, payload) {
    if (!this.ws || !this.connected) throw new Error('relay 未连接（中心服务器不可达或已断线）')
    this.ws.send(JSON.stringify({ type: 'reply', deviceId: this.deviceId, text: payload.text }))
  }
}

/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */

export function createAdapter(kind, config, ctx) {
  switch (kind) {
    case 'webhook':
      return new WebhookAdapter(config, ctx)
    case 'wecom':
      return new WeComAdapter(config, ctx)
    case 'wechatferry':
      return new WeChatFerryAdapter(config, ctx)
    case 'relay':
      return new RelayAdapter(config, ctx)
    default:
      throw new Error(`未知微信适配器: ${kind}`)
  }
}
