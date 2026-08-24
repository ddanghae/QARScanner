// Connects completed scans, local persistence, and bounded public Binance outcome refreshes.

import { state, emit, on } from "../state.js";
import { getKlinesRange } from "../api/binance.js";
import {
  FIVE_MIN_MS,
  MAX_HISTORY_EVENTS,
  evaluateHistoryEvent,
  historyRangeEnd,
  mergeScanResults,
  outcomeRefreshDue,
} from "../core/signal-history.js";
import { clearStoredHistory, loadHistory, saveHistory } from "./history-store.js";

const REFRESH_BATCH = 20;
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;
let initialized = false;

function setStorageIssue(error) {
  state.history.storageIssue = error || null;
  if (error) emit("history:error", error);
}

function persist() {
  const result = saveHistory(state.history.events);
  setStorageIssue(result.error);
  return result;
}

export function initHistoryController() {
  if (initialized) return;
  initialized = true;
  const loaded = loadHistory();
  state.history.events = loaded.events;
  state.history.storageIssue = loaded.error;
  on("scan:done", (info = {}) => {
    recordScanResults(state.results, info.completedAt || state.scan.lastUpdated || Date.now(), {
      provisional: Boolean(info.provisional),
    });
  });
}

export function recordScanResults(results, completedAt, options = {}) {
  const merged = mergeScanResults(state.history.events, results, completedAt, {
    provisional: Boolean(options.provisional),
    maxEvents: MAX_HISTORY_EVENTS,
  });
  if (merged.created || merged.updated) {
    state.history.events = merged.events;
    persist();
    emit("history:changed", { reason: "scan", ...merged });
  }
  emit("history:recorded", {
    created: merged.created,
    updated: merged.updated,
    ignored: merged.ignored,
  });
  return merged;
}

function replaceEvent(updated) {
  const index = state.history.events.findIndex((event) => event.id === updated.id);
  if (index < 0) return false;
  state.history.events = state.history.events.map((event, i) => i === index ? updated : event);
  return true;
}

export async function refreshHistoryOutcomes(options = {}) {
  if (state.history.refreshing) return { requested: 0, updated: 0, failed: 0, busy: true };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const batchSize = Math.min(100, Math.max(1, Math.floor(options.batchSize) || REFRESH_BATCH));
  const due = state.history.events
    .filter((event) => outcomeRefreshDue(event, now, {
      force: Boolean(options.force),
      cooldownMs: RETRY_COOLDOWN_MS,
    }))
    .sort((a, b) => a.paper.entryTime - b.paper.entryTime)
    .slice(0, batchSize);

  state.history.refreshing = true;
  state.history.lastError = null;
  emit("history:refresh:start", { requested: due.length });
  let updated = 0;
  let failed = 0;
  const errors = [];
  try {
    for (let i = 0; i < due.length; i++) {
      const event = due[i];
      try {
        const endTime = historyRangeEnd(event, now);
        if (endTime == null) continue;
        const limit = Math.min(1500, Math.ceil((endTime - event.paper.entryTime + 1) / FIVE_MIN_MS) + 1);
        const candles = await getKlinesRange(event.symbol, "5m", event.paper.entryTime, endTime, limit);
        const evaluated = evaluateHistoryEvent(event, candles, now);
        if (replaceEvent(evaluated)) updated++;
      } catch (error) {
        failed++;
        errors.push(`${event.symbol}: ${error.message}`);
      }
      emit("history:refresh:progress", { done: i + 1, total: due.length, updated, failed });
    }
    if (updated) persist();
    state.history.lastRefreshAt = now;
    state.history.lastError = errors.length ? errors.join(" | ") : null;
    emit("history:changed", { reason: "outcomes", updated, failed });
    emit("history:refresh:done", { requested: due.length, updated, failed });
    return { requested: due.length, updated, failed, busy: false };
  } finally {
    state.history.refreshing = false;
  }
}

export function clearHistoryRecords() {
  const cleared = clearStoredHistory();
  if (!cleared.ok) {
    setStorageIssue(cleared.error);
    return cleared;
  }
  state.history.events = [];
  state.history.lastError = null;
  state.history.lastRefreshAt = 0;
  setStorageIssue(null);
  emit("history:changed", { reason: "clear" });
  return cleared;
}

export default {
  initHistoryController,
  recordScanResults,
  refreshHistoryOutcomes,
  clearHistoryRecords,
};
