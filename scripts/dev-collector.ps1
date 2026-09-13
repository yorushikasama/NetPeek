<#
NetPeek 采集服务开发态启动脚本。

为什么需要它：采集服务必须以管理员身份运行（ETW 会话开不起来就没有任何数据），
而 UI 是普通权限。开发时手工来回 build + Start-Process -Verb RunAs + 猜「到底起没起」
每天要重复十几次，还经常留下上一次的僵尸实例把命名管道占住。

用法（普通权限窗口即可，只有启动/停止那一步会弹 UAC）：
  pwsh -ExecutionPolicy Bypass -File scripts\dev-collector.ps1              # 构建并（重）启动
  pwsh -ExecutionPolicy Bypass -File scripts\dev-collector.ps1 -NoBuild     # 跳过构建，直接重启
  pwsh -ExecutionPolicy Bypass -File scripts\dev-collector.ps1 -Status      # 只看状态
  pwsh -ExecutionPolicy Bypass -File scripts\dev-collector.ps1 -Tail        # 启动后跟随日志
  pwsh -ExecutionPolicy Bypass -File scripts\dev-collector.ps1 -Stop        # 只停止
  pwsh -ExecutionPolicy Bypass -File scripts\dev-collector.ps1 -Release     # 用 Release 产物
#>
[CmdletBinding(DefaultParameterSetName = 'Start')]
param(
    # 跳过 dotnet build，直接用现有产物启动（只改了 UI/Rust 侧时省几秒）。
    [Parameter(ParameterSetName = 'Start')]
    [switch]$NoBuild,

    # 启动后在当前窗口跟随 collector.log，Ctrl+C 退出跟随（服务继续在后台跑）。
    [Parameter(ParameterSetName = 'Start')]
    [switch]$Tail,

    # 使用 Release 配置的产物。
    [Parameter(ParameterSetName = 'Start')]
    [switch]$Release,

    # 只停止正在运行的采集服务实例，不构建不启动。
    [Parameter(ParameterSetName = 'Stop')]
    [switch]$Stop,

    # 只报告当前状态（进程 / 管道 / 日志尾部），不做任何改动。
    [Parameter(ParameterSetName = 'Status')]
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

$ProcessName  = 'NetPeek.Collector'
$PipeName     = 'NetPeekCollector'          # 与 IpcConstants.PipeName 一致
$ControlPipe  = 'NetPeekCollectorControl'   # 与 IpcConstants.ControlPipeName 一致
$Repo         = Split-Path -Parent $PSScriptRoot
$Configuration = if ($Release) { 'Release' } else { 'Debug' }
$Exe          = Join-Path $Repo "src\NetPeek.Collector\bin\$Configuration\net8.0-windows\NetPeek.Collector.exe"
$LogPath      = Join-Path $env:ProgramData 'NetPeek\collector.log'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok  ([string]$text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "    $text" -ForegroundColor Yellow }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-CollectorProcesses {
    # 服务实例可能以 LocalSystem 身份跑，普通权限下 Get-Process 仍能列出名字与 PID。
    @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
}

function Test-Pipe([string]$name) {
    # 命名管道在 Win32 里表现为 \\.\pipe\ 命名空间下的一个「文件」，
    # 枚举它比试探性 Connect 更轻，也不会打断服务端的 WaitForConnection。
    try {
        return [System.IO.Directory]::GetFiles('\\.\pipe\') -contains "\\.\pipe\$name"
    } catch {
        return $false
    }
}

function Stop-Collector {
    $procs = Get-CollectorProcesses
    if ($procs.Count -eq 0) {
        Write-Ok '没有正在运行的实例。'
        return
    }

    $pids = $procs.Id -join ', '
    Write-Step "停止已有实例（PID $pids）"

    if (Test-Admin) {
        $procs | Stop-Process -Force
    } else {
        # 目标进程是提权/LocalSystem 的，普通令牌杀不掉，只能借一次 UAC 跑 taskkill。
        $killArgs = @('/F') + ($procs.Id | ForEach-Object { '/PID'; "$_" })
        $kill = Start-Process -FilePath 'taskkill.exe' -ArgumentList $killArgs `
            -Verb RunAs -WindowStyle Hidden -PassThru -Wait
        if ($kill.ExitCode -ne 0) {
            throw "taskkill 失败（ExitCode=$($kill.ExitCode)），请手动结束 PID $pids。"
        }
    }

    # 端口/管道释放不是瞬时的，等到进程真的消失再返回，否则下一步启动会撞上
    # 「管道名已被占用」而退化成一个不对外服务的空壳进程。
    for ($i = 0; $i -lt 40; $i++) {
        if ((Get-CollectorProcesses).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    if ((Get-CollectorProcesses).Count -ne 0) {
        throw '旧实例未能在 10 秒内退出，请手动处理后重试。'
    }
    Write-Ok '已停止。'
}

function Show-Status {
    $procs = Get-CollectorProcesses
    Write-Step '当前状态'
    if ($procs.Count -eq 0) {
        Write-Warn2 '进程：未运行'
    } else {
        foreach ($p in $procs) {
            $since = try { $p.StartTime.ToString('HH:mm:ss') } catch { '未知' }
            Write-Ok "进程：PID $($p.Id)  启动于 $since"
        }
    }

    $snap = Test-Pipe $PipeName
    $ctrl = Test-Pipe $ControlPipe
    if ($snap) { Write-Ok "快照管道：\\.\pipe\$PipeName 就绪" }
    else       { Write-Warn2 "快照管道：\\.\pipe\$PipeName 不存在" }
    if ($ctrl) { Write-Ok "控制管道：\\.\pipe\$ControlPipe 就绪" }
    else       { Write-Warn2 "控制管道：\\.\pipe\$ControlPipe 不存在" }

    if (Test-Path $LogPath) {
        Write-Host ''
        Write-Host "--- $LogPath 末尾 15 行 ---" -ForegroundColor DarkGray
        Get-Content -Path $LogPath -Tail 15 -Encoding UTF8
    } else {
        Write-Warn2 "日志：$LogPath 尚未生成"
    }
}

# ---------------- 只看状态 ----------------
if ($Status) {
    Show-Status
    return
}

# ---------------- 只停止 ----------------
if ($Stop) {
    Stop-Collector
    return
}

# ---------------- 构建 ----------------
if (-not $NoBuild) {
    Write-Step "构建采集服务（$Configuration）"
    $csproj = Join-Path $Repo 'src\NetPeek.Collector\NetPeek.Collector.csproj'
    & dotnet build $csproj -c $Configuration -v minimal --nologo
    if ($LASTEXITCODE -ne 0) { throw '构建失败，先修编译错误。' }
    Write-Ok '构建完成。'
}

if (-not (Test-Path $Exe)) {
    throw "找不到产物：$Exe`n先去掉 -NoBuild 跑一次构建。"
}

# ---------------- 重启 ----------------
Stop-Collector

Write-Step '启动采集服务（会弹 UAC；ETW 会话必须管理员）'
# 工作目录设到产物目录，appsettings.json 与 Development 覆盖文件才能被 Host 找到。
$startArgs = @{
    FilePath         = $Exe
    WorkingDirectory = Split-Path -Parent $Exe
    WindowStyle      = 'Hidden'
}
if (-not (Test-Admin)) { $startArgs['Verb'] = 'RunAs' }
# 提权启动拿不到 PassThru 的可靠 PID（UAC 是另一个会话在创建进程），
# 所以不依赖返回值，统一用「管道是否出现」判断启动成功。
Start-Process @startArgs | Out-Null

Write-Step '等待命名管道就绪'
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if ((Test-Pipe $PipeName) -and (Test-Pipe $ControlPipe)) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
}

if (-not $ready) {
    Write-Warn2 '15 秒内没等到管道。常见原因：UAC 被拒绝、ETW 会话启动失败。'
    Show-Status
    throw '采集服务启动未确认。'
}

$procs = Get-CollectorProcesses
Write-Ok "已就绪：PID $($procs.Id -join ', ')"
Write-Ok "日志：$LogPath"
Write-Host ''
Write-Host '下一步：' -ForegroundColor DarkGray
Write-Host '  UI      cd src/NetPeek.App && npm run dev' -ForegroundColor DarkGray
Write-Host '  抽帧看  pwsh -ExecutionPolicy Bypass -File scripts\verify-collection.ps1' -ForegroundColor DarkGray
Write-Host '  停服务  pwsh -ExecutionPolicy Bypass -File scripts\dev-collector.ps1 -Stop' -ForegroundColor DarkGray

if ($Tail) {
    Write-Host ''
    Write-Host "--- 跟随 $LogPath（Ctrl+C 退出跟随，服务继续运行）---" -ForegroundColor DarkGray
    Get-Content -Path $LogPath -Tail 20 -Wait -Encoding UTF8
}
