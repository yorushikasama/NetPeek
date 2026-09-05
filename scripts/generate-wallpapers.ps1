# NetPeek 内置壁纸生成器（占位图：深色抽象渐变，适配浮岛文字可读性）。
# 用法：pwsh -NoProfile -File scripts\generate-wallpapers.ps1
# 产出：src/NetPeek.App/ui/wallpapers/wall-{1,2,3}.jpg（1920x1080，各一两百 KB）
#
# 设计约束：大面积压暗（浮岛上的文字对比度按岛屿底色保证，但底图过亮会毁观感）、
# 语义色点缀（琥珀/钢蓝取自 §1.2）、无具象内容（不抢 UI）。正式壁纸可直接替换同名文件。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\NetPeek.App\ui\wallpapers'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Wallpaper([string]$name, [string]$baseTop, [string]$baseBottom,
                       [string]$glowA, [string]$glowB, [int]$ax, [int]$ay, [int]$bx, [int]$by) {
    $w = 1920; $h = 1080
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'

    # 底：垂直渐变
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $base = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect, [System.Drawing.ColorTranslator]::FromHtml($baseTop),
        [System.Drawing.ColorTranslator]::FromHtml($baseBottom), 90)
    $g.FillRectangle($base, $rect)

    # 两团大光晕：中心色低 alpha → 透明。PathGradientBrush 做柔和辉光。
    foreach ($glow in @(@($glowA, $ax, $ay, 900), @($glowB, $bx, $by, 760))) {
        $color = [System.Drawing.ColorTranslator]::FromHtml($glow[0])
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddEllipse([int]($glow[1] - $glow[3]), [int]($glow[2] - $glow[3]), [int](2 * $glow[3]), [int](2 * $glow[3]))
        $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
        $pgb.CenterColor = [System.Drawing.Color]::FromArgb(46, $color.R, $color.G, $color.B)
        $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $color.R, $color.G, $color.B))
        $g.FillPath($pgb, $path)
        $pgb.Dispose(); $path.Dispose()
    }

    # 暗角：四边压暗，中央留亮
    $vignette = New-Object System.Drawing.Drawing2D.GraphicsPath
    $vignette.AddRectangle((New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
    $vgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($vignette)
    $vgb.CenterColor = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
    $vgb.SurroundColors = @([System.Drawing.Color]::FromArgb(140, 0, 0, 0))
    $g.FillPath($vgb, $vignette)
    $vgb.Dispose(); $vignette.Dispose()

    # 细噪点：模拟胶片颗粒，避免大面积渐变出现色带
    $rand = New-Object System.Random(42)
    for ($i = 0; $i -lt 9000; $i++) {
        $x = $rand.Next($w); $y = $rand.Next($h)
        $v = $rand.Next(18)
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(10, 255, 255, 255))
        $g.DrawRectangle($pen, $x, $y, 1, 1)
        $pen.Dispose()
    }

    $base.Dispose(); $g.Dispose()
    $jpgPath = Join-Path $outDir "$name.jpg"
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
    $bmp.Save($jpgPath, $codec, $params)
    $bmp.Dispose()
    Write-Host "已生成 $jpgPath"
}

# 1 熔金暮色：暖黑底 + 琥珀主光晕（左下）+ 钢蓝回声（右上）——与默认主题同族
New-Wallpaper 'wall-1' '#1c1510' '#0b0907' '#f0913f' '#7fa8c9' 480 820 1560 220
# 2 钢蓝深海：冷调，上传蓝为主光
New-Wallpaper 'wall-2' '#10151b' '#080a0d' '#7fa8c9' '#f0913f' 1500 780 380 240
# 3 石墨：中性灰阶，光晕极弱，最百搭
New-Wallpaper 'wall-3' '#191a1c' '#0d0e10' '#8a8f96' '#5a5e64' 960 540 300 900
Write-Host '内置壁纸生成完毕。'
