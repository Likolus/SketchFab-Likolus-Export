# run_namefix_validation.ps1 - validate static name-fix test cube in Blender
$ErrorActionPreference = 'Continue'

$blender = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
$fbxPath = $env:TEMP + '\ssh_bridge__test_name_fix.fbx'
$scriptPath = $env:TEMP + '\ssh_bridge_validate_fbx_in_blender.py'
$reportPath = $env:TEMP + '\namefix_report.json'

Write-Host '=== Running Blender headless validation on STATIC name-fix test cube ==='
Write-Host ('FBX     : ' + $fbxPath)
Write-Host ''

if (-not (Test-Path $fbxPath)) { Write-Host ('ERROR: FBX not found at ' + $fbxPath); exit 1 }
Write-Host ('FBX size: ' + (Get-Item $fbxPath).Length + ' bytes')
Write-Host ''

& $blender --background --python $scriptPath -- $fbxPath $reportPath

Write-Host ''
Write-Host ('=== Exit code: ' + $LASTEXITCODE + ' ===')

if (Test-Path $reportPath) {
    Write-Host ''
    Write-Host '=== Report contents (full) ==='
    Get-Content $reportPath -Raw -Encoding UTF8
} else {
    Write-Host 'Report NOT created'
}
