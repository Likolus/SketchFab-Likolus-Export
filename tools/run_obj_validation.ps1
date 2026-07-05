# run_obj_validation.ps1 - run Blender headless validation on Travelling Cat.obj
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

$blender = "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"
$objPath = "C:\Users\Likolus\Desktop\Travelling Cat\Travelling Cat.obj"
$scriptPath = $args[0]
if (-not $scriptPath) { $scriptPath = "$env:TEMP\ssh_bridge_validate_obj_in_blender.py" }
$reportPath = "C:\Users\Likolus\Desktop\Travelling Cat\obj_report.json"

Write-Host "=== Running Blender headless validation ==="
Write-Host "Blender : $blender"
Write-Host "OBJ     : $objPath"
Write-Host "Script  : $scriptPath"
Write-Host "Report  : $reportPath"
Write-Host ""

# Blender needs the args after --, and paths with spaces must be quoted
# We pass the obj path and report path as the two args
& $blender --background --python $scriptPath -- $objPath $reportPath

Write-Host ""
Write-Host "=== Exit code: $LASTEXITCODE ==="

if (Test-Path $reportPath) {
    Write-Host ""
    Write-Host "=== Report contents ==="
    Get-Content $reportPath -Raw -Encoding UTF8
} else {
    Write-Host "Report NOT created"
}
