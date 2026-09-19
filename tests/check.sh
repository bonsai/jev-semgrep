#!/bin/sh
# 自己検証: fixture.txt に対する OR / AND / 不一致 が期待どおりか。
# 境界付近の行(5, 28)は run ごとに ±0.05 ぶれるので、確実な正例・負例だけを見る。
set -e
cd "$(dirname "$0")"
# API キーはリポジトリ直下の .env (SEMGREP_ENV で上書き可)
export SEMGREP_ENV="${SEMGREP_ENV:-$PWD/../.env}"
J="node ../semgrep.mjs"
out=$($J -n -e 'ネットワークやリモート接続の障害' -e 'customer is asking for a refund' fixture.txt 2>/dev/null | cut -d: -f1)
for n in 4 6 7 13 30; do echo "$out" | grep -qx "$n"; done
for n in 1 8 11 15 26; do ! echo "$out" | grep -qx "$n"; done
[ "$($J -n -e 'ネットワークやリモート接続の障害' -a 'a retry is happening or was attempted' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "5 " ]
[ "$($J -n -e 'ネットワークやリモート接続の障害' -v 'a retry is happening or was attempted' fixture.txt 2>/dev/null | cut -d: -f1 | grep -cx 5)" = 0 ]
$J -n -v 'a timestamped server log line' fixture.txt 2>/dev/null | cut -d: -f1 | grep -qx 11
out=$($J -n -e 'customer is asking for a refund' -e '!a timestamped server log line' fixture.txt 2>/dev/null | cut -d: -f1)
for n in 7 11 20; do echo "$out" | grep -qx "$n"; done
! echo "$out" | grep -qx 4
if $J -e 'recipe for cooking pasta' fixture.txt 2>/dev/null; then exit 1; fi

# -l / -c / -r / -C の形式
[ "$($J -l -e 'customer is asking for a refund' fixture.txt 2>/dev/null)" = "fixture.txt" ]
[ "$($J -c -e 'customer is asking for a refund' fixture.txt 2>/dev/null)" = "1" ]
$J -r -l -e 'customer is asking for a refund' . 2>/dev/null | grep -qx './fixture.txt'
$J -n -C 1 -e 'customer is asking for a refund' fixture.txt 2>/dev/null | grep -qx '6-2026-09-19 08:02:35 ERROR timeout after 5000ms waiting for payment-gateway'
if $J -t 1.5 -e x fixture.txt 2>/dev/null; then exit 1; fi
if $J -C=1 -e x fixture.txt 2>/dev/null; then exit 1; fi
echo OK
