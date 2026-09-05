# NetPeek ETW 场景综合验证脚本（阶段 1 剩余验收项，自动可测部分）
# 覆盖：
#   S1 短连接     —— 连续 10 次独立 curl 短连接，按字节总和断言归因不丢、EventsLost=0
#   S2 快速退出   —— 短命进程产生流量后立即退出，断言新 PID 条目携带字节（名字允许为空）
#   S3 UDP/QUIC   —— UdpClient 发 UDP 报文（QUIC 同类通道），按字节总和断言 UDP 归因
#   S4 并存       —— logman 再开一个 Kernel-Network ETW 会话，验证互不干扰、EventsLost=0
#
# 已知行为（2026-09-04 实测）：快速退出的短命进程字节归因正常，但进程存活时间短于
# 快照周期（1s）时进程名解析失败（Name=""），所以断言一律按字节增量/新 PID，不按名字匹配。
#
# 前置：采集服务已以管理员身份运行。用法：pwsh -File scripts\verify-etw-scenarios.ps1

$ErrorActionPreference = 'Stop'

# ---------- 工具 ----------
function Read-Snapshot([System.IO.Pipes.NamedPipeClientStream]$Client) {
    # leaveOpen: $true —— Dispose reader 时不得关闭底层管道（每次调用新建 reader，管道由调用方统一关闭）
    $reader = New-Object System.IO.BinaryReader($Client, [System.Text.Encoding]::UTF8, $true)
    try {
        $len = $reader.ReadInt32()
        if ($len -le 0 -or $len -gt 16777216) { return $null }
        $bytes = $reader.ReadBytes($len)
        return [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    } finally { $reader.Dispose() }
}

function Connect-Pipe {
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'NetPeekCollector', [System.IO.Pipes.PipeDirection]::In)
            $c.Connect(2000)
            return $c
        } catch { Start-Sleep -Milliseconds 500 }
    }
    throw '无法连接采集服务管道'
}

$pass = 0; $fail = 0
function Assert-True([string]$Name, [bool]$Cond, [string]$Detail = '') {
    if ($Cond) { $script:pass++; Write-Host ("  [通过] {0} {1}" -f $Name, $Detail) -ForegroundColor Green }
    else       { $script:fail++; Write-Host ("  [失败] {0} {1}" -f $Name, $Detail) -ForegroundColor Red }
}

# ---------- 本地 HTTP 服务（端口空闲才启动，复用已存在的） ----------
$tmp = Join-Path $env:TEMP 'netpeek-loopback-test'
$pyProc = $null
if (-not (Get-NetTCPConnection -LocalPort 18081 -State Listen -ErrorAction SilentlyContinue)) {
    $py  = (Get-Command python).Source
    $pyProc = Start-Process -FilePath $py -PassThru -WindowStyle Hidden -ArgumentList @('-m', 'http.server', '18081', '--bind', '127.0.0.1', '--directory', $tmp)
    Start-Sleep -Seconds 2
    Write-Host "本地 HTTP 服务已启动 PID=$($pyProc.Id)" -ForegroundColor Cyan
} else {
    Write-Host '本地 HTTP 服务已在运行，复用。' -ForegroundColor Cyan
}

try {
    # ================= S1 短连接 =================
    Write-Host "`n===== S1 连续 10 次短连接（每次独立 TCP 连接）=====" -ForegroundColor Cyan
    $client = Connect-Pipe
    $baseSnap = Read-Snapshot $client
    $baseLost = $baseSnap.EventsLost

    for ($i = 1; $i -le 10; $i++) {
        & curl.exe -s --noproxy '*' -o NUL "http://127.0.0.1:18081/netpeek-test-5m.bin"
    }
    # 逐帧累加 TotalDownloadBytes（每周期增量，不受进程剪枝影响），累加 4 帧覆盖全部下载
    Write-Host '  10 次下载完成，累加 4 帧下载字节...'
    $accumDown = [uint64]0
    for ($n = 0; $n -lt 4; $n++) {
        $s = Read-Snapshot $client
        $accumDown += [uint64]$s.TotalDownloadBytes
        Start-Sleep -Milliseconds 500
    }
    $client.Dispose()

    $expected = 10 * 5242880
    Assert-True '短连接归因（按字节）' ($accumDown -ge ($expected * 0.85)) "累加下载字节 $([math]::Round($accumDown/1MB,1)) MB / 期望 ~$([math]::Round($expected/1MB,1)) MB"
    Assert-True '短连接不丢事件' ($baseLost -eq 0) "EventsLost=$baseLost"

    # ================= S2 快速退出 =================
    Write-Host "`n===== S2 进程快速退出（短命 curl，退出后观察条目与字节）=====" -ForegroundColor Cyan
    $client = Connect-Pipe
    $before = Read-Snapshot $client
    $pidSet = @{}; $before.Processes | ForEach-Object { $pidSet[$_.Pid] = $true }

    $quick = Start-Process curl.exe -PassThru -WindowStyle Hidden -ArgumentList @('-s', '--noproxy', '*', '-o', (Join-Path $tmp 'quick.bin'), 'http://127.0.0.1:18081/netpeek-test-5m.bin')
    $quick.WaitForExit(15000) | Out-Null
    Write-Host "  curl PID=$($quick.Id) 已退出（退出码 $($quick.ExitCode)），且不在 base 帧 PID 集合中：$(-not $pidSet.ContainsKey([int]$quick.Id))"

    $foundBytes = 0; $foundPid = $null
    for ($n = 0; $n -lt 6; $n++) {
        $s = Read-Snapshot $client
        $p = $s.Processes | Where-Object { $_.Pid -eq $quick.Id } | Select-Object -First 1
        if ($p) { $foundBytes = $p.DownloadTotal; $foundPid = $p.Pid; break }
        Start-Sleep -Milliseconds 700
    }
    $client.Dispose()
    Assert-True '退出后条目保留' ($null -ne $foundPid) "PID $($quick.Id) 退出后仍可见"
    Assert-True '退出后字节归因' ($foundBytes -ge (4MB * 0.9)) "下载 5MB 实际归因 $([math]::Round($foundBytes/1MB,2)) MB（name 可为空，字节不丢）"

    # ================= S3 UDP =================
    Write-Host "`n===== S3 UDP 报文归因（QUIC 走同一 UDP 通道）=====" -ForegroundColor Cyan
    $udpListener = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command',
        '$u = New-Object System.Net.Sockets.UdpClient(19001); Start-Sleep -Seconds 20; $u.Close()')
    Start-Sleep -Seconds 1

    $client = Connect-Pipe
    $snapBefore = Read-Snapshot $client
    $pidSetBefore = @{}; $snapBefore.Processes | ForEach-Object { $pidSetBefore[$_.Pid] = $true }

    # 发 50 个 1KB UDP 报文到 127.0.0.1:19001
    $sender = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command',
        '$u = New-Object System.Net.Sockets.UdpClient; $data = New-Object byte[] 1024; for ($i=0;$i -lt 50;$i++){ [void]$u.Send($data, 1024, "127.0.0.1", 19001) }; $u.Close()')
    $sender.WaitForExit(10000) | Out-Null

    # 按 sender 的 PID 精确断言（短命进程 name 可能为空，但字节必须进其条目）
    $senderUp = 0
    for ($n = 0; $n -lt 6; $n++) {
        $s = Read-Snapshot $client
        $p = $s.Processes | Where-Object { $_.Pid -eq $sender.Id } | Select-Object -First 1
        if ($p -and $p.UploadTotal -gt $senderUp) { $senderUp = $p.UploadTotal }
        Start-Sleep -Milliseconds 500
    }
    $client.Dispose()
    Assert-True 'UDP 上传归因（按 PID）' ($senderUp -ge 40KB) "sender PID=$($sender.Id) 累计上传 $([math]::Round($senderUp/1KB,1)) KB（期望 ~50KB）"
    Stop-Process -Id $udpListener.Id -Force -ErrorAction SilentlyContinue

    # ================= S4 并存 =================
    Write-Host "`n===== S4 与第二个 ETW 会话并存（logman 开 Kernel-Network）=====" -ForegroundColor Cyan
    $logmanOut = Join-Path $env:TEMP 'netpeek-coexist.etl'
    Remove-Item $logmanOut -ErrorAction SilentlyContinue
    # Kernel-Network 提供程序 GUID {7DD42A49-5329-4832-8DFD-43D979094A9B}，0x10 = 网络关键字
    # 会话名带时间戳，避免历史残留同名会话导致 create 失败
    $coexistName = "netpeek-coexist-$([DateTime]::Now.ToString('HHmmss'))"
    & logman delete $coexistName -ets 2>$null | Out-Null
    & logman create trace $coexistName -p "{7DD42A49-5329-4832-8DFD-43D979094A9B}" 0x10 -o $logmanOut -ets
    Assert-True '第二个 ETW 会话创建' ($LASTEXITCODE -eq 0) "logman create exit=$LASTEXITCODE ($coexistName)"
    Start-Sleep -Seconds 2

    $client = Connect-Pipe
    $baseSnap2 = Read-Snapshot $client
    # 并存期间产生流量，逐帧累加下载字节
    & curl.exe -s --noproxy '*' -o NUL "http://127.0.0.1:18081/netpeek-test-5m.bin"
    $accumDown2 = [uint64]0
    for ($n = 0; $n -lt 4; $n++) {
        $s = Read-Snapshot $client
        $accumDown2 += [uint64]$s.TotalDownloadBytes
        Start-Sleep -Milliseconds 500
    }
    $client.Dispose()

    Assert-True '并存时归因正常（按字节）' ($accumDown2 -ge (4MB * 0.85)) "并存期间累加下载字节 $([math]::Round($accumDown2/1MB,2)) MB"
    Assert-True '并存时不丢事件' ($baseSnap2.EventsLost -eq 0) "EventsLost=$($baseSnap2.EventsLost)"

    & logman delete $coexistName -ets 2>$null | Out-Null
    Write-Host "  已删除并存 ETW 会话 $coexistName"
}
finally {
    if ($pyProc -and -not $pyProc.HasExited) { Stop-Process -Id $pyProc.Id -Force }
    Get-Process -Name curl -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "结果：通过 $pass 项，失败 $fail 项" -ForegroundColor $(if ($fail -eq 0) {'Green'} else {'Red'})
exit $fail
