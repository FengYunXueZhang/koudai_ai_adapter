/**
 * 企业微信回调加解密（服务器模式）。
 *
 * 参考企业微信官方文档《接收消息与事件》：
 *   - 签名：msg_signature = SHA1(sort(token, timestamp, nonce, echostr|Encrypt))
 *   - 密文：EncodingAESKey 去掉尾部 '=' 后 base64 解码得 43 字节 key；
 *           AES-256-CBC，IV = key 前 16 字节；明文 = 16 字节随机串 + 4 字节网络序长度 + 消息 + receiveid
 * 纯 node:crypto 实现，零依赖。
 */
import { createHash, createDecipheriv } from 'node:crypto'

/**
 * 校验企业微信回调签名。
 * @param {string} token 企业微信后台配置的 Token
 * @param {string|null} timestamp
 * @param {string|null} nonce
 * @param {string|null} msgSignature 请求里的 msg_signature
 * @param {string|null} encrypt echostr（URL 验证）或 Encrypt（消息推送）
 * @returns {boolean}
 */
export function verifyWeComSignature(token, timestamp, nonce, msgSignature, encrypt) {
  if (!token || !timestamp || !nonce || !msgSignature || !encrypt) return false
  const raw = [token, timestamp, nonce, encrypt].sort().join('')
  const digest = createHash('sha1').update(raw).digest('hex')
  return digest === msgSignature
}

/**
 * 解密企业微信回调密文（echostr 或 Encrypt 共用同一算法）。
 * @param {string} encodingAESKey 43 位 Base64 形式的 AESKey（不含尾部 =）
 * @param {string} cipherBase64 密文（Base64）
 * @returns {string} 明文消息体（XML 或 URL 验证时的 echostr 明文）
 */
export function decryptWeComMessage(encodingAESKey, cipherBase64) {
  if (!encodingAESKey || !cipherBase64) throw new Error('缺少 encodingAESKey 或密文')
  const key = Buffer.from(encodingAESKey + '=', 'base64')
  if (key.length !== 32) throw new Error(`encodingAESKey 长度非法（应为 43 位，实际 ${encodingAESKey.length} 位）`)
  const iv = key.subarray(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherBase64, 'base64')), decipher.final()])

  // 去 PKCS7 填充
  const pad = decrypted[decrypted.length - 1]
  const unpadded = decrypted.subarray(0, decrypted.length - pad)

  // 明文布局：16 字节随机串 + 4 字节网络序消息长度 + 消息 + receiveid
  const msgLen = unpadded.readUInt32BE(16)
  const msg = unpadded.subarray(20, 20 + msgLen).toString('utf8')
  return msg
}
