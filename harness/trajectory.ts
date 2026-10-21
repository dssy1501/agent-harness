/**
 * trajectory.ts —— append-only 会话日志（对应 dsh 的"每次运行可追溯"）。
 *
 * 内核把所有 KernelEvent 都发出来。这里把它们逐行写进一个 JSONL 文件，
 * 之后可以像 dsh 的 Trajectory 视图那样回放、检索、审计。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { KernelEvent } from "../src/contract.ts";

export interface Trajectory {
  onEvent: (e: KernelEvent) => void;
  path: string;
}

export async function createTrajectory(
  dir: string,
  name = "trajectory",
): Promise<Trajectory> {
  const file = path.join(dir, `${name}.jsonl`);
  await fs.writeFile(file, "", "utf8"); // 覆盖式新建
  const onEvent = (e: KernelEvent): void => {
    // 异步追加，简单可靠（失败静默，不影响主流程）。
    fs.appendFile(file, JSON.stringify(e) + "\n", "utf8").catch(() => {});
  };
  return { onEvent, path: file };
}

/** 同时把关键事件打印到控制台，让本地运行的人能实时看到进度。 */
export function consoleLogger(e: KernelEvent): void {
  switch (e.t) {
    case "task:start":
      console.log(`\n▶ 任务开始：${e.goal}`);
      break;
    case "model:call":
      console.log(
        `  · 模型决策（步 ${e.step}），可用工具 ${e.toolNames.length} 个`,
      );
      break;
    case "capability:call":
      console.log(
        `  → 调用 ${e.capabilityId} ${JSON.stringify(e.args).slice(0, 120)}`,
      );
      break;
    case "capability:result":
      console.log(
        `  ← ${e.capabilityId} ${e.ok ? "成功" : "失败"}：${e.observation.slice(0, 160)}`,
      );
      break;
    case "gate:blocked":
      console.log(`  ⛔ 被权限闸门拦截：${e.capabilityId}（${e.risk}）`);
      break;
    case "snapshot:taken":
      console.log(`  ↩ 已做快照 ${e.snapshotId}`);
      break;
    case "task:done":
      console.log(`■ 任务结束：${e.reason}`);
      break;
    case "budget:hit":
      console.log(`⏱ 预算触顶：${e.limit}`);
      break;
    default:
      break;
  }
}
