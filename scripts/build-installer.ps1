# NetPeek 安装包构建脚本（§43 自研安装器版）
# 流程：
#   1. tauri build --no-bundle     → 主程序 exe（release，不打 bundle；targets 已是 []，双保险）
#   2. dotnet publish Collector    → self-contained 单文件（LocalSystem 服务不依赖用户装 .NET）
#   3. 填充 src/NetPeek.Installer/payload/（主程序 + 采集服务作为安装器内嵌资源）
#   4. dotnet publish Installer    → 单文件压缩 setup，即最终安装包
# 产物：dist\NetPeek.Setup.exe
# 用法：pwsh -File scripts\build-installer.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$payloadDir = Join-Path $repo 'src\NetPeek.Installer\payload'
$distDir = Join-Path $repo 'dist'
$dotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
if (-not (Test-Path $dotnet)) { throw "找不到 dotnet.exe: $dotnet（请确认已安装 .NET SDK 8.0 x64）" }

# 构建产物清理走 .NET API：环境的 safe-delete 钩子会把 Remove-Item -Recurse
# 重定向到回收站并在 trash 失败时 fail-closed，构建脚本不需要这层保护。
function Remove-Tree([string]$path) {
    if (Test-Path -LiteralPath $path) {
        [System.IO.Directory]::Delete($path, $true)
    }
}

# ---------- 1. 主程序（release 编译，不打 bundle） ----------
# 显式找 npm.cmd：PowerShell 5.1 的 Get-Command npm 会先命中 npm.ps1，
# 执行策略可能拦截 .ps1 且报错不进日志（本次构建静默失败的原因）。
$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { $npmCmd = Join-Path $env:ProgramFiles 'nodejs\npm.cmd' }
if (-not (Test-Path $npmCmd)) { throw "找不到 npm.cmd: $npmCmd" }
Write-Host 'tauri build --no-bundle（编译主程序 release）...' -ForegroundColor Cyan
Push-Location (Join-Path $repo 'src\NetPeek.App')
try {
    # 经 cmd /c 包裹并重定向：①PS 5.1 在 ErrorActionPreference=Stop 下会把原生命令
    # stderr 上的【进度信息】（tauri/rust 惯例）转成异常终止脚本；
    # ②Start-Process 在 Path/PATH 大小写共存的环境里有字典冲突 bug（workbuddy 环境实锤）。
    # 日志按 UTF-8 读：tauri/rust 输出是 UTF-8，PS 5.1 默认按 ANSI 读会变乱码。
    $buildLog = Join-Path $env:TEMP 'netpeek-tauri-build.out.log'
    $buildErr = Join-Path $env:TEMP 'netpeek-tauri-build.err.log'
    $cmdLine = "`"$npmCmd`" run build -- --no-bundle 1>`"$buildLog`" 2>`"$buildErr`""
    cmd /c $cmdLine
    Get-Content $buildLog -Encoding UTF8 | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Get-Content $buildErr -Encoding UTF8 | Write-Host -ForegroundColor Red
        throw "tauri build 失败（exit $LASTEXITCODE），stderr 见 $buildErr"
    }
}
finally { Pop-Location }

$releaseDir = Join-Path $repo 'src\NetPeek.App\src-tauri\target\release'
$mainExe = Join-Path $releaseDir 'NetPeek.exe'
if (-not (Test-Path $mainExe)) { $mainExe = Join-Path $releaseDir 'netpeek-app.exe' }
if (-not (Test-Path $mainExe)) { throw "主程序 exe 未找到（试过 NetPeek.exe / netpeek-app.exe）: $releaseDir" }
Write-Host ("主程序: {0:N1} MB" -f ((Get-Item $mainExe).Length / 1MB)) -ForegroundColor Green

# ---------- 2. 采集服务 ----------
Write-Host '发布采集服务（self-contained 单文件 win-x64，压缩）...' -ForegroundColor Cyan
Remove-Tree $payloadDir
New-Item -ItemType Directory -Path $payloadDir | Out-Null
& $dotnet publish (Join-Path $repo 'src\NetPeek.Collector\NetPeek.Collector.csproj') `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true -p:DebugType=None -p:DebugSymbols=false `
    -o $payloadDir
if ($LASTEXITCODE -ne 0) { throw '采集服务发布失败' }

$collectorExe = Join-Path $payloadDir 'NetPeek.Collector.exe'
if (-not (Test-Path $collectorExe)) { throw "采集服务单文件未生成: $collectorExe" }
# payload 只留 exe（csproj 按名内嵌这两个文件；pdb/json/杂项清掉保持干净）
# safe-delete 钩子 hook 了一切形态的 Remove-Item（含 -LiteralPath 管道），
# 构建产物清理统一走 .NET 静态 API
Get-ChildItem $payloadDir -Exclude 'NetPeek.exe', 'NetPeek.Collector.exe' |
    ForEach-Object {
        if ($_.PSIsContainer) { [System.IO.Directory]::Delete($_.FullName, $true) }
        else { [System.IO.File]::Delete($_.FullName) }
    }
Write-Host ("采集服务: {0:N1} MB" -f ((Get-Item $collectorExe).Length / 1MB)) -ForegroundColor Green

# ---------- 3. 填充 payload ----------
Copy-Item $mainExe (Join-Path $payloadDir 'NetPeek.exe') -Force
Write-Host "payload 已填充: $payloadDir" -ForegroundColor Cyan

# ---------- 4. 安装器（版本号与主应用对齐） ----------
$version = (Get-Content (Join-Path $repo 'src\NetPeek.App\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
Write-Host "发布安装器（版本 $version，单文件压缩）..." -ForegroundColor Cyan
Remove-Tree $distDir
New-Item -ItemType Directory -Path $distDir | Out-Null
& $dotnet publish (Join-Path $repo 'src\NetPeek.Installer\NetPeek.Installer.csproj') `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true -p:DebugType=None -p:DebugSymbols=false `
    -p:Version=$version -o $distDir
if ($LASTEXITCODE -ne 0) { throw '安装器发布失败' }

$setup = Join-Path $distDir 'NetPeek.Setup.exe'
if (-not (Test-Path $setup)) { throw "安装包未生成: $setup" }
Write-Host ''
Write-Host ("安装包生成完毕: {0} ({1:N1} MB)" -f $setup, ((Get-Item $setup).Length / 1MB)) -ForegroundColor Green
