BeforeAll {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $scriptPath = Join-Path $repoRoot 'tools\verify-vsix.ps1'
    . $scriptPath -LoadOnly

    # Always rebuild so fixtures stay aligned when lib/*.js modules are added or removed.
    & (Join-Path $PSScriptRoot 'build-fixtures.ps1')
}

Describe 'Resolve-VsixPath' {
    It 'returns the explicit path when it exists' {
        $vsix = Join-Path $TestDrive 'explicit.vsix'
        New-Item -ItemType File -Path $vsix -Force | Out-Null
        try {
            $result = Resolve-VsixPath -VsixPath $vsix -SearchRoot $TestDrive
            $result | Should -Be $vsix
        }
        finally {
            Remove-Item $vsix -Force -ErrorAction SilentlyContinue
        }
    }

    It 'falls back to the first vsix in the search root' {
        $searchRoot = Join-Path $TestDrive 'vsix-search'
        New-Item -ItemType Directory -Path $searchRoot -Force | Out-Null
        $fallback = Join-Path $searchRoot 'package.vsix'
        Set-Content -Path $fallback -Value 'vsix' -Encoding ascii
        $missing = Join-Path $searchRoot 'missing.vsix'

        $result = Resolve-VsixPath -VsixPath $missing -SearchRoot $searchRoot

        $result | Should -Be $fallback
    }

    It 'throws when no vsix can be resolved' {
        $searchRoot = Join-Path $TestDrive 'empty-search'
        New-Item -ItemType Directory -Path $searchRoot -Force | Out-Null
        $missing = Join-Path $searchRoot 'missing.vsix'

        { Resolve-VsixPath -VsixPath $missing -SearchRoot $searchRoot } |
            Should -Throw "VSIX not found at $missing"
    }
}

Describe 'Test-BlinterVsixPackage' {
    It 'passes for a valid extension-root vsix' {
        $fixture = Join-Path $PSScriptRoot 'fixtures\valid-extension.vsix'

        { Test-BlinterVsixPackage -VsixPath $fixture } | Should -Not -Throw
    }

    It 'passes for a flat-root vsix layout' {
        $fixture = Join-Path $PSScriptRoot 'fixtures\flat-root.vsix'

        { Test-BlinterVsixPackage -VsixPath $fixture } | Should -Not -Throw
    }

    It 'throws when a required file is missing' {
        $fixture = Join-Path $PSScriptRoot 'fixtures\missing-file.vsix'

        { Test-BlinterVsixPackage -VsixPath $fixture } |
            Should -Throw '*Missing required VSIX file: icons\blinter-logo.png*'
    }

    It 'throws when the bundled exe is too small' {
        $fixture = Join-Path $PSScriptRoot 'fixtures\small-exe.vsix'

        { Test-BlinterVsixPackage -VsixPath $fixture } |
            Should -Throw '*Bundled Blinter.exe is unexpectedly small*'
    }

    It 'cleans up the inspect directory after success' {
        $fixture = Join-Path $PSScriptRoot 'fixtures\valid-extension.vsix'
        Mock Remove-Item {
            param($Path)
            $script:cleanupPath = $Path
        }

        Test-BlinterVsixPackage -VsixPath $fixture

        $script:cleanupPath | Should -Match 'blinter-vsix-inspect-'
    }

    It 'cleans up the inspect directory after failure' {
        $fixture = Join-Path $PSScriptRoot 'fixtures\missing-file.vsix'
        Mock Remove-Item {
            param($Path)
            $script:cleanupPath = $Path
        }

        { Test-BlinterVsixPackage -VsixPath $fixture } | Should -Throw

        $script:cleanupPath | Should -Match 'blinter-vsix-inspect-'
    }
}

Describe 'Invoke-VerifyVsixScript' {
    It 'resolves and verifies the package' {
        $fixture = Join-Path $PSScriptRoot 'fixtures\valid-extension.vsix'
        Mock Resolve-VsixPath { return $fixture }
        Mock Test-BlinterVsixPackage { }

        Invoke-VerifyVsixScript -VsixPath $fixture

        Should -Invoke Resolve-VsixPath -Times 1 -Exactly
        Should -Invoke Test-BlinterVsixPackage -Times 1 -Exactly -ParameterFilter {
            $VsixPath -eq $fixture
        }
    }

    It 'uses the default vsix path when none is supplied' {
        $expectedDefault = Join-Path (Split-Path $scriptPath -Parent) '..\blinter.vsix'
        Mock Resolve-VsixPath { return 'resolved-path' }
        Mock Test-BlinterVsixPackage { }

        Invoke-VerifyVsixScript

        Should -Invoke Resolve-VsixPath -Times 1 -Exactly -ParameterFilter {
            $VsixPath -eq $expectedDefault
        }
    }
}
