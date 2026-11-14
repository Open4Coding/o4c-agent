# o4c for Windows, in one line:
#   irm https://raw.githubusercontent.com/Open4Coding/o4c-agent/main/install.ps1 | iex
# Downloads the single executable from the latest GitHub release, checks it against the release's
# SHA256SUMS.txt, puts it in %LOCALAPPDATA%\Programs\o4c and adds that folder to your PATH. No admin
# rights, no Node.js. Run it again to update. O4C_INSTALL_DIR picks another folder.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $release = 'https://github.com/Open4Coding/o4c-agent/releases/latest/download'
  $asset = 'o4c-win32-x64.exe'
  $dir = if ($env:O4C_INSTALL_DIR) { $env:O4C_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\o4c' }
  $exe = Join-Path $dir 'o4c.exe'
  $download = Join-Path $dir "$asset.download"
  $sums = Join-Path $dir 'SHA256SUMS.txt'

  New-Item -ItemType Directory -Force $dir | Out-Null
  Write-Host 'Downloading o4c from the latest GitHub release...'
  Invoke-WebRequest "$release/$asset" -OutFile $download -UseBasicParsing
  Invoke-WebRequest "$release/SHA256SUMS.txt" -OutFile $sums -UseBasicParsing

  $line = Get-Content $sums | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
  Remove-Item $sums
  $expected = if ($line) { ($line -split '\s+')[0] } else { '' }
  # .NET rather than Get-FileHash, which a PowerShell 7 module path can hide from Windows PowerShell.
  $stream = [IO.File]::OpenRead($download)
  try { $actual = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Close() }
  if (-not $expected -or $actual -ne $expected) {
    Remove-Item $download
    throw 'The download does not match the release checksum - nothing was installed. Try again later.'
  }

  try {
    Move-Item -Force $download $exe
  } catch {
    Remove-Item $download -ErrorAction SilentlyContinue
    throw "Could not replace $exe - close every running o4c and run this again."
  }

  # The user PATH, read and written unexpanded so entries like %USERPROFILE%\bin stay as they are.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (($userPath -split ';') -notcontains $dir) {
    $key.SetValue('Path', ((@($userPath.TrimEnd(';'), $dir) | Where-Object { $_ }) -join ';'), 'ExpandString')
    # Setting any variable through .NET tells Windows the environment changed, so new terminals see the PATH.
    [Environment]::SetEnvironmentVariable('O4C_INSTALLER', '1', 'User')
    [Environment]::SetEnvironmentVariable('O4C_INSTALLER', $null, 'User')
  }
  $key.Close()
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }

  $version = & $exe --version
  Write-Host ''
  Write-Host "o4c $version is installed in $dir." -ForegroundColor Green
  Write-Host 'Go to a project folder and run: o4c'
  Write-Host 'The first start asks for a model: a local AI server, Anthropic, or (with /endpoint-add) GitHub Copilot.'
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host 'For GitHub Copilot, also install the GitHub CLI and sign in: winget install --id GitHub.cli, then gh auth login'
  }
}
