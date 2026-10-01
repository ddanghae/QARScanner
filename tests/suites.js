// One registry for the browser/app runner and alternate Node runner.
export const suiteFiles = [
  "indicators.test.js", "structure.test.js", "liquidity.test.js", "scoring.test.js",
  "golden-cross.test.js", "noise.test.js", "early-detect.test.js", "repaint.test.js",
  "refresh.test.js", "paper-corr.test.js", "strategies.test.js", "chart-patterns.test.js",
  "pattern-entry.test.js", "format.test.js", "scanner.test.js", "pattern-validation.test.js",
  "fractal-continuation.test.js", "aggressive.test.js",
  "trend-retest.test.js",
];
export const suites = await Promise.all(suiteFiles.map(file => import(`./${file}`)));
