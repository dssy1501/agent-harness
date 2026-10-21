/**
 * harness.test.ts —— 用 MockProvider 跑通"编码 harness"的确定性测试。
 *
 * 不接真实 DeepSeek（没 key、且模型不可复现），全部用脚本化 Mock，
 * 断言：文件读写/编辑/撤销真的改盘、权限闸门对写和命令生效、轨迹落盘。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTask } from "../src/kernel.ts";
import type { KernelEvent } from "../src/contract.ts";
import {
  MockProvider,
  mockText,
  mockToolCall,
} from "../src/provider.ts";
import { codingHarnessManifest } from "../harness/manifest.ts";
import { createTrajectory } from "../harness/trajectory.ts";

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
}

const approveAll = async () => true;
const rejectAll = async () => false;

test("A. 默认 maxAutoRisk=read 时，可逆写被闸门拦下、文件不变", async () => {
  const dir = tmpDir();
  await fs.writeFile(path.join(dir, "a.txt"), "hello", "utf8");

  const provider = new MockProvider([
    mockToolCall("fs.edit_file", {
      path: "a.txt",
      old_string: "hello",
      new_string: "XYZ",
    }),
    mockText("被拒绝了，我没改。"),
  ]);

  const sink: KernelEvent[] = [];
  await runTask(codingHarnessManifest({ root: dir }), "把 a.txt 改成 XYZ", {
    provider,
    confirm: rejectAll,
    onEvent: (e) => sink.push(e),
  });

  const blocked = sink.some(
    (e) => e.t === "gate:blocked" && e.capabilityId === "fs.edit_file",
  );
  assert.equal(blocked, true, "可逆写应被闸门拦下");

  const content = await fs.readFile(path.join(dir, "a.txt"), "utf8");
  assert.equal(content, "hello", "文件不应被改动");
});

test("B. 旋钮提到 reversible-write 后，编辑并撤销，文件回到原样", async () => {
  const dir = tmpDir();
  await fs.writeFile(path.join(dir, "a.txt"), "hello", "utf8");

  const provider = new MockProvider([
    mockToolCall("fs.read_file", { path: "a.txt" }),
    mockToolCall("fs.edit_file", {
      path: "a.txt",
      old_string: "hello",
      new_string: "hello world",
    }),
    mockToolCall("fs.undo", { path: "a.txt" }),
    mockText("已编辑并撤销。"),
  ]);

  const res = await runTask(codingHarnessManifest({ root: dir }), "改一下再撤销", {
    provider,
    confirm: approveAll,
    policy: { maxAutoRisk: "reversible-write" },
  });

  assert.equal(res.reason, "model-finished");
  const content = await fs.readFile(path.join(dir, "a.txt"), "utf8");
  assert.equal(content, "hello", "撤销后应回到原内容");
});

test("C. shell 默认被闸门拦下（不可逆操作需确认）", async () => {
  const dir = tmpDir();

  const provider = new MockProvider([
    mockToolCall("shell.run", { command: "echo hi" }),
    mockText("shell 被拦了。"),
  ]);

  const sink: KernelEvent[] = [];
  await runTask(codingHarnessManifest({ root: dir }), "跑个命令", {
    provider,
    confirm: rejectAll,
    onEvent: (e) => sink.push(e),
  });

  const blocked = sink.some(
    (e) => e.t === "gate:blocked" && e.capabilityId === "shell.run",
  );
  assert.equal(blocked, true, "shell 应被闸门拦下");
});

test("D. 轨迹 JSONL 落盘且含关键事件", async () => {
  const dir = tmpDir();
  const traj = await createTrajectory(dir, "t");

  const provider = new MockProvider([
    mockToolCall("fs.list_dir", {}),
    mockText("看完了。"),
  ]);

  await runTask(codingHarnessManifest({ root: dir }), "列一下目录", {
    provider,
    confirm: approveAll,
    onEvent: traj.onEvent,
  });

  // 追加是异步的，稍等落盘。
  await new Promise((r) => setTimeout(r, 60));

  const raw = await fs.readFile(traj.path, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "应有轨迹记录");
  const events = lines.map((l) => JSON.parse(l) as KernelEvent);
  assert.ok(
    events.some((e) => e.t === "task:start"),
    "轨迹应含 task:start",
  );
  assert.ok(
    events.some((e) => e.t === "capability:call" && e.capabilityId === "fs.list_dir"),
    "轨迹应含 list_dir 调用",
  );
});
