# Which extreme conditions actually precede big moves? Bucket lift vs base rate.
$d = Import-Csv "$PSScriptRoot\prepump.csv"
foreach ($row in $d) {
  $v = [double]$row.pump24h
  $row | Add-Member -NotePropertyName big -NotePropertyValue ($v -ge 40) -Force
}
$base = ($d | Where-Object { $_.big }).Count / $d.Count
"base rate (max24h >= 40%): {0:P0}  ({1}/{2})`n" -f $base, ($d | Where-Object { $_.big }).Count, $d.Count

function Lift($name, $pred) {
  $hit = @($d | Where-Object { & $pred $_ })
  if ($hit.Count -lt 4) { "{0,-34} n={1,-3} (too few)" -f $name, $hit.Count; return }
  $b = @($hit | Where-Object { $_.big }).Count
  $rate = $b / $hit.Count
  "{0,-34} n={1,-4} big={2,-3} rate={3,5:P0}  lift={4,5:N2}x" -f $name, $hit.Count, $b, $rate, ($rate / $base)
}
function Num($r, $c) { if ($r.$c -eq '' -or $r.$c -eq $null) { $null } else { [double]$r.$c } }

Lift 'funding < -0.03% (shorts crowded)' { param($r) (Num $r 'fundAvgPct') -ne $null -and (Num $r 'fundAvgPct') -lt -0.03 }
Lift 'funding > +0.02% (longs crowded)'  { param($r) (Num $r 'fundAvgPct') -ne $null -and (Num $r 'fundAvgPct') -gt 0.02 }
Lift 'OI 48h > +30%'                     { param($r) (Num $r 'oiChg48h') -ne $null -and (Num $r 'oiChg48h') -gt 30 }
Lift 'OI 48h < -10%'                     { param($r) (Num $r 'oiChg48h') -ne $null -and (Num $r 'oiChg48h') -lt -10 }
Lift 'compress < 0.5 (tight coil)'       { param($r) (Num $r 'compress') -ne $null -and (Num $r 'compress') -lt 0.5 }
Lift 'compress > 3 (already expanding)'  { param($r) (Num $r 'compress') -ne $null -and (Num $r 'compress') -gt 3 }
Lift 'volRatio > 3 (vol surge)'          { param($r) (Num $r 'volRatio') -ne $null -and (Num $r 'volRatio') -gt 3 }
Lift 'volRatio < 0.6 (vol dry-up)'       { param($r) (Num $r 'volRatio') -ne $null -and (Num $r 'volRatio') -lt 0.6 }
Lift 'posInRange > 80 (at range high)'   { param($r) (Num $r 'posInRange') -ne $null -and (Num $r 'posInRange') -gt 80 }
Lift 'posInRange < 20 (at range low)'    { param($r) (Num $r 'posInRange') -ne $null -and (Num $r 'posInRange') -lt 20 }
Lift 'ddFromHigh < -30% (beaten down)'   { param($r) (Num $r 'ddFromHigh') -ne $null -and (Num $r 'ddFromHigh') -lt -30 }
Lift 'ddFromHigh > -10% (near high)'     { param($r) (Num $r 'ddFromHigh') -ne $null -and (Num $r 'ddFromHigh') -gt -10 }
Lift 'r14d > +25% (uptrend)'             { param($r) (Num $r 'r14d') -ne $null -and (Num $r 'r14d') -gt 25 }
Lift 'r14d < -25% (downtrend)'           { param($r) (Num $r 'r14d') -ne $null -and (Num $r 'r14d') -lt -25 }
Lift 'listed < 400d'                     { param($r) (Num $r 'ageDays') -lt 400 }
Lift 'listed > 600d'                     { param($r) (Num $r 'ageDays') -gt 600 }
"`n--- combos ---"
Lift 'OI>+30% AND volRatio>3'            { param($r) (Num $r 'oiChg48h') -gt 30 -and (Num $r 'volRatio') -gt 3 }
Lift 'compress>3 AND volRatio>3'         { param($r) (Num $r 'compress') -gt 3 -and (Num $r 'volRatio') -gt 3 }
Lift 'listed<400d AND ddFromHigh<-20%'   { param($r) (Num $r 'ageDays') -lt 400 -and (Num $r 'ddFromHigh') -lt -20 }
