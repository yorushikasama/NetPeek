# NetPeek 应用图标生成器：从设计原图产出全套资产。
# 用法：pwsh -NoProfile -File scripts\generate-icon.ps1 -Source <原图.png> [-SmallSource <小尺寸原图.png>]
# 产出（src/NetPeek.App/src-tauri/icons/）：
#   icon.ico     多尺寸：16/24/32/48/64/128/256（全部 PNG 压缩条目）
#   icon-32.png  托盘图标（lib.rs 编译期嵌入）
#   icon-128.png 打包清单用
#
# 尺寸依据微软官方指南（learn.microsoft.com/windows/apps/design/iconography/app-icon-construction）：
# 最少 16/24/32/48/256；这里补齐 64/128 让资源管理器与 Alt-Tab 的中间档不用插值。
#
# 双源策略：-SmallSource 提供 ≤48px 专用源（去光晕/回声、加粗描边）。任务栏与托盘
# 看的是 24/32 档，从 1024px 精细图直接缩放会糊——细描边和半透明光晕在 32px 下
# 只剩软边。不传 -SmallSource 时全部尺寸用 -Source（向后兼容）。
# 缩放统一走高质量双三次；透明边先裁掉再居中，内容占画布约 96%，避免"图标看起来很小"。

param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [string]$SmallSource
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$iconsDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\NetPeek.App\src-tauri\icons'

# ---- 1. 裁透明边 + 居中：找 alpha>8 的内容包围盒，取长边加 4% 边距 ----
function Get-CroppedContent([string]$path) {
    $src = New-Object System.Drawing.Bitmap($path)
    $left = $src.Width; $top = $src.Height; $right = -1; $bottom = -1
    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            if ($src.GetPixel($x, $y).A -gt 8) {
                if ($x -lt $left) { $left = $x }
                if ($x -gt $right) { $right = $x }
                if ($y -lt $top) { $top = $y }
                if ($y -gt $bottom) { $bottom = $y }
            }
        }
    }
    if ($right -lt 0) { throw "原图没有可见内容（全透明）：$path" }
    $contentW = $right - $left + 1
    $contentH = $bottom - $top + 1
    Write-Host ("内容包围盒：({0},{1}) {2}x{3}（原图 {4}x{5}，{6}）" -f $left, $top, $contentW, $contentH, $src.Width, $src.Height, (Split-Path -Leaf $path))

    $content = [Math]::Max($contentW, $contentH)
    $cropSize = [int][Math]::Ceiling($content * 1.04)
    $cropX = [int]($left + $contentW / 2 - $cropSize / 2)
    $cropY = [int]($top + $contentH / 2 - $cropSize / 2)
    $cropped = New-Object System.Drawing.Bitmap($cropSize, $cropSize)
    $g = [System.Drawing.Graphics]::FromImage($cropped)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $cropSize, $cropSize)),
        (New-Object System.Drawing.Rectangle($cropX, $cropY, $cropSize, $cropSize)),
        [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $src.Dispose()
    return ,$cropped
}

$large = Get-CroppedContent $Source
$small = $large
if ($SmallSource) {
    if (-not (Test-Path $SmallSource)) { throw "小尺寸原图不存在：$SmallSource" }
    $small = Get-CroppedContent $SmallSource
}

# ---- 2. 逐尺寸缩放：≤48 用小尺寸源（含托盘 32），≥64 用精细源 ----
function Resize-Icon([System.Drawing.Bitmap]$from, [int]$s) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($from, (New-Object System.Drawing.Rectangle(0, 0, $s, $s)))
    $g.Dispose()
    return $bmp
}

# 32px 放首层（Tauri 文档建议：开发期任务栏取首层显示）
$sizes = @(32, 24, 16, 48, 64, 128, 256)
$images = @{}
foreach ($s in $sizes) {
    $src = $(if ($s -le 48) { $small } else { $large })
    $images[$s] = Resize-Icon $src $s
}

$images[32].Save((Join-Path $iconsDir 'icon-32.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$images[128].Save((Join-Path $iconsDir 'icon-128.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# ---- 3. 手写 ICO：全部用 PNG 条目。手写 DIB 会被 rc.exe 以 RC2176 拒掉 ----
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)

$payloads = @()
foreach ($s in $sizes) {
    $pms = New-Object System.IO.MemoryStream
    $images[$s].Save($pms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $pms.ToArray()
    $pms.Dispose()
    $payloads += , $bytes
}

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$payloads[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $payloads[$i].Length
}
foreach ($p in $payloads) { $bw.Write($p) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $iconsDir 'icon.ico'), $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

# ---- 4. 预览图：把 16/32/48 三个小尺寸放大拼在一起供人工目检 ----
$prev = New-Object System.Drawing.Bitmap(300, 110)
$pg = [System.Drawing.Graphics]::FromImage($prev)
$pg.Clear([System.Drawing.Color]::FromArgb(255, 0x2a, 0x2f, 0x38))
$x = 10
foreach ($s in @(16, 32, 48)) {
    $pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $pg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $pg.DrawImage($images[$s], $x, 10, $s * 2, $s * 2)
    $x += $s * 2 + 20
}
$pg.Dispose()
$prev.Save((Join-Path $env:TEMP 'netpeek-icon-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$prev.Dispose()

foreach ($b in $images.Values) { $b.Dispose() }
$large.Dispose()
if ($small -ne $large) { $small.Dispose() }

Write-Host "已生成：icon.ico（$($sizes -join '/')）+ icon-32.png + icon-128.png"
Write-Host "小尺寸预览（2x 放大）：$env:TEMP\netpeek-icon-preview.png"
