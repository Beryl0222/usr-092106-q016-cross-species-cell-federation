import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { validateEvent } from "../validator.js";
import { GovernanceError } from "../errors.js";

/**
 * 仅追加领域事件存储。
 *
 * - 事件只追加、不更新、不删除；读取顺序即权威时间线。
 * - event_id 全局唯一，防止同一条事实被登记两次。
 * - 每个聚合维护单调 version：追加时必须等于当前版本 + 1（乐观并发），
 *   并行任务里落后的提交会被拒绝而不是覆盖。
 * - 命令幂等键（idempotencyKey）只允许登记一次；失败重跑命中同键时，
 *   平台取回首次结果，不会产生第二个“等价结果”。
 *
 * 可选传入 JSONL 文件路径：每次追加同步落盘一行，重放文件即可还原，
 * 使登记内容在进程之外仍可审计、可复现。
 */
export class EventStore {
  /** @param {{ journalFile?: string }} [options] */
  constructor(options = {}) {
    this._events = [];
    this._eventIds = new Set();
    /** @type {Map<string, number>} 聚合键 -> 最新版本号 */
    this._aggregateVersions = new Map();
    /** @type {Map<string, { command_id?: string, event_ids: string[], result?: unknown, recorded_at: string }>} */
    this._idempotency = new Map();
    this._journalFile = options.journalFile;
    if (this._journalFile && existsSync(this._journalFile)) {
      for (const line of readFileSync(this._journalFile, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this._ingest(JSON.parse(trimmed));
      }
      // 按幂等键聚齐同一命令的全部事件（撤权等命令一次写多个聚合）。
      for (const event of this._events) {
        if (!event.idempotency_key) continue;
        const record = this._idempotency.get(event.idempotency_key);
        if (record) {
          if (!record.event_ids.includes(event.event_id)) record.event_ids.push(event.event_id);
          record.command_id ??= event.causation_id;
          record.recorded_at ??= event.occurred_at;
        } else {
          this._idempotency.set(event.idempotency_key, {
            command_id: event.causation_id,
            event_ids: [event.event_id],
            recorded_at: event.occurred_at,
          });
        }
      }
    }
  }

  static aggregateKey(event) {
    return `${event.aggregate_type}:${event.aggregate_id}`;
  }

  /** 全部事件（权威顺序的只读副本）。 */
  all() {
    return this._events.map((e) => ({ ...e, payload: e.payload ? { ...e.payload } : e.payload }));
  }

  eventsForAggregate(aggregateType, aggregateId) {
    return this._events
      .filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId)
      .map((e) => ({ ...e, payload: e.payload ? { ...e.payload } : e.payload }));
  }

  currentVersion(aggregateType, aggregateId) {
    return this._aggregateVersions.get(`${aggregateType}:${aggregateId}`) ?? 0;
  }

  /** 取出某个幂等键首次提交时登记的结果（用于失败重跑/并行去重）。 */
  idempotencyRecord(key) {
    return this._idempotency.get(key);
  }

  /** 按事件标识取回事件（幂等重放时回传首次提交的事件）。 */
  eventsByIds(ids) {
    const wanted = new Set(ids);
    return this._events.filter((e) => wanted.has(e.event_id)).map((e) => ({ ...e }));
  }

  /**
   * 登记一个“不产生事件”的幂等判定结果（例如重跑命中已有等价结果时
   * 直接指引复用）。同键再次请求仍取回同一结果。
   */
  rememberOutcome(key, { commandId, result, recordedAt }) {
    if (this._idempotency.has(key)) return this._idempotency.get(key);
    const record = { command_id: commandId, event_ids: [], result, recorded_at: recordedAt };
    this._idempotency.set(key, record);
    return record;
  }

  /**
   * 以一个命令为单位原子追加事件。
   *
   * @param {object[]} events 已构造好的事件信封
   * @param {{ expectedVersion?: number, idempotencyKey?: string, commandId?: string, result?: unknown }} [meta]
   * @returns {{ events: object[], replay: boolean, result?: unknown }}
   *   首次提交返回事件；命中幂等键时 replay=true 并带回首次结果。
   */
  commit(events, meta = {}) {
    // 幂等命中优先：即使重放方没有再带事件，也能取回首次结果。
    if (meta.idempotencyKey) {
      const existing = this._idempotency.get(meta.idempotencyKey);
      if (existing) {
        return {
          events: this.eventsByIds(existing.event_ids),
          replay: true,
          result: existing.result,
        };
      }
    }

    if (!Array.isArray(events) || events.length === 0) {
      throw new GovernanceError("EMPTY_COMMIT", "一次提交至少要包含一个事件");
    }

    // 先在“影子状态”上校验整批事件，任何一条不合法则整批不生效。
    const draftVersions = new Map(this._aggregateVersions);
    for (const rawEvent of events) {
      // 幂等键与命令标识落到信封本身：仅靠日志即可重建幂等台账。
      if (meta.idempotencyKey && rawEvent.idempotency_key === undefined) rawEvent.idempotency_key = meta.idempotencyKey;
      if (meta.commandId && rawEvent.causation_id === undefined) rawEvent.causation_id = meta.commandId;
      const event = rawEvent;
      const errors = validateEvent(event);
      if (errors.length) {
        throw new GovernanceError("INVALID_EVENT", `事件 ${event.event_id ?? "<无标识>"} 不符合契约：${errors.join("；")}`, { errors });
      }
      if (this._eventIds.has(event.event_id)) {
        throw new GovernanceError("DUPLICATE_EVENT_ID", `事件标识已存在：${event.event_id}`);
      }
      const key = EventStore.aggregateKey(event);
      const next = (draftVersions.get(key) ?? 0) + 1;
      if (event.version !== next) {
        throw new GovernanceError(
          "VERSION_CONFLICT",
          `聚合 ${key} 期望版本 ${next}，收到 ${event.version}（并行提交或重放，请重读后再试）`,
          { aggregate: key, expected: next, received: event.version },
        );
      }
      draftVersions.set(key, next);
    }

    if (meta.expectedVersion !== undefined) {
      const firstKey = EventStore.aggregateKey(events[0]);
      const current = this._aggregateVersions.get(firstKey) ?? 0;
      if (meta.expectedVersion !== current) {
        throw new GovernanceError(
          "VERSION_CONFLICT",
          `聚合 ${firstKey} 已被其他提交推进到版本 ${current}，本次基于 ${meta.expectedVersion}`,
          { aggregate: firstKey, expected: current, basedOn: meta.expectedVersion },
        );
      }
    }

    for (const event of events) {
      this._ingest(event);
      if (this._journalFile) {
        appendFileSync(this._journalFile, `${JSON.stringify(event)}\n`);
      }
    }

    if (meta.idempotencyKey) {
      this._idempotency.set(meta.idempotencyKey, {
        command_id: meta.commandId,
        event_ids: events.map((e) => e.event_id),
        result: meta.result,
        recorded_at: events[0].occurred_at,
      });
    }

    return {
      events: events.map((e) => ({ ...e, payload: e.payload ? { ...e.payload } : e.payload })),
      replay: false,
      result: meta.result,
    };
  }

  /** 把一条已校验事件并入内存索引。 */
  _ingest(event) {
    this._events.push(event);
    this._eventIds.add(event.event_id);
    this._aggregateVersions.set(EventStore.aggregateKey(event), event.version);
  }
}
