/**
 * 跨物种细胞资料联邦使用的领域事件信封与事件清单。
 *
 * 事件是派生谱系的唯一事实来源：事件一经接收，event_id / occurred_at /
 * version 不得原地改写，任何更正都必须追加后继事件。业务规则不在类型层
 * 表达，由治理层（governance.ts）在追加事件前执行。
 */

/** 事件发起者。最小只需要稳定标识，角色用于治理判定。 */
export interface Actor {
  id: string;
  role?: string;
}

/** 所有事件共享的信封字段，payload 携带事件专属内容。 */
export interface DomainEvent<T = Record<string, unknown>> {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 聚合内的单调版本号，从 1 开始；同一聚合并发写入用它做乐观并发。 */
  version: number;
  summary: string;
  actor?: Actor;
  /** 触发本事件的命令标识（命令→事件）。 */
  causation_id?: string;
  /** 同一业务活动（一轮审查、一次发布等）的关联标识。 */
  correlation_id?: string;
  /** 命令幂等键：同键重放必须复用首次结果。 */
  idempotency_key?: string;
  payload?: T;
}

export type EventType =
  | "DATASET_REGISTERED"
  | "DATASET_QUALITY_RECORDED"
  | "MAPPING_REVISION_PROPOSED"
  | "MAPPING_APPROVED"
  | "LAYER_DERIVED"
  | "RUN_BATCH_REGISTERED"
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_DEDUP_RECORDED"
  | "CLAIM_PROPOSED"
  | "CLAIM_REVIEWED"
  | "CONSENT_GRANTED"
  | "ACCESS_WITHDRAWN"
  | "DERIVATIVE_FLAGGED"
  | "PUBLICATION_RELEASED";

export type AggregateType =
  | "dataset_version"
  | "ontology_mapping"
  | "derived_layer"
  | "run_batch"
  | "model_run"
  | "scientific_claim"
  | "consent_grant"
  | "publication";

/** 受控级别：controlled 表示人类受限样本，仅获批项目可计算。 */
export type RestrictionLevel = "open" | "controlled";

/** 基因标识映射 / 组织本体映射的种类。 */
export type MappingKind = "gene_identifier" | "tissue_ontology" | "disease_label" | "batch";

/** 主张的命题级别——跨物种相似度永远只能停在 hypothesis。 */
export type ClaimKind =
  | "cross_species_similarity_hypothesis"
  | "evolutionary_interpretation"
  | "disease_causal_interpretation";

export type ClaimStatus = "pending_review" | "accepted" | "returned" | "rejected";

export type ReviewVerdict = "accept" | "return" | "reject";

export type RunOutcome = "completed" | "failed";

/** 数据集版本登记内容。原始表达矩阵内容哈希登记后即不可变。 */
export interface DatasetPayload {
  dataset_id: string;
  species: "human" | "mouse" | "zebrafish" | "sponge" | string;
  matrix_kind: "raw_expression" | "metadata";
  content_hash: string;
  /** 行列规模等基本信息；不含个体表达数据。 */
  shape?: { cells?: number; genes?: number };
  restriction?: RestrictionLevel;
  /** 受限样本所属的供体/队列标识，仅治理与管理员视图可见。 */
  subject_ref?: string;
  parent_version_id?: string;
  quality_metrics?: Record<string, number>;
}

/** 映射修订：同名基因/组织/疾病并不等价，每次修订都留痕、需批准。 */
export interface MappingRevisionPayload {
  mapping_id: string;
  kind: MappingKind;
  revision: number;
  /** 源词汇 → 目标词汇的条目摘要（不放敏感数据）。 */
  entries_summary: { source_namespace: string; target_namespace: string; item_count: number };
  content_hash: string;
  supersedes_revision?: number;
  proposed_by: string;
  note?: string;
}

export interface MappingApprovedPayload {
  mapping_id: string;
  revision: number;
  approved_by: string;
}

/** 派生层：映射修订、批次校正等只能产生可比较的新层，绝不覆盖原始矩阵。 */
export interface DerivedLayerPayload {
  layer_id: string;
  dataset_version_id: string;
  transform: "mapping_application" | "batch_correction" | string;
  pipeline: PipelineStep[];
  content_hash: string;
  /** 本层直接使用的上游：数据集版本、映射修订、更早的层。 */
  derives_from: string[];
  mapping_revisions?: string[];
  created_by: string;
}

export interface PipelineStep {
  step: string;
  tool: string;
  tool_version: string;
  parameters: Record<string, unknown>;
}

export interface RunBatchPayload {
  batch_id: string;
  label: string;
  recorded_at: string;
}

export interface ModelRunPayload {
  run_id: string;
  project_id: string;
  batch_id: string;
  /** 运行读取的层或数据集版本。 */
  inputs: string[];
  pipeline: PipelineStep[];
  model: { name: string; version: string; parameters_hash: string; parameters?: Record<string, unknown> };
  outcome?: RunOutcome;
  output_layer_id?: string;
  /** 结果的规范化等价键：相同输入+流水线+参数哈希的成功结果等价。 */
  equivalence_key?: string;
  /** 去重时指向已登记的等价结果。 */
  equivalent_to_run_id?: string;
  error?: string;
}

export interface ClaimPayload {
  claim_id: string;
  run_id: string;
  kind: ClaimKind;
  status: ClaimStatus;
  statement: string;
  /** 相似度分值、方向等模型证据摘要；不含个体表达。 */
  evidence_summary?: Record<string, unknown>;
  proposed_by?: string;
}

export interface ClaimReviewedPayload {
  claim_id: string;
  verdict: ReviewVerdict;
  reviewer: string;
  rationale: string;
  /** 接受时允许落到的最高命题级别（复核把关，不允许自动升级）。 */
  accepted_kind?: ClaimKind;
}

export interface ConsentGrantPayload {
  grant_id: string;
  subject_ref: string;
  project_id: string;
  scope: string;
  granted_at: string;
}

export interface AccessWithdrawnPayload {
  subject_ref: string;
  project_id?: string;
  withdrawn_at: string;
  reason?: string;
}

export interface DerivativeFlaggedPayload {
  artifact_id: string;
  artifact_kind: "derived_layer" | "model_run" | "scientific_claim" | "publication";
  subject_ref: string;
  reason: "consent_withdrawn";
}

export interface PublicationPayload {
  publication_id: string;
  claim_ids: string[];
  released_at: string;
  /** 发布物只包含获准的聚合结论。 */
  aggregate_findings: string[];
}
