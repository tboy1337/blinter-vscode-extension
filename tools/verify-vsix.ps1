param(
    [string]$VsixPath = (Join-Path $PSScriptRoot '..\blinter.vsix'),
    [switch]$LoadOnly
)

$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'

$script:MinExeBytes = 500000

function Resolve-VsixPath {
    param(
        [string]$VsixPath,
        [string]$SearchRoot
    )

    if (Test-Path $VsixPath) {
        return $VsixPath
    }

    $fallback = Get-ChildItem -Path $SearchRoot -Filter '*.vsix' | Select-Object -First 1
    if ($fallback) {
        return $fallback.FullName
    }

    throw "VSIX not found at $VsixPath"
}

function Test-BlinterVsixPackage {
    param(
        [string]$VsixPath
    )

    $inspectRoot = Join-Path $env:TEMP "blinter-vsix-inspect-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $inspectRoot -Force | Out-Null

    try {
        Copy-Item -Path $VsixPath -Destination (Join-Path $inspectRoot 'package.zip') -Force
        Expand-Archive -Path (Join-Path $inspectRoot 'package.zip') -DestinationPath $inspectRoot -Force

        $extensionRoot = Join-Path $inspectRoot 'extension'
        if (-not (Test-Path $extensionRoot)) {
            $extensionRoot = $inspectRoot
        }

        $required = @(
            'extension.js',
            'package.json',
            'icons\blinter_icon.ico',
            'icons\blinter-logo.png',
            'vendor\Blinter\Blinter.exe'
        )

        foreach ($relativePath in $required) {
            $fullPath = Join-Path $extensionRoot $relativePath
            if (-not (Test-Path $fullPath)) {
                throw "Missing required VSIX file: $relativePath"
            }
        }

        $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
        $libModules = Get-ChildItem -Path (Join-Path $repoRoot 'lib') -Filter '*.js' -File |
            ForEach-Object { 'lib\' + $_.Name } |
            Sort-Object -Unique

        foreach ($relativePath in $libModules) {
            $fullPath = Join-Path $extensionRoot $relativePath
            if (-not (Test-Path $fullPath)) {
                throw "Missing required VSIX lib module: $relativePath"
            }
        }

        $exeSize = (Get-Item (Join-Path $extensionRoot 'vendor\Blinter\Blinter.exe')).Length
        if ($exeSize -lt $script:MinExeBytes) {
            throw "Bundled Blinter.exe is unexpectedly small ($exeSize bytes)."
        }

        Write-Information "VSIX verification passed: $VsixPath"
    }
    finally {
        if (Test-Path $inspectRoot) {
            Remove-Item -Path $inspectRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-VerifyVsixScript {
    param(
        [string]$VsixPath = (Join-Path $PSScriptRoot '..\blinter.vsix')
    )

    $resolvedPath = Resolve-VsixPath -VsixPath $VsixPath -SearchRoot (Join-Path $PSScriptRoot '..')
    Test-BlinterVsixPackage -VsixPath $resolvedPath
}

if (-not $LoadOnly -and $MyInvocation.InvocationName -ne '.') {
    Invoke-VerifyVsixScript -VsixPath $VsixPath
}
