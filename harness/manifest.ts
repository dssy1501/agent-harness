/**
 * manifest.ts —— 把文件 + 终端插件装配成一个"编码 harness"的 manifest。
 *
 * 这一步就是 dsh 里"选插件、装进运行时"的对应物：
 * 文件编辑、终端、状态提供者，全在这里拼起来。内核不关心它们是
 * 谁、干什么，只按契约对待。换一套工具 = 换这个 manifest。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppManifest, Policy } from "../src/contract.ts";
import { createFileSystemCapabilities } from "./plugins/filesystem.ts";
import { createShellCapability } from "./plugins/shell.ts";

export interface HarnessOptions {
  /** 工作目录（沙箱根）。智能体只能在这个目录内活动。 */
  root: string;
  /** 覆盖策略。默认只放行 read，其余都要确认。 */
  policy?: Partial<Policy>;
  /** 是否包含 shell 能力。默认包含。 */
  includeShell?: boolean;
}

export function codingHarnessManifest(opts: HarnessOptions): AppManifest {
  const root = path.resolve(opts.root);
  const capabilities = [
    ...createFileSystemCapabilities(root),
    ...(opts.includeShell ?? true ? [createShellCapability(root)] : []),
  ];

  const stateProviders = [
    {
      id: "workspace",
      title: "工作目录结构",
      refresh: "once" as const,
      snapshot: async () => describeTree(root),
    },
  ];

  return {
    appId: "coding-harness",
    title: "编码 Harness",
    systemPrompt:
      "你是一个运行在本地工作目录上的编码智能体。" +
      "你可以通过文件读写、局部改写、目录浏览、文件搜索和终端命令来理解和修改代码。" +
      "动手前先用 fs.list_dir / fs.glob / fs.grep 了解结构；改文件优先用 fs.edit_file 做局部修改，整体新建才用 fs.write_file。" +
      "任何写操作和命令都可能改变用户文件或系统状态，执行前务必向用户说明意图。" +
      "每步只做一件事，做完看结果再继续，不要假设执行成功。",
    capabilities,
    stateProviders,
    policy: opts.policy,
    snapshot: async () => ({ root, files: await collectFileList(root) }),
  };
}

async function collectFileList(root: string): Promise<string[]> {
  // 轻量快照：列一遍文件（不含内容），供内核做撤销/审计参考。
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else out.push(path.relative(root, full));
    }
  }
  await walk(root, 0);
  return out;
}

async function describeTree(
  root: string,
  depth = 0,
  max = 200,
): Promise<string> {
  const lines: string[] = [];
  async function walk(dir: string, d: number): Promise<void> {
    if (d > 3 || lines.length > max) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 40)) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const indent = "  ".repeat(d);
      lines.push(`${indent}${e.isDirectory() ? e.name + "/" : e.name}`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), d + 1);
    }
  }
  await walk(root, 0);
  return `工作目录 ${root} 结构（前 ${max} 项）：\n` + lines.join("\n");
}
