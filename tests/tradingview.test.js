// tests/tradingview.test.js — QAR → TradingView 심볼/15분봉 전달 계약.

import { suite, test, eq } from "./harness.js";
import { tvSymbol, tvChartUrl } from "../js/ui/tradingview.js";

export function run() {
  suite("tradingview handoff");

  test("Binance USD-M 무기한 심볼로 변환", () => {
    eq(tvSymbol("BTCUSDT"), "BINANCE:BTCUSDT.P");
  });

  test("Pine v3.4 권장 15분봉을 URL에 명시", () => {
    eq(
      tvChartUrl("BTCUSDT"),
      "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT.P&interval=15",
    );
  });
}

export default { run };
