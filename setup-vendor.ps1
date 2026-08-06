# Downloads the latest Blinter release zip and installs Blinter.exe into vendor/Blinter/.
# Adapted from upstream install_blinter.cmd (download/extract logic only).
param(
    [string]$BlinterVersion = $env:BLINTER_VERSION
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendorDir = Join-Path $repoRoot 'vendor\Blinter'
$vendorExe = Join-Path $vendorDir 'Blinter.exe'
$versionFile = Join-Path $repoRoot 'vendor\version.txt'
$minZipBytes = 500000

function Get-ReleaseAsset {
    param([string]$RequestedVersion)

    $releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/tboy1337/Blinter/releases?per_page=100'
    $candidates = $releases | Where-Object { -not $_.prerelease -and -not $_.draft }

    if ($RequestedVersion) {
        $tag = if ($RequestedVersion.StartsWith('v')) { $RequestedVersion } else { "v$RequestedVersion" }
        $release = $candidates | Where-Object { $_.tag_name -eq $tag } | Select-Object -First 1
        if (-not $release) {
            throw "Requested Blinter release not found: $tag"
        }
        $asset = $release.assets | Where-Object { $_.name -like 'Blinter-v*.zip' } | Select-Object -First 1
        if (-not $asset) {
            throw "No Blinter-v*.zip asset found for release $($release.tag_name)."
        }
        return @{
            Tag = $release.tag_name
            Url = $asset.browser_download_url
        }
    }

    foreach ($release in $candidates) {
        $asset = $release.assets | Where-Object { $_.name -like 'Blinter-v*.zip' } | Select-Object -First 1
        if ($asset) {
            return @{
                Tag = $release.tag_name
                Url = $asset.browser_download_url
            }
        }
    }

    throw 'No Blinter release with a Blinter-v*.zip asset was found on GitHub.'
}

Write-Host "[Blinter] Setting up vendor binary..."

if (-not (Test-Path $vendorDir)) {
    New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
}

$releaseInfo = Get-ReleaseAsset -RequestedVersion $BlinterVersion
Write-Host "[Blinter] Release: $($releaseInfo.Tag)"
Write-Host "[Blinter] Download: $($releaseInfo.Url)"

$tempRoot = Join-Path $env:TEMP "blinter-vendor-$([Guid]::NewGuid().ToString('N'))"
$zipPath = Join-Path $tempRoot 'Blinter.zip'
$extractDir = Join-Path $tempRoot 'extract'

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

try {
    Invoke-WebRequest -Uri $releaseInfo.Url -OutFile $zipPath -UseBasicParsing
    $zipSize = (Get-Item $zipPath).Length
    if ($zipSize -lt $minZipBytes) {
        throw "Downloaded zip is too small ($zipSize bytes)."
    }

    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $sourceExe = Get-ChildItem -Path $extractDir -Filter 'Blinter-v*.exe' -Recurse | Select-Object -First 1
    if (-not $sourceExe) {
        throw 'Blinter executable not found in extracted archive.'
    }

    Copy-Item -Path $sourceExe.FullName -Destination $vendorExe -Force

    if (-not (Test-Path $vendorExe)) {
        throw "Failed to copy executable to $vendorExe"
    }

    $versionOutput = & $vendorExe --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Blinter.exe --version failed: $versionOutput"
    }

    Write-Host "[Blinter] Installed: $vendorExe"
    Write-Host "[Blinter] Version output: $versionOutput"

    Set-Content -Path $versionFile -Value $releaseInfo.Tag -Encoding ascii
    Write-Host "[Blinter] Vendor setup complete ($($releaseInfo.Tag))."
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
