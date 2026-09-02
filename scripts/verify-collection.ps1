# NetPeek 真机采集验证脚本
# 功能：以管理员身份启动采集服务，读取命名管道，打印实时分进程流量快照。
# 用法（任选其一）：
#   1) 在资源管理器中右键本文件 -> 使用 PowerShell 运行
#   2) 打开管理员 PowerShell 后执行：  powershell -ExecutionPolicy Bypass -File scripts\verify-collection.ps1

$ErrorActionPreference = 'Stop'

# ---------- 自提权 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '需要管理员权限，正在请求提升...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    exit
}

$repo    = Split-Path -Parent $PSScriptRoot
$exe     = Join-Path $repo 'src\NetPeek.Collector\bin\Debug\net8.0\NetPeek.Collector.exe'
$dotnet  = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'

# ---------- 构建 ----------
Write-Host '正在构建采集服务...' -ForegroundColor Cyan
& $dotnet build (Join-Path $repo 'NetPeek.sln') -v minimal
if ($LASTEXITCODE -ne 0) { throw '构建失败，请先排查编译错误。' }

# ---------- 启动采集服务（后台） ----------
Write-Host '启动采集服务（需管理员，ETW 会话才会开启）...' -ForegroundColor Cyan
$outLog = Join-Path $env:TEMP 'netpeek-collector.out.log'
$errLog = Join-Path $env:TEMP 'netpeek-collector.err.log'
$proc = Start-Process -FilePath $exe -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

$client = $null
$reader = $null
try {
    # ---------- 连接命名管道（最多等 20 秒，等待 dotnet 构建与服务启动） ----------
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
    Write-Host '已连接，打印 10 帧快照（每秒一帧）...' -ForegroundColor Green

    for ($n = 1; $n -le 10; $n++) {
        $len = $reader.ReadInt32()
        if ($len -le 0 -or $len -gt 16777216) { break }

        $bytes = $reader.ReadBytes($len)
        $snap  = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json

        Write-Host ''
        Write-Host ("[第 {0} 帧] 状态={1} 丢事件={2} 进程数={3}" -f $n, $snap.Status, $snap.EventsLost, $snap.Processes.Count)
        Write-Host ("  总下行 {0,10:N1} KB/s   总上行 {1,10:N1} KB/s" -f ($snap.TotalDownloadBytes / 1KB), ($snap.TotalUploadBytes / 1KB))

        $snap.Processes |
            Sort-Object { $_.DownloadTotal + $_.UploadTotal } -Descending |
            Select-Object -First 8 |
            ForEach-Object {
                Write-Host ("    {0,-24} PID {1,-6} 下 {2,8:N1} KB/s 上 {3,8:N1} KB/s" -f $_.Name, $_.Pid, ($_.DownloadBytes / 1KB), ($_.UploadBytes / 1KB))
            }
    }
}
finally {
    if ($reader) { $reader.Dispose() }
    if ($client) { $client.Dispose() }
    if ($proc -and -not $proc.HasExited) {
        Write-Host '停止采集服务...' -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
    }
}

Write-Host ''
Write-Host '验证完成。' -ForegroundColor Green
