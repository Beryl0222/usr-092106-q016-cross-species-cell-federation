import { EventStore } from "../src/store/event-store.js";
import { FederationPlatform } from "../src/platform.js";

/**
 * 构造确定性平台：时钟按调用次数推进，事件标识顺序生成，便于断言。
 */
export function makePlatform({ journalFile } = {}) {
  let t = 0;
  const base = Date.parse("2026-10-05T09:00:00Z");
  const clock = () => new Date(base + t++ * 1000).toISOString();
  let seq = 0;
  const idGenerator = () => `evt-${String(++seq).padStart(3, "0")}`;
  const store = new EventStore(journalFile ? { journalFile } : undefined);
  const platform = new FederationPlatform({ store, clock, idGenerator });
  return { platform, clock, nextEventId: () => `evt-${String(seq + 1).padStart(3, "0")}` };
}

export const IDS = {
  project: "proj-cross-01",
  subject: "cohort-lung-2026",
  batch: "batch:2026-10-seqA",
  human: "dataset:human-lung:v1",
  mouse: "dataset:mouse-lung:v1",
  zebra: "dataset:zf-lung:v1",
  sponge: "dataset:sponge-body:v1",
  mappedLayer: "layer:hm-mapped:v1",
  correctedLayer: "layer:hm-corrected:v1",
  geneMapping: "gene-human-mouse",
  ontologyMapping: "tissue-uberon",
  diseaseMapping: "disease-mondo",
  run: "run:hm-001",
  claim: "claim:hm-001",
  publication: "pub:cross-001",
};

/** 标准映射流水线步骤。 */
export const PIPELINE_MAP = [
  { step: "identifier_mapping", tool: "ortho-map", tool_version: "1.4.0", parameters: { namespace: "HGNC->MGI", one_to_one_only: true } },
];
export const PIPELINE_CORRECT = [
  { step: "batch_correction", tool: "harmony", tool_version: "0.9.2", parameters: { theta: 2, lambda: 1 } },
];
export const PIPELINE_MODEL = [
  { step: "cross_species_embedding", tool: "cell-align", tool_version: "3.1.0", parameters: { dims: 50, k: 15 } },
];
export const MODEL = { name: "cell-align", version: "3.1.0", parameters_hash: "sha256:params-cellalign-v3" };

/**
 * 铺设到“可提交候选主张”为止的完整合规路径。
 * 返回平台与所有关键标识，供各场景在此基础上制造分歧。
 */
export function buildHappyPath(platform, { consent = true, qualityMetrics } = {}) {
  const d = (commandName, command, meta = {}) => platform.dispatch(commandName, command, meta);

  d("registerDataset", {
    dataset_id: "human-lung",
    species: "human",
    matrix_kind: "raw_expression",
    content_hash: "sha256:raw-human-lung-v1",
    shape: { cells: 48213, genes: 33538 },
    restriction: "controlled",
    subject_ref: IDS.subject,
    quality_metrics: qualityMetrics ?? { median_genes_per_cell: 1840, mitochondrial_fraction: 0.08 },
  });
  d("registerDataset", {
    dataset_id: "mouse-lung",
    species: "mouse",
    content_hash: "sha256:raw-mouse-lung-v1",
    shape: { cells: 30120, genes: 31022 },
  });
  d("registerDataset", { dataset_id: "zf-lung", species: "zebrafish", content_hash: "sha256:raw-zf-v1" });
  d("registerDataset", { dataset_id: "sponge-body", species: "sponge", content_hash: "sha256:raw-sponge-v1" });

  if (consent) {
    d("grantConsent", {
      grant_id: "grant:lung-2026:proj-cross-01",
      subject_ref: IDS.subject,
      project_id: IDS.project,
      scope: "跨物种单细胞比较的受控计算",
    });
  }

  d("proposeMappingRevision", {
    mapping_id: IDS.geneMapping,
    kind: "gene_identifier",
    entries_summary: { source_namespace: "HGNC", target_namespace: "MGI", item_count: 15220 },
    content_hash: "sha256:genemap-hm-r1",
    proposed_by: "curator-lab-a",
    note: "人鼠一对一同源基因，剔除歧义同名",
  });
  d("approveMapping", { mapping_id: IDS.geneMapping, revision: 1, approved_by: "ontology-board-b" });

  d("proposeMappingRevision", {
    mapping_id: IDS.ontologyMapping,
    kind: "tissue_ontology",
    entries_summary: { source_namespace: "LAB_TERM", target_namespace: "UBERON", item_count: 87 },
    content_hash: "sha256:tissue-r1",
    proposed_by: "curator-lab-a",
  });
  d("approveMapping", { mapping_id: IDS.ontologyMapping, revision: 1, approved_by: "ontology-board-b" });

  d("registerBatch", { batch_id: IDS.batch, label: "2026年10月测序与上机序列A" });

  d("deriveLayer", {
    layer_id: IDS.mappedLayer,
    dataset_version_id: IDS.human,
    transform: "mapping_application",
    pipeline: PIPELINE_MAP,
    content_hash: "sha256:layer-hm-mapped-v1",
    derives_from: [IDS.human, IDS.mouse],
    mapping_revisions: [{ mapping_id: IDS.geneMapping, revision: 1 }],
    created_by: "pipeline-bot",
  });
  d("deriveLayer", {
    layer_id: IDS.correctedLayer,
    dataset_version_id: IDS.human,
    transform: "batch_correction",
    pipeline: PIPELINE_CORRECT,
    content_hash: "sha256:layer-hm-corrected-v1",
    derives_from: [IDS.mappedLayer],
    created_by: "pipeline-bot",
  });

  // 无同意场景下停在比较层，由测试自行验证运行被门控。
  if (consent === false) return platform;

  d("startRun", {
    run_id: IDS.run,
    project_id: IDS.project,
    batch_id: IDS.batch,
    inputs: [IDS.correctedLayer],
    pipeline: PIPELINE_MODEL,
    model: MODEL,
  });
  d("completeRun", { run_id: IDS.run });

  d("proposeClaim", {
    claim_id: IDS.claim,
    run_id: IDS.run,
    kind: "cross_species_similarity_hypothesis",
    statement: "人肺与鼠肺中一组高表达上皮细胞在嵌入空间邻近，属待验证的跨物种相似性",
    evidence_summary: { neighbor_overlap: 0.81, note: "模型相似度，非因果结论" },
    proposed_by: "analyst-c",
  });

  return platform;
}

export function acceptAndPublish(platform, { acceptedKind } = {}) {
  platform.dispatch("reviewClaim", {
    claim_id: IDS.claim,
    verdict: "accept",
    reviewer: "expert-d",
    rationale: "多套参数与独立批次下稳定，作为相似性假设接受",
    accepted_kind: acceptedKind,
  });
  platform.dispatch("releasePublication", {
    publication_id: IDS.publication,
    claim_ids: [IDS.claim],
    aggregate_findings: ["人、鼠肺上皮细胞群在统一本体与同源基因空间中呈现可复现的转录组相似性（聚合结论）。"],
  });
}
