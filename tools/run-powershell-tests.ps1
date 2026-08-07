$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$pesterModule = Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1
if (-not $pesterModule) {
    Write-Error 'Pester is not installed. Install-Module Pester -Scope CurrentUser -Force'
    exit 1
}

if ($pesterModule.Version -lt [version]'5.5.0') {
    Write-Error "Pester 5.5.0 or newer is required (found $($pesterModule.Version))."
    exit 1
}

$reportsDir = Join-Path $repoRoot 'test\reports'
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

# Always rebuild so fixtures stay aligned when lib/*.js modules are added or removed.
& (Join-Path $repoRoot 'test\powershell\build-fixtures.ps1')

$config = New-PesterConfiguration
$config.Run.Path = Join-Path $repoRoot 'test\powershell'
$config.Run.PassThru = $true
$config.Output.Verbosity = 'Detailed'
$config.TestResult.Enabled = $true
$config.TestResult.OutputPath = Join-Path $reportsDir 'pester-results.xml'
$config.CodeCoverage.Enabled = $true
$config.CodeCoverage.Path = @(
    (Join-Path $repoRoot 'scripts\setup-vendor.ps1'),
    (Join-Path $repoRoot 'tools\verify-vsix.ps1')
)
$config.CodeCoverage.CoveragePercentTarget = 95
$config.CodeCoverage.OutputPath = Join-Path $reportsDir 'pester-coverage.xml'
$config.CodeCoverage.OutputFormat = 'JaCoCo'

$result = Invoke-Pester -Configuration $config

if ($result.FailedCount -gt 0) {
    Write-Error "Pester tests failed: $($result.FailedCount) failure(s)."
    exit 1
}

$coveragePercent = [math]::Round($result.CodeCoverage.CoveragePercent, 2)
Write-Information "PowerShell code coverage: $coveragePercent% (target >= 95%)"

if ($coveragePercent -lt 95) {
    Write-Error "PowerShell code coverage $coveragePercent% is below the 95% threshold."
    exit 1
}

Write-Information 'PowerShell Pester tests and coverage gate passed.'
