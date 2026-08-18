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
      const disposer = this.ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => this.#handleRequest(req, res),
      })
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
      const disposer = this.ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => this.#handleCallback(req, res),
      })
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
/* 个人微信（WeChatFerry）适配器 — 骨架，仅 Windows，风险自负           */
/* ------------------------------------------------------------------ */

class WeChatFerryAdapter {
  constructor(config, ctx) {
    this.config = config
    this.ctx = ctx
    this.handlers = []
  }

  async start() {
    // TODO: 接入 WeChatFerry（github.com/lich0821/WeChatFerry）。
    // 个人微信自动化违反微信《软件许可及服务协议》，有封号风险，仅供学习研究。
    // 典型接入：
    //   const wcf = new (await import('@wechatferry/node')).WeChatFerry()
    //   wcf.enableRecvMsg(true)
    //   wcf.on('message', (msg) => {
    //     if (msg.type === 1 /* WM_TEXT */) for (const h of this.handlers) h({ from: msg.sender, text: msg.content })
    //   })
    throw new Error('wechatferry 适配器尚未实现：请改用 wecom 或先阅读 lib/adapters.js 中的 TODO')
  }

  onMessage(handler) {
    this.handlers.push(handler)
  }

  async send(contact, payload) {
    // TODO: wcf.sendText(contact, payload.text)
    throw new Error('wechatferry 适配器尚未实现')
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
    default:
      throw new Error(`未知微信适配器: ${kind}`)
  }
}
