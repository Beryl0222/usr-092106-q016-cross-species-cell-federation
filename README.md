# 跨物种细胞资料联邦 · 数据与发现治理后端

人、鼠、斑马鱼、海绵的单细胞数据进入共同研究空间时，同名基因、组织本体、
实验批次、疾病标签并不等价；模型给出的“相似细胞”只是**待验证假设**。
本服务用**仅追加事件溯源**保证：任一候选关系都能复现其数据版本、标识映射、
处理流水线与模型参数；原始表达矩阵永不改写；跨物种相似度不会被自动升级为
进化或疾病因果结论。

零运行时依赖，Node ≥ 20，纯 ESM。

## 核心治理规则（代码强制，而非约定）

1. **原始矩阵不可变。** `DATASET_REGISTERED` 只按内容哈希登记版本；更正登记为
   新版本（`parent_version_id` 指向前版）。映射修订与批次校正只产生新的
   **派生层**（`LAYER_DERIVED`），绝不覆盖原始数据。
2. **映射必须批准。** 基因标识 / 组织本体 / 疾病标签映射的每次修订都留痕，
   且提交人不能自批（职责分离）；只有已批准修订才能进入比较层。
3. **跨物种相似度只是待审假设。** 模型结果只能提交为
   `cross_species_similarity_hypothesis`；进化解释或疾病因果解释只能由专家在
   复核中显式作出，系统不提供“自动升级”路径。
4. **受控人类样本按项目同意放行。** 缺少有效同意的计算直接拒绝；撤权后：
   - 阻止该链路的一切新运行；
   - 对运行、主张、发布等派生物逐一追加 `DERIVATIVE_FLAGGED`；
   - 项目级撤权不冻结可被其他获批项目复用的共享派生层，供体全局撤权才冻结层；
   - 被标记的发布立即停止公开，被标记的主张不能再进入发布。
5. **等价结果只登记一个。** 以「排序后的输入 + 流水线 + 模型参数指纹」生成
   规范等价键。失败重跑命中已有成功结果时只返回复用指引；两个并行等价运行中
   先完成者获胜，后来者登记为去重指针（`RUN_DEDUP_RECORDED`），不是第二份结果。
   被撤权标记的规范结果失去规范地位，持有效同意的项目可重新计算并接管该键。
6. **公开发布只含获准聚合结论。** 只有已接受、未被标记的主张能发布；公开视图
   不含供体、项目、批次、参数等受限元数据。管理员风险视图可定位许可与质量风险，
   但平台本身从不保存个体表达矩阵，因此也无从泄露。

## 架构

```
命令 (command)
   │  FederationPlatform.dispatch  —— 注入时间/事件ID/版本/操作者/因果ID/幂等键
   ▼
src/governance.js        纯策略：在当前读模型上判定，产出 0..n 个事件规格
   ▼
src/store/event-store.js 仅追加存储：事件ID唯一、聚合版本乐观并发、命令幂等、JSONL落盘
   ▼  重放
src/model/projections.js 读模型：数据集/映射/层/批次/运行/主张/同意/发布 + 谱系图
   ▲
   └── lineageFor / publicView / adminRiskView  三类读侧出口
```

事件是唯一事实来源；所有读模型与谱系闭包都是可随时从事件流重建的派生物。

## 事件信封

见 [`contracts/domain.schema.json`](contracts/domain.schema.json) 与类型定义
[`src/domain.ts`](src/domain.ts)。在基础字段之上新增：

- `actor`：操作者（id / role）；
- `causation_id`：触发命令（命令→事件）；
- `correlation_id`：同一业务活动（一轮撤权、一次发布）的关联标识；
- `idempotency_key`：命令幂等键，重放只取回首次结果；
- `payload`：内容哈希、映射修订、流水线步骤、模型参数指纹、审查结论、同意范围等。

事件一经接收，`event_id / occurred_at / version` 不可原地改写；更正只能追加后继事件。

### 事件与聚合

| 事件 | 聚合 | 含义 |
| --- | --- | --- |
| `DATASET_REGISTERED` / `DATASET_QUALITY_RECORDED` | dataset_version | 不可变数据版本与质量指标 |
| `MAPPING_REVISION_PROPOSED` / `MAPPING_APPROVED` | ontology_mapping | 基因/组织/疾病/批次映射修订与批准 |
| `LAYER_DERIVED` | derived_layer | 映射应用、批次校正等可比较新层 |
| `RUN_BATCH_REGISTERED` | run_batch | 实验/上机批次 |
| `RUN_STARTED` / `RUN_COMPLETED` / `RUN_FAILED` / `RUN_DEDUP_RECORDED` | model_run | 模型运行生命周期与等价去重 |
| `CLAIM_PROPOSED` / `CLAIM_REVIEWED` | scientific_claim | 候选相似性假设与专家复核 |
| `CONSENT_GRANTED` / `ACCESS_WITHDRAWN` | consent_grant | 同意登记与撤权 |
| `DERIVATIVE_FLAGGED` | 随被标记物而定 | 撤权后标记层/运行/主张/发布 |
| `PUBLICATION_RELEASED` | publication | 获准聚合结论的公开发布 |

## 复现任一候选关系

`platform.lineageFor(claimId)` 沿谱系图向上闭包，返回：

- 全部上游**原始数据版本**及其 `content_hash`、物种、行列规模、质量指标；
- 经批准的**映射修订**（命名空间、条目数、内容哈希、批准人）；
- 每一层的**处理流水线**（工具、版本、参数）与内容哈希；
- **运行批次**、项目、输入、模型名称/版本/**参数指纹** `parameters_hash`；
- 产生上述制品的**事件信封标识**，可回到 JSONL 日志逐字节核对。

清单只含哈希与参数指纹，不含供体身份与任何个体表达。

## 读侧出口

- `lineageFor(claimId)`：候选关系的完整复现清单（科研/审计）。
- `publicView(publicationId)`：任何人可读，仅含发布时间与获准聚合结论。
- `adminRiskView(actor)`：仅 `admin` / `data_steward`，定位质量风险、同意状态、
  撤权及受影响派生物；越权访问被拒绝。

## 本地检查

```bash
node --test
```

测试覆盖：契约校验、仅追加与版本并发、命令幂等、JSONL 跨进程重放、不可变与
派生层、映射批准与职责分离、同意门控、项目级/全局撤权级联、失败重跑与并行
去重、主张审查与禁止自动升级、发布收录规则与公开视图脱敏。

## 目录

- `contracts/`：事件信封 JSON Schema。
- `src/domain.ts`：信封与全部载荷的类型定义。
- `src/validator.js`：信封形状校验（不含业务规则）。
- `src/store/event-store.js`：仅追加存储、乐观并发、幂等台账、JSONL 日志。
- `src/model/projections.js`：读模型投影与谱系（祖先/后代/撤权影响闭包）。
- `src/governance.js`：治理策略（命令 → 事件规格）。
- `src/platform.js`：门面、复现清单、公开/管理员视图。
- `src/hashing.js`：内容寻址与运行等价键。
- `tests/`：契约、治理与生命周期场景。
- `data/sample.json`：受控人类数据版本登记样例。
