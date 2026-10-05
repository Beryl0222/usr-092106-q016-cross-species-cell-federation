/**
 * 领域事件信封的最小结构校验（零依赖）。
 *
 * 这里只做与业务流程无关的形状检查：必填字段、枚举、事件类型与聚合
 * 类型是否对应，以及各事件 payload 的关键字段是否齐全。治理规则
 * （同意、不可变、审查、去重等）在 governance.js 中执行。
 */

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [
  "DATASET_REGISTERED",
  "DATASET_QUALITY_RECORDED",
  "MAPPING_REVISION_PROPOSED",
  "MAPPING_APPROVED",
  "LAYER_DERIVED",
  "RUN_BATCH_REGISTERED",
  "RUN_STARTED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_DEDUP_RECORDED",
  "CLAIM_PROPOSED",
  "CLAIM_REVIEWED",
  "CONSENT_GRANTED",
  "ACCESS_WITHDRAWN",
  "DERIVATIVE_FLAGGED",
  "PUBLICATION_RELEASED",
];

export const AGGREGATE_TYPES = [
  "dataset_version",
  "ontology_mapping",
  "derived_layer",
  "run_batch",
  "model_run",
  "scientific_claim",
  "consent_grant",
  "publication",
];

/** 每种事件归属的聚合类型。 */
export const EVENT_AGGREGATE = {
  DATASET_REGISTERED: "dataset_version",
  DATASET_QUALITY_RECORDED: "dataset_version",
  MAPPING_REVISION_PROPOSED: "ontology_mapping",
  MAPPING_APPROVED: "ontology_mapping",
  LAYER_DERIVED: "derived_layer",
  RUN_BATCH_REGISTERED: "run_batch",
  RUN_STARTED: "model_run",
  RUN_COMPLETED: "model_run",
  RUN_FAILED: "model_run",
  RUN_DEDUP_RECORDED: "model_run",
  CLAIM_PROPOSED: "scientific_claim",
  CLAIM_REVIEWED: "scientific_claim",
  CONSENT_GRANTED: "consent_grant",
  ACCESS_WITHDRAWN: "consent_grant",
  // DERIVATIVE_FLAGGED 的聚合类型由 payload.artifact_kind 决定，见下方专项校验。
  PUBLICATION_RELEASED: "publication",
};

/** DERIVATIVE_FLAGGED 允许标记的派生物种类，且须与信封聚合类型一致。 */
const FLAGABLE_KINDS = ["derived_layer", "model_run", "scientific_claim", "publication"];

/** 各事件 payload 中必须存在的关键键（谱系与治理依赖它们）。 */
const REQUIRED_PAYLOAD_KEYS = {
  DATASET_REGISTERED: ["dataset_id", "species", "matrix_kind", "content_hash"],
  MAPPING_REVISION_PROPOSED: ["mapping_id", "kind", "revision", "content_hash"],
  MAPPING_APPROVED: ["mapping_id", "revision", "approved_by"],
  LAYER_DERIVED: ["layer_id", "dataset_version_id", "transform", "content_hash", "derives_from"],
  RUN_BATCH_REGISTERED: ["batch_id", "label"],
  RUN_STARTED: ["run_id", "project_id", "inputs", "pipeline", "model"],
  RUN_COMPLETED: ["run_id", "equivalence_key"],
  RUN_FAILED: ["run_id", "error"],
  RUN_DEDUP_RECORDED: ["run_id", "equivalent_to_run_id", "equivalence_key"],
  CLAIM_PROPOSED: ["claim_id", "run_id", "kind", "statement"],
  CLAIM_REVIEWED: ["claim_id", "verdict", "reviewer", "rationale"],
  CONSENT_GRANTED: ["grant_id", "subject_ref", "project_id", "scope"],
  ACCESS_WITHDRAWN: ["subject_ref", "withdrawn_at"],
  DERIVATIVE_FLAGGED: ["artifact_id", "artifact_kind", "subject_ref", "reason"],
  PUBLICATION_RELEASED: ["publication_id", "claim_ids", "aggregate_findings"],
};

export function validateEvent(record) {
  const errors = REQUIRED.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if (errors.length) return errors;

  if (typeof record.event_id !== "string" || !record.event_id) errors.push("event_id 必须是非空字符串");
  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if (typeof record.aggregate_id !== "string" || !record.aggregate_id) errors.push("aggregate_id 必须是非空字符串");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.summary !== "string" || !record.summary) errors.push("summary 必须是非空字符串");
  if (!Number.isFinite(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是合法的 date-time");

  const expectedAggregate = EVENT_AGGREGATE[record.event_type];
  if (expectedAggregate && record.aggregate_type !== expectedAggregate) {
    errors.push(`${record.event_type} 必须归属聚合 ${expectedAggregate}，实际为 ${record.aggregate_type}`);
  }

  if (record.payload !== undefined && (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  const requiredKeys = REQUIRED_PAYLOAD_KEYS[record.event_type];
  if (requiredKeys) {
    const payload = record.payload ?? {};
    for (const key of requiredKeys) {
      if (!(key in payload)) errors.push(`payload 缺少字段：${key}`);
    }
  }

  if (record.event_type === "DERIVATIVE_FLAGGED") {
    const kind = record.payload?.artifact_kind;
    if (!FLAGABLE_KINDS.includes(kind)) {
      errors.push(`DERIVATIVE_FLAGGED 的 artifact_kind 必须是 ${FLAGABLE_KINDS.join(" / ")}`);
    } else if (record.aggregate_type !== kind) {
      errors.push(`DERIVATIVE_FLAGGED 标记 ${kind} 时 aggregate_type 必须同为 ${kind}`);
    }
    if (record.payload?.reason !== "consent_withdrawn") {
      errors.push("DERIVATIVE_FLAGGED 的 reason 目前只允许 consent_withdrawn");
    }
  }
  return errors;
}
