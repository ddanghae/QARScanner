import { suite, test, eq } from "./harness.js";
import { createHistoryEvent } from "../js/core/signal-history.js";
import { HISTORY_STORAGE_KEY, clearStoredHistory, loadHistory, saveHistory } from "../js/history/history-store.js";

function event() {
  return createHistoryEvent({
    scanMode: "reversal", symbol: "TESTUSDT", direction: "long", price: 100, score: 70,
    stage: { stage: 3 }, grade: { key: "watch" },
    plan: { entry: 100, stop: 95, invalidation: 95, tp1: 105, valid: true },
  }, 12_345);
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

export function run() {
  suite("history storage");

  test("버전된 기록을 저장하고 다시 읽는다", () => {
    const storage = memoryStorage();
    eq(saveHistory([event()], storage).ok, true, "저장 성공");
    const loaded = loadHistory(storage);
    eq(loaded.error, null, "읽기 오류 없음");
    eq(loaded.events.length, 1, "한 건 복원");
    eq(loaded.events[0].symbol, "TESTUSDT", "심볼 복원");
  });

  test("깨진 JSON은 빈 기록으로 fail closed", () => {
    const storage = memoryStorage();
    storage.setItem(HISTORY_STORAGE_KEY, "{broken");
    const loaded = loadHistory(storage);
    eq(loaded.events.length, 0, "빈 기록");
    eq(loaded.error, "HISTORY_READ_FAILED", "오류 표시");
  });

  test("지원하지 않는 스키마를 조용히 섞지 않는다", () => {
    const storage = memoryStorage();
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ version: 99, events: [event()] }));
    const loaded = loadHistory(storage);
    eq(loaded.events.length, 0, "구버전 혼합 금지");
    eq(loaded.error, "UNSUPPORTED_OR_INVALID_HISTORY", "버전 오류");
  });

  test("저장소 quota 오류가 스캔 예외로 전파되지 않는다", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
    const saved = saveHistory([event()], storage);
    eq(saved.ok, false, "저장 실패 반환");
    eq(saved.error, "HISTORY_WRITE_FAILED", "quota 은닉");
  });

  test("사용자 확인 후 기록 키만 삭제한다", () => {
    const storage = memoryStorage();
    storage.setItem("unrelated-setting", "keep-me");
    saveHistory([event()], storage);
    eq(clearStoredHistory(storage).ok, true, "삭제 성공");
    eq(loadHistory(storage).events.length, 0, "기록 비움");
    eq(storage.getItem("unrelated-setting"), "keep-me", "다른 설정 보존");
  });
}
