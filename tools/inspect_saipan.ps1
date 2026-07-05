# inspect_saipan.ps1 - inspect the Saipan folder contents + metadata.json + FBX header
# ASCII-only to avoid encoding issues with Windows PowerShell
$ErrorActionPreference = 'Continue'

$folder = 'C:\Users\Likolus\Desktop\Saipan'
Write-Host '=== Contents of:' $folder '==='
if (-not (Test-Path $folder)) {
    Write-Host 'FOLDER NOT FOUND:' $folder
    Write-Host '=== Searching for any Saipan folder on C: ==='
    Get-ChildItem -Path 'C:\Users\Likolus\Desktop' -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'saipan' } |
        Select-Object FullName, LastWriteTime |
        Format-Table -AutoSize | Out-String -Width 250
    exit 0
}

Get-ChildItem -Path $folder -Recurse -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object FullName, @{N='SizeKB';E={[math]::Round($_.Length/1KB,2)}}, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 300

Write-Host ''
Write-Host '=== metadata.json (full) ==='
$meta = Join-Path $folder 'metadata.json'
if (Test-Path $meta) {
    $content = Get-Content $meta -Raw -Encoding UTF8
    Write-Host ('Total length: ' + $content.Length + ' chars')
    Write-Host $content
} else {
    Write-Host 'metadata.json NOT FOUND'
}

Write-Host ''
Write-Host '=== .fbx file header (first 64 bytes hex + ascii) ==='
$fbx = Get-ChildItem -Path $folder -Filter *.fbx -File | Select-Object -First 1
if ($fbx) {
    Write-Host ('FBX file: ' + $fbx.FullName)
    Write-Host ('FBX size: ' + $fbx.Length + ' bytes (' + [math]::Round($fbx.Length/1MB,2) + ' MB)')
    $stream = [System.IO.File]::OpenRead($fbx.FullName)
    $buf = New-Object byte[] 64
    $read = $stream.Read($buf, 0, 64)
    $stream.Close()
    $hex = ($buf | ForEach-Object { $_.ToString('x2') }) -join ' '
    Write-Host ('First 64 bytes (hex): ' + $hex)
    $ascii = ($buf | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } }) -join ''
    Write-Host ('First 64 bytes (ascii): ' + $ascii)
    if ($ascii.StartsWith('Kaydara FBX Binary')) {
        $ver = [BitConverter]::ToUInt32($buf, 23)
        Write-Host ('FBX binary version: ' + $ver + ' (7400 = 7.4, 7700 = 7.7, 7500 = 7.5)')
    } else {
        Write-Host 'WARNING: FBX does not start with Kaydara FBX Binary magic - may be ASCII FBX or not FBX at all'
    }
} else {
    Write-Host 'No .fbx file found in folder'
    Write-Host 'Looking for any file with fbx in name (case-insensitive):'
    Get-ChildItem -Path $folder -File | Where-Object { $_.Name -match 'fbx' } | Select-Object FullName, Length
}

Write-Host ''
Write-Host '=== .obj file info ==='
$obj = Get-ChildItem -Path $folder -Filter *.obj -File | Select-Object -First 1
if ($obj) {
    Write-Host ('OBJ file: ' + $obj.FullName + ', ' + $obj.Length + ' bytes')
}

Write-Host ''
Write-Host '=== Textures ==='
$texFolder = Join-Path $folder 'textures'
if (Test-Path $texFolder) {
    Get-ChildItem $texFolder -File | Select-Object Name, @{N='SizeKB';E={[math]::Round($_.Length/1KB,2)}} | Format-Table -AutoSize | Out-String -Width 200
}
