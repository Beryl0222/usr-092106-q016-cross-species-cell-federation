import { GovernanceError } from "./errors.js";
import { runEquivalenceKey } from "./hashing.js";
import { ancestorsOf, consentActive } from "./model/projections.js";

/**
 * 治理策略引擎（纯函数，不触碰事件存储）。
 *
 * 每个命令处理函数在当前读模型上做判定，返回一个或多个“事件规格”，
 * 由平台门面补齐标识、版本、时间、操作者后原子提交。任何违例都抛出
 * GovernanceError，调用方不会得到半截事件。
 *
 * 关键不变量：
 *  1. 原始表达矩阵只登记、不改写；映射修订与批次校正只能产生新的派生层。
 *  2. 进入比较层的映射必须是已批准修订。
 *  3. 受控人类样本只对持有有效同意的项目开放计算；撤权阻止新运行，
 *     并级联标记全部既有派生物。
 *  4. 相同输入+流水线+模型参数只登记一个成功结果（失败重跑/并行去重）。
 *  5. 跨物种相似度只能以待审假设提交；进化/疾病因果升级只能由专家
 *     在复核中显式作出。
 *  6. 发布只收录已接受、未被标记的主张，输出聚合结论。
 */

const KNOWN_SPECIES = new Set(["human", "mouse", "zebrafish", "sponge"]);
const SUBMITTABLE_CLAIM_KINDS = new Set(["cross_species_similarity_hypothesis"]);
const REVIEW_ACCEPTABLE_KINDS = new Set([
  "cross_species_similarity_hypothesis",
  "evolutionary_interpretation",
  "disease_causal_interpretation",
]);

/** 质量风险阈值：仅用于管理员风险定位，不硬阻断计算。 */
export const QUALITY_THRESHOLDS = {
  median_genes_per_cell: 200,
  mitochondrial_fraction: 0.2,
};

const spec = (type, aggregateType, aggregateId, payload, summary) => ({
  type,
  aggregateType,
  aggregateId,
  payload,
  summary,
});

function requireFound(value, code, message, details = {}) {
  if (!value) throw new GovernanceError(code, message, details);
}

/** 沿输入向上遍历谱系，汇总受控供体与被标记的祖先。 */
function inputLineage(state, inputs) {
  const subjects = new Set();
  const flagged = new Set();
  const visited = new Set();
  const stack = [...inputs];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = state.artifacts.get(id);
    if (!node) {
      throw new GovernanceError("UNKNOWN_INPUT", `谱系中不存在输入：${id}`, { input: id });
    }
    for (const s of node.subjects) subjects.add(s);
    if (state.flags.has(id)) flagged.add(id);
    for (const up of node.derivesFrom) stack.push(up);
  }
  return { subjects, flagged };
}

/* ---------------- 数据集与质量 ---------------- */

export function registerDataset(state, cmd) {
  if (!KNOWN_SPECIES.has(cmd.species)) {
    throw new GovernanceError("UNKNOWN_SPECIES", `物种不在联邦范围内：${cmd.species}`, { species: cmd.species });
  }
  if (!cmd.content_hash) throw new GovernanceError("MISSING_CONTENT_HASH", "登记数据集必须提供内容哈希");
  const prior = [...state.datasets.values()].filter((d) => d.dataset_id === cmd.dataset_id);
  const versionNumber = prior.length + 1;
  const versionId = `dataset:${cmd.dataset_id}:v${versionNumber}`;
  if (state.datasets.has(versionId)) {
    throw new GovernanceError("DATASET_VERSION_EXISTS", `数据集版本已存在：${versionId}`);
  }
  if (cmd.restriction === "controlled" && !cmd.subject_ref) {
    throw new GovernanceError("CONTROLLED_REQUIRES_SUBJECT", "受控数据集必须登记供体/队列标识 subject_ref");
  }
  if (cmd.parent_version_id && !state.datasets.has(cmd.parent_version_id)) {
    throw new GovernanceError("UNKNOWN_PARENT_VERSION", `父版本不存在：${cmd.parent_version_id}`);
  }
  return {
    events: [
      spec(
        "DATASET_REGISTERED",
        "dataset_version",
        versionId,
        {
          dataset_id: cmd.dataset_id,
          species: cmd.species,
          matrix_kind: cmd.matrix_kind ?? "raw_expression",
          content_hash: cmd.content_hash,
          shape: cmd.shape,
          restriction: cmd.restriction ?? "open",
          subject_ref: cmd.subject_ref ?? null,
          parent_version_id: cmd.parent_version_id ?? null,
          quality_metrics: cmd.quality_metrics ?? {},
        },
        `登记 ${cmd.species} 数据集 ${cmd.dataset_id} 的不可变版本 v${versionNumber}`,
      ),
    ],
    result: { dataset_version_id: versionId, version: versionNumber },
  };
}

export function recordQuality(state, cmd) {
  const ds = state.datasets.get(cmd.dataset_version_id);
  requireFound(ds, "UNKNOWN_DATASET", `数据集版本不存在：${cmd.dataset_version_id}`);
  if (!cmd.metrics || typeof cmd.metrics !== "object" || Object.keys(cmd.metrics).length === 0) {
    throw new GovernanceError("EMPTY_METRICS", "质量指标必须是非空对象；更正应追加新事件而非改写旧值");
  }
  return {
    events: [
      spec(
        "DATASET_QUALITY_RECORDED",
        "dataset_version",
        cmd.dataset_version_id,
        { metrics: cmd.metrics },
        `追加数据集 ${cmd.dataset_version_id} 的质量指标`,
      ),
    ],
  };
}

/* ---------------- 基因/本体/疾病映射 ---------------- */

export function proposeMappingRevision(state, cmd) {
  const existing = state.mappings.get(cmd.mapping_id);
  const revision = existing ? Math.max(...existing.revisions.keys()) + 1 : 1;
  if (existing && existing.kind !== cmd.kind) {
    throw new GovernanceError("MAPPING_KIND_MISMATCH", `映射 ${cmd.mapping_id} 的种类不可变更：${existing.kind}`);
  }
  if (cmd.supersedes_revision !== undefined) {
    if (!existing || !existing.revisions.has(cmd.supersedes_revision)) {
      throw new GovernanceError("UNKNOWN_REVISION", `被取代的映射修订不存在：${cmd.supersedes_revision}`);
    }
  }
  return {
    events: [
      spec(
        "MAPPING_REVISION_PROPOSED",
        "ontology_mapping",
        `mapping:${cmd.mapping_id}#${revision}`,
        {
          mapping_id: cmd.mapping_id,
          kind: cmd.kind,
          revision,
          entries_summary: cmd.entries_summary,
          content_hash: cmd.content_hash,
          supersedes_revision: cmd.supersedes_revision ?? null,
          proposed_by: cmd.proposed_by,
          note: cmd.note ?? null,
        },
        `提交 ${cmd.kind} 映射 ${cmd.mapping_id} 的第 ${revision} 版修订（待批准）`,
      ),
    ],
    result: { mapping_id: cmd.mapping_id, revision },
  };
}

export function approveMapping(state, cmd) {
  const mapping = state.mappings.get(cmd.mapping_id);
  requireFound(mapping, "UNKNOWN_MAPPING", `映射不存在：${cmd.mapping_id}`);
  const revision = mapping.revisions.get(cmd.revision);
  requireFound(revision, "UNKNOWN_REVISION", `映射修订不存在：${cmd.mapping_id}#${cmd.revision}`);
  if (revision.approved) {
    throw new GovernanceError("REVISION_ALREADY_APPROVED", `映射修订已批准：${cmd.mapping_id}#${cmd.revision}`);
  }
  if (revision.proposed_by === cmd.approved_by) {
    throw new GovernanceError("SEPARATION_OF_DUTIES", "映射修订的批准人不得是提交人（需专家复核）");
  }
  return {
    events: [
      spec(
        "MAPPING_APPROVED",
        "ontology_mapping",
        `mapping:${cmd.mapping_id}#${cmd.revision}`,
        { mapping_id: cmd.mapping_id, revision: cmd.revision, approved_by: cmd.approved_by },
        `批准映射 ${cmd.mapping_id}#${cmd.revision}，成为可用于比较层的现行修订`,
      ),
    ],
  };
}

/* ---------------- 派生层（不可变原始数据之上的新层） ---------------- */

export function deriveLayer(state, cmd) {
  if (state.layers.has(cmd.layer_id) || state.artifacts.has(cmd.layer_id)) {
    throw new GovernanceError("LAYER_EXISTS", `层标识已存在，层不可原地改写：${cmd.layer_id}`);
  }
  const ds = state.datasets.get(cmd.dataset_version_id);
  requireFound(ds, "UNKNOWN_DATASET", `基数据集版本不存在：${cmd.dataset_version_id}`);
  if (!Array.isArray(cmd.pipeline) || cmd.pipeline.length === 0) {
    throw new GovernanceError("EMPTY_PIPELINE", "派生层必须登记可复现的处理流水线步骤");
  }
  const upstream = [...new Set([cmd.dataset_version_id, ...(cmd.derives_from ?? [])])];
  for (const id of upstream) {
    if (!state.artifacts.has(id)) throw new GovernanceError("UNKNOWN_UPSTREAM", `上游制品不存在：${id}`, { upstream: id });
  }
  const approvedRefs = [];
  for (const ref of cmd.mapping_revisions ?? []) {
    const revision = state.mappings.get(ref.mapping_id)?.revisions.get(ref.revision);
    if (!revision) {
      throw new GovernanceError("UNKNOWN_MAPPING_REVISION", `映射修订不存在：${ref.mapping_id}#${ref.revision}`);
    }
    if (!revision.approved) {
      throw new GovernanceError("MAPPING_NOT_APPROVED", `只有已批准的映射修订才能进入比较层：${ref.mapping_id}#${ref.revision}`);
    }
    approvedRefs.push(`mapping:${ref.mapping_id}#${ref.revision}`);
  }
  if (cmd.transform === "mapping_application" && approvedRefs.length === 0) {
    throw new GovernanceError("MAPPING_REQUIRED", "映射应用层必须至少引用一个已批准映射修订");
  }
  return {
    events: [
      spec(
        "LAYER_DERIVED",
        "derived_layer",
        cmd.layer_id,
        {
          layer_id: cmd.layer_id,
          dataset_version_id: cmd.dataset_version_id,
          transform: cmd.transform,
          pipeline: cmd.pipeline,
          content_hash: cmd.content_hash,
          derives_from: upstream,
          mapping_revisions: approvedRefs,
          created_by: cmd.created_by,
        },
        `在 ${cmd.dataset_version_id} 之上经 ${cmd.transform} 派生出可比较新层 ${cmd.layer_id}（原始矩阵保持不变）`,
      ),
    ],
  };
}

/* ---------------- 运行批次 ---------------- */

export function registerBatch(state, cmd) {
  if (state.batches.has(cmd.batch_id)) {
    throw new GovernanceError("BATCH_EXISTS", `运行批次已存在：${cmd.batch_id}`);
  }
  return {
    events: [
      spec(
        "RUN_BATCH_REGISTERED",
        "run_batch",
        cmd.batch_id,
        { batch_id: cmd.batch_id, label: cmd.label, recorded_at: cmd.recorded_at ?? null },
        `登记实验/运行批次 ${cmd.batch_id}（${cmd.label}）`,
      ),
    ],
  };
}

/* ---------------- 模型运行（同意门控 + 等价去重） ---------------- */

export function startRun(state, cmd) {
  if (state.runs.has(cmd.run_id)) throw new GovernanceError("RUN_EXISTS", `运行已存在：${cmd.run_id}`);
  if (!state.batches.has(cmd.batch_id)) throw new GovernanceError("UNKNOWN_BATCH", `运行批次不存在：${cmd.batch_id}`);
  if (!Array.isArray(cmd.inputs) || cmd.inputs.length === 0) {
    throw new GovernanceError("EMPTY_INPUTS", "运行必须声明输入制品");
  }
  if (!cmd.model?.parameters_hash) {
    throw new GovernanceError("MISSING_PARAMETERS_HASH", "模型运行必须登记参数指纹 parameters_hash");
  }
  const { subjects, flagged } = inputLineage(state, cmd.inputs);

  // 撤权后阻止新运行：祖先已被标记，直接拒绝。
  if (flagged.size > 0) {
    throw new GovernanceError(
      "INPUTS_FLAGGED",
      `输入链路上存在同意撤权后被标记的制品：${[...flagged].join("、")}`,
      { flagged: [...flagged] },
    );
  }
  // 受控人类样本：对该项目逐一校验有效同意。
  const missingConsent = [...subjects].filter((s) => !consentActive(state, s, cmd.project_id));
  if (missingConsent.length > 0) {
    throw new GovernanceError(
      "CONSENT_REQUIRED",
      `项目 ${cmd.project_id} 缺少对受控供体的有效同意：${missingConsent.join("、")}（或同意已撤权）`,
      { subjects: missingConsent, project_id: cmd.project_id },
    );
  }

  const equivalenceKey = runEquivalenceKey({ inputs: cmd.inputs, pipeline: cmd.pipeline, model: cmd.model });
  const canonical = state.equivalence.get(equivalenceKey);
  if (canonical && !state.flags.has(canonical)) {
    // 已有未受污染的等价成功结果：不再启动、不产生第二个等价结果，直接指引复用。
    return {
      events: [],
      result: { deduped: true, reused_run_id: canonical, equivalence_key: equivalenceKey },
    };
  }
  // 若既有等价结果已因撤权被标记，则它失去规范地位：持有效同意的项目可重新计算。

  return {
    events: [
      spec(
        "RUN_STARTED",
        "model_run",
        cmd.run_id,
        {
          run_id: cmd.run_id,
          project_id: cmd.project_id,
          batch_id: cmd.batch_id,
          inputs: cmd.inputs,
          pipeline: cmd.pipeline,
          model: cmd.model,
          equivalence_key: equivalenceKey,
        },
        `项目 ${cmd.project_id} 在批次 ${cmd.batch_id} 启动模型运行 ${cmd.run_id}`,
      ),
    ],
    result: { run_id: cmd.run_id, equivalence_key: equivalenceKey },
  };
}

export function completeRun(state, cmd) {
  const run = state.runs.get(cmd.run_id);
  requireFound(run, "UNKNOWN_RUN", `运行不存在：${cmd.run_id}`);
  if (run.status !== "running") {
    throw new GovernanceError("RUN_NOT_RUNNING", `运行 ${cmd.run_id} 当前状态为 ${run.status}，不能登记完成`);
  }
  if (cmd.output_layer_id && !state.layers.has(cmd.output_layer_id)) {
    throw new GovernanceError("UNKNOWN_OUTPUT_LAYER", `输出层不存在：${cmd.output_layer_id}`);
  }

  // 并行任务：等价键的首个“未受污染”成功者获胜；若旧规范结果已被撤权
  // 标记，持有效同意的新运行可接管该键，而不是被错误去重。
  const canonical = state.equivalence.get(run.equivalence_key);
  if (canonical && canonical !== cmd.run_id && !state.flags.has(canonical)) {
    return {
      events: [
        spec(
          "RUN_DEDUP_RECORDED",
          "model_run",
          cmd.run_id,
          {
            run_id: cmd.run_id,
            equivalence_key: run.equivalence_key,
            equivalent_to_run_id: canonical,
          },
          `运行 ${cmd.run_id} 与已完成的 ${canonical} 等价，只保留后者作为唯一结果`,
        ),
      ],
      result: { deduped: true, canonical_run_id: canonical },
    };
  }

  return {
    events: [
      spec(
        "RUN_COMPLETED",
        "model_run",
        cmd.run_id,
        {
          run_id: cmd.run_id,
          outcome: "completed",
          equivalence_key: run.equivalence_key,
          output_layer_id: cmd.output_layer_id ?? null,
          model: run.model,
        },
        `运行 ${cmd.run_id} 完成，结果按等价键 ${run.equivalence_key.slice(0, 19)}… 登记`,
      ),
    ],
    result: { deduped: false, run_id: cmd.run_id, output_layer_id: cmd.output_layer_id ?? null },
  };
}

export function failRun(state, cmd) {
  const run = state.runs.get(cmd.run_id);
  requireFound(run, "UNKNOWN_RUN", `运行不存在：${cmd.run_id}`);
  if (run.status !== "running") {
    throw new GovernanceError("RUN_NOT_RUNNING", `运行 ${cmd.run_id} 当前状态为 ${run.status}，不能登记失败`);
  }
  return {
    events: [
      spec(
        "RUN_FAILED",
        "model_run",
        cmd.run_id,
        { run_id: cmd.run_id, error: cmd.error },
        `运行 ${cmd.run_id} 失败：${cmd.error}（不登记结果，可在修正后重跑）`,
      ),
    ],
  };
}

/* ---------------- 候选主张与专家复核 ---------------- */

export function proposeClaim(state, cmd) {
  if (state.claims.has(cmd.claim_id)) throw new GovernanceError("CLAIM_EXISTS", `主张已存在：${cmd.claim_id}`);
  const run = state.runs.get(cmd.run_id);
  requireFound(run, "UNKNOWN_RUN", `运行不存在：${cmd.run_id}`);
  if (run.status === "failed") {
    throw new GovernanceError("CLAIM_ON_FAILED_RUN", "失败运行不产出候选主张");
  }
  if (run.status === "deduped") {
    throw new GovernanceError("CLAIM_ON_DEDUPED_RUN", `该运行是去重指针，请基于权威结果 ${run.equivalent_to_run_id} 提交主张`, {
      canonical_run_id: run.equivalent_to_run_id,
    });
  }
  if (run.status !== "completed") {
    throw new GovernanceError("RUN_NOT_COMPLETED", `运行状态为 ${run.status}，完成后才能提交主张`);
  }
  if (!SUBMITTABLE_CLAIM_KINDS.has(cmd.kind)) {
    throw new GovernanceError(
      "CLAIM_KIND_FORBIDDEN",
      "跨物种模型相似度只能提交为待审的相似性假设；进化或疾病因果结论不得由模型自动升级",
      { submitted: cmd.kind },
    );
  }
  if (state.flags.has(cmd.run_id)) {
    throw new GovernanceError("RUN_FLAGGED", `运行 ${cmd.run_id} 已因同意撤权被标记，不能据此提交主张`);
  }
  return {
    events: [
      spec(
        "CLAIM_PROPOSED",
        "scientific_claim",
        cmd.claim_id,
        {
          claim_id: cmd.claim_id,
          run_id: cmd.run_id,
          kind: "cross_species_similarity_hypothesis",
          status: "pending_review",
          statement: cmd.statement,
          evidence_summary: cmd.evidence_summary ?? null,
          proposed_by: cmd.proposed_by,
        },
        `提交待审相似性假设 ${cmd.claim_id}（基于运行 ${cmd.run_id}，不作进化/因果结论）`,
      ),
    ],
  };
}

export function reviewClaim(state, cmd) {
  const claim = state.claims.get(cmd.claim_id);
  requireFound(claim, "UNKNOWN_CLAIM", `主张不存在：${cmd.claim_id}`);
  if (!["pending_review", "returned"].includes(claim.status)) {
    throw new GovernanceError("CLAIM_NOT_REVIEWABLE", `主张状态为 ${claim.status}，不能再次复核`);
  }
  if (claim.proposed_by && cmd.reviewer === claim.proposed_by) {
    throw new GovernanceError("SEPARATION_OF_DUTIES", "复核专家不得是主张提交人");
  }
  if (!["accept", "return", "reject"].includes(cmd.verdict)) {
    throw new GovernanceError("BAD_VERDICT", `复核结论必须是 accept/return/reject：${cmd.verdict}`);
  }
  if (cmd.verdict === "accept" && state.flags.has(cmd.claim_id)) {
    throw new GovernanceError("CLAIM_FLAGGED", "主张已因同意撤权被标记，不能接受");
  }
  let acceptedKind = null;
  if (cmd.verdict === "accept") {
    acceptedKind = cmd.accepted_kind ?? "cross_species_similarity_hypothesis";
    if (!REVIEW_ACCEPTABLE_KINDS.has(acceptedKind)) {
      throw new GovernanceError("BAD_ACCEPTED_KIND", `接受的命题级别不被认可：${acceptedKind}`);
    }
  }
  return {
    events: [
      spec(
        "CLAIM_REVIEWED",
        "scientific_claim",
        cmd.claim_id,
        {
          claim_id: cmd.claim_id,
          verdict: cmd.verdict,
          reviewer: cmd.reviewer,
          rationale: cmd.rationale,
          accepted_kind: acceptedKind,
        },
        `专家 ${cmd.reviewer} 对主张 ${cmd.claim_id} 给出 ${cmd.verdict}${
          acceptedKind && acceptedKind !== "cross_species_similarity_hypothesis" ? `（升级为 ${acceptedKind}）` : ""
        }`,
      ),
    ],
  };
}

/* ---------------- 同意与撤权 ---------------- */

export function grantConsent(state, cmd) {
  const key = `${cmd.subject_ref}␟${cmd.project_id}`;
  const existing = state.grants.get(key);
  if (existing && existing.withdrawn_at === null) {
    throw new GovernanceError("GRANT_EXISTS", `该供体对项目的有效同意已存在：${key}`);
  }
  return {
    events: [
      spec(
        "CONSENT_GRANTED",
        "consent_grant",
        cmd.grant_id,
        {
          grant_id: cmd.grant_id,
          subject_ref: cmd.subject_ref,
          project_id: cmd.project_id,
          scope: cmd.scope,
          granted_at: cmd.granted_at ?? null,
        },
        `登记供体 ${cmd.subject_ref} 对项目 ${cmd.project_id} 的同意（范围：${cmd.scope}）`,
      ),
    ],
  };
}

/**
 * 撤权：发出 ACCESS_WITHDRAWN，并对所有尚未标记的受影响派生物逐一追加
 * DERIVATIVE_FLAGGED（层/运行/主张/发布；原始数据集本身不被改写）。
 */
export function withdrawAccess(state, cmd) {
  const affectedProjects = cmd.project_id ? [cmd.project_id] : null;
  let matched = false;
  for (const grant of state.grants.values()) {
    if (grant.subject_ref !== cmd.subject_ref) continue;
    if (affectedProjects && grant.project_id !== cmd.project_id) continue;
    if (grant.withdrawn_at === null) matched = true;
  }
  if (!matched) {
    throw new GovernanceError("NO_ACTIVE_GRANT", `供体 ${cmd.subject_ref} 没有可撤销的有效同意`);
  }

  const events = [
    spec(
      "ACCESS_WITHDRAWN",
      "consent_grant",
      `consent:${cmd.subject_ref}:${cmd.project_id ?? "*"}`,
      {
        subject_ref: cmd.subject_ref,
        project_id: cmd.project_id ?? null,
        withdrawn_at: cmd.withdrawn_at ?? null,
        reason: cmd.reason ?? null,
      },
      `撤回归属于 ${cmd.subject_ref}${cmd.project_id ? `（项目 ${cmd.project_id}）` : "（全部项目）"} 的同意，冻结新计算`,
    ),
  ];

  const flagged = [];
  for (const [id, node] of state.artifacts) {
    if (!["derived_layer", "model_run", "scientific_claim", "publication"].includes(node.kind)) continue;
    if (!node.subjects.has(cmd.subject_ref)) continue;
    if (state.flags.has(id)) continue;
    if (affectedProjects) {
      // 项目级撤权：共享派生层不标记（仍可供其他获批项目使用），
      // 只冻结归属该项目的运行及其主张/发布链路。
      if (node.kind === "derived_layer") continue;
      if (!node.projects.has(cmd.project_id)) continue;
    }
    events.push(
      spec(
        "DERIVATIVE_FLAGGED",
        node.kind,
        id,
        {
          artifact_id: id,
          artifact_kind: node.kind,
          subject_ref: cmd.subject_ref,
          reason: "consent_withdrawn",
        },
        `派生物 ${id} 受 ${cmd.subject_ref} 撤权影响，标记为受限`,
      ),
    );
    flagged.push(id);
  }

  return { events, result: { subject_ref: cmd.subject_ref, flagged_artifacts: flagged } };
}

/* ---------------- 公开发布 ---------------- */

export function releasePublication(state, cmd) {
  if (state.publications.has(cmd.publication_id)) {
    throw new GovernanceError("PUBLICATION_EXISTS", `发布已存在：${cmd.publication_id}`);
  }
  if (!Array.isArray(cmd.claim_ids) || cmd.claim_ids.length === 0) {
    throw new GovernanceError("EMPTY_PUBLICATION", "发布必须至少引用一条主张");
  }
  if (!Array.isArray(cmd.aggregate_findings) || cmd.aggregate_findings.length === 0) {
    throw new GovernanceError("AGGREGATE_FINDINGS_REQUIRED", "公开发布只能包含获准的聚合结论");
  }
  for (const claimId of cmd.claim_ids) {
    const claim = state.claims.get(claimId);
    requireFound(claim, "UNKNOWN_CLAIM", `主张不存在：${claimId}`);
    if (claim.status !== "accepted") {
      throw new GovernanceError("CLAIM_NOT_ACCEPTED", `只有已接受的主张可以公开发布：${claimId}（${claim.status}）`);
    }
    if (state.flags.has(claimId)) {
      throw new GovernanceError("CLAIM_FLAGGED", `主张 ${claimId} 已受撤权影响被标记，必须移出发布`);
    }
  }
  return {
    events: [
      spec(
        "PUBLICATION_RELEASED",
        "publication",
        cmd.publication_id,
        {
          publication_id: cmd.publication_id,
          claim_ids: [...cmd.claim_ids],
          aggregate_findings: cmd.aggregate_findings,
          released_at: cmd.released_at ?? null,
        },
        `发布 ${cmd.publication_id}：仅收录 ${cmd.claim_ids.length} 条已接受主张的聚合结论`,
      ),
    ],
  };
}

/* ---------------- 管理员风险定位 ---------------- */

export function qualityRisks(state) {
  const risks = [];
  for (const ds of state.datasets.values()) {
    const m = ds.quality_metrics ?? {};
    if (Object.keys(m).length === 0) {
      risks.push({ dataset_version_id: ds.version_id, level: "warning", issue: "缺少质量指标" });
      continue;
    }
    if (m.median_genes_per_cell !== undefined && m.median_genes_per_cell < QUALITY_THRESHOLDS.median_genes_per_cell) {
      risks.push({
        dataset_version_id: ds.version_id,
        level: "risk",
        issue: `每细胞中位基因数 ${m.median_genes_per_cell} 低于阈值 ${QUALITY_THRESHOLDS.median_genes_per_cell}`,
      });
    }
    if (m.mitochondrial_fraction !== undefined && m.mitochondrial_fraction > QUALITY_THRESHOLDS.mitochondrial_fraction) {
      risks.push({
        dataset_version_id: ds.version_id,
        level: "risk",
        issue: `线粒体比例 ${m.mitochondrial_fraction} 高于阈值 ${QUALITY_THRESHOLDS.mitochondrial_fraction}`,
      });
    }
  }
  return risks;
}

export { ancestorsOf };
