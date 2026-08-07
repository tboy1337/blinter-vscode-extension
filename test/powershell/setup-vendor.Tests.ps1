BeforeAll {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $scriptPath = Join-Path $repoRoot 'scripts\setup-vendor.ps1'
    . (Join-Path $PSScriptRoot 'support\VendorTestHelpers.ps1')
    . $scriptPath -LoadOnly
}

Describe 'Get-ReleaseAsset' {
    It 'returns the latest stable release with a zip asset' {
        $mockReleases = @(
            [pscustomobject]@{
                tag_name   = 'v9.0.0'
                prerelease = $true
                draft      = $false
                assets     = @(
                    [pscustomobject]@{ name = 'Blinter-v9.0.0.zip'; browser_download_url = 'https://example.com/prerelease.zip' }
                )
            },
            [pscustomobject]@{
                tag_name   = 'v8.0.0'
                prerelease = $false
                draft      = $true
                assets     = @(
                    [pscustomobject]@{ name = 'Blinter-v8.0.0.zip'; browser_download_url = 'https://example.com/draft.zip' }
                )
            },
            [pscustomobject]@{
                tag_name   = 'v7.0.0'
                prerelease = $false
                draft      = $false
                assets     = @(
                    [pscustomobject]@{ name = 'notes.txt'; browser_download_url = 'https://example.com/notes.txt' }
                )
            },
            [pscustomobject]@{
                tag_name   = 'v6.0.0'
                prerelease = $false
                draft      = $false
                assets     = @(
                    [pscustomobject]@{ name = 'Blinter-v6.0.0.zip'; browser_download_url = 'https://example.com/stable.zip' }
                )
            }
        )

        Mock Invoke-RestMethod { return $mockReleases }

        $result = Get-ReleaseAsset -RequestedVersion ''

        $result.Tag | Should -Be 'v6.0.0'
        $result.Url | Should -Be 'https://example.com/stable.zip'
    }

    It 'returns a pinned release when version is provided without v prefix' {
        $mockReleases = @(
            [pscustomobject]@{
                tag_name   = 'v5.1.0'
                prerelease = $false
                draft      = $false
                assets     = @(
                    [pscustomobject]@{ name = 'Blinter-v5.1.0.zip'; browser_download_url = 'https://example.com/v5.1.0.zip' }
                )
            }
        )

        Mock Invoke-RestMethod { return $mockReleases }

        $result = Get-ReleaseAsset -RequestedVersion '5.1.0'

        $result.Tag | Should -Be 'v5.1.0'
        $result.Url | Should -Be 'https://example.com/v5.1.0.zip'
    }

    It 'returns a pinned release when version already has v prefix' {
        $mockReleases = @(
            [pscustomobject]@{
                tag_name   = 'v4.0.0'
                prerelease = $false
                draft      = $false
                assets     = @(
                    [pscustomobject]@{ name = 'Blinter-v4.0.0.zip'; browser_download_url = 'https://example.com/v4.0.0.zip' }
                )
            }
        )

        Mock Invoke-RestMethod { return $mockReleases }

        $result = Get-ReleaseAsset -RequestedVersion 'v4.0.0'

        $result.Tag | Should -Be 'v4.0.0'
    }

    It 'throws when the requested release is not found' {
        Mock Invoke-RestMethod { return @() }

        { Get-ReleaseAsset -RequestedVersion '1.0.0' } | Should -Throw 'Requested Blinter release not found: v1.0.0'
    }

    It 'throws when the pinned release has no zip asset' {
        $mockReleases = @(
            [pscustomobject]@{
                tag_name   = 'v3.0.0'
                prerelease = $false
                draft      = $false
                assets     = @(
                    [pscustomobject]@{ name = 'notes.txt'; browser_download_url = 'https://example.com/notes.txt' }
                )
            }
        )

        Mock Invoke-RestMethod { return $mockReleases }

        { Get-ReleaseAsset -RequestedVersion '3.0.0' } | Should -Throw 'No Blinter-v*.zip asset found for release v3.0.0.'
    }

    It 'throws when no release has a zip asset' {
        $mockReleases = @(
            [pscustomobject]@{
                tag_name   = 'v2.0.0'
                prerelease = $false
                draft      = $false
                assets     = @()
            }
        )

        Mock Invoke-RestMethod { return $mockReleases }

        { Get-ReleaseAsset -RequestedVersion '' } | Should -Throw 'No Blinter release with a Blinter-v*.zip asset was found on GitHub.'
    }
}

Describe 'Invoke-BlinterVersionCheck' {
    It 'returns exit code and output from the executable' {
        $fakeExe = Join-Path $TestDrive 'Blinter-v1.0.0.cmd'
        Set-Content -Path $fakeExe -Value "@echo off`r`nif `"%~1`"==`"--version`" (`r`n  echo Blinter v1.0.0`r`n  exit /b 0`r`n)`r`nexit /b 1" -Encoding ascii

        $result = Invoke-BlinterVersionCheck -ExePath $fakeExe

        $result.ExitCode | Should -Be 0
        "$($result.Output)" | Should -Match 'Blinter v1.0.0'
    }
}

Describe 'Install-BlinterVendor' {
    BeforeEach {
        $script:testRoot = Join-Path $TestDrive 'vendor-setup'
        if (Test-Path $script:testRoot) {
            Remove-Item $script:testRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Path $script:testRoot -Force | Out-Null
    }

    It 'installs the vendor binary on the happy path' {
        $paths = Initialize-BlinterVendorInstallMocks -RepoRoot $script:testRoot

        Install-BlinterVendor -BlinterVersion '1.0.0' -RepoRoot $script:testRoot

        Test-Path $paths.VendorExe | Should -Be $true
        (Get-Content $paths.VersionFile -Raw).Trim() | Should -Be 'v1.0.0'
    }

    It 'works when the vendor directory already exists' {
        $paths = Initialize-BlinterVendorInstallMocks -RepoRoot $script:testRoot -VendorDirExists

        Install-BlinterVendor -BlinterVersion '1.0.0' -RepoRoot $script:testRoot

        Test-Path $paths.VendorExe | Should -Be $true
    }

    It 'defaults RepoRoot to the repository root beside scripts when omitted' {
        $expectedRoot = Split-Path -Parent (Split-Path -Parent $scriptPath)
        $expectedRoot | Should -Be "$repoRoot"
    }

    It 'throws when the downloaded zip is too small' {
        Mock Get-ReleaseAsset {
            return @{ Tag = 'v1.0.0'; Url = 'https://example.com/small.zip' }
        }
        Mock Invoke-WebRequest {
            param($OutFile)
            Set-Content -Path $OutFile -Value 'tiny' -Encoding ascii
        }

        { Install-BlinterVendor -BlinterVersion '1.0.0' -RepoRoot $script:testRoot } |
            Should -Throw '*Downloaded zip is too small*'
    }

    It 'throws when the executable is missing from the archive' {
        Mock Get-ReleaseAsset {
            return @{ Tag = 'v1.0.0'; Url = 'https://example.com/empty.zip' }
        }
        Mock Invoke-WebRequest {
            param($OutFile)
            $fs = [System.IO.File]::Create($OutFile)
            try { $fs.SetLength(600000) } finally { $fs.Close() }
        }
        Mock Expand-Archive { }

        { Install-BlinterVendor -BlinterVersion '1.0.0' -RepoRoot $script:testRoot } |
            Should -Throw 'Blinter executable not found in extracted archive.'
    }

    It 'throws when the executable copy fails' {
        Mock Get-ReleaseAsset {
            return @{ Tag = 'v1.0.0'; Url = 'https://example.com/Blinter-v1.0.0.zip' }
        }
        Mock Invoke-WebRequest {
            param($OutFile)
            $fs = [System.IO.File]::Create($OutFile)
            try { $fs.SetLength(600000) } finally { $fs.Close() }
        }
        Mock Expand-Archive {
            param($DestinationPath)
            Set-Content -Path (Join-Path $DestinationPath 'Blinter-v1.0.0.exe') -Value 'exe' -Encoding ascii
        }
        Mock Copy-Item { }

        { Install-BlinterVendor -BlinterVersion '1.0.0' -RepoRoot $script:testRoot } |
            Should -Throw '*Failed to copy executable to*'
    }

    It 'throws when Blinter.exe --version fails' {
        Initialize-BlinterVendorInstallMocks -RepoRoot $script:testRoot -VersionCommandFails | Out-Null

        { Install-BlinterVendor -BlinterVersion '1.0.0' -RepoRoot $script:testRoot } |
            Should -Throw '*Blinter.exe --version failed*'
    }

    It 'removes the temp directory in finally when installation fails' {
        Mock Get-ReleaseAsset {
            return @{ Tag = 'v1.0.0'; Url = 'https://example.com/Blinter-v1.0.0.zip' }
        }
        Mock Invoke-WebRequest {
            param($OutFile)
            $fs = [System.IO.File]::Create($OutFile)
            try { $fs.SetLength(100) } finally { $fs.Close() }
        }
        Mock Remove-Item {
            param($Path)
            $script:cleanupPath = $Path
        }

        { Install-BlinterVendor -BlinterVersion '1.0.0' -RepoRoot $script:testRoot } |
            Should -Throw '*Downloaded zip is too small*'

        $script:cleanupPath | Should -Match 'blinter-vendor-'
    }
}

Describe 'Invoke-SetupVendorScript' {
    It 'delegates to Install-BlinterVendor' {
        Mock Install-BlinterVendor { }

        Invoke-SetupVendorScript -BlinterVersion '2.0.0'

        Should -Invoke Install-BlinterVendor -Times 1 -Exactly -ParameterFilter {
            $BlinterVersion -eq '2.0.0'
        }
    }
}
