$d = Import-Csv "$PSScriptRoot\prepump.csv"

function Stat($vals) {
  $x = @($vals | Where-Object { $_ -ne '' -and $_ -ne $null } | ForEach-Object { [double]$_ } | Sort-Object)
  if ($x.Count -eq 0) { return @{ med = 'n/a'; n = 0 } }
  $m = if ($x.Count % 2) { $x[[int](($x.Count - 1) / 2)] } else { ($x[$x.Count / 2 - 1] + $x[$x.Count / 2]) / 2 }
  @{ med = [math]::Round($m, 2); n = $x.Count }
}

# regroup by actual max-24h move, not by the 30d list
foreach ($row in $d) {
  $v = [double]$row.pump24h
  $t = if ($v -ge 40) { 'A_BIG40+' } elseif ($v -ge 15) { 'B_MID' } else { 'C_QUIET' }
  $row | Add-Member -NotePropertyName tier -NotePropertyValue $t -Force
}

$d | Group-Object tier | Sort-Object Name | Format-Table Name, Count -AutoSize | Out-String -Width 100
$cols = 'pump24h','rangePct','baseRange','compress','volRatio','posInRange','r14d','ddFromHigh','upBars','oiChg48h','fundAvgPct','ageDays'
$tiers = 'A_BIG40+','B_MID','C_QUIET'
"{0,-12}{1,14}{2,14}{3,14}" -f 'metric(med)', $tiers[0], $tiers[1], $tiers[2]
"-" * 54
foreach ($col in $cols) {
  $line = "{0,-12}" -f $col
  foreach ($t in $tiers) {
    $s = Stat (($d | Where-Object { $_.tier -eq $t }).$col)
    $line += "{0,14}" -f "$($s.med) (n$($s.n))"
  }
  $line
}

"`n=== A_BIG40+ full list ==="
$d | Where-Object { $_.tier -eq 'A_BIG40+' } | Sort-Object { [double]$_.pump24h } -Descending |
  Format-Table symbol, pump24h, pumpDate, compress, volRatio, posInRange, r14d, ddFromHigh, oiChg48h, fundAvgPct -AutoSize | Out-String -Width 220
