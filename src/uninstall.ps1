<#
  卸载 Prompt Studio（单用户安装，不需要管理员）
  用法:  powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Silent]
#>
[CmdletBinding()]
param([switch]$Silent)

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\PromptStudio"
function Stop-RunningApp {
  param([string]$Dir, [int]$Port)
  $killed = @()
  # 1) 命令行里带安装目录的进程：cmd.exe 跑 run.cmd 时会命中
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($Dir.ToLower()) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed += $_.ProcessId }
  # 2) 占着端口不放的进程：run.cmd 里是 cd + "node server.mjs"，命令行不含路径，只能靠端口找
  try {
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop).OwningProcess
    foreach ($id in @($owner)) {
      if (-not $id) { continue }
      $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $id) -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      if ($p.Name -ne "node.exe" -and $p.Name -ne "cmd.exe") { continue }
      # L11：端口被别的程序占着不能乱杀 —— 先确认这个进程确实属于 Prompt Studio
      # （命令行里带安装目录，或它的父进程是跑 run.cmd 的那个 cmd.exe）
      $looksOurs = ($p.CommandLine -and $p.CommandLine.ToLower().Contains($Dir.ToLower()))
      if (-not $looksOurs -and $p.ParentProcessId) {
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
        $looksOurs = ($parent -and $parent.CommandLine -and $parent.CommandLine.ToLower().Contains($Dir.ToLower()))
      }
      if ($looksOurs) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        $killed += $id
      } else {
        Write-Host ("  [i]  端口 " + $Port + " 被 pid " + $id + " 占用，但它不属于 Prompt Studio，已跳过。") -ForegroundColor DarkGray
      }
    }
  } catch {}
  if ($killed.Count -gt 0) { Start-Sleep -Milliseconds 1500 }
  return ($killed | Select-Object -Unique)
}

function Remove-DirWithRetry {
  param([string]$Dir, [int]$Tries = 8)
  for ($i = 1; $i -le $Tries; $i++) {
    try {
      Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction Stop
      return $true
    } catch {
      if ($i -eq $Tries) { return $false }
      Start-Sleep -Milliseconds (300 * $i)
    }
  }
  return $false
}
function Ok([string]$t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  Prompt Studio 卸载程序" -ForegroundColor White
Write-Host "  --------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  安装目录: $InstallDir" -ForegroundColor Gray
Write-Host ""

if (-not $Silent) {
  $ans = Read-Host "  确认卸载? (Y/N)"
  if ($ans -notmatch '^[Yy]') { Write-Host "  已取消。"; Write-Host ""; exit 0 }
}

$killed = Stop-RunningApp -Dir $InstallDir -Port 5178
if ($killed.Count -gt 0) { Ok ("已停止正在运行的服务（PID: " + ($killed -join ", ") + "）") }

foreach ($lnk in @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Prompt Studio.lnk"),
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Prompt Studio.lnk"),
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\Prompt Studio.lnk"))) {
  if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue; Ok "已删除快捷方式: $lnk" }
}

$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PromptStudio"
if (Test-Path $regPath) { Remove-Item -Path $regPath -Recurse -Force -ErrorAction SilentlyContinue; Ok "已移除「设置 > 应用」中的注册项" }

$guard = (Join-Path $env:LOCALAPPDATA "Programs")
if ($InstallDir.StartsWith($guard, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $InstallDir)) {
  if (Remove-DirWithRetry -Dir $InstallDir) {
    Ok "已删除安装目录"
  } else {
    # L11：以前这里用 Start-Job「2 秒后继续删」，父会话一退出子作业就被终止，基本不会执行。
    # 改成同步等待 + 重试，实在删不掉就明确告诉用户怎么办。
    Warn "有文件被占用，继续同步重试删除…"
    $removed = $false
    for ($i = 1; $i -le 5; $i++) {
      Start-Sleep -Milliseconds (600 * $i)
      if (Remove-DirWithRetry -Dir $InstallDir -Tries 2) { Ok "已删除安装目录"; $removed = $true; break }
    }
    if (-not $removed) {
      Warn "还有文件被占用，没能删干净。重启电脑后再运行一次本脚本，或手动删除："
      Write-Host ("     " + $InstallDir) -ForegroundColor DarkGray
    }
  }
}

Write-Host ""
Write-Host "  Prompt Studio 已卸载。" -ForegroundColor White
Write-Host "  浏览器里缓存的设置与 Key 属于浏览器数据，如需要请自行清理。" -ForegroundColor DarkGray
Write-Host ""