# inspect_obj_file.ps1 - inspect the OBJ file structure
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

$objPath = "C:\Users\Likolus\Desktop\Travelling Cat\Travelling Cat.obj"
$lines = Get-Content $objPath -Encoding UTF8

Write-Host "=== OBJ file stats ==="
Write-Host "Total lines: $($lines.Count)"
Write-Host "v  lines: $(($lines | Where-Object { $_ -match '^v ' }).Count)"
Write-Host "vt lines: $(($lines | Where-Object { $_ -match '^vt ' }).Count)"
Write-Host "vn lines: $(($lines | Where-Object { $_ -match '^vn ' }).Count)"
Write-Host "f  lines: $(($lines | Where-Object { $_ -match '^f ' }).Count)"
Write-Host "o  lines: $(($lines | Where-Object { $_ -match '^o ' }).Count)"
Write-Host "usemtl lines: $(($lines | Where-Object { $_ -match '^usemtl ' }).Count)"

Write-Host ""
Write-Host "=== Object names ==="
$lines | Where-Object { $_ -match '^o ' } | Select-Object -First 10

Write-Host ""
Write-Host "=== Material references ==="
$lines | Where-Object { $_ -match '^usemtl ' } | Select-Object -First 10

Write-Host ""
Write-Host "=== First 5 v lines ==="
$lines | Where-Object { $_ -match '^v ' } | Select-Object -First 5

Write-Host ""
Write-Host "=== First 5 vt lines ==="
$lines | Where-Object { $_ -match '^vt ' } | Select-Object -First 5

Write-Host ""
Write-Host "=== First 5 vn lines ==="
$lines | Where-Object { $_ -match '^vn ' } | Select-Object -First 5

Write-Host ""
Write-Host "=== First 5 f lines ==="
$lines | Where-Object { $_ -match '^f ' } | Select-Object -First 5

Write-Host ""
Write-Host "=== Last 5 f lines (might have biggest indices) ==="
$lines | Where-Object { $_ -match '^f ' } | Select-Object -Last 5

Write-Host ""
Write-Host "=== Looking for face lines with index > 10000 (might be problematic) ==="
$bigFaces = $lines | Where-Object { $_ -match '^f ' } | Where-Object {
    $matches = [regex]::Matches($_, '(\d+)')
    $max = 0
    foreach ($m in $matches) { $v = [int]$m.Groups[1].Value; if ($v -gt $max) { $max = $v } }
    $max -gt 10000
}
Write-Host "Found $($bigFaces.Count) face lines with index > 10000"
$bigFaces | Select-Object -First 5
Write-Host "..."
$bigFaces | Select-Object -Last 5
