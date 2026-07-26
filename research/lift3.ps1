$d = Import-Csv "$PSScriptRoot\prepump2.csv"
foreach ($r in $d) { $r | Add-Member -NotePropertyName big -NotePropertyValue ([double]$r.pump24h -ge 40) -Force }
$base = @($d | Where-Object { $_.big }).Count / $d.Count
function Num($r, $c) { if ($r.$c -eq '' -or $null -eq $r.$c) { $null } else { [double]$r.$c } }
function Show($label, $hit) {
  if ($hit.Count -lt 8) { "{0,-42} n={1,-4} (too few)" -f $label, $hit.Count; return }
  $rate = @($hit | Where-Object { $_.big }).Count / $hit.Count
  "{0,-42} n={1,-4} rate={2,5:P0}  lift={3,5:N2}x" -f $label, $hit.Count, $rate, ($rate/$base)
}

"base = {0:P0}`n" -f $base
"--- r14dLag buckets (prior 14d trend, measured 24h before pump) ---"
foreach ($b in @(@('< -40%',-9999,-40), @('-40..-15%',-40,-15), @('-15..0%',-15,0), @('0..+15%',0,15), @('+15..+40%',15,40), @('> +40%',40,99999))) {
  Show $b[0] @($d | Where-Object { $v = Num $_ 'r14dLag'; $null -ne $v -and $v -ge $b[1] -and $v -lt $b[2] })
}

"`n--- combos, all measured at LAG (strictly before the move) ---"
Show 'volRatioLag>2 AND compressLag>2'      @($d | Where-Object { (Num $_ 'volRatioLag') -gt 2 -and (Num $_ 'compressLag') -gt 2 })
Show 'volRatioLag>2 AND ddLag<-30%'         @($d | Where-Object { (Num $_ 'volRatioLag') -gt 2 -and (Num $_ 'ddLag') -lt -30 })
Show 'ageDays<400 AND volRatioLag>2'        @($d | Where-Object { [double]$_.ageDays -lt 400 -and (Num $_ 'volRatioLag') -gt 2 })
Show 'ageDays<400 AND ddLag<-30%'           @($d | Where-Object { [double]$_.ageDays -lt 400 -and (Num $_ 'ddLag') -lt -30 })
Show 'abs(fundLag)>0.02 (crowded either way)' @($d | Where-Object { $v = Num $_ 'fundLag'; $null -ne $v -and [math]::Abs($v) -gt 0.02 })
Show 'abs(fundLag)<0.006 (neutral funding)' @($d | Where-Object { $v = Num $_ 'fundLag'; $null -ne $v -and [math]::Abs($v) -lt 0.006 })
Show 'coiled+quiet: compressLag<0.7 & volRatioLag<0.7' @($d | Where-Object { (Num $_ 'compressLag') -lt 0.7 -and (Num $_ 'volRatioLag') -lt 0.7 })
Show 'ageDays<400 & ddLag<-30 & volRatioLag>1.5' @($d | Where-Object { [double]$_.ageDays -lt 400 -and (Num $_ 'ddLag') -lt -30 -and (Num $_ 'volRatioLag') -gt 1.5 })

"`n--- what the big movers looked like 24h before (medians) ---"
function Med($v) { $x=@($v | Where-Object { $_ -ne '' -and $null -ne $_ } | ForEach-Object {[double]$_} | Sort-Object); if(!$x.Count){return 'n/a'}; $m = if($x.Count%2){$x[[int](($x.Count-1)/2)]}else{($x[$x.Count/2-1]+$x[$x.Count/2])/2}; "$([math]::Round($m,2)) (n$($x.Count))" }
$B = @($d | Where-Object { $_.big }); $Q = @($d | Where-Object { -not $_.big })
"{0,-14}{1,18}{2,18}" -f 'metricLag','BIG(>=40%)','REST'
foreach ($col in 'compressLag','volRatioLag','posLag','r14dLag','ddLag','oiLag','fundLag','ageDays') {
  "{0,-14}{1,18}{2,18}" -f $col, (Med $B.$col), (Med $Q.$col)
}
