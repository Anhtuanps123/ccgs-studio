# CCGS Studio: cài lần đầu trên Windows. Chạy bằng cai-dat.cmd (bấm đúp).
# Cài Node 24.21.0 nếu chưa có (bản đã chạy được trên máy công ty), npm install, rồi chạy Studio.
# Các package còn lại (Claude Code, Git, uv, graphify...) cài ở màn "Cài package" trong Studio.
param([switch]$NoStart)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$msg) {
  Write-Host ''
  Write-Host $msg -ForegroundColor Red
  Read-Host 'Bấm Enter để đóng' | Out-Null
  exit 1
}
function Has([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host '=== CCGS Studio: cài lần đầu ===' -ForegroundColor Cyan

if (-not (Has 'node')) {
  Write-Host 'Chưa có Node.js. Cài Node 24.21.0 bằng winget (Windows có thể hỏi quyền admin)...'
  if (-not (Has 'winget')) { Fail 'Máy không có winget. Tải Node 24 ở https://nodejs.org rồi chạy lại cai-dat.cmd.' }
  winget install --id OpenJS.NodeJS.LTS -e --version 24.21.0 --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Fail "Cài Node không thành công (mã $LASTEXITCODE). Xem lỗi phía trên." }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Has 'node')) { Fail 'Đã cài Node nhưng cửa sổ này chưa thấy lệnh node. Đóng cửa sổ rồi chạy lại cai-dat.cmd.' }
}

$nodeV = (node --version).Trim()
Write-Host "Node $nodeV"
if ([int]($nodeV.TrimStart('v').Split('.')[0]) -lt 24) { Fail "Node $nodeV quá cũ, cần bản 24 trở lên. Cài Node 24 rồi chạy lại." }

Write-Host ''
Write-Host '=== npm install ===' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
  Fail ("npm install lỗi. Nếu lỗi nhắc tới better-sqlite3 hoặc node-gyp, cần Visual Studio Build Tools (C++):`n" +
    '  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' +
    "`nCài xong chạy lại cai-dat.cmd.")
}
if ($NoStart) { Write-Host 'Xong npm install (bỏ qua bước chạy Studio).'; exit 0 }

Write-Host ''
Write-Host '=== Chạy Studio tại http://127.0.0.1:4310 ===' -ForegroundColor Cyan
Write-Host 'Trình duyệt sẽ tự mở màn "Cài package" sau khoảng 30 giây. Đóng cửa sổ này là tắt Studio.'
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 30; Start-Process http://127.0.0.1:4310/setup'
npm start
if ($LASTEXITCODE -ne 0) { Fail "Studio dừng với mã $LASTEXITCODE. Nếu báo cổng 4310 đang bận thì Studio đã chạy sẵn ở cửa sổ khác." }
