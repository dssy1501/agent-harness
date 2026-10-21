/**
 * tools.ts —— 把契约里的 Capability 翻译成模型能懂的工具定义。
 *
 * 这一步是全平台"一份定义驱动三处"的关键一环：
 *   zod schema ──┬─→ JSON Schema（给模型的 tools 列表）
 *                ├─→ 运行时校验（模型给错参数直接拒绝）
 *                └─→ TypeScript 类型（编译期就对上）
 *
 * 如果这里没做好，模型就会幻觉出不存在的参数，
 * 而运行时又静默接受——那是 agent 崩掉的头号原因。
 */

import { z } from "zod";
import type { Capability } from "./contract.ts";

/** 云端 API 的工具定义格式（OpenAI 兼容，国内大多数服务都认这个）。 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 把单个能力转成工具定义。
 *
 * description 里刻意加了一段风险等级说明——让模型知道
 * 这个动作有多危险，它在规划时会自己收敛。
 */
export function capabilityToTool(cap: Capability): ToolDefinition {
  const jsonSchema = z.toJSONSchema(cap.params, {
    io: "input",
    unrepresentable: "any",
  });

  return {
    type: "function",
    function: {
      name: cap.id,
      description: `${cap.description}（风险等级：${cap.risk}）`,
      // JSON Schema 的根必须是 object 且带 properties，
      // 大多数云端 API 不接受别的根类型，这里统一规整一下。
      parameters: normalizeRootObject(jsonSchema as Record<string, unknown>),
    },
  };
}

/** 一堆能力 → 一批工具定义。 */
export function capabilitiesToTools(caps: Capability[]): ToolDefinition[] {
  return caps.map(capabilityToTool);
}

/**
 * 规整 schema 根节点为 OpenAI tools 要求的形式。
 * 有些 schema 库会产出 $ref / $defs，云端 API 不一定吃得下，
 * 所以这里强制内联展开一层，根节点固定为 object。
 */
function normalizeRootObject(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const { $schema, $defs, definitions, ...rest } = schema;

  const normalized: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    ...rest,
  };

  // 没有 properties 的能力（无参能力）也要给个空对象，
  // 否则部分 API 会返回 400。
  if (!normalized.properties) {
    normalized.properties = {};
  }

  return normalized;
}
