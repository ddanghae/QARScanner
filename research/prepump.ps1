# Pre-pump condition analysis: pumpers vs control group
# ponytail: 1h klines limit=1000 (~41d, weight 10). 96 syms -> ~960 weight, under 2400/min.
$ErrorActionPreference = 'Stop'
$here = "C:\Users\anny\AppData\Local\Temp\claude\C--Users-anny-Documents-pine\6bb0ed98-aad4-48f1-ba02-681ef753b307\scratchpad"

$pumpers = @('BANKUSDT','AKEUSDT','USUSDT','ESPORTSUSDT','KAITOUSDT','TLMUSDT','EULUSDT','BULLAUSDT',
             'ZAMAUSDT','ONUSDT','PROMUSDT','AVAAIUSDT','MUSDT','UBUSDT','EPICUSDT','CHILLGUYUSDT')

$all = (Import-Csv "$here\gainers.csv").symbol
$ctrl = $all | Where-Object { $pumpers -notcontains $_ }   # full universe, no sampling

# listing age
$info = Invoke-RestMethod "https://fapi.binance.com/fapi/v1/exchangeInfo" -TimeoutSec 30
$onboard = @{}; $info.symbols | ForEach-Object { $onboard[$_.symbol] = $_.onboardDate }

function Get-Metrics($sym, $grp) {
    try { $k = Invoke-RestMethod "https://fapi.binance.com/fapi/v1/klines?symbol=$sym&interval=1h&limit=1000" -TimeoutSec 25 }
    catch { return $null }
    $n = $k.Count
    if ($n -lt 200) { return $null }

    $close = @(); $high = @(); $low = @(); $vol = @(); $ts = @()
    foreach ($b in $k) { $close += [double]$b[4]; $high += [double]$b[2]; $low += [double]$b[3]; $vol += [double]$b[7]; $ts += [long]$b[0] }

    # pump start = index maximizing 24h forward return (need 48h of history before it)
    $best = -999.0; $pi = -1
    for ($i = 48; $i -lt $n - 24; $i++) {
        if ($close[$i] -le 0) { continue }
        $r = ($close[$i+24] / $close[$i] - 1) * 100
        if ($r -gt $best) { $best = $r; $pi = $i }
    }
    if ($pi -lt 0) { return $null }

    # --- pre-window: 48h ending at pump start ---
    $pw = 48
    $pH = ($high[($pi-$pw)..($pi-1)] | Measure-Object -Maximum).Maximum
    $pL = ($low[($pi-$pw)..($pi-1)]  | Measure-Object -Minimum).Minimum
    $rangePct = if ($pL -gt 0) { ($pH/$pL - 1) * 100 } else { $null }

    # baseline range: the 48h window ending 7d earlier (is compression NEW?)
    $bi = $pi - 168
    $baseRange = $null
    if ($bi - $pw -ge 0) {
        $bH = ($high[($bi-$pw)..($bi-1)] | Measure-Object -Maximum).Maximum
        $bL = ($low[($bi-$pw)..($bi-1)]  | Measure-Object -Minimum).Minimum
        if ($bL -gt 0) { $baseRange = ($bH/$bL - 1) * 100 }
    }

    # volume dry-up: 48h avg vol vs prior 7d avg vol
    $vPre = ($vol[($pi-$pw)..($pi-1)] | Measure-Object -Average).Average
    $vBase = $null
    if ($pi - 216 -ge 0) { $vBase = ($vol[($pi-216)..($pi-$pw-1)] | Measure-Object -Average).Average }
    $volRatio = if ($vBase -gt 0) { $vPre / $vBase } else { $null }

    # where in the 48h range did it break from
    $posInRange = if ($pH -gt $pL) { ($close[$pi-1] - $pL) / ($pH - $pL) * 100 } else { $null }

    # prior trend: 14d return ending at pump start, and drawdown from 30d high
    $r14 = if ($pi - 336 -ge 0 -and $close[$pi-336] -gt 0) { ($close[$pi-1]/$close[$pi-336] - 1)*100 } else { $null }
    $r30 = if ($pi - 720 -ge 0 -and $close[$pi-720] -gt 0) { ($close[$pi-1]/$close[$pi-720] - 1)*100 } else { $null }
    $lookH = ($high[0..($pi-1)] | Measure-Object -Maximum).Maximum
    $ddFromHigh = if ($lookH -gt 0) { ($close[$pi-1]/$lookH - 1)*100 } else { $null }

    # green-candle share in pre-window (quiet accumulation?)
    $up = 0; for ($j = $pi-$pw; $j -lt $pi; $j++) { if ($close[$j] -gt $close[$j-1]) { $up++ } }

    $pumpTs = $ts[$pi]
    $ageDays = [math]::Round(((Get-Date).ToUniversalTime() - [datetimeoffset]::FromUnixTimeMilliseconds($onboard[$sym]).UtcDateTime).TotalDays, 0)

    # --- open interest over pre-window (30d retention only) ---
    $oiChg = $null
    try {
        $oi = Invoke-RestMethod "https://fapi.binance.com/futures/data/openInterestHist?symbol=$sym&period=1h&limit=500" -TimeoutSec 20
        $seg = $oi | Where-Object { [long]$_.timestamp -ge ($pumpTs - $pw*3600000) -and [long]$_.timestamp -le $pumpTs }
        if ($seg.Count -ge 10) {
            $a = [double]$seg[0].sumOpenInterest; $b = [double]$seg[-1].sumOpenInterest
            if ($a -gt 0) { $oiChg = ($b/$a - 1)*100 }
        }
    } catch {}

    # --- funding over pre-window ---
    $fundAvg = $null
    try {
        $f = Invoke-RestMethod "https://fapi.binance.com/fapi/v1/fundingRate?symbol=$sym&startTime=$($pumpTs - $pw*3600000)&endTime=$pumpTs&limit=100" -TimeoutSec 20
        if ($f.Count -ge 2) { $fundAvg = (($f | ForEach-Object { [double]$_.fundingRate }) | Measure-Object -Average).Average * 100 }
    } catch {}

    [pscustomobject]@{
        symbol     = $sym
        grp        = $grp
        pump24h    = [math]::Round($best,1)
        pumpDate   = [datetimeoffset]::FromUnixTimeMilliseconds($pumpTs).UtcDateTime.ToString('MM-dd HH:mm')
        ageDays    = $ageDays
        rangePct   = if ($rangePct -ne $null) { [math]::Round($rangePct,1) } else { $null }
        baseRange  = if ($baseRange -ne $null) { [math]::Round($baseRange,1) } else { $null }
        compress   = if ($baseRange -gt 0 -and $rangePct -ne $null) { [math]::Round($rangePct/$baseRange,2) } else { $null }
        volRatio   = if ($volRatio -ne $null) { [math]::Round($volRatio,2) } else { $null }
        posInRange = if ($posInRange -ne $null) { [math]::Round($posInRange,0) } else { $null }
        r14d       = if ($r14 -ne $null) { [math]::Round($r14,1) } else { $null }
        r30d       = if ($r30 -ne $null) { [math]::Round($r30,1) } else { $null }
        ddFromHigh = if ($ddFromHigh -ne $null) { [math]::Round($ddFromHigh,1) } else { $null }
        upBars     = $up
        oiChg48h   = if ($oiChg -ne $null) { [math]::Round($oiChg,1) } else { $null }
        fundAvgPct = if ($fundAvg -ne $null) { [math]::Round($fundAvg,4) } else { $null }
    }
}

$out = New-Object System.Collections.ArrayList
$i = 0
foreach ($s in $pumpers) { $i++; $m = Get-Metrics $s 'PUMP'; if ($m) { [void]$out.Add($m) } }
Write-Host "pumpers done"
foreach ($s in $ctrl) { $i++; if ($i % 20 -eq 0) { Write-Host "  $i" }; $m = Get-Metrics $s 'CTRL'; if ($m) { [void]$out.Add($m) } }

$out | Export-Csv "$here\prepump.csv" -NoTypeInformation -Encoding utf8
Write-Host "done: $($out.Count) rows"
