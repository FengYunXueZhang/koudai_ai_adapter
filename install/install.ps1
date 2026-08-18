# ============================================================
# 口袋求索 · 设备端一键安装器（Windows）
# 作用：自动装好"本地设备端"，让微信小程序可以远控这台电脑上的
#       DeepSeek Harness。
# 用法：双击运行（或右键 → 使用 PowerShell 运行）。全程自动，
#       唯一需要你输入的是 DeepSeek API Key。
# 来源：GitHub / Gitee 自动拉取插件（可 -PluginSource 指定）。
# ============================================================
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '口袋求索 · 设备端一键安装'

Write-Host "==============================================" -ForegroundColor Green
Write-Host "  口袋求索 · 设备端一键安装" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green

# ---------- 参数 ----------
param(
  [string]$ServerUrl = 'ws://ws.soulyouai.com',
  [string]$PluginSource = 'auto'   # auto | gitee | github | local
)

$NodeVersion = 'v20.19.0'
$Base = Join-Path $env:LOCALAPPDATA 'pocket-qiussuo'
$NodeDir = Join-Path $Base 'node'
$PluginDir = Join-Path $Base 'plugin'
$DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
$ProfileDir = Join-Path $DSH_HOME 'profiles\web'
$CredFile = Join-Path $DSH_HOME '.credentials.yaml'

function Step($msg) { Write-Host "`n[$msg]" -ForegroundColor Cyan }

# ---------- 1. Node.js ----------
Step '1/6 检查 Node.js'
$nodeExe = Join-Path $NodeDir 'node.exe'
if (-not (Test-Path $nodeExe)) {
  Write-Host "未检测到 Node，正在下载 v$NodeVersion（约 30MB）..."
  $url = "https://npmmirror.com/mirrors/node/$NodeVersion/node-$NodeVersion-win-x64.zip"
  $zip = Join-Path $Base 'node.zip'
  New-Item -ItemType Directory -Force -Path $Base | Out-Null
  Invoke-WebRequest -Uri $url -OutFile $zip
  Write-Host "解压中..."
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Base 'node-tmp') -Force
  Move-Item (Join-Path $Base "node-tmp\node-$NodeVersion-win-x64") $NodeDir -Force
  Remove-Item $zip, (Join-Path $Base 'node-tmp') -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Node 已安装到 $NodeDir"
} else {
  Write-Host "Node 已存在 ✓"
}
$env:PATH = "$NodeDir;$NodeDir\node_modules\npm\bin;" + $env:PATH

# ---------- 2. pnpm（corepack 自带） ----------
Step '2/6 准备 pnpm'
& "$NodeDir\corepack.cmd" enable 2>$null | Out-Null
& "$NodeDir\corepack.cmd" prepare pnpm@9 --activate 2>&1 | Out-Null
$pnpm = Join-Path $NodeDir 'pnpm.cmd'
if (-not (Test-Path $pnpm)) { $pnpm = Join-Path $NodeDir 'pnpm.exe' }
if (-not (Test-Path $pnpm)) {
  Write-Host "pnpm 未就绪，尝试 npm 全局安装..." -ForegroundColor Yellow
  & "$NodeDir\npm.cmd" install -g pnpm@9
  $pnpm = Join-Path $NodeDir 'pnpm.cmd'
}
Write-Host "pnpm 就绪 ✓"

# ---------- 3. DeepSeek Harness (dsh) ----------
Step '3/6 安装 DeepSeek Harness'
$dshBin = Join-Path $NodeDir 'dsh.cmd'
if (-not (Test-Path $dshBin)) {
  Write-Host "安装 dsh CLI（首次约 1 分钟）..."
  & "$NodeDir\npm.cmd" install -g @deepseek-ai/dsh 2>&1 | Out-Null
}
if (-not (Test-Path $dshBin)) {
  # npm 全局 bin 可能在 node 目录下
  $dshBin = (Get-ChildItem $NodeDir -Filter 'dsh*' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
Write-Host "dsh 就绪 ✓"

# ---------- 4. 拉取插件 ----------
Step '4/6 获取微信遥控插件'
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
  $zip = Join-Path $Base 'plugin.zip'
  $src = $PluginSource
  if ($src -eq 'auto') { $src = 'gitee' }  # 国内默认 Gitee（GitHub 可加 -PluginSource github）
  $url = switch ($src) {
    'gitee'  { 'https://gitee.com/fengyun-senior/wechat_deepseek_harness_plugin/repository/archive/master.zip' }
    'github' { 'https://github.com/FengYunXueZhang/koudai_ai_adapter/archive/refs/heads/master.zip' }
    default  { throw "未知插件来源 $src" }
  }
  Write-Host "从 $src 下载插件..."
  Invoke-WebRequest -Uri $url -OutFile $zip
  New-Item -ItemType Directory -Force -Path (Join-Path $Base 'plugin-tmp') | Out-Null
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Base 'plugin-tmp') -Force
  $extracted = Get-ChildItem (Join-Path $Base 'plugin-tmp') -Directory | Select-Object -First 1
  Move-Item $extracted.FullName $PluginDir -Force
  Remove-Item $zip, (Join-Path $Base 'plugin-tmp') -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "插件已下载到 $PluginDir"
} else {
  Write-Host "插件已存在 ✓"
}
# 安装插件依赖
Push-Location $PluginDir
& $pnpm install --store-dir (Join-Path $Base 'pnpm-store') 2>&1 | Out-Null
Pop-Location

# ---------- 5. 注册插件 + 写入配置 ----------
Step '5/6 注册插件并写入配置'
& $dshBin plugin --profile web add $PluginDir -w 2>&1 | Out-Null

# 设备标识（每次安装唯一）
$deviceId = 'pc-' + (Get-Random -Minimum 100000 -Maximum 999999)
$token = -join ((48..57)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})

# 配对码：由 token 派生（与服务器同算法），6 位数字
$sha = [System.Security.Cryptography.SHA256]::Create()
$hex = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))).Replace('-','').ToLower()
$code = ([Convert]::ToInt64($hex.Substring($hex.Length - 6), 16) % 1000000).ToString('D6')

# 用户层配置：relay 适配器
$patch = @"

# 口袋求索 relay 配置（一键安装器生成）
- id: wechat-remote
  config:
    adapter: relay
    allowlist:
      - relay
    relay:
      serverUrl: '$ServerUrl'
      deviceId: '$deviceId'
      token: '$token'
"@
Add-Content -Path (Join-Path $ProfileDir 'cordis.patch.yml') -Value $patch -Encoding UTF8
Write-Host "relay 配置已写入（设备ID: $deviceId）"

# DeepSeek API Key
Step '6/6 配置 DeepSeek API Key'
$key = $env:DEEPSEEK_API_KEY
if (-not $key) {
  $key = Read-Host "请输入你的 DeepSeek API Key（sk- 开头，platform.deepseek.com 免费获取）"
}
$key = $key.Trim()
if ($key -notmatch '^sk-') { throw 'Key 必须以 sk- 开头' }
$credDir = Split-Path $CredFile
New-Item -ItemType Directory -Force -Path $credDir | Out-Null
Set-Content -Path $CredFile -Value "DEEPSEEK_API_KEY: $key" -Encoding UTF8
Write-Host "API Key 已保存到 $CredFile"

# ---------- 启动 ----------
Step '启动设备端'
$dshHome = Split-Path $ProfileDir -Parent -Resolve
$env:DSH_HOME = $DSH_HOME
$launcher = Join-Path $Base '启动设备.bat'
@"
@echo off
set DSH_HOME=$DSH_HOME
"$NodeDir\node.exe" "$NodeDir\node_modules\@deepseek-ai\dsh\lib\bin.js" web
"@ | Set-Content -Path $launcher -Encoding ASCII

Start-Process -FilePath "$NodeDir\node.exe" -ArgumentList "$NodeDir\node_modules\@deepseek-ai\dsh\lib\bin.js",'web' -WindowStyle Hidden
Start-Sleep -Seconds 12

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "  设备ID : $deviceId" -ForegroundColor Yellow
Write-Host "  配对码 : $code   ← 在小程序「设置→添加设备」里填这个" -ForegroundColor Yellow
Write-Host "  （扫码绑定格式：poket:$deviceId`:$code）" -ForegroundColor DarkGray
Write-Host "  以后手动启动：双击 $launcher" -ForegroundColor Yellow
Write-Host "  小程序里：设置 → 添加设备 → 输入配对码 → 即可远控本机" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "按回车退出"; Read-Host
