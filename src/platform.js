import { randomUUID } from "node:crypto";

import { EventStore } from "./store/event-store.js";
import {
  ancestorsOf,
  consentActive,
  project,
} from "./model/projections.js";
import * as governance from "./governance.js";
import { GovernanceError } from "./errors.js";

/**
 * 联合研究平台门面。
 *
 * 职责：
 *  - 接收命令 → 在最新读模型上运行治理判定 → 为事件补齐标识/版本/时间/
 *    操作者/因果关联 → 经仅追加存储原子提交。
 *  - 命令幂等：同键重放（失败重跑、网络重试、并行点击）只取回首次结果。
 *  - 提供复现清单、公开发布视图、管理员风险视图三种读侧出口，并在出口处
 *    保证个体表达与受限元数据不外泄。
 *
 * 时钟与标识生成器均可注入，便于确定性测试。
 */

const HANDLERS = {
  registerDataset: governance.registerDataset,
  recordQuality: governance.recordQuality,
  proposeMappingRevision: governance.proposeMappingRevision,
  approveMapping: governance.approveMapping,
  deriveLayer: governance.deriveLayer,
  registerBatch: governance.registerBatch,
  startRun: governance.startRun,
  completeRun: governance.completeRun,
  failRun: governance.failRun,
  proposeClaim: governance.proposeClaim,
  reviewClaim: governance.reviewClaim,
  grantConsent: governance.grantConsent,
  withdrawAccess: governance.withdrawAccess,
  releasePublication: governance.releasePublication,
};

/** 若命令未自带时间，则由平台时钟补齐这些载荷字段。 */
const NOW_FIELDS = {
  registerBatch: "recorded_at",
  grantConsent: "granted_at",
  withdrawAccess: "withdrawn_at",
  releasePublication: "released_at",
};

export class FederationPlatform {
  /**
   * @param {{ store?: EventStore, clock?: () => string, idGenerator?: (ctx: object) => string }} [options]
   */
  constructor(options = {}) {
    this.store = options.store ?? new EventStore();
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idGenerator = options.idGenerator ?? (({ commandName, seq }) => `${commandName}-${seq}-${randomUUID()}`);
    this._seq = 0;
  }

  /** 从事件流重建读模型（派生数据，随时可完整重放）。 */
  state() {
    return project(this.store.all());
  }

  /**
   * 分发一条治理命令。
   * @param {string} commandName HANDLERS 中的命令名
   * @param {object} command 命令载荷
   * @param {{ idempotencyKey?: string, actor?: object, correlationId?: string }} [meta]
   */
  dispatch(commandName, command, meta = {}) {
    const handler = HANDLERS[commandName];
    if (!handler) throw new GovernanceError("UNKNOWN_COMMAND", `未知命令：${commandName}`);

    // 先查命令幂等台账：命中则原样返回首次结果，不执行、不追加事件。
    if (meta.idempotencyKey) {
      const prior = this.store.idempotencyRecord(meta.idempotencyKey);
      if (prior) {
        return {
          replay: true,
          events: this.store.eventsByIds(prior.event_ids ?? []),
          result: prior.result,
          command_id: prior.command_id,
        };
      }
    }

    const commandId = `cmd-${commandName}-${(this._seq += 1)}`;
    const now = this.clock();
    const normalized = { ...command };
    const nowField = NOW_FIELDS[commandName];
    if (nowField && normalized[nowField] === undefined) normalized[nowField] = now;

    const state = this.state();
    const decision = handler(state, normalized);
    const specs = decision.events ?? [];

    // 零事件判定（如重跑时命中已有等价成功结果）：记下幂等结果后直接返回。
    if (specs.length === 0) {
      if (meta.idempotencyKey) {
        this.store.rememberOutcome(meta.idempotencyKey, { commandId, result: decision.result, recordedAt: now });
      }
      return { replay: false, events: [], result: decision.result, command_id: commandId };
    }

    // 每个聚合在本批内的版本递增（撤权会同时写多个聚合）。
    const batchVersions = new Map();
    const envelopes = specs.map((s) => {
      const key = `${s.aggregateType}:${s.aggregateId}`;
      const version = (batchVersions.get(key) ?? this.store.currentVersion(s.aggregateType, s.aggregateId)) + 1;
      batchVersions.set(key, version);
      this._seq += 1;
      return {
        event_id: this.idGenerator({ commandName, aggregateId: s.aggregateId, eventType: s.type, seq: this._seq }),
        event_type: s.type,
        aggregate_type: s.aggregateType,
        aggregate_id: s.aggregateId,
        occurred_at: now,
        version,
        summary: s.summary,
        actor: meta.actor ? { id: meta.actor.id, role: meta.actor.role } : undefined,
        causation_id: commandId,
        correlation_id: meta.correlationId,
        idempotency_key: meta.idempotencyKey,
        payload: s.payload,
      };
    });

    const committed = this.store.commit(envelopes, {
      idempotencyKey: meta.idempotencyKey,
      commandId,
      result: decision.result,
    });

    if (committed.replay) {
      return { replay: true, events: committed.events, result: committed.result, command_id: commandId };
    }
    return { replay: false, events: committed.events, result: decision.result, command_id: commandId };
  }

  /**
   * 候选关系的复现清单：沿谱系向上闭包，汇总原始数据版本（内容哈希）、
   * 基因/本体映射修订、处理流水线、运行批次与模型参数指纹，以及产生它们
   * 的事件序列。清单只含哈希与参数指纹，不含任何个体表达。
   */
  lineageFor(claimId) {
    const state = this.state();
    const claim = state.claims.get(claimId);
    if (!claim) throw new GovernanceError("UNKNOWN_CLAIM", `主张不存在：${claimId}`);

    const ancestorIds = [...ancestorsOf(state, claimId)].filter((id) => id !== claimId);
    const datasets = [];
    const mappingRevisions = [];
    const layers = [];
    const runs = [];

    for (const id of ancestorIds) {
      const ds = state.datasets.get(id);
      if (ds) {
        datasets.push({
          dataset_version_id: ds.version_id,
          dataset_id: ds.dataset_id,
          species: ds.species,
          matrix_kind: ds.matrix_kind,
          content_hash: ds.content_hash,
          shape: ds.shape,
          parent_version_id: ds.parent_version_id,
          quality_metrics: ds.quality_metrics,
          // 复现清单可以注明受控制性，但不展开供体身份。
          restriction: ds.restriction,
        });
      }
      const layer = state.layers.get(id);
      if (layer) {
        layers.push({
          layer_id: layer.layer_id,
          transform: layer.transform,
          content_hash: layer.content_hash,
          derives_from: layer.derives_from,
          mapping_revisions: layer.mapping_revisions,
          pipeline: layer.pipeline,
          flagged: layer.flagged,
        });
      }
      const run = state.runs.get(id);
      if (run) {
        runs.push({
          run_id: run.run_id,
          batch_id: run.batch_id,
          project_id: run.project_id,
          status: run.status,
          inputs: run.inputs,
          pipeline: run.pipeline,
          model: {
            name: run.model.name,
            version: run.model.version,
            parameters_hash: run.model.parameters_hash,
          },
          equivalence_key: run.equivalence_key,
          equivalent_to_run_id: run.equivalent_to_run_id,
        });
      }
      if (id.startsWith("mapping:")) {
        const [, tail] = id.split("mapping:");
        const hash = tail.lastIndexOf("#");
        const mappingId = tail.slice(0, hash);
        const revisionNo = Number(tail.slice(hash + 1));
        const rev = state.mappings.get(mappingId)?.revisions.get(revisionNo);
        if (rev) {
          mappingRevisions.push({
            ref: id,
            kind: rev.kind,
            revision: rev.revision,
            content_hash: rev.content_hash,
            entries_summary: rev.entries_summary,
            supersedes_revision: rev.supersedes_revision,
            approved: rev.approved,
            approved_by: rev.approved_by,
          });
        }
      }
    }

    // 产生这些制品的事件信封标识，用于回到事件日志逐字节核对。
    const producingEvents = this.store
      .all()
      .filter((e) => ancestorIds.includes(e.aggregate_id) || e.aggregate_id === claimId)
      .map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        aggregate_id: e.aggregate_id,
        version: e.version,
        causation_id: e.causation_id,
      }));

    return {
      claim: {
        claim_id: claim.claim_id,
        kind: claim.kind,
        status: claim.status,
        statement: claim.statement,
        run_id: claim.run_id,
        evidence_summary: claim.evidence_summary,
        reviews: claim.reviews,
      },
      provenance: { datasets, mapping_revisions: mappingRevisions, layers, runs },
      ancestor_ids: ancestorIds,
      producing_events: producingEvents,
    };
  }

  /**
   * 公开发布视图：任何人可读，但只给出获准的聚合结论与发布时间，
   * 不包含供体、项目、批次、参数、原始哈希之外的任何受限元数据。
   */
  publicView(publicationId) {
    const state = this.state();
    const pub = state.publications.get(publicationId);
    if (!pub) throw new GovernanceError("UNKNOWN_PUBLICATION", `发布不存在：${publicationId}`);
    if (pub.flagged) throw new GovernanceError("PUBLICATION_FLAGGED", `发布 ${publicationId} 已受撤权影响，停止公开`);
    return {
      publication_id: pub.publication_id,
      released_at: pub.released_at,
      findings: pub.aggregate_findings,
      claim_count: pub.claim_ids.length,
    };
  }

  /**
   * 管理员风险视图：定位许可（同意/撤权）与质量风险及受影响派生物。
   * 仅 admin / data_steward 角色可访问；即便如此也只返回标识与指标，
   * 平台从不存储、因此也无法泄露个体表达矩阵。
   */
  adminRiskView(actor) {
    if (!actor || !["admin", "data_steward"].includes(actor.role)) {
      throw new GovernanceError("FORBIDDEN", "仅管理员或数据管家可查看风险视图");
    }
    const state = this.state();

    const consent = [...state.grants.values()].map((g) => ({
      subject_ref: g.subject_ref,
      project_id: g.project_id,
      scope: g.scope,
      active: consentActive(state, g.subject_ref, g.project_id),
      withdrawn_at: g.withdrawn_at,
    }));

    const withdrawals = state.withdrawals.map((w) => ({
      subject_ref: w.subject_ref,
      project_id: w.project_id,
      withdrawn_at: w.withdrawn_at,
      affected_artifacts: [...state.artifacts.values()]
        .filter((n) => n.subjects.has(w.subject_ref) && ["derived_layer", "model_run", "scientific_claim", "publication"].includes(n.kind))
        .map((n) => n.id),
    }));

    return {
      quality_risks: governance.qualityRisks(state),
      consent,
      withdrawals,
      flagged_artifacts: [...state.flags.values()],
    };
  }
}
