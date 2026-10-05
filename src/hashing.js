import { createHash } from "node:crypto";

/**
 * 规范化哈希：对对象的键排序后序列化，保证语义相同的输入得到相同哈希，
 * 用于内容寻址、模型参数指纹和运行等价键。
 * @param {unknown} value
 * @returns {string} 形如 sha256:…
 */
export function canonicalHash(value) {
  const json = JSON.stringify(sortKeys(value));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

/**
 * 运行等价键：相同输入集合 + 相同处理流水线 + 相同模型参数指纹，
 * 则成功结果等价。失败重跑与并行任务命中同键时只登记一个结果。
 */
export function runEquivalenceKey({ inputs = [], pipeline = [], model = {} }) {
  return canonicalHash({
    inputs: [...inputs].map(String).sort(),
    pipeline,
    model: { name: model.name, version: model.version, parameters_hash: model.parameters_hash },
  });
}
