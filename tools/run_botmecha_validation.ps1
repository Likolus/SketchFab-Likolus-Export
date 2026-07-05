# run_botmecha_validation.ps1 - run Blender headless validation on BOT MECHA Warrior FBX
# ASCII-only to avoid encoding issues
$ErrorActionPreference = 'Continue'

$blender = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
$fbxPath = 'C:\Users\Likolus\Desktop\BOT MECHA Warrior 3d by Oscar Creativo\BOT MECHA Warrior 3d by Oscar Creativo.fbx'
$scriptPath = $args[0]
if (-not $scriptPath) { $scriptPath = $env:TEMP + '\ssh_bridge_validate_fbx_in_blender.py' }
$reportPath = 'C:\Users\Likolus\Desktop\BOT MECHA Warrior 3d by Oscar Creativo\fbx_report.json'

Write-Host '=== Running Blender headless FBX validation ==='
Write-Host ('Blender : ' + $blender)
Write-Host ('FBX     : ' + $fbxPath)
Write-Host ('Script  : ' + $scriptPath)
Write-Host ('Report  : ' + $reportPath)
Write-Host ''

& $blender --background --python $scriptPath -- $fbxPath $reportPath

Write-Host ''
Write-Host ('=== Exit code: ' + $LASTEXITCODE + ' ===')

if (Test-Path $reportPath) {
    Write-Host ''
    Write-Host '=== Report file size ==='
    $size = (Get-Item $reportPath).Length
    Write-Host ('Report size: ' + $size + ' bytes')
    if ($size -lt 80000) {
        Write-Host '=== Report contents (full) ==='
        Get-Content $reportPath -Raw -Encoding UTF8
    } else {
        Write-Host '=== Report contents (first 60000 chars) ==='
        $c = Get-Content $reportPath -Raw -Encoding UTF8
        Write-Host $c.Substring(0, 60000)
        Write-Host '...[truncated]...'
    }
} else {
    Write-Host 'Report NOT created'
}
