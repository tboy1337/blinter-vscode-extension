# Builds VSIX fixture archives for verify-vsix Pester tests.
$ErrorActionPreference = 'Stop'

$fixturesDir = Join-Path $PSScriptRoot 'fixtures'
if (-not (Test-Path $fixturesDir)) {
    New-Item -ItemType Directory -Path $fixturesDir -Force | Out-Null
}

function New-VsixFixture {
    param(
        [string]$Name,
        [scriptblock]$Build
    )

    $staging = Join-Path $env:TEMP "vsix-fixture-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        & $Build $staging
        $zipPath = Join-Path $env:TEMP "vsix-fixture-$([Guid]::NewGuid().ToString('N')).zip"
        $outPath = Join-Path $fixturesDir $Name
        try {
            Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
            Move-Item -Path $zipPath -Destination $outPath -Force
        }
        finally {
            if (Test-Path $zipPath) {
                Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    finally {
        if (Test-Path $staging) {
            Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Add-RequiredVsixFiles {
    param(
        [string]$Root,
        [int]$ExeBytes = 500001
    )

    $dirs = @(
        'icons',
        'lib',
        'vendor\Blinter'
    )
    foreach ($dir in $dirs) {
        $fullDir = Join-Path $Root $dir
        New-Item -ItemType Directory -Path $fullDir -Force | Out-Null
    }

    Set-Content -Path (Join-Path $Root 'extension.js') -Value '// fixture' -Encoding ascii
    Set-Content -Path (Join-Path $Root 'package.json') -Value '{}' -Encoding ascii
    Set-Content -Path (Join-Path $Root 'icons\blinter_icon.ico') -Value 'ico' -Encoding ascii
    Set-Content -Path (Join-Path $Root 'icons\blinter-logo.png') -Value 'png' -Encoding ascii

    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    Get-ChildItem -Path (Join-Path $repoRoot 'lib') -Filter '*.js' -File | ForEach-Object {
        $stubPath = Join-Path $Root ('lib\' + $_.Name)
        Set-Content -Path $stubPath -Value '// fixture' -Encoding ascii
    }

    $exePath = Join-Path $Root 'vendor\Blinter\Blinter.exe'
    $fs = [System.IO.File]::Create($exePath)
    try {
        $fs.SetLength($ExeBytes)
    }
    finally {
        $fs.Close()
    }
}

New-VsixFixture -Name 'valid-extension.vsix' -Build {
    param($staging)
    $extensionRoot = Join-Path $staging 'extension'
    New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
    Add-RequiredVsixFiles -Root $extensionRoot -ExeBytes 500001
}

New-VsixFixture -Name 'flat-root.vsix' -Build {
    param($staging)
    Add-RequiredVsixFiles -Root $staging -ExeBytes 500001
}

New-VsixFixture -Name 'missing-file.vsix' -Build {
    param($staging)
    $extensionRoot = Join-Path $staging 'extension'
    New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
    Add-RequiredVsixFiles -Root $extensionRoot -ExeBytes 500001
    Remove-Item (Join-Path $extensionRoot 'icons\blinter-logo.png') -Force
}

New-VsixFixture -Name 'small-exe.vsix' -Build {
    param($staging)
    $extensionRoot = Join-Path $staging 'extension'
    New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
    Add-RequiredVsixFiles -Root $extensionRoot -ExeBytes 100
}

Write-Information "VSIX fixtures written to $fixturesDir"
