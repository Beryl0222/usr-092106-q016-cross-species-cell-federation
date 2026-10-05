import assert from "node:assert/strict";
import test from "node:test";

import { GovernanceError } from "../src/errors.js";
import { makePlatform, buildHappyPath, acceptAndPublish, IDS, PIPELINE_MODEL, MODEL } from "./fixtures.js";

function expectError(fn, code) {
  assert.throws(
    fn,
    (e) => {
      assert.ok(e instanceof GovernanceError, `期望 GovernanceError，实际 ${e.constructor.name}: ${e.message}`);
      if (code) assert.equal(e.code, code, `期望错误码 ${code}，实际 ${e.code}（${e.message}）`);
      return true;
    },
  );
}

test("合规全路径：登记→批准映射→派生层→运行→待审假设→专家接受→公开发布", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  const before = platform.state();
  assert.equal(before.claims.get(IDS.claim).status, "pending_review");
  assert.equal(before.claims.get(IDS.claim).kind, "cross_species_similarity_hypothesis");

  acceptAndPublish(platform);
  const state = platform.state();
  assert.equal(state.claims.get(IDS.claim).status, "accepted");
  assert.ok(state.publications.has(IDS.publication));
});

test("复现清单可还原任一候选关系的数据版本、映射修订、流水线与模型参数指纹", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  const lineage = platform.lineageFor(IDS.claim);

  const datasetIds = lineage.provenance.datasets.map((d) => d.dataset_version_id);
  assert.deepEqual(datasetIds.sort(), [IDS.human, IDS.mouse].sort());
  const human = lineage.provenance.datasets.find((d) => d.dataset_version_id === IDS.human);
  assert.equal(human.content_hash, "sha256:raw-human-lung-v1");
  assert.equal(human.restriction, "controlled");
  // 清单只提示受控制性，不暴露供体身份或个体表达数据。
  assert.equal("subject_ref" in human, false);
  assert.equal(JSON.stringify(lineage).includes(IDS.subject), false);
  assert.equal(/cell_barcode|expression_matrix|raw_counts/i.test(JSON.stringify(lineage.provenance)), false);

  assert.equal(lineage.provenance.mapping_revisions.length, 1);
  assert.equal(lineage.provenance.mapping_revisions[0].content_hash, "sha256:genemap-hm-r1");
  assert.equal(lineage.provenance.mapping_revisions[0].approved, true);

  const layerTransforms = lineage.provenance.layers.map((l) => l.transform).sort();
  assert.deepEqual(layerTransforms, ["batch_correction", "mapping_application"]);

  const run = lineage.provenance.runs[0];
  assert.equal(run.batch_id, IDS.batch);
  assert.equal(run.model.parameters_hash, MODEL.parameters_hash);
  assert.equal(run.pipeline[0].tool, "cell-align");
  assert.ok(run.equivalence_key.startsWith("sha256:"));

  assert.ok(lineage.producing_events.length >= 8);
  assert.ok(lineage.producing_events.every((e) => e.event_id && e.causation_id));
});

test("原始表达矩阵不可变：新版本另登记，映射与校正只产生新层，原始哈希不变", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  const r2 = platform.dispatch("registerDataset", {
    dataset_id: "human-lung",
    species: "human",
    content_hash: "sha256:raw-human-lung-v2",
    restriction: "controlled",
    subject_ref: IDS.subject,
    parent_version_id: IDS.human,
  });
  assert.equal(r2.result.dataset_version_id, "dataset:human-lung:v2");

  const state = platform.state();
  assert.equal(state.datasets.get(IDS.human).content_hash, "sha256:raw-human-lung-v1");
  assert.equal(state.datasets.get("dataset:human-lung:v2").parent_version_id, IDS.human);
  // 原始数据与派生层是不同制品，原始节点上没有任何“变换”。
  assert.ok(!state.artifacts.get(IDS.human).derivesFrom.has(IDS.correctedLayer));
  assert.ok(state.layers.has(IDS.mappedLayer) && state.layers.has(IDS.correctedLayer));
});

test("未批准映射不得进入比较层；映射提交人不能自批", () => {
  const { platform } = makePlatform();
  platform.dispatch("registerDataset", { dataset_id: "human-lung", species: "human", content_hash: "h1" });
  platform.dispatch("proposeMappingRevision", {
    mapping_id: "g",
    kind: "gene_identifier",
    entries_summary: { source_namespace: "HGNC", target_namespace: "MGI", item_count: 3 },
    content_hash: "m1",
    proposed_by: "same-person",
  });
  expectError(
    () => platform.dispatch("approveMapping", { mapping_id: "g", revision: 1, approved_by: "same-person" }),
    "SEPARATION_OF_DUTIES",
  );
  expectError(
    () =>
      platform.dispatch("deriveLayer", {
        layer_id: "L",
        dataset_version_id: IDS.human,
        transform: "mapping_application",
        pipeline: [{ step: "map", tool: "t", tool_version: "1", parameters: {} }],
        content_hash: "l1",
        derives_from: [IDS.human],
        mapping_revisions: [{ mapping_id: "g", revision: 1 }],
        created_by: "bot",
      }),
    "MAPPING_NOT_APPROVED",
  );
});

test("受控人类样本：缺同意不能计算，开放物种数据可直接计算，授权后放行", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform, { consent: false });
  expectError(
    () =>
      platform.dispatch("startRun", {
        run_id: "run:blocked",
        project_id: IDS.project,
        batch_id: IDS.batch,
        inputs: [IDS.correctedLayer],
        pipeline: PIPELINE_MODEL,
        model: MODEL,
      }),
    "CONSENT_REQUIRED",
  );

  // 纯开放数据（鼠）的运行无需同意。
  const open = platform.dispatch("startRun", {
    run_id: "run:open",
    project_id: "proj-other",
    batch_id: IDS.batch,
    inputs: [IDS.mouse],
    pipeline: PIPELINE_MODEL,
    model: { ...MODEL, parameters_hash: "sha256:open-only" },
  });
  assert.equal(open.result.run_id, "run:open");

  // 补授权后受控链路放行。
  platform.dispatch("grantConsent", {
    grant_id: "grant-1",
    subject_ref: IDS.subject,
    project_id: IDS.project,
    scope: "受控比较计算",
  });
  const allowed = platform.dispatch("startRun", {
    run_id: IDS.run,
    project_id: IDS.project,
    batch_id: IDS.batch,
    inputs: [IDS.correctedLayer],
    pipeline: PIPELINE_MODEL,
    model: MODEL,
  });
  assert.equal(allowed.replay, false);
});

test("跨物种相似度只能提交为待审假设，不能自动升级为因果结论", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  expectError(
    () =>
      platform.dispatch("proposeClaim", {
        claim_id: "claim:bad",
        run_id: IDS.run,
        kind: "disease_causal_interpretation",
        statement: "该细胞状态导致肺纤维化",
        proposed_by: "analyst-c",
      }),
    "CLAIM_KIND_FORBIDDEN",
  );
  // 复核人不能是提交人。
  expectError(
    () =>
      platform.dispatch("reviewClaim", {
        claim_id: IDS.claim,
        verdict: "accept",
        reviewer: "analyst-c",
        rationale: "自批",
      }),
    "SEPARATION_OF_DUTIES",
  );
  // 专家在复核中显式升级，结论等级才被记录在该审查事件上。
  platform.dispatch("reviewClaim", {
    claim_id: IDS.claim,
    verdict: "accept",
    reviewer: "expert-d",
    rationale: "功能实验佐证，接受为疾病因果解释",
    accepted_kind: "disease_causal_interpretation",
  });
  const state = platform.state();
  assert.equal(state.claims.get(IDS.claim).kind, "disease_causal_interpretation");
  assert.equal(state.claims.get(IDS.claim).reviews[0].accepted_kind, "disease_causal_interpretation");
});

test("发布只收录已接受主张，公开视图只有获准聚合结论", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  expectError(
    () =>
      platform.dispatch("releasePublication", {
        publication_id: "pub-early",
        claim_ids: [IDS.claim],
        aggregate_findings: ["结论"],
      }),
    "CLAIM_NOT_ACCEPTED",
  );
  acceptAndPublish(platform);
  const view = platform.publicView(IDS.publication);
  assert.deepEqual(Object.keys(view).sort(), ["claim_count", "findings", "publication_id", "released_at"]);
  assert.equal(JSON.stringify(view).includes(IDS.subject), false);
  assert.equal(JSON.stringify(view).includes(IDS.project), false);
});

test("命令幂等：同键重试只取回首次结果", () => {
  const { platform } = makePlatform();
  const payload = { dataset_id: "mouse-lung", species: "mouse", content_hash: "h1" };
  const a = platform.dispatch("registerDataset", payload, { idempotencyKey: "idem-register-1" });
  const b = platform.dispatch("registerDataset", payload, { idempotencyKey: "idem-register-1" });
  assert.equal(a.replay, false);
  assert.equal(b.replay, true);
  assert.deepEqual(b.result, a.result);
  assert.equal(platform.state().datasets.size, 1);
});

test("管理员风险视图：可定位许可与质量风险，但不含个体表达；越权被拒", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform, { qualityMetrics: { median_genes_per_cell: 90, mitochondrial_fraction: 0.41 } });
  expectError(() => platform.adminRiskView({ id: "x", role: "analyst" }), "FORBIDDEN");

  const view = platform.adminRiskView({ id: "admin-1", role: "admin" });
  const humanRisk = view.quality_risks.filter((r) => r.dataset_version_id === IDS.human);
  assert.equal(humanRisk.length, 2);
  const consentRow = view.consent.find((c) => c.subject_ref === IDS.subject);
  assert.equal(consentRow.active, true);
  // 风险视图仅含标识与指标。
  assert.equal(JSON.stringify(view).includes("sha256:raw-human-lung-v1"), false);
  assert.equal(/cell_barcode|expression_matrix/i.test(JSON.stringify(view)), false);
});
