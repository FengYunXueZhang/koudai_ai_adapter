# ============================================================
# 口袋求索 · 设备端一键安装器（Windows）
# 作用：自动装好"本地设备端"，让微信小程序可以远控这台电脑上的
#       DeepSeek Harness。
# 用法：双击"一键安装.bat"即可。全程自动，唯一需要你输入的是
#       DeepSeek API Key。
# 来源：GitHub / Gitee 自动拉取插件（可 -PluginSource 指定）。
# ============================================================

# ---------- 参数（必须位于脚本最前） ----------
param(
  [string]$ServerUrl = 'ws://ws.soulyouai.com',
  [string]$PluginSource = 'auto'   # auto | gitee | github | local
)

$ErrorActionPreference = 'Continue'
$Host.UI.RawUI.WindowTitle = 'Koudai AI Installer'

Write-Host "==============================================" -ForegroundColor Green
Write-Host "  口袋求索 · 设备端一键安装" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green

# 输出编码对齐（避免中文叠字）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 防重复运行：已有其它安装器实例时退出
$otherInst = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*install.ps1*' } | Select-Object -First 1
if ($otherInst) {
  Write-Host "检测到已有安装器在运行（PID $($otherInst.ProcessId)），请先关闭其它安装窗口，再重新运行本程序。" -ForegroundColor Yellow
  Write-Host "按回车退出"; Read-Host
  exit 1
}

function Step($msg) { Write-Host "`n[$msg]" -ForegroundColor Cyan }
function Check($desc, $ok) { if (-not $ok) { throw "步骤失败：$desc" } }

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
Check 'dsh CLI 安装失败（可重跑本安装器）' (Test-Path $dshBin)
Write-Host "dsh 就绪 ✓"

# ---------- 4. 拉取插件（逐文件 raw 直链，规避 Gitee 归档下载页） ----------
Step '4/6 获取微信遥控插件'
$pluginFiles = @('package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/adapters.js', 'lib/bridge.js', 'lib/drivers.js', 'lib/wecom-crypto.js')
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
  $src = $PluginSource
  if ($src -eq 'auto') { $src = 'gitee' }  # 国内默认 Gitee（GitHub 可加 -PluginSource github）
  $rawBase = switch ($src) {
    'gitee'  { 'https://gitee.com/fengyun-senior/wechat_deepseek_harness_plugin/raw/master' }
    'github' { 'https://raw.githubusercontent.com/FengYunXueZhang/koudai_ai_adapter/master' }
    default  { throw "未知插件来源 $src" }
  }
  Write-Host "从 $src 下载插件文件..."
  New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir 'lib') | Out-Null
  $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0'
  foreach ($f in $pluginFiles) {
    try {
      Invoke-WebRequest -Uri "$rawBase/$f" -OutFile (Join-Path $PluginDir $f) -TimeoutSec 40 -UserAgent $ua
    } catch {
      throw "下载插件文件失败: $f —— $($_.Exception.Message)"
    }
  }
  Check '插件文件不完整' ((Test-Path (Join-Path $PluginDir 'package.json')) -and (Get-Content (Join-Path $PluginDir 'lib\index.js') -Raw -Encoding UTF8).Contains('relay'))
  Write-Host "插件已下载到 $PluginDir"
} else {
  Write-Host "插件已存在 ✓"
}
# 安装插件依赖
Write-Host "正在安装插件依赖（首次需下载约 20MB，请耐心等待 1~3 分钟）..." -ForegroundColor Yellow
Push-Location $PluginDir
& $pnpm install --store-dir (Join-Path $Base 'pnpm-store') 2>&1 | Out-Null
Pop-Location
Check '插件依赖安装失败' (Test-Path (Join-Path $PluginDir 'node_modules'))

# ---------- 5. 注册插件 + 写入配置 ----------
Step '5/6 注册插件并写入配置'
$profilePkg = Join-Path $ProfileDir 'package.json'
$alreadyRegistered = (Test-Path $profilePkg) -and ((Get-Content $profilePkg -Raw -Encoding UTF8) -match 'dsh-plugin-wechat-remote')
if ($alreadyRegistered) {
  Write-Host "插件已注册过，跳过重新链接（保留现有安装）" -ForegroundColor Yellow
} else {
  & $dshBin plugin --profile web add $PluginDir -w 2>&1 | Out-Null
  Check '插件注册失败' ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq $null)
}

# 设备标识（每次安装唯一）
$deviceId = 'pc-' + (Get-Random -Minimum 100000 -Maximum 999999)
$token = -join ((48..57)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})

# 配对码：由 token 派生（与服务器同算法），6 位数字
$sha = [System.Security.Cryptography.SHA256]::Create()
$hex = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))).Replace('-','').ToLower()
$code = ([Convert]::ToInt64($hex.Substring($hex.Length - 6), 16) % 1000000).ToString('D6')

# 用户层配置：relay 适配器（若已存在 wechat-remote 配置则跳过，避免覆盖/重复）
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path $patchFile) {
  $existing = Get-Content $patchFile -Raw -Encoding UTF8
  if ($existing -match 'id: wechat-remote') {
    Write-Host "检测到已存在 wechat-remote 配置，跳过写入（如需更换设备，请先清理 $patchFile 中的 wechat-remote 段）" -ForegroundColor Yellow
    $skipPatch = $true
  }
}
if (-not $skipPatch) {
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
  Add-Content -Path $patchFile -Value $patch -Encoding UTF8
  Write-Host "relay 配置已写入（设备ID: $deviceId）"
}

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
