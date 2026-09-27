# Launches the browser-control CDP session fully detached from the caller.
#
# Why: opencode's shell tool waits on a Job Object (process tree). A daemon
# started with Start-Process stays in the job, so the tool call blocks until
# timeout. CREATE_BREAKAWAY_FROM_JOB makes the daemon escape the job, so this
# script (and the tool call) returns immediately.
#
# Usage:  & "$skill\launch.ps1" [-Port 9333]
# Output: "already running (connected=...) pid N"  OR  "launched cdp.mjs detached pid N"
param(
  [int]$Port = 9333
)
$ErrorActionPreference = 'Stop'
$skill = $PSScriptRoot
$statusUrl = "http://127.0.0.1:$Port/status"

function Get-PortPid {
  netstat -ano | Select-String (":$Port\s+.*LISTENING") | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
}

# 1. A healthy session already owns the port -> self-heal cdp.pid, do not relaunch.
try {
  $s = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 3
  $spid = Get-PortPid
  if ($spid) { $spid | Out-File (Join-Path $skill 'cdp.pid') -Encoding ascii }
  Write-Output "already running (connected=$($s.connected)) pid $spid"
  return
} catch { }

# 2. Launch node cdp.mjs, breaking away from our job object.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DetachedLauncher {
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFO {
    public int cb; public IntPtr reserved; public IntPtr lpTitle; public IntPtr hwnd;
    public int xSize; public int ySize; public int xCountChars; public int yCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcessW(
    string lpApplicationName, string lpCommandLine,
    IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
    bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Launch(string exe, string args, string workDir, uint flags) {
    string cmdLine = "\"" + exe + "\" " + args;
    var sui = new STARTUPINFO(); sui.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    var pi = new PROCESS_INFORMATION();
    bool ok = CreateProcessW(exe, cmdLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, workDir, ref sui, out pi);
    int pid = ok ? pi.dwProcessId : -Marshal.GetLastWin32Error();
    if (ok) { CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }
    return pid;
  }
}
"@
$node = (Get-Command node).Source
$cdp = Join-Path $skill 'cdp.mjs'
$env:CDP_CTRL_PORT = "$Port"
$env:CDP_DETACHED = "1"
# CREATE_BREAKAWAY_FROM_JOB(0x01000000) | DETACHED_PROCESS(0x00000008)
$flags = [uint32]0x01000008
$npid = [DetachedLauncher]::Launch($node, "`"$cdp`"", $skill, $flags)
if ($npid -lt 0) {
  Write-Output "FAILED to launch cdp.mjs (win32 error $(-1 * $npid))"
  exit 1
}
$npid | Out-File (Join-Path $skill 'cdp.pid') -Encoding ascii
Write-Output "launched cdp.mjs detached pid $npid (cdp.mjs rewrites cdp.pid once it owns the port)"
