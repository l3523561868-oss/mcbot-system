#Requires -Version 5.1
<#
.SYNOPSIS
    MCBot 一键安装 / 环境检查（Windows）

.DESCRIPTION
    只做四件事：检查运行时、装 npm 依赖、打 node_modules 补丁、复制配置模板。
    不联网下载脚本、不改系统设置、不请求管理员、不删除任何文件、不接触账号凭证。
    重复执行安全（幂等）；已有配置文件一律不覆盖。

.PARAMETER Check
    只检查并打印结论，不做任何修改（等价于 doctor + 依赖/补丁状态）。

.PARAMETER Force
    即使 node_modules 已存在也重新执行 npm install。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
# 让子进程（python/node）的 UTF-8 输出在本窗口正确显示；仅影响当前进程
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }
$Root = Split-Path -Parent $PSScriptRoot

function Step($m) { Write-Host " "; Write-Host "== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Failed = $true }

$script:Failed = $false

function Get-ToolVersion($exe, $argList) {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { return $null }
    try {
        $out = & $exe @argList 2>&1 | Out-String
        return (($out -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
    } catch { return $null }
}

function Version-AtLeast($text, [int]$major) {
    if (-not $text) { return $false }
    $m = [regex]::Match($text, '(\d+)\.(\d+)')
    if (-not $m.Success) { return $false }
    return ([int]$m.Groups[1].Value -ge $major)
}

Write-Host "MCBot 安装器 · $Root"

# ---------- 1. 运行时 ----------
Step "1/4 检查运行时"
$py = Get-ToolVersion "python" @("--version")
if (-not $py) { $py = Get-ToolVersion "py" @("-3", "--version") }
if ($py) {
    $pyv = ($py -replace '^Python\s*', '').Trim()
    if (Version-AtLeast $pyv 3) { Ok "Python $pyv" } else { Fail "Python 版本过低（$pyv），需要 3.10+（本脚本只校验主版本）" }
} else { Fail "未找到 python（安装后需重开终端）" }

$node = Get-ToolVersion "node" @("--version")
if ($node) {
    $nv = $node.TrimStart('v')
    if (Version-AtLeast $nv 18) { Ok "Node $nv" } else { Fail "Node 版本过低（$nv），需要 18+" }
} else { Fail "未找到 node" }

$npm = Get-ToolVersion "npm" @("--version")
if ($npm) { Ok "npm $npm" } else { Fail "未找到 npm（随 Node 安装）" }

if (-not (Test-Path (Join-Path $Root "src\bot\forge-live.mjs"))) {
    Fail "仓库结构不完整：缺 src\bot\forge-live.mjs"
}

if ($Check) {
    Step "检查模式：以下仅报告，不做修改"
    $nm = Join-Path $Root "src\bot\node_modules"
    if (Test-Path $nm) { Ok "node_modules 已存在" } else { Warn "node_modules 未安装 → 去掉 -Check 再运行本脚本" }
    $bots = Join-Path $Root "src\console\bots.json"
    if (Test-Path $bots) { Ok "bots.json 已存在" } else { Warn "bots.json 未创建 → 安装时会从模板复制" }
    if (Test-Path (Join-Path $Root "scripts\doctor.py")) {
        Step "详细体检"
        & python (Join-Path $Root "scripts\doctor.py")
        exit $LASTEXITCODE
    }
    exit $(if ($script:Failed) { 1 } else { 0 })
}

if ($script:Failed) { Write-Host " "; Write-Host "先解决上面的 FAIL 再继续。" -ForegroundColor Red; exit 1 }

# ---------- 2. 依赖 ----------
Step "2/4 安装 Node 依赖"
Push-Location (Join-Path $Root "src\bot")
try {
    $needInstall = $Force -or -not (Test-Path "node_modules")
    if ($needInstall) {
        Write-Host "  npm install（首次约 300-600 MB，几分钟）…"
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败（退出码 $LASTEXITCODE）" }
        Ok "依赖安装完成"
    } else {
        Ok "node_modules 已存在，跳过（-Force 可强制重装）"
    }

    # ---------- 3. 补丁 ----------
    Step "3/4 恢复 node_modules 补丁"
    & node apply-patches.mjs
    if ($LASTEXITCODE -ne 0) { throw "apply-patches.mjs 失败（退出码 $LASTEXITCODE）" }
    Ok "补丁已恢复（每次 npm install 后都必须重打）"
} catch {
    Write-Host "  [FAIL] $_" -ForegroundColor Red
    Pop-Location
    exit 1
} finally {
    if ((Get-Location).Path -ne $Root) { Pop-Location }
}

# ---------- 4. 配置 ----------
Step "4/4 准备配置（不覆盖已有文件）"
$pairs = @(
    @{ Src = "config\bots.example.json";      Dst = "src\console\bots.json" },
    @{ Src = "config\brain.example.json";     Dst = "src\console\brain.json" },
    @{ Src = "config\providers.example.json"; Dst = "src\console\data\providers.json" }
)
foreach ($p in $pairs) {
    $src = Join-Path $Root $p.Src
    $dst = Join-Path $Root $p.Dst
    if (-not (Test-Path $src)) { Warn "模板缺失：$($p.Src)"; continue }
    if (Test-Path $dst) { Ok "$($p.Dst) 已存在，保留不动"; continue }
    $dir = Split-Path -Parent $dst
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    Copy-Item $src $dst
    Ok "$($p.Dst) 已从模板创建（记得填自己的服务器与账号）"
}

# ---------- 收尾 ----------
Step "体检"
& python (Join-Path $Root "scripts\doctor.py")
$code = $LASTEXITCODE

Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1) 编辑 src\console\bots.json：填服务器地址、账号名、AuthMe 口令"
Write-Host "  2) 通道表：见 docs\01-部署流程\05-获取整合包与抓包.md（当前若仍是样本，连真服会被踢）"
Write-Host "  3) 启动：scripts\启动全部.bat，或 python src\console\console.py --port 8900"
Write-Host "  4) 校验：python scripts\doctor.py --verify"

exit $code
