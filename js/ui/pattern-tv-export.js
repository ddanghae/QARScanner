// Snapshot of the scanner's actual detections for the manually pasted Pine overlay.
import { tvSymbol } from "./tradingview.js";

const TV_TIMEFRAMES = { "5m": "5", "15m": "15", "1h": "60", "4h": "240" };
const MAX_RECORDS = 80;
const MAX_CHARS = 39000; // TradingView text_area strings are limited to 40,960 characters.

const numberField = (value) => {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "na";
  return Number(value).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
};
const timeField = (value) => value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0
  ? String(Number(value)) : "na";
const textField = (value) => String(value ?? "").replace(/[|\r\n]/g, " ").trim().slice(0, 80);
const hasPrice = (value) => value != null && Number.isFinite(Number(value)) && Number(value) > 0;

function serializePattern(pattern, timeframe, detail, candidate, fallbackPrice) {
  const detectedAt = timeField(detail.detectedAt);
  if (detectedAt === "na") return null;
  const selected = candidate?.patternId === pattern.id && candidate.timeframe === timeframe
    && hasPrice(candidate.entryLow) && hasPrice(candidate.entryHigh)
    && hasPrice(candidate.stop) && hasPrice(candidate.tp1)
    && hasPrice(candidate.tp2) && hasPrice(candidate.tp3);
  const points = Array.isArray(detail.points) ? detail.points.slice(0, 5) : [];
  const pointFields = Array.from({ length: 5 }, (_, index) => [
    timeField(points[index]?.time), numberField(points[index]?.price),
  ]).flat();
  const fields = [
    "P", TV_TIMEFRAMES[timeframe], detectedAt, textField(pattern.name),
    { bullish: "L", bearish: "S", neutral: "N" }[detail.bias] || "N",
    { breakout: "B", reaction: "R", forming: "F" }[detail.status] || "F",
    numberField(detail.fitScore), numberField(detail.completionPct),
    numberField(detail.detectedPrice ?? fallbackPrice),
    numberField(detail.trigger), numberField(detail.invalidation), numberField(detail.projection),
    numberField(detail.zone?.low), numberField(detail.zone?.high),
    selected ? numberField(candidate.entryLow) : "na",
    selected ? numberField(candidate.entryHigh) : "na",
    selected ? numberField(candidate.stop) : "na",
    selected ? numberField(candidate.tp1) : "na",
    selected ? numberField(candidate.tp2) : "na",
    selected ? numberField(candidate.tp3) : "na",
    ...pointFields,
  ];
  return { line: fields.join("|"), selected, fitScore: Number(detail.fitScore) || 0 };
}

export function buildPatternTvSnapshot(row, { exportedAt = Date.now(), includeRealtimeCandle = false } = {}) {
  if (!/^[A-Z0-9_]{3,30}$/.test(row?.symbol || "")) throw new Error("TradingView 종목 코드가 올바르지 않습니다.");
  const exportedTime = Number.isFinite(Number(exportedAt)) ? Number(exportedAt) : Date.now();
  const header = ["QAR1", tvSymbol(row.symbol), new Date(exportedTime).toISOString(), includeRealtimeCandle ? "R" : "C"].join("|");
  const records = [];
  let missingAnchors = 0;
  for (const pattern of row.patterns || []) {
    for (const timeframe of Object.keys(TV_TIMEFRAMES)) {
      const detail = pattern.timeframes?.[timeframe];
      if (!detail) continue;
      const record = serializePattern(pattern, timeframe, detail, row.entryCandidate, row.price);
      if (record) records.push(record);
      else missingAnchors++;
    }
  }
  records.sort((a, b) => Number(b.selected) - Number(a.selected) || b.fitScore - a.fitScore);
  const lines = [header];
  let omitted = missingAnchors;
  for (const record of records) {
    const nextLength = lines.join("\n").length + 1 + record.line.length;
    if (lines.length - 1 >= MAX_RECORDS || nextLength > MAX_CHARS) { omitted++; continue; }
    lines.push(record.line);
  }
  return { text: lines.join("\n"), count: lines.length - 1, omitted };
}
