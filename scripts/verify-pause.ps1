# NetPeek 暂停/恢复监控 端到端验证脚本
# 验证链路：UI 侧控制命令 -> 反向控制管道 -> 采集服务 Pause/Resume -> 快照 Status/速率变化。
# 用法：以管理员身份运行（ETW 需要权限）：
#   pwsh -ExecutionPolicy Bypass -File scripts\verify-pause.ps1

$ErrorActionPreference = 'Stop'

# 始终记录到文件，便于提权后从外部读取结果。
$transcriptPath = Join-Path $env:TEMP 'netpeek-verify-pause.log'
try { Stop-Transcript | Out-Null } catch {}
Start-Transcript -Path $transcriptPath -Force | Out-Null

# ---------- 自提权 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '需要管理员权限，正在请求提升...' -ForegroundColor Yellow
    Start-Process pwsh -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    exit
}

$repo = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $repo 'src\NetPeek.Collector\bin\Debug\net8.0-windows\NetPeek.Collector.exe'

if (-not (Test-Path $exe)) { throw "采集服务未构建：$exe" }

function Read-Frame([System.IO.BinaryReader]$reader) {
    $len = $reader.ReadInt32()
    if ($len -le 0 -or $len -gt 16777216) { throw "非法帧长度 $len" }
    $bytes = $reader.ReadBytes($len)
    return ([System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
}

function Send-Control([string]$command) {
    # 短连接：写入一行命令后立即断开。
    $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'NetPeekCollectorControl', [System.IO.Pipes.PipeDirection]::Out)
    $c.Connect(3000)
    $w = New-Object System.IO.StreamWriter($c)
    $w.AutoFlush = $true
    $w.WriteLine($command)
    Start-Sleep -Milliseconds 100
    $w.Dispose()
    $c.Dispose()
}

$outLog = Join-Path $env:TEMP 'netpeek-collector.out.log'
$errLog = Join-Path $env:TEMP 'netpeek-collector.err.log'

Write-Host '启动采集服务（需管理员，ETW 会话才会开启）...' -ForegroundColor Cyan
$proc = Start-Process -FilePath $exe -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

$client = $null
$reader = $null
$failed = $false

try {
    # ---------- 连接快照管道 ----------
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'NetPeekCollector', [System.IO.Pipes.PipeDirection]::In)
            $client.Connect(1000)
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $client -or -not $client.IsConnected) { throw "无法连接快照管道。错误日志：$errLog" }
    $reader = New-Object System.IO.BinaryReader($client)
    Write-Host '已连接快照管道。' -ForegroundColor Green

    # ---------- 阶段 1：基线（应 ok，通常有速率） ----------
    Write-Host "`n[1] 读取基线快照..." -ForegroundColor Cyan
    $base = Read-Frame $reader
    $base2 = Read-Frame $reader
    Write-Host ("    Status={0} 总下行={1:N1} KB/s 总上行={2:N1} KB/s 进程数={3}" -f $base2.Status, ($base2.TotalDownloadBytes/1KB), ($base2.TotalUploadBytes/1KB), $base2.Processes.Count)
    if ($base2.Status -ne 'ok') { throw "基线状态应为 ok，实际为 $($base2.Status)" }

    # ---------- 阶段 2：暂停 ----------
    Write-Host "`n[2] 发送 pause 命令..." -ForegroundColor Cyan
    Send-Control 'pause'
    $paused = $null
    for ($i = 0; $i -lt 5; $i++) {
        $s = Read-Frame $reader
        if ($s.Status -eq 'paused') { $paused = $s; break }
    }
    if (-not $paused) { throw "未在 5 帧内收到 paused 状态" }
    # 再读一帧确认速率归零、累计冻结
    $paused2 = Read-Frame $reader
    Write-Host ("    Status={0} 总下行={1:N1} KB/s 总上行={2:N1} KB/s" -f $paused2.Status, ($paused2.TotalDownloadBytes/1KB), ($paused2.TotalUploadBytes/1KB))
    if ($paused2.TotalDownloadBytes -ne 0 -or $paused2.TotalUploadBytes -ne 0) { throw "暂停后速率应为 0" }

    # 暂停期间累计值应冻结（两帧之间 DownloadTotal 之和不变）
    $sum1 = ($paused.Processes | Measure-Object -Property DownloadTotal -Sum).Sum
    $sum2 = ($paused2.Processes | Measure-Object -Property DownloadTotal -Sum).Sum
    Write-Host ("    累计下载合计 帧A={0} 帧B={1}（应相等=冻结）" -f $sum1, $sum2)
    if ($sum1 -ne $sum2) { throw "暂停期间累计值应冻结，但 $sum1 -> $sum2" }

    # ---------- 阶段 3：恢复 ----------
    Write-Host "`n[3] 发送 resume 命令..." -ForegroundColor Cyan
    Send-Control 'resume'
    $resumed = $null
    for ($i = 0; $i -lt 5; $i++) {
        $s = Read-Frame $reader
        if ($s.Status -eq 'ok') { $resumed = $s; break }
    }
    if (-not $resumed) { throw "未在 5 帧内恢复到 ok 状态" }
    Write-Host ("    Status={0} 总下行={1:N1} KB/s 总上行={2:N1} KB/s" -f $resumed.Status, ($resumed.TotalDownloadBytes/1KB), ($resumed.TotalUploadBytes/1KB))

    # ---------- 阶段 4：toggle（用真实 UI 命令） ----------
    Write-Host "`n[4] 发送 toggle 命令（UI 托盘使用的命令）..." -ForegroundColor Cyan
    Send-Control 'toggle'
    $t1 = $null
    for ($i = 0; $i -lt 5; $i++) { $s = Read-Frame $reader; if ($s.Status -eq 'paused') { $t1 = $s; break } }
    if (-not $t1) { throw "toggle 后应为 paused" }
    Write-Host "    toggle -> paused OK"
    Send-Control 'toggle'
    $t2 = $null
    for ($i = 0; $i -lt 5; $i++) { $s = Read-Frame $reader; if ($s.Status -eq 'ok') { $t2 = $s; break } }
    if (-not $t2) { throw "再次 toggle 后应恢复 ok" }
    Write-Host "    toggle -> ok OK"

    Write-Host "`n暂停/恢复监控 验证通过 ✔" -ForegroundColor Green
}
catch {
    $failed = $true
    Write-Host "`n验证失败：$_" -ForegroundColor Red
    if (Test-Path $outLog) { Write-Host "`n--- 采集服务 stdout（尾部） ---" -ForegroundColor Yellow; Get-Content $outLog -Tail 30 }
    if (Test-Path $errLog) { Write-Host "`n--- 采集服务 stderr（尾部） ---" -ForegroundColor Yellow; Get-Content $errLog -Tail 30 }
}
finally {
    if ($reader) { $reader.Dispose() }
    if ($client) { $client.Dispose() }
    if ($proc -and -not $proc.HasExited) {
        Write-Host '停止采集服务...' -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
    }
    Stop-Transcript | Out-Null
}

if ($failed) { exit 1 }
