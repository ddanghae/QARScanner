# Binance USDT-M perpetual gainers: 24h / 7d / 30d
# ponytail: sequential REST calls, ~700 syms. Klines limit=31 -> weight 1 each, well under 2400/min.
$ErrorActionPreference = 'Stop'
$info = Invoke-RestMethod "https://fapi.binance.com/fapi/v1/exchangeInfo" -TimeoutSec 30
$syms = $info.symbols | Where-Object { $_.contractType -eq 'PERPETUAL' -and $_.quoteAsset -eq 'USDT' -and $_.status -eq 'TRADING' } | ForEach-Object { $_.symbol }
Write-Host "symbols: $($syms.Count)"

$rows = New-Object System.Collections.ArrayList
$i = 0
foreach ($s in $syms) {
    $i++
    if ($i % 100 -eq 0) { Write-Host "  $i/$($syms.Count)" }
    try {
        $k = Invoke-RestMethod "https://fapi.binance.com/fapi/v1/klines?symbol=$s&interval=1d&limit=31" -TimeoutSec 20
    } catch { continue }
    if ($k.Count -lt 2) { continue }
    $last  = [double]$k[-1][4]           # current close
    $c1    = [double]$k[-2][4]           # 1d ago close
    $bars  = $k.Count
    $c7    = if ($bars -ge 8)  { [double]$k[-8][4] }  else { $null }
    $c30   = if ($bars -ge 31) { [double]$k[0][4] }   else { $null }

    # max run-up inside window: lowest low -> highest high that comes after it
    $lows  = $k | ForEach-Object { [double]$_[3] }
    $highs = $k | ForEach-Object { [double]$_[2] }
    $minSoFar = [double]::MaxValue; $bestRun = 0.0
    for ($j = 0; $j -lt $bars; $j++) {
        if ($lows[$j] -lt $minSoFar) { $minSoFar = $lows[$j] }
        if ($minSoFar -gt 0) { $r = ($highs[$j] / $minSoFar - 1) * 100; if ($r -gt $bestRun) { $bestRun = $r } }
    }

    [void]$rows.Add([pscustomobject]@{
        symbol = $s
        d1     = [math]::Round(($last/$c1 - 1)*100, 1)
        d7     = if ($c7)  { [math]::Round(($last/$c7  - 1)*100, 1) } else { $null }
        d30    = if ($c30) { [math]::Round(($last/$c30 - 1)*100, 1) } else { $null }
        runup  = [math]::Round($bestRun, 1)
        bars   = $bars
        price  = $last
    })
}
$rows | Export-Csv -Path "$PSScriptRoot\gainers.csv" -NoTypeInformation -Encoding utf8
Write-Host "done: $($rows.Count) rows"
