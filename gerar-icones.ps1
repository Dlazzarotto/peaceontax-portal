# Gera os ícones do portal a partir de public/logo.png
# Rode na raiz do projeto:  powershell -ExecutionPolicy Bypass -File .\gerar-icones.ps1

Add-Type -AssemblyName System.Drawing

$origem = ".\public\logo.png"
if (-not (Test-Path $origem)) {
  Write-Host "Nao encontrei public\logo.png" -ForegroundColor Red
  exit 1
}

function Redimensionar($destino, $lado) {
  $img = [System.Drawing.Image]::FromFile((Resolve-Path $origem))
  $bmp = New-Object System.Drawing.Bitmap $lado, $lado
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::White)

  # Mantem a proporcao da logo, centralizada, com margem de 8%
  $margem = [int]($lado * 0.08)
  $area = $lado - (2 * $margem)
  $escala = [Math]::Min($area / $img.Width, $area / $img.Height)
  $w = [int]($img.Width * $escala)
  $h = [int]($img.Height * $escala)
  $x = [int](($lado - $w) / 2)
  $y = [int](($lado - $h) / 2)

  $g.DrawImage($img, $x, $y, $w, $h)
  $bmp.Save((Join-Path (Get-Location) $destino), [System.Drawing.Imaging.ImageFormat]::Png)

  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  $kb = [math]::Round((Get-Item $destino).Length / 1KB, 1)
  Write-Host ("  gerado {0} ({1} KB)" -f $destino, $kb) -ForegroundColor Green
}

Write-Host "Gerando icones a partir de public\logo.png..." -ForegroundColor Cyan
Redimensionar ".\public\icon-192.png" 192
Redimensionar ".\public\icon-512.png" 512
Redimensionar ".\app\icon.png" 192          # favicon da aba
Redimensionar ".\app\apple-icon.png" 180    # tela inicial do iPhone
Write-Host "Pronto." -ForegroundColor Cyan
