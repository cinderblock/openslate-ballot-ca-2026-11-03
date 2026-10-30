# Reads the text of a scanned PDF with Windows' built-in OCR (Windows.Media.Ocr).
#
#   powershell.exe -NoProfile -File scripts/lib/ocr-pdf.ps1 -Pdf <file.pdf> -Out <file.json>
#
# Windows PowerShell 5.1 only (PowerShell 7 can't load the WinRT types). Writes
# { engine, scale, pages: [{ page, width, height, lines: [{ text, x, y, w, h }] }] }
# with each line's box in pixels of the rendered page. Nothing is cleaned up here;
# the caller decides what is body text and what is a form.
param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][string]$Out,
  [double]$Scale = 3.0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction" })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait() | Out-Null
  $task.Result
}
function AwaitAction($op) { $task = $asAction.Invoke($null, @($op)); $task.Wait() | Out-Null }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Pdf).Path)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language "en-US"))
if (-not $engine) { throw "No en-US OCR engine installed" }
$max = [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension

$pages = @()
for ($n = 0; $n -lt $doc.PageCount; $n++) {
  $pg = $doc.GetPage($n)
  $scale = [Math]::Min($Scale, $max / [Math]::Max($pg.Size.Width, $pg.Size.Height))
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opts.DestinationWidth = [uint32]($pg.Size.Width * $scale)
  $opts.DestinationHeight = [uint32]($pg.Size.Height * $scale)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($pg.RenderToStreamAsync($stream, $opts))
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) {
    $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0; $y1 = 0
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      $x0 = [Math]::Min($x0, $r.X); $y0 = [Math]::Min($y0, $r.Y)
      $x1 = [Math]::Max($x1, $r.X + $r.Width); $y1 = [Math]::Max($y1, $r.Y + $r.Height)
    }
    $lines += [ordered]@{ text = $line.Text; x = [int]$x0; y = [int]$y0; w = [int]($x1 - $x0); h = [int]($y1 - $y0) }
  }
  $pages += [ordered]@{ page = $n + 1; width = [int]$decoder.PixelWidth; height = [int]$decoder.PixelHeight; lines = $lines }
  $stream.Dispose()
}
$json = [ordered]@{ engine = "Windows.Media.Ocr " + $engine.RecognizerLanguage.LanguageTag; scale = $Scale; pages = $pages } |
  ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
