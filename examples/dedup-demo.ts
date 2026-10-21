/**
 * dedup-demo.ts —— 跑"把重复的任务删了"这个指令，对照两个 manifest。
 *
 * 正确版（goodManifest）：应用暴露了状态注入 + find_duplicates + remove_duplicates，
 *   模型能看清现状、用确定性逻辑判重、确认后删除。
 * 错误版（brokenManifest）：只有 list + delete，没有"查重复"能力，
 *   模型面对"删重复的"只能猜 id 或直接说找不到——这就是用户遇到的现场。
 *
 * 跑法：node --experimental-strip-types examples/dedup-demo.ts
 * 结果会同时打印到控制台并写入 _dedup_out.txt。
 */

import { writeFileSync } from "node:fs";
import { runTask } from "../src/kernel.ts";
import type { KernelEvent } from "../src/contract.ts";
import {
  MockProvider,
  mockText,
  mockToolCall,
} from "../src/provider.ts";
import {
  goodManifest,
  brokenManifest,
  resetTasks,
  getTaskCount,
} from "./tasks-manifest.ts";

/** 收集一次运行的"可读记录"。 */
async function runScenario(
  label: string,
  manifest: typeof goodManifest,
  provider: MockProvider,
): Promise<string> {
  resetTasks();
  const lines: string[] = [];
  lines.push(`=== ${label} ===`);
  const before = getTaskCount();
  lines.push(`执行前任务数：${before}`);

  const transcript: string[] = [];
  const onEvent = (e: KernelEvent) => {
    if (e.t === "capability:result") {
      transcript.push(`   ↳ [${e.capabilityId}] ${e.observation}`);
    } else if (e.t === "gate:blocked") {
      transcript.push(`   ⛔ 被闸门拦下：${e.capabilityId} (${e.risk})`);
    }
  };

  const res = await runTask(manifest, "把重复的任务删了", {
    provider,
    confirm: async () => true, // 演示中一律批准
    onEvent,
  });

  for (const line of transcript) lines.push(line);
  lines.push(`模型最终答复：${res.answer}`);
  lines.push(`执行后任务数：${getTaskCount()}（少了 ${before - getTaskCount()} 个）`);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const out: string[] = [];
  out.push("# 场景演示：把重复的任务删了\n");

  // 正确版：模型先 list，再 find_duplicates，再 remove_duplicates。
  const goodProvider = new MockProvider([
    mockToolCall("tasks.list", {}),
    mockToolCall("tasks.find_duplicates", {}),
    mockToolCall("tasks.remove_duplicates", {}),
    mockText("已清理所有重复任务，保留每组一个。"),
  ]);
  out.push(
    await runScenario("正确版：应用给了状态注入 + 查重复能力", goodManifest, goodProvider),
  );

  // 错误版：模型 list 之后，没有"查重复"可用，只能说找不到。
  const brokenProvider = new MockProvider([
    mockToolCall("tasks.list", {}),
    mockText(
      "我看到了任务列表，但无法可靠判断哪些是'重复'——应用没有提供更明确的查重能力，为避免误删，我需要你明确告诉我要删哪些。",
    ),
  ]);
  out.push(
    await runScenario("错误版：只有 list + delete（复现'他说找不到'）", brokenManifest, brokenProvider),
  );

  const text = out.join("\n");
  writeFileSync(
    new URL("../_dedup_out.txt", import.meta.url),
    text,
    "utf8",
  );
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
