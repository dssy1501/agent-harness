/**
 * probe-manifest.ts —— 一个"没有业务"的探针应用。
 *
 * 存在的唯一目的：在你还没想好做什么应用之前，
 * 把契约的每个分支都跑一遍。它的"业务"是刻意设计出来的，
 * 专门覆盖这些边角：
 *
 *   read 级能力            —— 应该自动执行，不该弹确认
 *   reversible-write 级     —— 应该先做快照，应该弹确认
 *   irreversible-write 级  —— 应该弹确认，且提示里要显出不可逆
 *   privileged 级          —— 应该弹确认，且参数要被完整展示给人看
 *   幻觉能力名              —— 模型调了不存在的能力，要被拒且给出可用清单
 *   幻觉参数                —— 模型给了 schema 外的字段，要被拒且说明差在哪
 *   handler 抛异常          —— 不能让整个任务崩掉
 *   易变状态                —— "always" 刷新的状态提供者每轮都要更新
 *
 * 如果这些分支在探针应用上全都是对的，契约就算立住了。
 * 之后换真实应用，需要担心的就从"内核对不对"变成"我的能力写对没写对"。
 *
 * 注意：这个应用的状态存储就是一个普通对象，
 * 真实应用里它会是 Redux store / Pinia / React state 之类的东西。
 * 内核不在乎它是什么——内核只认识契约。
 */

import { z } from "zod";
import type { AppManifest, Capability } from "../src/contract.ts";

/* ------------------------------------------------------------------ *
 * 探针应用自己的状态。刻意用最朴素的结构，方便看清数据流。
 * ------------------------------------------------------------------ */
interface Item {
  id: number;
  label: string;
  done: boolean;
}

interface ProbeState {
  items: Item[];
  nextId: number;
}

const state: ProbeState = {
  items: [
    { id: 1, label: "第一项", done: false },
    { id: 2, label: "第二项", done: true },
  ],
  nextId: 3,
};

/* ------------------------------------------------------------------ *
 * 能力 1：只读，自动执行
 * ------------------------------------------------------------------ */
const listItems: Capability<
  { includeDone?: boolean },
  Item[]
> = {
  id: "probe.list_items",
  title: "列出所有条目",
  description:
    "查看当前应用里的全部条目。当用户询问'现在有什么''列一下'，或你需要先了解现状再决定动作时使用。这个动作没有任何副作用，可以放心调用。",
  risk: "read",
  reversible: true,
  params: z.object({
    includeDone: z
      .boolean()
      .optional()
      .describe("是否包含已完成的条目，默认包含"),
  }),
  async handler({ includeDone = true }) {
    const items = includeDone
      ? state.items
      : state.items.filter((i) => !i.done);
    return {
      ok: true,
      data: items,
      observation: `共 ${items.length} 项：${items
        .map((i) => `#${i.id} ${i.label}${i.done ? "(已完成)" : ""}`)
        .join("；")}`,
    };
  },
};

/* ------------------------------------------------------------------ *
 * 能力 2：可逆写，需要确认 + 快照
 * ------------------------------------------------------------------ */
const addItem: Capability<{ label: string }> = {
  id: "probe.add_item",
  title: "新增条目",
  description:
    "向应用里添加一个新条目。当用户说'加一个''记一下'时使用。这会改变应用状态，但可以通过撤销恢复。",
  risk: "reversible-write",
  reversible: true,
  params: z.object({
    label: z.string().min(1).max(80).describe("条目内容，必填，1 到 80 字"),
  }),
  async handler({ label }) {
    const item: Item = { id: state.nextId, label, done: false };
    state.nextId += 1;
    state.items.push(item);
    return {
      ok: true,
      data: item,
      observation: `已新增条目 #${item.id}「${item.label}」，当前共 ${state.items.length} 项。`,
    };
  },
};

/* ------------------------------------------------------------------ *
 * 能力 3：不可逆写，必须确认
 * ------------------------------------------------------------------ */
const purgeDone: Capability = {
  id: "probe.purge_done",
  title: "清除所有已完成条目",
  description:
    "删除所有已完成的条目，删除后无法恢复。仅在用户明确表示要清理已完成项时使用。如果用户只是随口提到'完成'，不要调用这个动作。",
  risk: "irreversible-write",
  reversible: false,
  params: z.object({
    // 刻意要求一个显式确认字段：让模型必须"想清楚自己真的要删"。
    // 这也是骗过模型随手乱调的一道门槛。
    confirm: z
      .literal(true)
      .describe("必须显式传入 true，表示你确认要执行不可逆删除"),
  }),
  async handler() {
    const removed = state.items.filter((i) => i.done).length;
    state.items = state.items.filter((i) => !i.done);
    return {
      ok: true,
      data: { removed },
      observation: `已永久删除 ${removed} 个已完成条目，此操作无法撤销。剩余 ${state.items.length} 项。`,
    };
  },
};

/* ------------------------------------------------------------------ *
 * 能力 4：特权操作（有外部副作用），必须确认
 *
 * "特权"和"不可逆"是两回事：发消息是可逆的（能撤回），
 * 但它影响了外部世界，所以照样要人点头。
 * ------------------------------------------------------------------ */
const sendReport: Capability<{ to: string; body: string }> = {
  id: "probe.send_report",
  title: "发送报告到外部",
  description:
    "把当前条目汇总通过邮件发送给指定收件人。这个动作会影响外部世界（真实发送邮件），只有在用户明确要求发送时使用。",
  risk: "privileged",
  reversible: false,
  params: z.object({
    to: z.string().email().describe("收件人邮箱，必须是合法邮箱格式"),
    body: z.string().min(1).describe("报告正文"),
  }),
  async handler({ to, body }) {
    // 真实应用里这里是 SMTP 调用。探针应用里只记录，不外发。
    return {
      ok: true,
      data: { to, len: body.length },
      observation: `报告已发送至 ${to}，正文 ${body.length} 字。`,
    };
  },
};

/* ------------------------------------------------------------------ *
 * 能力 5：用来试错的坏能力
 *
 * 它故意在特定条件下抛异常，专门验证"handler 崩了不会带走整个任务"。
 * ------------------------------------------------------------------ */
const flakyAction: Capability = {
  id: "probe.flaky_action",
  title: "不稳定的动作",
  description:
    "一个用于测试的动作，当参数 force 为 true 时会抛出异常。正常情况下不要使用这个动作。",
  risk: "reversible-write",
  reversible: true,
  params: z.object({
    force: z.boolean().describe("为 true 时触发异常，用于测试容错"),
  }),
  async handler({ force }) {
    if (force) {
      throw new Error("探针异常：这是预设的失败，用于验证容错");
    }
    return { ok: true, observation: "正常执行，没有异常。" };
  },
};

/* ------------------------------------------------------------------ *
 * 状态提供者
 *
 * 一个每轮刷新（易变），一个只注入一次（稳定）。
 * 这么做是为了能观察到"上下文装配"在两种模式下的差异。
 * ------------------------------------------------------------------ */
const stateProviders = [
  {
    id: "items",
    title: "当前条目",
    refresh: "always" as const,
    snapshot: async () => {
      if (state.items.length === 0) return "（空）";
      return state.items
        .map((i) => `#${i.id} ${i.label}${i.done ? " [已完成]" : ""}`)
        .join("\n");
    },
  },
  {
    id: "app_meta",
    title: "应用元信息",
    refresh: "once" as const,
    snapshot: async () =>
      "探针应用，用于验证智能体内核契约。没有任何真实业务逻辑。",
  },
];

/* ------------------------------------------------------------------ *
 * Manifest —— 应用交给内核的全部东西
 * ------------------------------------------------------------------ */
export const probeManifest: AppManifest = {
  appId: "probe",
  title: "探针应用（无业务）",
  systemPrompt:
    "这是一个用于测试内核的探针应用，数据是一份简单的条目清单。" +
    "你可以查看、新增条目，也可以清除已完成项或发送报告。" +
    "清除已完成项是不可逆的，发送报告有外部副作用，执行前务必向用户说明并取得同意。",
  capabilities: [
    listItems,
    addItem,
    purgeDone,
    sendReport,
    flakyAction,
  ],
  stateProviders,
  // 探针应用刻意收紧策略，让所有分支都能被观察到。
  policy: {
    maxAutoRisk: "read",
    maxSteps: 8,
    maxToolCalls: 10,
  },
  snapshot: async () => structuredClone(state),
};

/** 导出内部状态，供测试断言用。 */
export function getProbeState(): ProbeState {
  return structuredClone(state);
}

/** 测试之间重置状态。 */
export function resetProbeState(): void {
  state.items = [
    { id: 1, label: "第一项", done: false },
    { id: 2, label: "第二项", done: true },
  ];
  state.nextId = 3;
}
