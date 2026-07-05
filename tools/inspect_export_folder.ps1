# inspect_export_folder.ps1 - inspect the exported model folder
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

$folder = "C:\Users\Likolus\Desktop\Travelling Cat"
Write-Host "=== Contents of: $folder ==="
Get-ChildItem -Path $folder -Recurse -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object FullName, @{N='SizeKB';E={[math]::Round($_.Length/1KB,2)}}, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 300

Write-Host ""
Write-Host "=== metadata.json (first 4000 chars) ==="
$meta = Join-Path $folder "metadata.json"
if (Test-Path $meta) {
    $content = Get-Content $meta -Raw -Encoding UTF8
    Write-Host "Total length: $($content.Length) chars"
    if ($content.Length -gt 4000) {
        Write-Host $content.Substring(0, 4000)
        Write-Host "...[truncated]..."
    } else {
        Write-Host $content
    }
} else {
    Write-Host "metadata.json NOT FOUND"
}

Write-Host ""
Write-Host "=== .fbx file header (first 64 bytes hex) ==="
$fbx = Get-ChildItem -Path $folder -Filter *.fbx -File | Select-Object -First 1
if ($fbx) {
    Write-Host "FBX file: $($fbx.FullName)"
    Write-Host "FBX size: $($fbx.Length) bytes"
    $stream = [System.IO.File]::OpenRead($fbx.FullName)
    $buf = New-Object byte[] 64
    $read = $stream.Read($buf, 0, 64)
    $stream.Close()
    $hex = ($buf | ForEach-Object { $_.ToString('x2') }) -join ' '
    Write-Host "First 64 bytes (hex): $hex"
    $ascii = ($buf | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } }) -join ''
    Write-Host "First 64 bytes (ascii): $ascii"
} else {
    Write-Host "No .fbx file found in folder"
}
