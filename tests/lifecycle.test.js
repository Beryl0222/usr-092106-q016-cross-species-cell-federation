import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { EventStore } from "../src/store/event-store.js";
import { FederationPlatform } from "../src/platform.js";
import { GovernanceError } from "../src/errors.js";
import { makePlatform, buildHappyPath, acceptAndPublish, IDS, PIPELINE_MODEL, MODEL } from "./fixtures.js";

const mkdtempP = promisify(mkdtemp);
const rmP = promisify(rm);

function expectError(fn, code) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof GovernanceError, `期望 GovernanceError，实际 ${e.constructor.name}: ${e.message}`);
    if (code) assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}（${e.message}）`);
    return true;
  });
}

/** 只铺设一个开放数据集与批次，用于运行去重实验。 */
function minimalOpenPlatform() {
  const { platform } = makePlatform();
  platform.dispatch("registerDataset", { dataset_id: "mouse-lung", species: "mouse", content_hash: "sha256:m1" });
  platform.dispatch("registerBatch", { batch_id: IDS.batch, label: "序列A" });
  const runInput = {
    project_id: "proj-open",
    batch_id: IDS.batch,
    inputs: ["dataset:mouse-lung:v1"],
    pipeline: PIPELINE_MODEL,
    model: { ...MODEL, parameters_hash: "sha256:params-open" },
  };
  return { platform, runInput };
}

test("失败重跑：失败不登记结果；成功一次后再次等价运行被指引复用，绝不产生第二个结果", () => {
  const { platform, runInput } = minimalOpenPlatform();
  platform.dispatch("startRun", { ...runInput, run_id: "r1" });
  platform.dispatch("failRun", { run_id: "r1", error: "GPU 掉卡" });

  // 同参数重跑可以启动（尚无成功结果）。
  const retry = platform.dispatch("startRun", { ...runInput, run_id: "r2" });
  assert.equal(retry.result.equivalence_key !== undefined, true);
  platform.dispatch("completeRun", { run_id: "r2" });
  assert.equal(platform.state().equivalence.get(retry.result.equivalence_key), "r2");

  // 再次发起等价运行：零事件、指引复用 r2。
  const duplicate = platform.dispatch("startRun", { ...runInput, run_id: "r3" });
  assert.deepEqual(duplicate.events, []);
  assert.equal(duplicate.result.deduped, true);
  assert.equal(duplicate.result.reused_run_id, "r2");
  assert.ok(!platform.state().runs.has("r3"));
});

test("并行任务：两个等价运行同时在跑，只有先完成者登记结果，后来者记为去重指针", () => {
  const { platform, runInput } = minimalOpenPlatform();
  platform.dispatch("startRun", { ...runInput, run_id: "pa" });
  platform.dispatch("startRun", { ...runInput, run_id: "pb" });

  platform.dispatch("completeRun", { run_id: "pa" });
  const pbDone = platform.dispatch("completeRun", { run_id: "pb" });
  assert.equal(pbDone.result.deduped, true);
  assert.equal(pbDone.result.canonical_run_id, "pa");
  assert.equal(platform.state().runs.get("pb").status, "deduped");

  // 去重运行不是独立结果：不能据此提交主张。
  expectError(
    () => platform.dispatch("proposeClaim", { claim_id: "c-b", run_id: "pb", kind: "cross_species_similarity_hypothesis", statement: "x", proposed_by: "a" }),
    "CLAIM_ON_DEDUPED_RUN",
  );
  // 权威结果 pa 可以正常提交。
  platform.dispatch("proposeClaim", { claim_id: "c-a", run_id: "pa", kind: "cross_species_similarity_hypothesis", statement: "y", proposed_by: "a" });
  assert.equal(platform.state().claims.get("c-a").status, "pending_review");
});

test("项目级撤权：阻止新运行并标记该项目运行/主张/发布；共享派生层对其他获批项目仍可用", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  acceptAndPublish(platform);

  const out = platform.dispatch("withdrawAccess", {
    subject_ref: IDS.subject,
    project_id: IDS.project,
    reason: "供体撤回同意",
  });
  const flagged = out.result.flagged_artifacts;
  assert.ok(flagged.includes(IDS.run));
  assert.ok(flagged.includes(IDS.claim));
  assert.ok(flagged.includes(IDS.publication));
  // 项目级撤权不冻结跨项目共享的比较层。
  assert.ok(!flagged.includes(IDS.mappedLayer));
  assert.ok(!flagged.includes(IDS.correctedLayer));

  // 被标记的发布立即停止公开。
  expectError(() => platform.publicView(IDS.publication), "PUBLICATION_FLAGGED");
  // 被标记的主张即使状态为 accepted，也不能再被任何新发布收录。
  assert.equal(platform.state().claims.get(IDS.claim).flagged, true);
  expectError(
    () =>
      platform.dispatch("releasePublication", {
        publication_id: "pub-after-withdraw",
        claim_ids: [IDS.claim],
        aggregate_findings: ["撤权后试图再发布"],
      }),
    "CLAIM_FLAGGED",
  );
  // 新项目运行因同意失效被拒。
  expectError(
    () =>
      platform.dispatch("startRun", {
        run_id: "run:after-withdraw",
        project_id: IDS.project,
        batch_id: IDS.batch,
        inputs: [IDS.correctedLayer],
        pipeline: PIPELINE_MODEL,
        model: MODEL,
      }),
    "CONSENT_REQUIRED",
  );
  // 撤权不可重复登记。
  expectError(
    () => platform.dispatch("withdrawAccess", { subject_ref: IDS.subject, project_id: IDS.project }),
    "NO_ACTIVE_GRANT",
  );

  // 另一个获批项目可继续使用同一共享比较层。
  platform.dispatch("grantConsent", {
    grant_id: "grant-p2",
    subject_ref: IDS.subject,
    project_id: "proj-cross-02",
    scope: "受控比较计算",
  });
  const other = platform.dispatch("startRun", {
    run_id: "run:p2",
    project_id: "proj-cross-02",
    batch_id: IDS.batch,
    inputs: [IDS.correctedLayer],
    pipeline: PIPELINE_MODEL,
    model: MODEL,
  });
  assert.equal(other.result.run_id, "run:p2");
});

test("供体全局撤权：共享派生层一并标记，任何项目的新运行都被阻止", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  const out = platform.dispatch("withdrawAccess", { subject_ref: IDS.subject });
  assert.ok(out.result.flagged_artifacts.includes(IDS.mappedLayer));
  assert.ok(out.result.flagged_artifacts.includes(IDS.correctedLayer));

  expectError(
    () =>
      platform.dispatch("startRun", {
        run_id: "run:blocked-global",
        project_id: "proj-any",
        batch_id: IDS.batch,
        inputs: [IDS.correctedLayer],
        pipeline: PIPELINE_MODEL,
        model: MODEL,
      }),
    "INPUTS_FLAGGED",
  );

  // 管理员可定位受影响派生物。
  const view = platform.adminRiskView({ id: "admin", role: "data_steward" });
  const w = view.withdrawals.find((x) => x.subject_ref === IDS.subject && x.project_id === null);
  assert.ok(w.affected_artifacts.includes(IDS.claim));
});

test("派生物标记是追加事件：撤权与标记事件可在事件日志中完整追溯", () => {
  const { platform } = makePlatform();
  buildHappyPath(platform);
  platform.dispatch("withdrawAccess", { subject_ref: IDS.subject, project_id: IDS.project });
  const events = platform.store.all();
  const withdrawEvent = events.find((e) => e.event_type === "ACCESS_WITHDRAWN");
  const flagEvents = events.filter((e) => e.event_type === "DERIVATIVE_FLAGGED");
  assert.ok(withdrawEvent);
  assert.ok(flagEvents.length >= 2);
  // 同一撤权命令下的事件共享 causation 与时间；各聚合标记事件版本与其历史连续。
  const versions = new Map();
  for (const e of platform.store.all()) {
    const k = `${e.aggregate_type}:${e.aggregate_id}`;
    versions.set(k, (versions.get(k) ?? 0) + 1);
    assert.equal(e.version, versions.get(k), `事件 ${e.event_id} 版本不连续`);
  }
  for (const e of flagEvents) {
    assert.equal(e.causation_id, withdrawEvent.causation_id);
  }
});

test("日志文件跨进程重放：谱系、审查结论与公开发布完全一致", async () => {
  const dir = await mkdtempP(join(tmpdir(), "federation-e2e-"));
  try {
    const file = join(dir, "journal.jsonl");

    const p1 = makePlatform({ journalFile: file }).platform;
    buildHappyPath(p1);
    acceptAndPublish(p1);
    const lineage1 = p1.lineageFor(IDS.claim);
    const public1 = p1.publicView(IDS.publication);

    const store2 = new EventStore({ journalFile: file });
    const p2 = new FederationPlatform({ store: store2, clock: () => "2026-10-05T10:00:00Z" });
    const lineage2 = p2.lineageFor(IDS.claim);
    const public2 = p2.publicView(IDS.publication);

    assert.deepEqual(
      lineage2.ancestor_ids.sort(),
      lineage1.ancestor_ids.sort(),
    );
    assert.equal(lineage2.provenance.datasets.length, lineage1.provenance.datasets.length);
    assert.equal(lineage2.claim.status, "accepted");
    assert.equal(lineage2.claim.kind, "cross_species_similarity_hypothesis");
    assert.deepEqual(public2, public1);

    // 重放后的存储仍保持仅追加语义：再撤权可继续追加且级联判定正确。
    p2.dispatch("withdrawAccess", { subject_ref: IDS.subject, project_id: IDS.project });
    expectError(() => p2.publicView(IDS.publication), "PUBLICATION_FLAGGED");
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
});
