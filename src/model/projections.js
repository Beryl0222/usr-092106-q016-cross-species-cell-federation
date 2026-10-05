/**
 * 读模型投影：把仅追加事件流折叠成治理与查询所需的索引。
 *
 * 投影是派生数据，随时可以从事件流完整重建；它不持有任何独立事实。
 * 其中 artifacts 是统一的谱系图（数据集/映射/层/运行/主张/发布都是节点），
 * 正向边用于复现清单，反向边用于撤权后的派生物级联定位。
 */

function newState() {
  return {
    datasets: new Map(),
    layers: new Map(),
    /** mapping_id -> { revisions: Map<rev, revision记录>, approvedRevision: number|null } */
    mappings: new Map(),
    batches: new Map(),
    runs: new Map(),
    claims: new Map(),
    publications: new Map(),
    /** `${subject_ref}␟${project_id}` -> 授权记录 */
    grants: new Map(),
    withdrawals: [],
    /** artifact_id -> 最近一次 DERIVATIVE_FLAGGED 内容 */
    flags: new Map(),
    /** 统一谱系图：id -> { kind, derivesFrom: Set, children: Set, subjects: Set } */
    artifacts: new Map(),
    /** equivalence_key -> 首个成功结果的 run_id（等价结果的权威登记） */
    equivalence: new Map(),
    eventCount: 0,
  };
}

function grantKey(subjectRef, projectId) {
  return `${subjectRef}␟${projectId}`;
}

function node(state, id, kind) {
  let n = state.artifacts.get(id);
  if (!n) {
    n = { id, kind, derivesFrom: new Set(), children: new Set(), subjects: new Set(), projects: new Set() };
    state.artifacts.set(id, n);
  } else if (kind) {
    n.kind = kind;
  }
  return n;
}

/**
 * 登记一条谱系边，并把上游节点携带的受控供体标识与项目归属传播给下游。
 * 项目归属用于精确的项目级撤权（只冻结该项目的运行/主张/发布）。
 */
function link(state, childId, childKind, upstreamIds = [], ownSubjects = [], ownProjects = []) {
  const child = node(state, childId, childKind);
  for (const subject of ownSubjects) child.subjects.add(subject);
  for (const project of ownProjects) child.projects.add(project);
  for (const upId of upstreamIds) {
    const up = node(state, upId, undefined);
    child.derivesFrom.add(upId);
    up.children.add(childId);
    for (const subject of up.subjects) child.subjects.add(subject);
    for (const project of up.projects) child.projects.add(project);
  }
  return child;
}

function apply(state, event) {
  const p = event.payload ?? {};
  state.eventCount += 1;

  switch (event.event_type) {
    case "DATASET_REGISTERED": {
      state.datasets.set(event.aggregate_id, {
        version_id: event.aggregate_id,
        dataset_id: p.dataset_id,
        species: p.species,
        matrix_kind: p.matrix_kind,
        content_hash: p.content_hash,
        shape: p.shape,
        restriction: p.restriction ?? "open",
        subject_ref: p.subject_ref ?? null,
        parent_version_id: p.parent_version_id ?? null,
        quality_metrics: { ...(p.quality_metrics ?? {}) },
        registered_at: event.occurred_at,
      });
      link(
        state,
        event.aggregate_id,
        "dataset_version",
        p.parent_version_id ? [p.parent_version_id] : [],
        p.restriction === "controlled" && p.subject_ref ? [p.subject_ref] : [],
      );
      break;
    }

    case "DATASET_QUALITY_RECORDED": {
      const ds = state.datasets.get(event.aggregate_id);
      if (ds) Object.assign(ds.quality_metrics, p.metrics ?? p.quality_metrics ?? {});
      break;
    }

    case "MAPPING_REVISION_PROPOSED": {
      let mapping = state.mappings.get(p.mapping_id);
      if (!mapping) {
        mapping = { mapping_id: p.mapping_id, kind: p.kind, revisions: new Map(), approvedRevision: null };
        state.mappings.set(p.mapping_id, mapping);
      }
      mapping.revisions.set(p.revision, {
        revision: p.revision,
        kind: p.kind,
        entries_summary: p.entries_summary,
        content_hash: p.content_hash,
        supersedes_revision: p.supersedes_revision ?? null,
        proposed_by: p.proposed_by,
        note: p.note ?? null,
        approved: false,
        approved_by: null,
        proposed_at: event.occurred_at,
      });
      const revisionNodeId = `mapping:${p.mapping_id}#${p.revision}`;
      link(
        state,
        revisionNodeId,
        "ontology_mapping",
        p.supersedes_revision ? [`mapping:${p.mapping_id}#${p.supersedes_revision}`] : [],
      );
      break;
    }

    case "MAPPING_APPROVED": {
      const mapping = state.mappings.get(p.mapping_id);
      const rev = mapping?.revisions.get(p.revision);
      if (rev) {
        rev.approved = true;
        rev.approved_by = p.approved_by;
        rev.approved_at = event.occurred_at;
        mapping.approvedRevision = p.revision;
      }
      break;
    }

    case "LAYER_DERIVED": {
      state.layers.set(p.layer_id, {
        layer_id: p.layer_id,
        dataset_version_id: p.dataset_version_id,
        transform: p.transform,
        pipeline: p.pipeline,
        content_hash: p.content_hash,
        derives_from: [...p.derives_from],
        mapping_revisions: [...(p.mapping_revisions ?? [])],
        created_by: p.created_by,
        created_at: event.occurred_at,
        flagged: false,
      });
      // 映射修订也是本层的直接上游：纳入谱系闭包以支持复现与撤权传播。
      link(state, p.layer_id, "derived_layer", [...p.derives_from, ...(p.mapping_revisions ?? [])]);
      break;
    }

    case "RUN_BATCH_REGISTERED": {
      state.batches.set(p.batch_id, { batch_id: p.batch_id, label: p.label, recorded_at: p.recorded_at });
      break;
    }

    case "RUN_STARTED": {
      state.runs.set(p.run_id, {
        run_id: p.run_id,
        project_id: p.project_id,
        batch_id: p.batch_id,
        inputs: [...p.inputs],
        pipeline: p.pipeline,
        model: p.model,
        status: "running",
        equivalence_key: p.equivalence_key ?? null,
        equivalent_to_run_id: null,
        output_layer_id: null,
        error: null,
        started_at: event.occurred_at,
      });
      link(state, p.run_id, "model_run", p.inputs, [], [p.project_id]);
      break;
    }

    case "RUN_COMPLETED": {
      const run = state.runs.get(p.run_id);
      if (run) {
        run.status = "completed";
        run.equivalence_key = p.equivalence_key;
        run.output_layer_id = p.output_layer_id ?? run.output_layer_id;
        run.completed_at = event.occurred_at;
        if (p.model) run.model = p.model;
        if (run.output_layer_id) {
          // 输出层以运行为上游：供体与项目归属随之传播，保证撤权级联可达。
          link(state, run.output_layer_id, "derived_layer", [p.run_id]);
        }
      }
      // 等价键先到先得；但既有规范结果若已因撤权被标记，则由新结果接管。
      if (p.equivalence_key) {
        const incumbent = state.equivalence.get(p.equivalence_key);
        if (!incumbent || state.flags.has(incumbent)) state.equivalence.set(p.equivalence_key, p.run_id);
      }
      break;
    }

    case "RUN_FAILED": {
      const run = state.runs.get(p.run_id);
      if (run) {
        run.status = "failed";
        run.error = p.error;
        run.failed_at = event.occurred_at;
      }
      break;
    }

    case "RUN_DEDUP_RECORDED": {
      const run = state.runs.get(p.run_id);
      if (run) {
        run.status = "deduped";
        run.equivalence_key = p.equivalence_key;
        run.equivalent_to_run_id = p.equivalent_to_run_id;
      }
      break;
    }

    case "CLAIM_PROPOSED": {
      state.claims.set(p.claim_id, {
        claim_id: p.claim_id,
        run_id: p.run_id,
        kind: p.kind,
        status: p.status ?? "pending_review",
        statement: p.statement,
        evidence_summary: p.evidence_summary ?? null,
        proposed_by: p.proposed_by ?? null,
        reviews: [],
        proposed_at: event.occurred_at,
      });
      link(state, p.claim_id, "scientific_claim", [p.run_id]);
      break;
    }

    case "CLAIM_REVIEWED": {
      const claim = state.claims.get(p.claim_id);
      if (claim) {
        claim.reviews.push({
          verdict: p.verdict,
          reviewer: p.reviewer,
          rationale: p.rationale,
          accepted_kind: p.accepted_kind ?? null,
          reviewed_at: event.occurred_at,
        });
        if (p.verdict === "accept") {
          claim.status = "accepted";
          claim.kind = p.accepted_kind ?? claim.kind;
        } else if (p.verdict === "return") {
          claim.status = "returned";
        } else {
          claim.status = "rejected";
        }
      }
      break;
    }

    case "CONSENT_GRANTED": {
      state.grants.set(grantKey(p.subject_ref, p.project_id), {
        grant_id: p.grant_id,
        subject_ref: p.subject_ref,
        project_id: p.project_id,
        scope: p.scope,
        granted_at: p.granted_at,
        withdrawn_at: null,
      });
      break;
    }

    case "ACCESS_WITHDRAWN": {
      state.withdrawals.push({
        subject_ref: p.subject_ref,
        project_id: p.project_id ?? null,
        withdrawn_at: p.withdrawn_at,
        reason: p.reason ?? null,
      });
      for (const [key, grant] of state.grants) {
        if (grant.subject_ref !== p.subject_ref) continue;
        if (p.project_id && grant.project_id !== p.project_id) continue;
        grant.withdrawn_at = p.withdrawn_at;
      }
      break;
    }

    case "DERIVATIVE_FLAGGED": {
      state.flags.set(p.artifact_id, { ...p, flagged_at: event.occurred_at });
      const target =
        state.layers.get(p.artifact_id) ??
        state.runs.get(p.artifact_id) ??
        state.claims.get(p.artifact_id) ??
        state.publications.get(p.artifact_id);
      if (target) target.flagged = true;
      break;
    }

    case "PUBLICATION_RELEASED": {
      state.publications.set(p.publication_id, {
        publication_id: p.publication_id,
        claim_ids: [...p.claim_ids],
        aggregate_findings: [...p.aggregate_findings],
        released_at: p.released_at,
        flagged: false,
      });
      link(state, p.publication_id, "publication", p.claim_ids);
      break;
    }

    default:
      break;
  }
}

/** 从事件流（重放）构建读模型。 */
export function project(events) {
  const state = newState();
  for (const event of events) apply(state, event);
  return state;
}

/** 当前授权是否仍有效（存在授权且未被撤权）。 */
export function consentActive(state, subjectRef, projectId) {
  const grant = state.grants.get(grantKey(subjectRef, projectId));
  return Boolean(grant && grant.withdrawn_at === null);
}

/** 从某个节点向上的全部祖先（含自身），即复现所需的完整数据谱系。 */
export function ancestorsOf(state, artifactId) {
  const seen = new Set();
  const stack = [artifactId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = state.artifacts.get(id);
    if (n) for (const up of n.derivesFrom) stack.push(up);
  }
  return seen;
}

/** 从某个节点向下的全部后代（含自身），用于撤权级联定位。 */
export function descendantsOf(state, artifactId) {
  const seen = new Set();
  const stack = [artifactId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = state.artifacts.get(id);
    if (n) for (const child of n.children) stack.push(child);
  }
  return seen;
}

/**
 * 撤权后受影响的全部派生物：从该供体的所有受控数据集版本向下闭包，
 * 但排除公开/开放数据节点（供体标识只会出现在受控链路上）。
 */
export function affectedByWithdrawal(state, subjectRef) {
  const roots = [];
  for (const [id, n] of state.artifacts) {
    if (n.kind === "dataset_version" && n.subjects.has(subjectRef)) roots.push(id);
  }
  const affected = new Set();
  for (const root of roots) for (const id of descendantsOf(state, root)) affected.add(id);
  return affected;
}
