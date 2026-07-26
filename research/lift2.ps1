$d = Import-Csv "$PSScriptRoot\prepump2.csv"
foreach ($r in $d) { $r | Add-Member -NotePropertyName big -NotePropertyValue ([double]$r.pump24h -ge 40) -Force }
$base = @($d | Where-Object { $_.big }).Count / $d.Count
"base rate (max24h >= 40%): {0:P0}  ({1}/{2})" -f $base, @($d | Where-Object { $_.big }).Count, $d.Count
"T0  = 48h ending AT pump start   |   LAG = 48h ending 24h BEFORE pump start`n"

function Num($r, $c) { if ($r.$c -eq '' -or $null -eq $r.$c) { $null } else { [double]$r.$c } }
function Row($label, $col, $op, $thr) {
  $line = "{0,-30}" -f $label
  foreach ($c in @($col, ($col + 'Lag'))) {
    $hit = @($d | Where-Object { $v = Num $_ $c; $null -ne $v -and (& $op $v $thr) })
    if ($hit.Count -lt 8) { $line += "{0,20}" -f "n=$($hit.Count) --" ; continue }
    $rate = @($hit | Where-Object { $_.big }).Count / $hit.Count
    $line += "{0,20}" -f ("n={0} {1:P0} {2:N2}x" -f $hit.Count, $rate, ($rate/$base))
  }
  $line
}
$gt = { param($v,$t) $v -gt $t }; $lt = { param($v,$t) $v -lt $t }

"{0,-30}{1,20}{2,20}" -f 'condition', 'T0 (at pump)', 'LAG (24h earlier)'
"-" * 70
Row 'compress > 3 (expanding)'   'compress' $gt 3
Row 'compress < 0.5 (coiled)'    'compress' $lt 0.5
Row 'volRatio > 3 (vol surge)'   'volRatio' $gt 3
Row 'volRatio < 0.6 (dry-up)'    'volRatio' $lt 0.6
Row 'pos > 80 (at range high)'   'pos'      $gt 80
Row 'pos < 20 (at range low)'    'pos'      $lt 20
Row 'r14d > +25%'                'r14d'     $gt 25
Row 'r14d < -25%'                'r14d'     $lt -25
Row 'dd < -30% (beaten down)'    'dd'       $lt -30
Row 'dd > -10% (near high)'      'dd'       $gt -10
Row 'OI 48h > +20%'              'oi'       $gt 20
Row 'OI 48h < -10%'              'oi'       $lt -10
Row 'funding < -0.03%'           'fund'     $lt -0.03
Row 'funding > +0.02%'           'fund'     $gt 0.02

"`n--- age (no leakage possible) ---"
foreach ($b in @(@('<300d',0,300), @('300-500d',300,500), @('500-800d',500,800), @('>800d',800,99999))) {
  $hit = @($d | Where-Object { [double]$_.ageDays -ge $b[1] -and [double]$_.ageDays -lt $b[2] })
  if ($hit.Count -eq 0) { continue }
  $rate = @($hit | Where-Object { $_.big }).Count / $hit.Count
  "{0,-12} n={1,-4} rate={2,5:P0}  lift={3,5:N2}x" -f $b[0], $hit.Count, $rate, ($rate/$base)
}
