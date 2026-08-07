$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $repoRoot 'PSScriptAnalyzerSettings.psd1'
$targets = @(
    (Join-Path $repoRoot 'scripts'),
    (Join-Path $repoRoot 'tools')
)

$findings = @()
foreach ($target in $targets) {
    $findings += Invoke-ScriptAnalyzer -Path $target -Recurse -Settings $settingsPath
}

if ($findings.Count -gt 0) {
    $findings | Format-Table -AutoSize RuleName, Severity, ScriptName, Line, Message
    Write-Error "PSScriptAnalyzer reported $($findings.Count) finding(s)."
    exit 1
}

Write-Information 'PSScriptAnalyzer reported no findings.'
