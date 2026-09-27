# QARScanner project instructions

## Project shape

- Static browser app built with HTML, CSS, and JavaScript ES modules.
- The scanner produces research candidates; it does not place orders.
- Binance access uses public endpoints. Never add private keys or order execution to the app.
- Keep signal detection, risk calculations, and UI changes covered by deterministic tests.

## Development checks

- Run `npm test` for syntax checks, local preview-server checks, app tests, and the alternate Node test runner.
- Run `npm run serve` to preview the app at `http://127.0.0.1:8080`.
- The preview server may expose static app assets and the user-facing chart pattern guide only. Do not expose research files, Git metadata, or project instructions.

## Signal and backtest rules

- Use only candles available at the signal timestamp; do not introduce lookahead or unfinished-candle leakage.
- Keep candidate detection separate from entry, sizing, and order execution.
- Preserve stop-loss, take-profit, expiry, and risk guards when changing signal logic.
- Do not tune rules against the final evaluation period or describe unvalidated results as proven performance.
- Keep pattern-specific detections identifiable; do not silently blend their evidence into one score.
