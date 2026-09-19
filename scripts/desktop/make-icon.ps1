# make-icon.ps1 — gera release/icon.ico (ícone do DeepsProxy)
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1 <pasta-release>
param([string]$OutDir)

Add-Type -AssemblyName System.Drawing

$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$outFile = Join-Path $OutDir 'icon.ico'

if (Test-Path $outFile) { Write-Host "icon.ico ja existe: $outFile"; exit 0 }

$size = 64
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Fundo: retângulo arredondado azul.
$rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 12
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point 0, 0),
    (New-Object System.Drawing.Point $size, $size),
    [System.Drawing.Color]::FromArgb(255, 74, 108, 247),
    [System.Drawing.Color]::FromArgb(255, 20, 40, 120))
$g.FillPath($brush, $path)

# Letras "DP" brancas.
$font = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$layout = New-Object System.Drawing.RectangleF 0, -2, $size, $size
$g.DrawString('DP', $font, [System.Drawing.Brushes]::White, $layout, $sf)

# Icon de 64x64.
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)

$fs = [System.IO.File]::Create($outFile)
$icon.Save($fs)
$fs.Close()

$g.Dispose(); $bmp.Dispose(); $icon.Dispose()
Write-Host "icon.ico gerado: $outFile"