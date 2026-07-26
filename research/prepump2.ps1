# v2: same metrics measured at TWO windows to separate prediction from leakage.
#   T0  window = 48h ending AT pump start   (may already contain the early leg)
#   LAG window = 48h ending 24h BEFORE pump start (strictly ahead of the move)
param([int]$daysBack = 0, [string]$outFile = 'prepump2.csv')
$ErrorActionPreference = 'Stop'
# daysBack>0 = out-of-sample: shift the whole 1000h window back. OI hist only keeps 30d, so OI is null there.
$endMs = if ($daysBack -gt 0) { [DateTimeOffset]::UtcNow.AddDays(-$daysBack).ToUnixTimeMilliseconds() } else { $null }
$here = "C:\Users\anny\AppData\Local\Temp\claude\C--Users-anny-Documents-pine\6bb0ed98-aad4-48f1-ba02-681ef753b307\scratchpad"
$syms = (Import-Csv "$here\gainers.csv").symbol
$info = Invoke-RestMethod "https://fapi.binance.com/fapi/v1/exchangeInfo" -TimeoutSec 30
$onboard = @{}; $info.symbols | ForEach-Object { $onboard[$_.symbol] = $_.onboardDate }

$out = New-Object System.Collections.ArrayList
$n = 0
foreach ($sym in $syms) {
    $n++
    if ($n % 100 -eq 0) { Write-Host "  $n/$($syms.Count)" }
    $kUrl = "https://fapi.binance.com/fapi/v1/klines?symbol=$sym&interval=1h&limit=1000"
    if ($endMs) { $kUrl += "&endTime=$endMs" }
    try { $k = Invoke-RestMethod $kUrl -TimeoutSec 25 }
    catch { continue }
    $nb = $k.Count
    if ($nb -lt 300) { continue }

    $close=@(); $high=@(); $low=@(); $vol=@(); $ts=@()
    foreach ($b in $k) { $close+=[double]$b[4]; $high+=[double]$b[2]; $low+=[double]$b[3]; $vol+=[double]$b[7]; $ts+=[long]$b[0] }

    # pump start = bar maximizing forward 24h return; need 72+48 bars of history behind it
    $best=-999.0; $pi=-1
    for ($i=240; $i -lt $nb-24; $i++) {
        if ($close[$i] -le 0) { continue }
        $r = ($close[$i+24]/$close[$i] - 1)*100
        if ($r -gt $best) { $best=$r; $pi=$i }
    }
    if ($pi -lt 0) { continue }

    # window metrics ending at index $e (exclusive)
    function Win($e) {
        $w=48
        $H=($high[($e-$w)..($e-1)] | Measure-Object -Maximum).Maximum
        $L=($low[($e-$w)..($e-1)]  | Measure-Object -Minimum).Minimum
        $rng = if ($L -gt 0) { ($H/$L-1)*100 } else { $null }
        $bH=($high[($e-$w-168)..($e-$w-121)] | Measure-Object -Maximum).Maximum   # 48h window one week earlier
        $bL=($low[($e-$w-168)..($e-$w-121)]  | Measure-Object -Minimum).Minimum
        $base = if ($bL -gt 0) { ($bH/$bL-1)*100 } else { $null }
        $vP=($vol[($e-$w)..($e-1)] | Measure-Object -Average).Average
        $vB=($vol[($e-216)..($e-$w-1)] | Measure-Object -Average).Average
        @{
            compress = if ($base -gt 0 -and $rng -ne $null) { [math]::Round($rng/$base,2) } else { $null }
            volRatio = if ($vB -gt 0) { [math]::Round($vP/$vB,2) } else { $null }
            pos      = if ($H -gt $L) { [math]::Round(($close[$e-1]-$L)/($H-$L)*100,0) } else { $null }
            r14      = if ($close[$e-336] -gt 0) { [math]::Round(($close[$e-1]/$close[$e-336]-1)*100,1) } else { $null }
            dd       = [math]::Round(($close[$e-1]/(($high[0..($e-1)] | Measure-Object -Maximum).Maximum)-1)*100,1)
        }
    }
    $t0  = Win $pi
    $lag = Win ($pi-24)

    function OiFund($endTs) {
        $oi=$null; $fd=$null
        if (-not $endMs) {
        try {
            $h = Invoke-RestMethod "https://fapi.binance.com/futures/data/openInterestHist?symbol=$sym&period=1h&limit=500" -TimeoutSec 20
            $seg = $h | Where-Object { [long]$_.timestamp -ge ($endTs - 48*3600000) -and [long]$_.timestamp -le $endTs }
            if ($seg.Count -ge 10) { $a=[double]$seg[0].sumOpenInterest; if ($a -gt 0) { $oi=[math]::Round(([double]$seg[-1].sumOpenInterest/$a-1)*100,1) } }
        } catch {}
        }
        try {
            $f = Invoke-RestMethod "https://fapi.binance.com/fapi/v1/fundingRate?symbol=$sym&startTime=$($endTs-48*3600000)&endTime=$endTs&limit=100" -TimeoutSec 20
            if ($f.Count -ge 2) { $fd=[math]::Round(((($f | ForEach-Object {[double]$_.fundingRate}) | Measure-Object -Average).Average*100),4) }
        } catch {}
        @{ oi=$oi; fd=$fd }
    }
    $m0 = OiFund $ts[$pi]
    $mL = OiFund $ts[$pi-24]

    [void]$out.Add([pscustomobject]@{
        symbol=$sym; pump24h=[math]::Round($best,1)
        pumpDate=[datetimeoffset]::FromUnixTimeMilliseconds($ts[$pi]).UtcDateTime.ToString('MM-dd HH:mm')
        ageDays=[math]::Round(((Get-Date).ToUniversalTime()-[datetimeoffset]::FromUnixTimeMilliseconds($onboard[$sym]).UtcDateTime).TotalDays,0)
        compress=$t0.compress; volRatio=$t0.volRatio; pos=$t0.pos; r14d=$t0.r14; dd=$t0.dd; oi=$m0.oi; fund=$m0.fd
        compressLag=$lag.compress; volRatioLag=$lag.volRatio; posLag=$lag.pos; r14dLag=$lag.r14; ddLag=$lag.dd; oiLag=$mL.oi; fundLag=$mL.fd
    })
}
$out | Export-Csv "$here\$outFile" -NoTypeInformation -Encoding utf8
Write-Host "done: $($out.Count) rows"
