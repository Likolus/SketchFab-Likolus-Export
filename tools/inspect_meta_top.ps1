# inspect_meta_top.ps1 - show top-level keys of metadata.json + rig/animation presence
$ErrorActionPreference = 'Continue'
$meta = 'C:\Users\Likolus\Desktop\BOT MECHA Warrior 3d by Oscar Creativo\metadata.json'
$c = Get-Content $meta -Raw -Encoding UTF8
Write-Host ('Total length: ' + $c.Length + ' chars')
Write-Host '=== First 2500 chars ==='
Write-Host $c.Substring(0, [Math]::Min(2500, $c.Length))
Write-Host ''
Write-Host '=== Search for rig/anim/skeleton/bone keywords ==='
$lines = $c -split "`n"
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match 'rig|anim|skeleton|bone|joint|skin|deform|armature') {
        Write-Host ('L' + $i + ': ' + $lines[$i].Trim())
    }
}
Write-Host ''
Write-Host '=== Top-level JSON keys ==='
try {
    $j = $c | ConvertFrom-Json
    $j.PSObject.Properties | ForEach-Object { Write-Host (' - ' + $_.Name) }
    if ($j.fbxStats) {
        Write-Host 'fbxStats keys:'
        $j.fbxStats.PSObject.Properties | ForEach-Object { Write-Host ('   - ' + $_.Name) }
    }
} catch {
    Write-Host ('ConvertFrom-Json error: ' + $_.Exception.Message)
}
