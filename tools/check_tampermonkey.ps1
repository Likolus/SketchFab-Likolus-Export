# check_tampermonkey.ps1 - find which version of the userscript is installed
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== Looking for Tampermonkey script storage ==="
# Tampermonkey stores scripts in the browser extension storage.
# Chrome: %LOCALAPPDATA%\Google\Chrome\User Data\Default\Local Extension Settings\<ext-id>\
# The Tampermonkey extension ID is dhdgffkkebhmkfjojejmpbldmpobfkfo
$tampermonkeyId = "dhdgffkkebhmkfjojejmpbldmpobfkfo"
$chromePaths = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Local Extension Settings\$tampermonkeyId",
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Local Extension Settings\$tampermonkeyId",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Local Extension Settings\$tampermonkeyId"
)
foreach ($p in $chromePaths) {
    if (Test-Path $p) {
        Write-Host "Found TM storage: $p"
        Get-ChildItem $p | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200
    }
}

# Tampermonkey also stores script source in IndexedDB / LevelDB. Look for the userscript by name in LevelDB files.
Write-Host ""
Write-Host "=== Searching LevelDB / IndexedDB for SketchFabLikolus script source ==="
$searchDirs = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Local Extension Settings\$tampermonkeyId",
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\IndexedDB"
)
foreach ($d in $searchDirs) {
    if (Test-Path $d) {
        Write-Host "--- $d ---"
        Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -gt 1000 } |
            Select-Object FullName, Length, LastWriteTime |
            Format-Table -AutoSize | Out-String -Width 200
    }
}

# Try to extract the script source directly. Tampermonkey stores scripts as values
# in a LevelDB-like file. Easier: use Tampermonkey's "export" feature is not scriptable.
# Instead, we just grep for "@version" near "SketchFabLikolus" in any .ldb/.log file.
Write-Host ""
Write-Host "=== Grep for SketchFabLikolus in extension storage ==="
foreach ($d in $searchDirs) {
    if (Test-Path $d) {
        Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            $f = $_
            try {
                $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
                # Convert to ASCII, look for "@version" near "SketchFab"
                $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
                if ($ascii -match 'SketchFabLikolus') {
                    Write-Host "MATCH in: $($f.FullName)"
                    # Find @version occurrences with context
                    $matches = [regex]::Matches($ascii, '@version\s+([\d\.]+)')
                    foreach ($m in $matches) {
                        Write-Host "  Found @version: $($m.Groups[1].Value)"
                    }
                }
            } catch {}
        }
    }
}

# Also check if Tampermonkey has an "export folder" - usually it doesn't, but the script
# source may also live in %APPDATA%\Tampermonkey\ or similar
Write-Host ""
Write-Host "=== Other possible Tampermonkey locations ==="
$otherPaths = @(
    "$env:APPDATA\Tampermonkey",
    "$env:LOCALAPPDATA\Tampermonkey",
    "$env:APPDATA\..\Local\Google\Chrome\User Data\Default\Extensions\$tampermonkeyId"
)
foreach ($p in $otherPaths) {
    if (Test-Path $p) {
        Write-Host "Found: $p"
        Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 20 FullName, Length | Format-Table -AutoSize | Out-String -Width 200
    }
}
