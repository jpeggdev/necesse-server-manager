# Locates ISCC.exe wherever it landed: winget installs it under the per-user
# LOCALAPPDATA, choco (what CI uses) installs it under Program Files (x86). A
# single hardcoded path breaks on whichever machine used the other installer.
#
# Dot-sourced by installer/verify-installer.ps1 and by the installer-build
# steps in .github/workflows/ci.yml and release.yml, so there is exactly one
# definition of "where is ISCC.exe" instead of three that can drift.
function Resolve-Iscc {
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
    if ($base) {
      $candidates.Add((Join-Path $base "Inno Setup 6\ISCC.exe"))
      $candidates.Add((Join-Path $base "Programs\Inno Setup 6\ISCC.exe"))
    }
  }
  $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($onPath) { $candidates.Add($onPath.Source) }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "ISCC.exe not found. Looked in:`n  $($candidates -join "`n  ")"
}
