// Versioned browser persistence for scanner history. Storage failures never stop scans.

import {
  HISTORY_SCHEMA_VERSION,
  MAX_HISTORY_EVENTS,
  sanitizeHistoryEvents,
} from "../core/signal-history.js";

export const HISTORY_STORAGE_KEY = "qar-scan-history-v1";

function resolveStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage; } catch { return null; }
}

export function loadHistory(storage) {
  const target = resolveStorage(storage);
  if (!target) return { events: [], error: "STORAGE_UNAVAILABLE" };
  try {
    const raw = target.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return { events: [], error: null };
    const parsed = JSON.parse(raw);
    if (parsed?.version !== HISTORY_SCHEMA_VERSION || !Array.isArray(parsed?.events)) {
      return { events: [], error: "UNSUPPORTED_OR_INVALID_HISTORY" };
    }
    return { events: sanitizeHistoryEvents(parsed.events), error: null };
  } catch {
    return { events: [], error: "HISTORY_READ_FAILED" };
  }
}

export function saveHistory(events, storage) {
  const target = resolveStorage(storage);
  if (!target) return { ok: false, error: "STORAGE_UNAVAILABLE" };
  try {
    const payload = {
      version: HISTORY_SCHEMA_VERSION,
      savedAt: Date.now(),
      events: sanitizeHistoryEvents(events, MAX_HISTORY_EVENTS),
    };
    target.setItem(HISTORY_STORAGE_KEY, JSON.stringify(payload));
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "HISTORY_WRITE_FAILED" };
  }
}

export function clearStoredHistory(storage) {
  const target = resolveStorage(storage);
  if (!target) return { ok: false, error: "STORAGE_UNAVAILABLE" };
  try {
    target.removeItem(HISTORY_STORAGE_KEY);
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "HISTORY_CLEAR_FAILED" };
  }
}

export default { loadHistory, saveHistory, clearStoredHistory, HISTORY_STORAGE_KEY };
