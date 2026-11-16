# Verifies the Windows portable builds: splash timing, single instance, and zip start time.
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$r = Join-Path $env:TEMP 'itvr-time.txt'
$portable = 'C:\Dev\ITVR_RDP\release\ITVR RDP-Portable-1.0.0-x64.exe'
$zip = 'C:\Dev\ITVR_RDP\release\ITVR RDP-1.0.0-win-x64.zip'

function Stop-All { Get-Process 'ITVR*' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2 }
function Visible-Window-Of([int]$procId) {
  $script:found = $false
  [W]::EnumWindows({ param($h, $l) $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq $procId -and [W]::IsWindowVisible($h)) { $script:found = $true; return $false }; return $true }, [IntPtr]::Zero) | Out-Null
  return $script:found
}
function Wait-Main($sw) {
  while ($sw.Elapsed.TotalSeconds -lt 90) {
    if (Get-Process 'ITVR RDP' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'ITVR RDP' }) { return [math]::Round($sw.Elapsed.TotalSeconds, 1) }
    Start-Sleep -Milliseconds 200
  }
  return 'timeout'
}

Stop-All
# 1. portable: time to splash (any visible window from the launcher) and to the main window
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $portable -PassThru
$splash = $null
while ($sw.Elapsed.TotalSeconds -lt 30 -and -not $splash) {
  if (Visible-Window-Of $p.Id) { $splash = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
  Start-Sleep -Milliseconds 100
}
"portable: splash visible after $splash s" | Out-File $r -Encoding utf8
"portable: main window after $(Wait-Main $sw) s" | Out-File $r -Append -Encoding utf8

# 2. single instance: launch again while running, expect still one main window
Start-Process -FilePath $portable | Out-Null
Start-Sleep 30
$mains = @(Get-Process 'ITVR RDP' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'ITVR RDP' }).Count
"second launch: main windows open = $mains (expect 1)" | Out-File $r -Append -Encoding utf8
Stop-All

# 3. zip build: extract once, then time a normal start
$dir = Join-Path $env:TEMP 'itvr-zip-test'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
$exe = Get-ChildItem $dir -Recurse -Filter 'ITVR RDP.exe' | Select-Object -First 1
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath $exe.FullName | Out-Null
"zip: main window after $(Wait-Main $sw) s (exe at $($exe.FullName.Replace($dir, '<zip>')))" | Out-File $r -Append -Encoding utf8
Stop-All
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath $exe.FullName | Out-Null
"zip: second start after $(Wait-Main $sw) s" | Out-File $r -Append -Encoding utf8
Stop-All
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
"done" | Out-File $r -Append -Encoding utf8
