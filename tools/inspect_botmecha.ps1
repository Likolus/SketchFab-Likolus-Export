# inspect_botmecha.ps1 - list contents of BOT MECHA Warrior export folder
$ErrorActionPreference = 'Continue'
$folder = 'C:\Users\Likolus\Desktop\BOT MECHA Warrior 3d by Oscar Creativo'

Write-Host '=== Folder contents ==='
Write-Host ('Path: ' + $folder)
Write-Host ''

if (-not (Test-Path $folder)) {
    Write-Host 'ERROR: folder does not exist'
    exit 1
}

Get-ChildItem -LiteralPath $folder -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($folder.Length).TrimStart('\')
    $size = if ($_.PSIsContainer) { '<DIR>' } else { $_.Length.ToString() }
    Write-Host ('{0,15}  {1}' -f $size, $rel)
}

Write-Host ''
Write-Host '=== FBX files (with size) ==='
Get-ChildItem -LiteralPath $folder -Filter '*.fbx' -Recurse | ForEach-Object {
    Write-Host ('FBX: ' + $_.FullName + '  size=' + $_.Length + ' bytes')
}

Write-Host ''
Write-Host '=== metadata.json (if present) ==='
$meta = Join-Path $folder 'metadata.json'
if (Test-Path $meta) {
    $c = Get-Content $meta -Raw -Encoding UTF8
    Write-Host ('Length: ' + $c.Length + ' chars')
    Write-Host $c
} else {
    Write-Host 'no metadata.json'
}

Write-Host ''
Write-Host '=== FBX header bytes (first 32 bytes of first fbx) ==='
$firstFbx = Get-ChildItem -LiteralPath $folder -Filter '*.fbx' -Recurse | Select-Object -First 1
if ($firstFbx) {
    $bytes = [System.IO.File]::ReadAllBytes($firstFbx.FullName)[0..31]
    $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ' '
    $ascii = -join ($bytes | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } })
    Write-Host ('HEX  : ' + $hex)
    Write-Host ('ASCII: ' + $ascii)
    # version is bytes 23-26 little endian
    if ($bytes.Length -ge 27) {
        $ver = $bytes[23] + ($bytes[24] -shl 8) + ($bytes[25] -shl 16) + ($bytes[26] -shl 24)
        Write-Host ('FBX version: ' + $ver)
    }
}
