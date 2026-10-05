import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { validateEvent, EVENT_TYPES, AGGREGATE_TYPES, EVENT_AGGREGATE } from "../src/validator.js";
import { EventStore } from "../src/store/event-store.js";
import { GovernanceError } from "../src/errors.js";

const mkdtempP = promisify(mkdtemp);
const rmP = promisify(rm);

const baseEvent = (overrides = {}) => ({
  event_id: "e1",
  event_type: "RUN_BATCH_REGISTERED",
  aggregate_type: "run_batch",
  aggregate_id: "b1",
  occurred_at: "2026-10-05T09:00:00Z",
  version: 1,
  summary: "登记批次",
  payload: { batch_id: "b1", label: "序列A" },
  ...overrides,
});

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("事件类型与聚合类型一一对应（撤权标记除外，随被标记物而定）", () => {
  for (const type of EVENT_TYPES) {
    if (type === "DERIVATIVE_FLAGGED") continue;
    assert.ok(AGGREGATE_TYPES.includes(EVENT_AGGREGATE[type]), `${type} -> ${EVENT_AGGREGATE[type]}`);
  }
});

test("事件信封缺字段、错误版本、类型不匹配都会被拒绝", () => {
  assert.match(validateEvent({ ...baseEvent(), version: 0 }).join(), /version 必须是正整数/);
  assert.match(
    validateEvent({ ...baseEvent(), event_type: "RUN_COMPLETED", aggregate_type: "run_batch" }).join(),
    /必须归属聚合 model_run/,
  );
  assert.match(
    validateEvent({ ...baseEvent(), payload: { batch_id: "b1" } }).join(),
    /payload 缺少字段：label/,
  );
});

test("撤权标记的聚合类型必须随被标记物种类，且原因固定为同意撤权", () => {
  const flag = (overrides = {}) =>
    validateEvent({
      ...baseEvent(),
      event_type: "DERIVATIVE_FLAGGED",
      aggregate_type: "scientific_claim",
      payload: { artifact_id: "c1", artifact_kind: "scientific_claim", subject_ref: "s1", reason: "consent_withdrawn" },
      ...overrides,
    });

  assert.deepEqual(flag(), []);
  // aggregate_type 与 artifact_kind 不一致 → 拒绝。
  assert.match(
    flag({ aggregate_type: "model_run" }).join(),
    /aggregate_type 必须同为 scientific_claim/,
  );
  // 非撤权原因 → 拒绝。
  assert.match(
    flag({ payload: { artifact_id: "c1", artifact_kind: "scientific_claim", subject_ref: "s1", reason: "other" } }).join(),
    /reason 目前只允许 consent_withdrawn/,
  );
});

test("事件只追加：版本号必须连续，重复事件标识被拒绝", () => {
  const store = new EventStore();
  const commit = (event) => store.commit([event]);

  commit(baseEvent());
  assert.throws(
    () => commit(baseEvent()),
    (e) => e instanceof GovernanceError && e.code === "DUPLICATE_EVENT_ID",
  );
  assert.throws(
    () => commit(baseEvent({ event_id: "e2", version: 3 })),
    (e) => e.code === "VERSION_CONFLICT",
  );
  commit(baseEvent({ event_id: "e2", version: 2 }));

  // 读取顺序即追加顺序，且事件内容不被原地改写。
  const stored = store.all();
  assert.deepEqual(stored.map((e) => e.event_id), ["e1", "e2"]);
  stored[0].summary = "被外部改写";
  assert.equal(store.all()[0].summary, "登记批次");
});

test("同批事件先整体校验，任一不合法则整批不生效", () => {
  const store = new EventStore();
  const good = baseEvent();
  const bad = baseEvent({ event_id: "e2", version: 1, event_type: "UNKNOWN_TYPE" });
  assert.throws(
    () => store.commit([good, bad]),
    (e) => e instanceof GovernanceError && e.code === "INVALID_EVENT",
  );
  assert.equal(store.all().length, 0);
});

test("幂等键重放只取回首次结果，不产生第二个等价结果", () => {
  const store = new EventStore();
  const out1 = store.commit([baseEvent()], { idempotencyKey: "cmd-key-1", result: { ok: 1 } });
  const out2 = store.commit([baseEvent({ event_id: "e-other", version: 9 })], { idempotencyKey: "cmd-key-1" });
  assert.equal(out1.replay, false);
  assert.equal(out2.replay, true);
  assert.deepEqual(out2.result, { ok: 1 });
  assert.deepEqual(store.all().map((e) => e.event_id), ["e1"]);
});

test("JSONL 日志可重放还原谱系与幂等台账", async () => {
  const dir = await mkdtempP(join(tmpdir(), "federation-"));
  try {
    const file = join(dir, "journal.jsonl");
    const store1 = new EventStore({ journalFile: file });
    store1.commit([baseEvent()], { idempotencyKey: "k1", commandId: "cmd-1" });

    const store2 = new EventStore({ journalFile: file });
    assert.deepEqual(store2.all().map((e) => e.event_id), ["e1"]);
    assert.equal(store2.currentVersion("run_batch", "b1"), 1);
    const replayed = store2.idempotencyRecord("k1");
    assert.deepEqual(replayed.event_ids, ["e1"]);
    assert.equal(replayed.command_id, "cmd-1");
    // 重放后再次提交同键仍然只命中首次结果。
    assert.equal(store2.commit([], { idempotencyKey: "k1" }).replay, true);
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
});
