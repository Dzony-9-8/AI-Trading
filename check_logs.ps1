$file = Get-Item "D:\AI\AI Trading\logs\bot.log"
$gb = [math]::Round($file.Length / 1GB, 3)
$mb = [math]::Round($file.Length / 1MB, 1)
Write-Host "File: $($file.Name)"
Write-Host "Size: $gb GB ($mb MB)"
Write-Host "Last modified: $($file.LastWriteTime)"
Write-Host ""
Write-Host "--- Last 20 lines ---"
Get-Content "D:\AI\AI Trading\logs\bot.log" -Tail 20
