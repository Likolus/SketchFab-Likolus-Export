# run_fbx_inspect.ps1 - run fbx_inspect.py on BOT MECHA FBX using system python
$ErrorActionPreference = 'Continue'
$fbxPath = 'C:\Users\Likolus\Desktop\BOT MECHA Warrior 3d by Oscar Creativo\BOT MECHA Warrior 3d by Oscar Creativo.fbx'
$scriptPath = $env:TEMP + '\ssh_bridge_fbx_inspect.py'

Write-Host '=== Running fbx_inspect.py on BOT MECHA FBX ==='
Write-Host ('FBX    : ' + $fbxPath)
Write-Host ('Script : ' + $scriptPath)
Write-Host ''

# Try system python (not Blender's)
& python $scriptPath $fbxPath
Write-Host ('=== Exit code: ' + $LASTEXITCODE + ' ===')
