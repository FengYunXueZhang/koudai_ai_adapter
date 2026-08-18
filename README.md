# 口袋求索 · Koudai AI

> 用微信小程序，远程遥控你的电脑。
> 手机发指令，电脑上的 AI 帮你执行——跑命令、处理文件、查资料，结果回到手机。

---

## 🚀 两步上手

### 第 1 步：电脑上安装"设备端"（Windows，约 3 分钟）

**下载安装器**（任选其一）：

| 渠道 | 地址 |
|---|---|
| GitHub Release | https://github.com/FengYunXueZhang/koudai_ai_adapter/releases/latest |
| 国内镜像（Gitee） | https://gitee.com/fengyun-senior/wechat_deepseek_harness_plugin/releases |

下载 **`pocket-qiussuo-installer.zip`**（仅 4.5KB）→ 解压 → **双击「一键安装.bat」**：

1. 全程自动（自动安装 Node / DeepSeek Harness / 本适配器，无需手动配置）
2. 唯一手动步骤：输入你的 **DeepSeek API Key**（没有 → [platform.deepseek.com](https://platform.deepseek.com) 免费创建）
3. 完成后屏幕显示：**设备ID** 和 **6位配对码** ← 记下来（或截图）

> 以后想再启动电脑端：双击安装目录里的 `启动设备.bat`。

### 第 2 步：手机微信里绑定并远控

1. 在微信中**搜索小程序「口袋求索」**（小程序发布上线后即可搜索；审核期可用体验版）
2. 小程序里：**设置 → 添加设备**
3. 把电脑上显示的 **设备ID** 和 **配对码** 填进去 → **绑定成功**
4. 回到聊天页，发指令，例如：
   ```
   运行 node -e "console.log(21*2)" 并把结果告诉我
   ```
5. 电脑上的 AI 真的执行命令，结果回到你的手机 ✅

---

## 📖 常见问题

| 问题 | 解决 |
|---|---|
| 双击没反应 / 被杀毒拦截 | 右键 `一键安装.bat` → 以管理员身份运行 |
| 安装慢 | 首次要下载 Node 等组件（约 1 分钟），属正常 |
| 绑定提示"设备未在线" | 确认电脑端已启动（屏幕显示设备ID） |
| 忘记配对码 | 重跑一次「一键安装.bat」会重新生成 |
| 不在 Windows 上 | v1 支持 Windows；macOS/Linux 可自部署 DSH 插件（见下方技术说明） |

## 🔒 安全说明

- 你的 **API Key 只保存在自己电脑本地**，用于本机 AI 调用，服务器不存储
- 设备只接受**用配对码绑定过**的小程序用户，别人无法控制你的电脑
- 小程序与电脑之间走 **wss 加密通道**（备案域名 + HTTPS 证书）

---

## 🛠 技术说明（开发者/自部署）

本项目是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 bundle 插件：

- **架构**：微信小程序 ⇄ 中心服务器（中继）⇄ 本机 DSH Harness（agent 在本地沙箱执行）
- **插件目录**：`lib/`（适配器：relay / webhook / wecom / wechatferry）
- **一键安装器**：`install/install.ps1`
- 手动安装插件：`dsh plugin --profile web add <本仓库路径> -w`，然后在 `~/.dsh/profiles/web/cordis.patch.yml` 配置 relay（serverUrl/deviceId/token）

## 📦 发布记录

- **v1.1.0**：一键安装器 + 配对码绑定 + 安装包（`dist/pocket-qiussuo-installer.zip`）
- 更早：relay 中继、心跳保活、wss 域名接入等

## 📄 License

MIT
