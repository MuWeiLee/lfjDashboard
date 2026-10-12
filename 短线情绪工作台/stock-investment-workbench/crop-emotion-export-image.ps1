param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [int]$BottomPadding = 36,
  [int]$Tolerance = 10
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Bitmap]::FromFile($InputPath)
try {
  $samples = @(
    $source.GetPixel(0, $source.Height - 1),
    $source.GetPixel($source.Width - 1, $source.Height - 1),
    $source.GetPixel([Math]::Floor($source.Width / 2), $source.Height - 1)
  )
  $backgroundR = [int](($samples | Measure-Object -Property R -Average).Average)
  $backgroundG = [int](($samples | Measure-Object -Property G -Average).Average)
  $backgroundB = [int](($samples | Measure-Object -Property B -Average).Average)
  $lastContentRow = -1
  for ($y = $source.Height - 1; $y -ge 0 -and $lastContentRow -lt 0; $y--) {
    $differentPixels = 0
    for ($x = 0; $x -lt $source.Width; $x += 3) {
      $pixel = $source.GetPixel($x, $y)
      $difference = [Math]::Abs($pixel.R - $backgroundR) + [Math]::Abs($pixel.G - $backgroundG) + [Math]::Abs($pixel.B - $backgroundB)
      if ($difference -gt $Tolerance) {
        $differentPixels++
        if ($differentPixels -ge 3) { $lastContentRow = $y; break }
      }
    }
  }
  $height = if ($lastContentRow -ge 0) { [Math]::Min($source.Height, $lastContentRow + 1 + $BottomPadding) } else { $source.Height }
  $target = New-Object System.Drawing.Bitmap($source.Width, $height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($target)
    try {
      $graphics.Clear([System.Drawing.Color]::FromArgb($backgroundR, $backgroundG, $backgroundB))
      $sourceRect = New-Object System.Drawing.Rectangle(0, 0, $source.Width, $height)
      $graphics.DrawImage($source, $sourceRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $graphics.Dispose() }
    $target.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $target.Dispose() }
} finally { $source.Dispose() }
