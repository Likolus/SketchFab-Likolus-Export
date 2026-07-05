# run_any_fbx_validation.ps1 - validate any uploaded FBX in Blender
# Usage: run_any_fbx_validation.ps1 <fbxBasename>
# e.g. run_any_fbx_validation.ps1 _test_name_fix.fbx
$ErrorActionPreference = 'Continue'

$blender = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
$fbxName = $args[0]
if (-not $fbxName) { Write-Host 'ERROR: no fbx name arg'; exit 1 }
$fbxPath = $env:TEMP + '\ssh_bridge_' + $fbxName
$scriptPath = $env:TEMP + '\ssh_bridge_validate_fbx_in_blender.py'
$reportPath = $env:TEMP + '\' + $fbxName + '_report.json'

Write-Host '=== Running Blender headless validation ==='
Write-Host ('Blender : ' + $blender)
Write-Host ('FBX     : ' + $fbxPath)
Write-Host ('Script  : ' + $scriptPath)
Write-Host ('Report  : ' + $reportPath)
Write-Host ''

if (-not (Test-Path $fbxPath)) { Write-Host ('ERROR: FBX not found at ' + $fbxPath); exit 1 }
Write-Host ('FBX size: ' + (Get-Item $fbxPath).Length + ' bytes')
Write-Host ''

& $blender --background --python $scriptPath -- $fbxPath $reportPath

Write-Host ''
Write-Host ('=== Exit code: ' + $LASTEXITCODE + ' ===')

if (Test-Path $reportPath) {
    Write-Host ''
    Write-Host ('Report size: ' + (Get-Item $reportPath).Length + ' bytes')
    Write-Host '=== Report contents (full) ==='
    Get-Content $reportPath -Raw -Encoding UTF8
} else {
    Write-Host 'Report NOT created'
}
