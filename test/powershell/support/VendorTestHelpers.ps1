function Initialize-BlinterVendorInstallMocks {
    param(
        [string]$RepoRoot,
        [switch]$VendorDirExists,
        [switch]$VersionCommandFails
    )

    Mock Get-ReleaseAsset {
        return @{
            Tag = 'v1.0.0'
            Url = 'https://example.com/Blinter-v1.0.0.zip'
        }
    }

    Mock Invoke-WebRequest {
        param($OutFile)
        $fs = [System.IO.File]::Create($OutFile)
        try {
            $fs.SetLength(600000)
        }
        finally {
            $fs.Close()
        }
    }

    Mock Expand-Archive {
        param($DestinationPath)
        $exeDir = Join-Path $DestinationPath 'nested'
        New-Item -ItemType Directory -Path $exeDir -Force | Out-Null
        Set-Content -Path (Join-Path $exeDir 'Blinter-v1.0.0.exe') -Value 'exe' -Encoding ascii
    }

    Mock Copy-Item {
        param($Destination)
        $parent = Split-Path $Destination -Parent
        if (-not (Test-Path $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Set-Content -Path $Destination -Value 'installed-exe' -Encoding ascii
    }

    if ($VendorDirExists) {
        $vendorDir = Join-Path $RepoRoot 'vendor\Blinter'
        New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
    }

    if ($VersionCommandFails) {
        Mock Invoke-BlinterVersionCheck {
            return @{
                ExitCode = 1
                Output   = 'version failed'
            }
        }
    }
    else {
        Mock Invoke-BlinterVersionCheck {
            return @{
                ExitCode = 0
                Output   = 'Blinter v1.0.0'
            }
        }
    }

    return @{
        VendorDir   = Join-Path $RepoRoot 'vendor\Blinter'
        VendorExe   = Join-Path $RepoRoot 'vendor\Blinter\Blinter.exe'
        VersionFile = Join-Path $RepoRoot 'vendor\version.txt'
    }
}
