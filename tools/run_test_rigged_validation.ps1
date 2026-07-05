# run_test_rigged_validation.ps1 - validate the locally-generated rigged test FBX in Blender
$ErrorActionPreference = 'Continue'

$blender = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
$fbxPath = $env:TEMP + '\ssh_bridge__test_rigged.fbx'
$scriptPath = $env:TEMP + '\ssh_bridge_validate_fbx_in_blender.py'
$reportPath = $env:TEMP + '\test_rigged_report.json'

Write-Host '=== Running Blender headless validation on RIGGED test FBX ==='
Write-Host ('Blender : ' + $blender)
Write-Host ('FBX     : ' + $fbxPath)
Write-Host ('Script  : ' + $scriptPath)
Write-Host ('Report  : ' + $reportPath)
Write-Host ''

if (-not (Test-Path $fbxPath)) { Write-Host ('ERROR: FBX not found at ' + $fbxPath); exit 1 }
$fbxSize = (Get-Item $fbxPath).Length
Write-Host ('FBX size: ' + $fbxSize + ' bytes')
Write-Host ''

& $blender --background --python $scriptPath -- $fbxPath $reportPath

Write-Host ''
Write-Host ('=== Exit code: ' + $LASTEXITCODE + ' ===')

if (Test-Path $reportPath) {
    Write-Host ''
    $size = (Get-Item $reportPath).Length
    Write-Host ('Report size: ' + $size + ' bytes')
    Write-Host '=== Report contents (full) ==='
    Get-Content $reportPath -Raw -Encoding UTF8
} else {
    Write-Host 'Report NOT created'
}
