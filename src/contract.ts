/**
 * contract.ts —— 整个平台的唯一契约。
 *
 * 这个文件是整个项目里最重要的文件。它定义了：
 *   1. 应用与内核的边界（应用侧必须实现什么，内核侧保证什么）
 *   2. 风险等级词汇表（由内核定义，应用只能选用，不能自创）
 *   3. 能力的形状（一个能力 = 描述 + 参数 schema + 处理器 + 风险声明）
 *   4. 观测的格式（动作结果如何回到模型上下文）
 *
 * 设计原则：内核不认识任何业务概念，只认识这份契约。
 * 换一个应用 = 换掉 manifest 和 adapter，这个文件一行不用改。
 */

import type { z } from "zod";

/* ------------------------------------------------------------------ *
 * 一、风险等级词汇表（内核所有权）
 *
 * 为什么必须由内核定义？因为"应用 A 的删除"和"应用 B 的删除"
 * 危险程度完全不同。如果让每个应用自己发明等级，
 * 内核就没法执行统一策略，权限体系会烂掉。
 *
 * 分级依据不是"动作类型"，而是"出错的代价"：
 *   read              —— 没有副作用，随便做
 *   reversible-write  —— 改了能还原，代价可控
 *   irreversible-write —— 删了就没了，必须人看过
 *   privileged        —— 有外部副作用（花钱/发消息/上传），必须人点头
 * ------------------------------------------------------------------ */
export type RiskLevel =
  | "read"
  | "reversible-write"
  | "irreversible-write"
  | "privileged";

/** 风险等级排序，数字越大越危险。内核用它做策略判断，别自己写 if-else。 */
export const RISK_ORDER: Record<RiskLevel, number> = {
  read: 0,
  "reversible-write": 1,
  "irreversible-write": 2,
  privileged: 3,
};

/**
 * 权限策略。
 *
 * 这里刻意只用"一个旋钮"而不是一堆开关列表：
 *   maxAutoRisk —— 不超过这个风险等级的动作自动执行，更高的全部要人确认。
 * 单旋钮比"要不要确认 A、要不要确认 B"的列表更好推理，
 * "逐步放权"也变成了一件直观的事：把这个值一级一级往上提。
 */
export interface Policy {
  /**
   * 允许免确认自动执行的最高风险等级。
   * 默认 "read"：只读自动跑，任何写操作都要人点头。
   * 这是整个平台最重要的安全默认值。
   */
  maxAutoRisk: RiskLevel;
  /** 单任务最大循环步数。硬上限，防 agent 死循环烧钱。 */
  maxSteps: number;
  /** 单任务最大 tool call 次数。和 maxSteps 分开，允许更细的控制。 */
  maxToolCalls: number;
}

/** 默认策略：只读自动执行，其余全部人工确认。 */
export const DEFAULT_POLICY: Policy = {
  maxAutoRisk: "read",
  maxSteps: 12,
  maxToolCalls: 20,
};

/** 判断某个风险等级是否需要人工确认。内核内部统一走这个函数。 */
export function needsConfirmation(
  risk: RiskLevel,
  policy: Policy,
): boolean {
  return RISK_ORDER[risk] > RISK_ORDER[policy.maxAutoRisk];
}

/* ------------------------------------------------------------------ *
 * 二、状态与快照
 *
 * Snapshot 是"应用状态的任意可序列化存档"。
 * 内核不解释它的内容，只负责保存、交出、调用 restore 时原样还回去。
 * 这是"每次动作可 undo"的根基——解释权在应用，保存权在内核。
 * ------------------------------------------------------------------ */
export interface Snapshot {
  /** 时序标识，用来自证新鲜度和排障。 */
  id: string;
  /** 应用返回的任何可 JSON 序列化状态。内核当黑盒。 */
  payload: unknown;
}

/* ------------------------------------------------------------------ *
 * 三、能力（Capability）
 *
 * 一个能力 = 让模型知道它存在 + 能验证参数 + 真的干活。
 * 注意 handler 是同步意图、异步执行的：返回 ActionResult 而不是直接改 UI。
 * ------------------------------------------------------------------ */
export interface Capability<
  P = unknown,
  R = unknown,
> {
  /** 全局唯一 id，形如 "todo.create"。内核用它在 manifest 里寻址。 */
  id: string;
  /** 给人看的名字，出现在确认弹窗和审计日志里。 */
  title: string;
  /**
   * 给模型看的说明。这句话的质量直接决定模型用对还是用错，
   * 比 prompt 调校值钱得多。写清楚"什么时候该用、什么时候不该用"。
   */
  description: string;
  /** 危险等级，从内核词汇表里选。 */
  risk: RiskLevel;
  /** 是否可撤销。kernel 据此在执行前决定要不要先做快照。 */
  reversible: boolean;
  /**
   * 参数 schema。这里是全文件最关键的字段：
   * 同一个 zod schema 同时驱动三件事——
   *   1. 运行时校验模型给的参数（防止幻觉参数）
   *   2. 生成给模型的 JSON Schema 工具定义（tools 列表）
   *   3. TypeScript 类型推断（P）
   * 一份定义，三个用途，不存在"代码里的类型和文档里的类型不一致"。
   */
  params: z.ZodType<P>;
  /**
   * 真正干活的代码。
   * input 已经过 schema 校验，可以直接信任类型。
   */
  handler: (
    input: P,
    ctx: ActionContext,
  ) => Promise<ActionResult<R>>;
}

/**
 * 传给 handler 的执行上下文。
 * 内核在这里注入它承诺的东西，handler 只管用。
 */
export interface ActionContext {
  /** 当前任务 id，用于日志关联和排障。 */
  taskId: string;
  /** 能力 id。日志用。 */
  capabilityId: string;
  /** 内核在执行前做好的快照，可逆写操作应该能利用它恢复。 */
  snapshot?: Snapshot;
  /** 让应用自己发声（输出到用户界面/日志），替代 console.log。 */
  emit: (event: KernelEvent) => void;
}

/**
 * 动作的执行结果。
 *
 * 特别注意 observation 字段：它是**给模型看的字符串，会进上下文窗口**。
 * 这里故意用 string 而不是结构化对象，是为了把上下文长度的控制权
 * 交回应用手里——应用最清楚哪些信息对下一步决策有用。
 * 约定：短、结构化、直接给事实，不要客套话。
 */
export interface ActionResult<R = unknown> {
  ok: boolean;
  /** 给人/给上层程序用的真实结果数据。 */
  data?: R;
  /** 给模型看的一句事实。太长会被上下文预算挤爆。 */
  observation: string;
}

/* ------------------------------------------------------------------ *
 * 四、状态提供者（StateProvider）
 *
 * 这是"应用能被 AI 完全控制"最容易被漏掉的一块。
 * 一个只能干活、看不见状态的智能体是半瞎的。
 *
 * 能力（Capability）回答"能做什么"，
 * 状态提供者回答"现在是什么样"。
 * 两者缺一不可。
 * ------------------------------------------------------------------ */
export interface StateProvider {
  id: string;
  title: string;
  /**
   * 主动刷新鲜频率：
   *   "once"   —— 任务开始时注入一次（默认，省 token）
   *   "always" —— 每一轮都重新注入（适合频繁变化的关键状态）
   */
  refresh?: "once" | "always";
  /** 产出当前状态的文本摘要。会被标注为"当前应用状态"注入上下文。 */
  snapshot: () => Promise<string>;
}

/* ------------------------------------------------------------------ *
 * 五、Manifest —— 应用交给内核的全部东西
 *
 * 这就是应用侧的全部工作量。一个应用对内核说：
 * "这些是我的能力，这些是我的状态，这些是你的策略覆盖。"
 * 别的什么都不用给。
 * ------------------------------------------------------------------ */
export interface AppManifest {
  /** 应用标识，如 "photo-album"。 */
  appId: string;
  /** 人类可读的应用名。 */
  title: string;
  /** 应用专属的系统提示词，追加在内核框架提示词之后。 */
  systemPrompt?: string;
  /** 能力集合。 */
  capabilities: Capability[];
  /** 状态提供者集合。 */
  stateProviders: StateProvider[];
  /** 覆盖内核默认策略。至少是部分覆盖。 */
  policy?: Partial<Policy>;
  /**
   * 应用级状态存档。可逆能力执行前，内核会调它拿一份存档。
   * 不给这个函数 = 应用放弃自动撤销能力，内核不会替你兜底。
   */
  snapshot?: () => Promise<unknown>;
}

/* ------------------------------------------------------------------ *
 * 六、事件与日志
 *
 * 平台化之后，每个 bug 都会在"某个用户的某个应用"里重现。
 * 能不能查清问题，全靠这里。所以事件流从第一版就是强制项，
 * 不是可选的调试装饰。
 * ------------------------------------------------------------------ */
export type KernelEvent =
  | { t: "task:start"; taskId: string; goal: string }
  | { t: "task:done"; taskId: string; reason: StopReason }
  | { t: "state:inject"; taskId: string; providerIds: string[] }
  | {
      t: "model:call";
      taskId: string;
      step: number;
      toolNames: string[];
    }
  | {
      t: "capability:call";
      taskId: string;
      step: number;
      capabilityId: string;
      args: unknown;
    }
  | {
      t: "capability:result";
      taskId: string;
      step: number;
      capabilityId: string;
      ok: boolean;
      observation: string;
    }
  | {
      t: "gate:blocked";
      taskId: string;
      capabilityId: string;
      risk: RiskLevel;
    }
  | {
      t: "snapshot:taken";
      taskId: string;
      capabilityId: string;
      snapshotId: string;
    }
  | { t: "budget:hit"; taskId: string; limit: string };

/** 任务为什么停下。模型"说做完了"和"被预算拦住"必须能区分。 */
export type StopReason =
  | "model-finished"
  | "max-steps"
  | "max-tool-calls"
  | "error";

export interface TaskResult {
  taskId: string;
  /** 模型最终给用户的答复。 */
  answer: string;
  reason: StopReason;
  /** 实际发生的步数与工具调用数，用于成本复盘。 */
  steps: number;
  toolCalls: number;
}
