param(
    [Parameter(Mandatory = $true)][string]$InputManifest,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [switch]$ValidateOnly
)

# 僅呼叫已安裝的 Windows OCR，禁止下載模型或傳送影像至遠端。
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw '請使用 Windows PowerShell 5.1 執行本機 OCR。' }

function Get-LocalPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.StartsWith('\\') -or $Value.StartsWith('//')) { throw '只接受本機路徑。' }
    $full = [IO.Path]::GetFullPath($Value)
    $components = New-Object 'System.Collections.Generic.List[string]'
    $current = $full
    while (-not [string]::IsNullOrEmpty($current)) {
        $components.Insert(0, $current)
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    foreach ($component in $components) {
        try { $attributes = [IO.File]::GetAttributes($component) }
        catch [IO.FileNotFoundException] { continue }
        catch [IO.DirectoryNotFoundException] { continue }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '路徑含連結或重新解析點，已停止。' }
    }
    return $full
}

function Test-WithinPath([string]$Root, [string]$Candidate) {
    return $Candidate.StartsWith($Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NewOutput([string]$Value, [string]$Root, [string]$RunDirectory) {
    $full = Get-LocalPath $Value
    if (-not (Test-WithinPath $Root $full) -or [IO.Path]::GetExtension($full) -ine '.json' -or [IO.Path]::GetDirectoryName($full) -ine $RunDirectory) { throw '輸出必須位於同一私人執行目錄且為 JSON。' }
    if ([IO.File]::Exists($full) -or [IO.Directory]::Exists($full)) { throw '輸出已存在，拒絕覆寫。' }
    return $full
}

function Assert-Integer($Value, [int]$Minimum, [int]$Maximum) {
    if ($Value -isnot [ValueType] -or $Value -is [bool] -or [double]::IsNaN([double]$Value) -or [math]::Floor([double]$Value) -ne [double]$Value -or $Value -lt $Minimum -or $Value -gt $Maximum) { throw '圖片或變體數值無效。' }
}

function Get-Sha256([string]$Filename) {
    $stream = [IO.File]::OpenRead($Filename)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Convert-OcrBounds($Rectangle, [double]$Scale, [double]$OffsetX, [double]$OffsetY) {
    # 輸出仍為放大座標；下游除以 scale 後即還原成原圖座標。
    return @{ x = $Rectangle.X + $OffsetX * $Scale; y = $Rectangle.Y + $OffsetY * $Scale; width = $Rectangle.Width; height = $Rectangle.Height }
}

$privateRoot = Get-LocalPath (Join-Path $PSScriptRoot '..\private-fixtures')
$manifestPath = Get-LocalPath $InputManifest
if (-not (Test-WithinPath $privateRoot $manifestPath) -or [IO.Path]::GetExtension($manifestPath) -ine '.json' -or -not [IO.File]::Exists($manifestPath)) { throw '清單必須是私人目錄內的 JSON。' }
if ((Get-Item -LiteralPath $manifestPath).Length -gt 10MB) { throw '清單超過 10 MB。' }
$runDirectory = [IO.Path]::GetDirectoryName($manifestPath)
$resolvedOutput = Assert-NewOutput $OutputPath $privateRoot $runDirectory
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $manifest.images -or @($manifest.images).Count -lt 1 -or @($manifest.images).Count -gt 100) { throw '需要 1 至 100 張圖片。' }
$seenIds = @{}
foreach ($inputImage in $manifest.images) {
    Assert-Integer $inputImage.width 1 4000
    Assert-Integer $inputImage.height 1 4000
    if ($inputImage.sha256 -isnot [string] -or $inputImage.sha256 -notmatch '^[a-f0-9]{64}$' -or $inputImage.assetId -cne ('image-' + $inputImage.sha256.Substring(0, 20))) { throw '圖片雜湊或識別碼無效。' }
    if ($seenIds.ContainsKey($inputImage.assetId)) { throw '圖片識別碼重複。' }
    $seenIds[$inputImage.assetId] = $true
    $sourcePath = Get-LocalPath $inputImage.sourcePath
    if (-not (Test-WithinPath $runDirectory $sourcePath) -or -not [IO.File]::Exists($sourcePath) -or (Get-Item -LiteralPath $sourcePath).Length -gt 20MB) { throw '來源快照必須位於本次私人執行目錄。' }
    if ((Get-Sha256 $sourcePath) -cne $inputImage.sha256) { throw '來源快照雜湊不符。' }
    if ($null -eq $inputImage.variants -or @($inputImage.variants).Count -lt 1 -or @($inputImage.variants).Count -gt 4) { throw '變體清單無效。' }
    $seenVariants = @{}
    foreach ($variant in $inputImage.variants) {
        if ($variant.name -notin @('original', 'upscale2', 'invert2', 'namecolumn2') -or $seenVariants.ContainsKey($variant.name)) { throw '變體名稱不支援或重複。' }
        $seenVariants[$variant.name] = $true
        $expectedScale = 2; $expectedX = 0; $expectedY = 0
        if ($variant.name -eq 'original') { $expectedScale = 1 }
        if ($variant.name -eq 'namecolumn2') {
            if ($inputImage.width -ne 589 -or $inputImage.height -ne 1280) { throw '姓名裁切只支援已定義版型。' }
            $expectedX = 104; $expectedY = 258
        }
        $offsetX = 0; $offsetY = 0
        if ($null -ne $variant.offsetX) { $offsetX = $variant.offsetX }
        if ($null -ne $variant.offsetY) { $offsetY = $variant.offsetY }
        Assert-Integer $variant.scale 1 2
        Assert-Integer $offsetX 0 4000
        Assert-Integer $offsetY 0 4000
        if ($variant.scale -ne $expectedScale -or $offsetX -ne $expectedX -or $offsetY -ne $expectedY) { throw '變體縮放或裁切位移不符。' }
        $variantPath = Get-LocalPath $variant.path
        if (-not (Test-WithinPath $runDirectory $variantPath) -or -not [IO.File]::Exists($variantPath)) { throw '變體必須位於本次私人執行目錄。' }
        if ($variant.name -eq 'original' -and $variantPath -ine $sourcePath) { throw '原始變體必須使用已驗證的來源快照。' }
    }
}
if ($ValidateOnly) { Write-Output '離線檔案與變體檢查通過；未執行 OCR。'; return }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Wait-WinRt([object]$Operation, [type]$ResultType) {
    $task = $taskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    try { $completed = $task.Wait(60000) }
    catch { throw ('Windows OCR 步驟 ' + $ResultType.Name + ' 失敗：' + $_.Exception.GetBaseException().Message) }
    if (-not $completed) { throw '單張圖片 OCR 超過 60 秒，已停止。' }
    return $task.Result
}

$language = New-Object Windows.Globalization.Language('zh-Hant-TW')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) { throw '未安裝 zh-Hant-TW Windows OCR 語言包；未下載或改動系統設定。' }
$images = @()
foreach ($inputImage in $manifest.images) {
    $variants = @()
    foreach ($variant in $inputImage.variants) {
        $stream = $null
        $fileStream = $null
        $bitmap = $null
        $timer = [Diagnostics.Stopwatch]::StartNew()
        try {
            # 只讀取本次私人執行目錄的快照或衍生檔。
            $checkedVariant = Get-LocalPath $variant.path
            if (-not (Test-WithinPath $runDirectory $checkedVariant)) { throw '變體路徑已改變。' }
            $fileStream = [IO.File]::OpenRead($checkedVariant)
            $stream = [IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fileStream)
            $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $expectedWidth = $inputImage.width * $variant.scale
            $expectedHeight = $inputImage.height * $variant.scale
            if ($variant.name -eq 'namecolumn2') { $expectedWidth = 282; $expectedHeight = 1958 }
            if ($bitmap.PixelWidth -ne $expectedWidth -or $bitmap.PixelHeight -ne $expectedHeight) { throw '變體實際尺寸與清單不符。' }
            if ($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
                throw '圖片超過 Windows OCR 可處理尺寸。'
            }
            $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @()
            foreach ($line in $result.Lines) {
                $words = @()
                foreach ($word in $line.Words) {
                    $rect = $word.BoundingRect
                    $words += @{ text = $word.Text; bounds = (Convert-OcrBounds $rect $variant.scale $variant.offsetX $variant.offsetY) }
                }
                $lines += @{ text = $line.Text; words = @($words) }
            }
            $timer.Stop()
            $variants += @{ name = $variant.name; scale = $variant.scale; elapsedMs = $timer.ElapsedMilliseconds; lines = @($lines) }
        }
        finally {
            if ($null -ne $bitmap) { $bitmap.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
            if ($null -ne $fileStream) { $fileStream.Dispose() }
        }
    }
    $images += @{ assetId = $inputImage.assetId; sha256 = $inputImage.sha256; label = $inputImage.label; width = $inputImage.width; height = $inputImage.height; variants = @($variants) }
}
$output = @{
    format = 'arknights-local-ocr'; schemaVersion = 1; createdAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');
    engine = @{ name = 'Windows.Media.Ocr'; language = 'zh-Hant-TW'; version = [Environment]::OSVersion.Version.ToString() };
    images = @($images)
}
$json = $output | ConvertTo-Json -Depth 20
$resolvedOutput = Assert-NewOutput $resolvedOutput $privateRoot $runDirectory
$outputStream = [IO.File]::Open($resolvedOutput, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
    $outputStream.Write($bytes, 0, $bytes.Length)
} finally { $outputStream.Dispose() }
Write-Output ('已完成本機 OCR：' + $images.Count + ' 張；原始文字只寫入私有結果檔。')
