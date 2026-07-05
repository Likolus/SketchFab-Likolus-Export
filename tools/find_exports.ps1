# find_exports.ps1 - find recently exported FBX/OBJ/ZIP files on the work machine
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

$searchRoots = @(
    "$env:USERPROFILE\Downloads",
    "$env:USERPROFILE\Desktop",
    "$env:USERPROFILE\Documents",
    "C:\Users\Public",
    "D:\",
    "E:\"
)

Write-Host "=== Searching for FBX / OBJ / ZIP files (top 30 by date) ==="
$results = foreach ($root in $searchRoots) {
    if (Test-Path $root) {
        Get-ChildItem -Path $root -Include *.fbx,*.obj,*.zip -Recurse -File -Depth 4 |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 30
    }
}

$results | Sort-Object LastWriteTime -Descending |
    Select-Object -First 30 FullName, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 250

Write-Host ""
Write-Host "=== Blender installations ==="
Get-ChildItem -Path "C:\Program Files\Blender Foundation","C:\Program Files (x86)\Blender Foundation" -Filter blender.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName

Write-Host ""
Write-Host "=== Tampermonkey / browser profile check (looking for SketchFab export folder) ==="
$browserPaths = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default",
    "$env:APPDATA\Mozilla\Firefox\Profiles"
)
foreach ($bp in $browserPaths) {
    if (Test-Path $bp) {
        Write-Host "Browser profile exists: $bp"
    }
}

Write-Host ""
Write-Host "=== Looking for any folder named *sketchfab* or *likolus* or *export* ==="
Get-ChildItem -Path "C:\Users\Likolus" -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'sketch|likolus|export|mig|aircraft|model' } |
    Select-Object FullName, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 250
