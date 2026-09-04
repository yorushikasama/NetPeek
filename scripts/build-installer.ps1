# NetPeek 安装包构建脚本（阶段 5）
# 步骤：
#   1. 发布采集服务：self-contained 单文件 win-x64（LocalSystem 服务不依赖用户装 .NET 运行时）
#      → src-tauri/installer/collector/NetPeek.Collector.exe（collector.wxs 的 File Source 相对路径）
#   2. tauri build --bundles msi：Tauri 自动处理 WebView2 检测（downloadBootstrapper）、
#      MajorUpgrade 升级清理、UI 安装/卸载；collector.wxs 以 fragment 合并进 MSI 装服务
# 用法：pwsh -File scripts\build-installer.ps1
# 产物：src/NetPeek.App/src-tauri/target/release/bundle/msi/*.msi

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$publishOut = Join-Path $repo 'src\NetPeek.App\src-tauri\installer\collector'
$dotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'

# ---------- 1. 发布采集服务 ----------
Write-Host '发布采集服务（self-contained 单文件 win-x64）...' -ForegroundColor Cyan
if (Test-Path $publishOut) { Remove-Item $publishOut -Recurse -Force }
& $dotnet publish (Join-Path $repo 'src\NetPeek.Collector\NetPeek.Collector.csproj') `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $publishOut
if ($LASTEXITCODE -ne 0) { throw '采集服务发布失败' }

$exe = Join-Path $publishOut 'NetPeek.Collector.exe'
if (-not (Test-Path $exe)) { throw "采集服务单文件未生成: $exe" }
Write-Host ("采集服务: {0:N1} MB" -f ((Get-Item $exe).Length / 1MB)) -ForegroundColor Green

# ---------- 1.5 复制服务到 light 的工作目录 ----------
# Tauri 的 WiX bundler 会 remove_dir_all(target/release/wix/x64) 再重建，所以不能把文件放在
# 该目录下。collector.wxs 的 File Source="..\..\NetPeek.Collector.exe" 相对 light 的 cwd
# (target/release/wix/x64) 解析到 target/release/，该目录不被清空，主二进制也在此。
$releaseDir = Join-Path $repo 'src\NetPeek.App\src-tauri\target\release'
Copy-Item $exe (Join-Path $releaseDir 'NetPeek.Collector.exe') -Force
Write-Host "服务已复制到 release 目录（fragment 相对路径解析点）: $releaseDir" -ForegroundColor Cyan

# ---------- 2. tauri build MSI ----------
Write-Host 'tauri build --bundles msi（首次会编译 release 版 Rust，较慢）...' -ForegroundColor Cyan
Push-Location (Join-Path $repo 'src\NetPeek.App')
try {
    & npm run build -- --bundles msi
    if ($LASTEXITCODE -ne 0) { throw 'tauri build 失败' }
}
finally { Pop-Location }

$msi = Get-ChildItem (Join-Path $repo 'src\NetPeek.App\src-tauri\target\release\bundle\msi\*.msi') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msi) { throw '未找到生成的 MSI' }
Write-Host ''
Write-Host ("MSI 生成完毕: {0} ({1:N1} MB)" -f $msi.FullName, ($msi.Length / 1MB)) -ForegroundColor Green
