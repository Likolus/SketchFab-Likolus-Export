# inspect_botmecha_deep.ps1 - deep inspection of BOT MECHA export
$ErrorActionPreference = 'Continue'
$folder = 'C:\Users\Likolus\Desktop\BOT MECHA Warrior 3d by Oscar Creativo'
$meta = Join-Path $folder 'metadata.json'
$fbx = Join-Path $folder 'BOT MECHA Warrior 3d by Oscar Creativo.fbx'

Write-Host '=== metadata.json (full) ==='
Get-Content $meta -Raw -Encoding UTF8

Write-Host ''
Write-Host '=== FBX file info ==='
$fi = Get-Item $fbx
Write-Host ('Size: ' + $fi.Length + ' bytes')
Write-Host ('Modified: ' + $fi.LastWriteTime)
$bytes = [System.IO.File]::ReadAllBytes($fbx)[0..30]
$hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ' '
Write-Host ('Header hex: ' + $hex)
$ver = $bytes[23] + ($bytes[24] -shl 8) + ($bytes[25] -shl 16) + ($bytes[26] -shl 24)
Write-Host ('FBX version: ' + $ver)
