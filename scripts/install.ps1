[CmdletBinding()]
param(
    [string]$Version = $env:INTERLOCK_VERSION,
    [string]$InstallDir = $env:INTERLOCK_INSTALL_DIR,
    [string]$Repository = $env:INTERLOCK_REPOSITORY,
    [string]$BaseUrl = $env:INTERLOCK_BASE_URL
)

$ErrorActionPreference = 'Stop'
if (-not $Repository) { $Repository = 'JarenKempton/interlock' }
if (-not $InstallDir) { $InstallDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Interlock\bin' }

$architecture = if ($env:INTERLOCK_ARCH) { $env:INTERLOCK_ARCH } else { [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
switch ($architecture.ToLowerInvariant()) {
    { $_ -in 'x64', 'amd64', 'x86_64' } { $machine = 'x64'; break }
    { $_ -in 'arm64', 'aarch64' } { $machine = 'arm64'; break }
    default { throw "interlock: unsupported architecture: $architecture" }
}

$asset = "interlock-windows-$machine.exe"
if (-not $BaseUrl) {
    if ((-not $Version) -or ($Version -eq 'latest')) {
        throw 'interlock: INTERLOCK_VERSION is required for prerelease installation'
    }
    $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    $BaseUrl = "https://github.com/$Repository/releases/download/$tag"
}
$BaseUrl = $BaseUrl.TrimEnd('/')

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$destination = Join-Path $InstallDir 'interlock.exe'
$temporary = Join-Path $InstallDir ('.interlock.' + [Guid]::NewGuid().ToString('N') + '.exe')
$backup = Join-Path $InstallDir ('.interlock-backup.' + [Guid]::NewGuid().ToString('N') + '.exe')
$checksums = Join-Path ([IO.Path]::GetTempPath()) ('interlock-checksums.' + [Guid]::NewGuid().ToString('N'))

try {
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$asset" -OutFile $temporary
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/checksums.txt" -OutFile $checksums
    $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) { throw "interlock: checksums.txt has no entry for $asset" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "interlock: checksum verification failed for $asset" }

    if (Test-Path -LiteralPath $destination) {
        try {
            [IO.File]::Replace($temporary, $destination, $backup)
            Remove-Item -LiteralPath $backup -Force
        } catch {
            if ((-not (Test-Path -LiteralPath $destination)) -and (Test-Path -LiteralPath $backup)) {
                Move-Item -LiteralPath $backup -Destination $destination
            }
            throw
        }
    } else {
        Move-Item -LiteralPath $temporary -Destination $destination
    }
} finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $checksums -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed interlock to $destination"
$pathEntries = $env:PATH -split [IO.Path]::PathSeparator
if ($InstallDir -notin $pathEntries) {
    Write-Warning "$InstallDir is not on PATH. Add it to your user PATH, then open a new terminal."
}
