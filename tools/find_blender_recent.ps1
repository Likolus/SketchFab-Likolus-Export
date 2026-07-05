# find_blender_recent.ps1 - find recently opened files via Blender's recent-files list
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== Blender recent files ==="
$blenderConfig = "$env:APPDATA\Blender Foundation\Blender\5.1"
if (Test-Path $blenderConfig) {
    Write-Host "Blender config dir: $blenderConfig"
    Get-ChildItem -Path $blenderConfig -Recurse -File | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200
    $recentFile = "$blenderConfig\recent-files.txt"
    if (Test-Path $recentFile) {
        Write-Host "=== Contents of recent-files.txt ==="
        Get-Content $recentFile
    } else {
        Write-Host "recent-files.txt NOT FOUND"
    }
    # Also check the .blend recovery autosave folder
    $autosave = "$blenderConfig\autosave"
    if (Test-Path $autosave) {
        Write-Host "=== Autosave folder ==="
        Get-ChildItem $autosave -File | Sort-Object LastWriteTime -Descending | Select-Object -First 10 FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200
    }
} else {
    Write-Host "Blender config dir NOT FOUND: $blenderConfig"
    Write-Host "Available Blender versions in APPDATA:"
    Get-ChildItem "$env:APPDATA\Blender Foundation\Blender" -ErrorAction SilentlyContinue | Select-Object Name, FullName
}

Write-Host ""
Write-Host "=== All .obj files on C: (depth 5, top 20 by date) ==="
Get-ChildItem -Path "C:\" -Filter *.obj -Recurse -File -Depth 5 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 20 FullName, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 300

Write-Host ""
Write-Host "=== All .fbx files on C: (depth 5, top 20 by date) ==="
Get-ChildItem -Path "C:\" -Filter *.fbx -Recurse -File -Depth 5 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 20 FullName, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 300

Write-Host ""
Write-Host "=== Process: is Blender running? ==="
Get-Process -Name "blender*" -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, Path, StartTime, MainWindowTitle |
    Format-List
