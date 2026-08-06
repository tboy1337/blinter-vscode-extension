param(
    [string]$VsixPath = (Join-Path $PSScriptRoot '..\blinter.vsix')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $VsixPath)) {
    $fallback = Get-ChildItem -Path (Join-Path $PSScriptRoot '..') -Filter '*.vsix' | Select-Object -First 1
    if ($fallback) {
        $VsixPath = $fallback.FullName
    } else {
        throw "VSIX not found at $VsixPath"
    }
}

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

    $exeSize = (Get-Item (Join-Path $extensionRoot 'vendor\Blinter\Blinter.exe')).Length
    if ($exeSize -lt 500000) {
        throw "Bundled Blinter.exe is unexpectedly small ($exeSize bytes)."
    }

    Write-Host "VSIX verification passed: $VsixPath"
}
finally {
    if (Test-Path $inspectRoot) {
        Remove-Item -Path $inspectRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
