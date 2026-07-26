# Out-of-sample: does the LAG-window signal hold in earlier windows?
$here = $PSScriptRoot
function Num($r, $c) { if ($r.$c -eq '' -or $null -eq $r.$c) { $null } else { [double]$r.$c } }

$sets = @(
  @{ name = 'IN  (now-41d)'; file = 'prepump2.csv' },
  @{ name = 'OOS-A (-42d)';  file = 'oos_a.csv' },
  @{ name = 'OOS-B (-84d)';  file = 'oos_b.csv' }
)
$data = @{}
foreach ($s in $sets) {
  $d = Import-Csv "$here\$($s.file)"
  foreach ($r in $d) { $r | Add-Member -NotePropertyName big -NotePropertyValue ([double]$r.pump24h -ge 40) -Force }
  $data[$s.name] = $d
}

function Line($label, $pred) {
  $out = "{0,-32}" -f $label
  foreach ($s in $sets) {
    $d = $data[$s.name]
    $base = @($d | Where-Object { $_.big }).Count / $d.Count
    $hit = @($d | Where-Object { & $pred $_ })
    if ($hit.Count -lt 8) { $out += "{0,17}" -f "n=$($hit.Count) --"; continue }
    $rate = @($hit | Where-Object { $_.big }).Count / $hit.Count
    $out += "{0,17}" -f ("n={0} {1:N2}x" -f $hit.Count, ($rate / $base))
  }
  $out
}

$hdr = "{0,-32}" -f 'condition (LAG window)'
foreach ($s in $sets) { $hdr += "{0,17}" -f $s.name }
$hdr
"-" * 83
$bl = "{0,-32}" -f 'BASE RATE'
foreach ($s in $sets) { $d = $data[$s.name]; $bl += "{0,17}" -f ("{0}/{1} {2:P0}" -f @($d | Where-Object { $_.big }).Count, $d.Count, (@($d | Where-Object { $_.big }).Count / $d.Count)) }
$bl
""
Line 'r14dLag > +40%'            { param($r) (Num $r 'r14dLag') -gt 40 }
Line 'r14dLag > +25%'            { param($r) (Num $r 'r14dLag') -gt 25 }
Line 'r14dLag < -40%'            { param($r) (Num $r 'r14dLag') -lt -40 }
Line 'r14dLag -15..+15 (DEAD)'   { param($r) $v=Num $r 'r14dLag'; $null -ne $v -and $v -gt -15 -and $v -lt 15 }
Line 'volRatioLag > 3'           { param($r) (Num $r 'volRatioLag') -gt 3 }
Line 'volRatioLag > 2'           { param($r) (Num $r 'volRatioLag') -gt 2 }
Line 'volRatioLag < 0.6 (dryup)' { param($r) $v=Num $r 'volRatioLag'; $null -ne $v -and $v -lt 0.6 }
Line 'compressLag > 3'           { param($r) (Num $r 'compressLag') -gt 3 }
Line 'compressLag < 0.5 (coil)'  { param($r) $v=Num $r 'compressLag'; $null -ne $v -and $v -lt 0.5 }
Line 'abs(fundLag) > 0.02%'      { param($r) $v=Num $r 'fundLag'; $null -ne $v -and [math]::Abs($v) -gt 0.02 }
Line 'abs(fundLag) < 0.006%'     { param($r) $v=Num $r 'fundLag'; $null -ne $v -and [math]::Abs($v) -lt 0.006 }
Line 'ddLag < -30%'              { param($r) (Num $r 'ddLag') -lt -30 }
Line 'posLag < 20 (range low)'   { param($r) $v=Num $r 'posLag'; $null -ne $v -and $v -lt 20 }
Line 'ageDays < 300'             { param($r) [double]$r.ageDays -lt 300 }
Line 'ageDays > 800'             { param($r) [double]$r.ageDays -gt 800 }
""
Line 'COMBO |fund|>.02 & |r14d|>25' { param($r) $f=Num $r 'fundLag'; $t=Num $r 'r14dLag'; $null -ne $f -and $null -ne $t -and [math]::Abs($f) -gt 0.02 -and [math]::Abs($t) -gt 25 }
Line 'COMBO volLag>2 & compLag>2'   { param($r) (Num $r 'volRatioLag') -gt 2 -and (Num $r 'compressLag') -gt 2 }
Line 'COMBO coil: comp<.7 & vol<.7' { param($r) $c=Num $r 'compressLag'; $v=Num $r 'volRatioLag'; $null -ne $c -and $null -ne $v -and $c -lt 0.7 -and $v -lt 0.7 }
