/**
 * tasks-manifest.ts —— 用"删重复任务"这个真实场景，演示"不够智能"的真正根因。
 *
 * 用户说"把重复的任务删了"，智能体说"找不到"。
 *
 * 这个失败不是模型蠢，是应用侧两个东西没给够：
 *   1. 状态注入：模型根本没看到任务列表，无从判断"重复"
 *   2. 判重能力：应用只给了 delete(id)，没给"查重复"，
 *      于是模型要自己凭空判断重复——它做不到，只能说找不到
 *
 * 正确做法（见 goodManifest）：
 *   - 状态提供者把任务列表喂给模型（看得见）
 *   - find_duplicates 用确定性代码判重，不靠模型发挥（判得准、可复现）
 *   - remove_duplicates 把"删重复的"变成单一能力，模型只负责确认候选
 *
 * brokenManifest 故意只暴露 list + delete，用来复现"找不到"。
 */

import type { AppManifest, Capability } from "../src/contract.ts";
import { z } from "zod";

interface Task {
  id: number;
  title: string;
  done: boolean;
}

// 故意造一批带重复的数据：写周报 x3、回复邮件 x2。
const tasks: Task[] = [
  { id: 1, title: "写周报", done: false },
  { id: 2, title: "写周报", done: false },
  { id: 3, title: "写周报", done: true },
  { id: 4, title: "回复邮件", done: false },
  { id: 5, title: "回复邮件", done: false },
  { id: 6, title: "订会议室", done: false },
];

/**
 * 确定性判重：按标题分组，同标题多条即为重复。
 * 保留规则：优先保留一个未完成的；其余删除。
 * 注意——这套规则写在应用代码里，不靠模型去"理解重复"。
 * 好处：每次结果一致、可解释、不会今天删这组明天删那组。
 */
function findDuplicates(): { keep: Task; remove: Task[] }[] {
  const byTitle = new Map<string, Task[]>();
  for (const t of tasks) {
    const arr = byTitle.get(t.title) ?? [];
    arr.push(t);
    byTitle.set(t.title, arr);
  }
  const groups: { keep: Task; remove: Task[] }[] = [];
  for (const arr of byTitle.values()) {
    if (arr.length > 1) {
      const keep = arr.find((t) => !t.done) ?? arr[0]!;
      groups.push({ keep, remove: arr.filter((t) => t.id !== keep.id) });
    }
  }
  return groups;
}

/** 把判重结果压成一段给模型看的短摘要。 */
function describeGroups(groups: { keep: Task; remove: Task[] }[]): string {
  if (groups.length === 0) return "未发现重复任务。";
  const lines = groups.map((g, i) => {
    const removeIds = g.remove.map((t) => `#${t.id}`).join(", ");
    return `${i + 1}. "${g.keep.title}" 保留 #${g.keep.id}，删除 ${removeIds}`;
  });
  return `发现 ${groups.length} 组重复：\n${lines.join("\n")}`;
}

/* ----------------------- 能力定义 ----------------------- */

const listTasks: Capability = {
  id: "tasks.list",
  title: "列出所有任务",
  description:
    "查看当前全部任务及其 id、标题、完成状态。任何需要'找/查/看'任务的指令，都先调用我拿到全貌。",
  risk: "read",
  reversible: true,
  params: z.object({}),
  async handler() {
    const text = tasks
      .map((t) => `#${t.id} ${t.title}${t.done ? " [已完成]" : ""}`)
      .join("\n");
    return {
      ok: true,
      observation: `共 ${tasks.length} 个任务：\n${text}`,
    };
  },
};

const deleteTask: Capability<{ id: number; confirm: true }> = {
  id: "tasks.delete",
  title: "删除指定任务",
  description:
    "按 id 删除单个任务。必须先已经知道要删的 id（来自 list 或 find_duplicates 的结果），不要凭空猜 id。",
  risk: "irreversible-write",
  reversible: false,
  params: z.object({
    id: z.number().int().positive().describe("要删除的任务 id"),
    confirm: z.literal(true).describe("显式传 true 表示确认删除"),
  }),
  async handler({ id }) {
    const i = tasks.findIndex((t) => t.id === id);
    if (i < 0) {
      return { ok: false, observation: `找不到 id 为 ${id} 的任务，可能已删除或 id 不对。` };
    }
    const [removed] = tasks.splice(i, 1);
    return {
      ok: true,
      observation: `已删除 #${removed!.id}「${removed!.title}」。剩余 ${tasks.length} 个。`,
    };
  },
};

const findDuplicatesCap: Capability = {
  id: "tasks.find_duplicates",
  title: "查找重复任务",
  description:
    "按标题判定哪些任务是重复的，返回每组保留哪个、删除哪些。当用户提到'重复''清理重复'时调用我，而不是自己猜。",
  risk: "read",
  reversible: true,
  params: z.object({}),
  async handler() {
    return { ok: true, observation: describeGroups(findDuplicates()) };
  },
};

const removeDuplicatesCap: Capability = {
  id: "tasks.remove_duplicates",
  title: "删除所有重复任务",
  description:
    "专门处理'把重复的任务删了'这类意图：内部会判重并删除多余副本，只保留每组一个。属于不可逆操作，执行前需要用户确认。",
  risk: "irreversible-write",
  reversible: false,
  params: z.object({}),
  async handler() {
    const groups = findDuplicates();
    const removed: number[] = [];
    for (const g of groups) {
      for (const t of g.remove) {
        const i = tasks.findIndex((x) => x.id === t.id);
        if (i >= 0) {
          tasks.splice(i, 1);
          removed.push(t.id);
        }
      }
    }
    return {
      ok: true,
      observation: `已删除 ${removed.length} 个重复任务：#${removed.join(", #")}。剩余 ${tasks.length} 个。`,
    };
  },
};

const stateProviders = [
  {
    id: "tasks",
    title: "当前任务列表",
    refresh: "once" as const,
    snapshot: async () =>
      tasks.length === 0
        ? "（空）"
        : tasks
            .map((t) => `#${t.id} ${t.title}${t.done ? " [已完成]" : ""}`)
            .join("\n"),
  },
];

/** 正确版：状态注入 + 判重能力齐全。 */
export const goodManifest: AppManifest = {
  appId: "tasks",
  title: "任务清单（正确版）",
  systemPrompt:
    "这是一个任务清单应用。处理'删重复的'这种指令时，先 list 或 find_duplicates " +
    "看清现状，再用 remove_duplicates 处理，不要凭空猜 id。",
  capabilities: [listTasks, deleteTask, findDuplicatesCap, removeDuplicatesCap],
  stateProviders,
  policy: { maxAutoRisk: "read", maxSteps: 10, maxToolCalls: 12 },
};

/** 错误版：只暴露 list + delete。这就是"他说找不到"的根因复现。 */
export const brokenManifest: AppManifest = {
  appId: "tasks",
  title: "任务清单（错误版）",
  systemPrompt:
    "这是一个任务清单应用。注意：应用没有提供'查重复'的能力，只有按 id 删除。",
  capabilities: [listTasks, deleteTask],
  stateProviders,
  policy: { maxAutoRisk: "read", maxSteps: 10, maxToolCalls: 12 },
};

/** 测试后重置状态。 */
export function resetTasks(): void {
  tasks.length = 0;
  tasks.push(
    { id: 1, title: "写周报", done: false },
    { id: 2, title: "写周报", done: false },
    { id: 3, title: "写周报", done: true },
    { id: 4, title: "回复邮件", done: false },
    { id: 5, title: "回复邮件", done: false },
    { id: 6, title: "订会议室", done: false },
  );
}

export function getTaskCount(): number {
  return tasks.length;
}
