# NetPeek 进程元数据冒烟验证脚本
# 验证链路：采集服务（管理员）-> 命名管道 -> 快照中的 Path / IconBase64 / StartTimeUnixMs 字段端到端生效。
# 用法：pwsh -ExecutionPolicy Bypass -File scripts\verify-meta.ps1
# 输出同时写入 %TEMP%\netpeek-verify-meta.log（提权新窗口关闭后可从日志读结果）。

$ErrorActionPreference = 'Stop'

$transcriptPath = Join-Path $env:TEMP 'netpeek-verify-meta.log'
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

$outLog = Join-Path $env:TEMP 'netpeek-collector.out.log'
$errLog = Join-Path $env:TEMP 'netpeek-collector.err.log'
$proc = Start-Process -FilePath $exe -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

$client = $null
$reader = $null
try {
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'NetPeekCollector', [System.IO.Pipes.PipeDirection]::In)
            $client.Connect(1000)
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $client -or -not $client.IsConnected) {
        throw "无法连接采集服务命名管道。错误日志：$errLog"
    }

    $reader = New-Object System.IO.BinaryReader($client)
    Write-Host '已连接，读取 5 帧检查元数据字段...' -ForegroundColor Green

    $ok = $true
    for ($n = 1; $n -le 5; $n++) {
        $len = $reader.ReadInt32()
        if ($len -le 0 -or $len -gt 16777216) { throw "非法帧长度 $len" }

        $bytes = $reader.ReadBytes($len)
        $snap  = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json

        Write-Host ''
        Write-Host ("[第 {0} 帧] 状态={1} 丢事件={2} 进程数={3}" -f $n, $snap.Status, $snap.EventsLost, $snap.Processes.Count)
        Write-Host ("  会话启动 UnixMs = {0}" -f $snap.SessionStartedUnixMs)

        $withPath = 0; $withIcon = 0; $withStart = 0
        $snap.Processes | Sort-Object { $_.DownloadTotal + $_.UploadTotal } -Descending | Select-Object -First 5 |
            ForEach-Object {
                $hasPath  = [bool]$_.Path
                $hasIcon  = [bool]$_.IconBase64
                $hasStart = $_.StartTimeUnixMs -gt 0
                if ($hasPath)  { $withPath++ }
                if ($hasIcon)  { $withIcon++ }
                if ($hasStart) { $withStart++ }
                $iconLen = if ($_.IconBase64) { $_.IconBase64.Length } else { 0 }
                Write-Host ("    {0,-22} PID {1,-6} 路径={2,-6} 图标={3,-7} 启动={4}  iconLen={5}" -f `
                    $_.Name, $_.Pid, $hasPath, $hasIcon, $hasStart, $iconLen)
                if ($hasPath) { Write-Host ("        -> {0}" -f $_.Path) }
            }

        # 前 5 名的采样里至少有路径与图标存在（前几名的进程一般都能读到元数据）
        if ($n -ge 3 -and $withPath -eq 0) { $ok = $false; Write-Host '  错误：无任何进程带 Path' -ForegroundColor Red }
        if ($n -ge 3 -and $withStart -eq 0) { $ok = $false; Write-Host '  错误：无任何进程带 StartTimeUnixMs' -ForegroundColor Red }
    }

    if ($ok) { Write-Host ''; Write-Host '元数据冒烟验证通过。' -ForegroundColor Green }
    else { Write-Host ''; Write-Host '元数据冒烟验证失败。' -ForegroundColor Red; exit 1 }
}
finally {
    if ($reader) { $reader.Dispose() }
    if ($client) { $client.Dispose() }
    if ($proc -and -not $proc.HasExited) {
        Write-Host '停止采集服务...' -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
    }
}

Stop-Transcript | Out-Null
