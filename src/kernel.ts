/**
 * kernel.ts —— 智能体内核：任务循环 + 上下文装配 + 权限闸门 + 预算控制。
 *
 * 这个文件没有任何业务代码。它只做四件事：
 *   1. 把应用状态和任务目标装配成模型提示
 *   2. 让模型在一组工具里选下一步
 *   3. 过闸门、做快照、执行、把结果写回上下文
 *   4. 盯着预算，超了就停
 *
 * 三步循环（想 → 做 → 看）写死在这里，应用不该有自己的循环。
 * 如果某天你想换"先规划再执行"的模式，改的是这个文件，
 * 而不是每个应用各写一遍。
 */

import { randomUUID } from "node:crypto";
import type {
  AppManifest,
  Capability,
  KernelEvent,
  Policy,
  Snapshot,
  StopReason,
  TaskResult,
} from "./contract.js";
import { DEFAULT_POLICY, needsConfirmation } from "./contract.ts";
import { capabilitiesToTools } from "./tools.ts";
import type { Message, Provider } from "./provider.ts";

export interface KernelOptions {
  provider: Provider;
  /** 覆盖内核默认策略（合并优先级低于 manifest.policy）。 */
  policy?: Partial<Policy>;
  /**
   * 人工确认钩子。UI 层在这里弹"是否允许智能体执行 X"。
   * 不给这个函数时，默认行为是拒绝并告知模型需要授权——
   * 宁可它停下来问，也不许它闷头干。
   */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
  /** 全量事件流。日志、UI 进度、排障全靠它，别丢。 */
  onEvent?: (e: KernelEvent) => void;
  temperature?: number;
}

/** 需要人点头时，交给 UI 的全部信息。 */
export interface ConfirmRequest {
  taskId: string;
  capabilityId: string;
  capabilityTitle: string;
  risk: string;
  reversible: boolean;
  args: unknown;
}

export async function runTask(
  manifest: AppManifest,
  goal: string,
  options: KernelOptions,
): Promise<TaskResult> {
  const taskId = randomUUID();
  const emit = options.onEvent ?? (() => {});
  const policy = mergePolicy(manifest.policy, options.policy);

  // 能力注册表：id → Capability。模型每次只能从这里取，取不到就是没有。
  const registry = new Map<string, Capability>();
  for (const cap of manifest.capabilities) {
    if (registry.has(cap.id)) {
      throw new Error(`manifest 里能力 id 重复：${cap.id}`);
    }
    registry.set(cap.id, cap);
  }

  const tools = capabilitiesToTools([...registry.values()]);
  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt(manifest) },
    { role: "user", content: goal },
  ];

  // 任务开始时的初始状态注入。
  const onceProviders = manifest.stateProviders.filter(
    (p) => (p.refresh ?? "once") === "once",
  );
  if (onceProviders.length > 0) {
    const blocks = await Promise.all(
      onceProviders.map(async (p) => ({
        id: p.id,
        text: await p.snapshot(),
      })),
    );
    messages.push({ role: "user", content: formatState(blocks) });
    emit({
      t: "state:inject",
      taskId,
      providerIds: blocks.map((b) => b.id),
    });
  }

  const volatileProviders = manifest.stateProviders.filter(
    (p) => p.refresh === "always",
  );

  let step = 0;
  let toolCalls = 0;

  emit({ t: "task:start", taskId, goal });

  /* ---------------- 主循环 ---------------- */
  while (step < policy.maxSteps) {
    step += 1;
    emit({ t: "model:call", taskId, step, toolNames: [...registry.keys()] });

    const resp = await options.provider.complete({
      messages,
      tools,
      temperature: options.temperature,
    });

    // 模型不再调工具 = 它认为做完了。这就是终止条件。
    if (resp.toolCalls.length === 0) {
      const answer = resp.content ?? "";
      emit({ t: "task:done", taskId, reason: "model-finished" });
      return {
        taskId,
        answer,
        reason: "model-finished",
        steps: step,
        toolCalls,
      };
    }

    // 把助手的这次工具调用请求也记进历史，否则下一步模型会失忆。
    messages.push({
      role: "assistant",
      content: resp.content,
      toolCalls: resp.toolCalls,
    });

    for (const call of resp.toolCalls) {
      toolCalls += 1;

      if (toolCalls > policy.maxToolCalls) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: "已达到本次任务的工具调用预算上限，任务强制停止。",
        });
        emit({ t: "budget:hit", taskId, limit: "maxToolCalls" });
        return finish(taskId, messages, "max-tool-calls", step, toolCalls, emit);
      }

      const observation = await executeOne(
        registry,
        call,
        manifest,
        taskId,
        policy,
        step,
        emit,
        options,
      );

      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: observation,
      });
    }

    // 每轮结束后刷新"易变状态"，让模型下一步看到的是最新情况。
    // 代价是上下文会变长——这是用 token 换状态新鲜度，
    // 真实实现里应该配合上下文摘要/裁剪，这里先保证正确。
    //
    // 注意这里必须发事件：看不见的注入等于没法排障。
    // 上下文装配是整个内核最容易被怀疑出问题的地方，
    // 它每吹一次进出，日志里就得留一道痕。
    if (volatileProviders.length > 0) {
      const blocks = await Promise.all(
        volatileProviders.map(async (p) => ({
          id: p.id,
          text: await p.snapshot(),
        })),
      );
      messages.push({ role: "user", content: formatState(blocks) });
      emit({
        t: "state:inject",
        taskId,
        providerIds: blocks.map((b) => b.id),
      });
    }
  }

  emit({ t: "budget:hit", taskId, limit: "maxSteps" });
  return finish(taskId, messages, "max-steps", step, toolCalls, emit);
}

/* ------------------------------------------------------------------ *
 * 单次能力执行：寻址 → 校验参数 → 过闸门 → 快照 → 执行
 * 顺序不能换。先校验再确认，避免让人确认一堆本来就会被拒的参数。
 * ------------------------------------------------------------------ */
async function executeOne(
  registry: Map<string, Capability>,
  call: { id: string; name: string; argumentsJson: string },
  manifest: AppManifest,
  taskId: string,
  policy: Policy,
  step: number,
  emit: (e: KernelEvent) => void,
  options: KernelOptions,
): Promise<string> {
  // 1) 寻址：模型调了一个不存在的能力。这是幻觉，直接拒。
  const cap = registry.get(call.name);
  if (!cap) {
    return [
      `错误：不存在名为 "${call.name}" 的能力。`,
      `可用能力只有：${[...registry.keys()].join(", ")}`,
    ].join("");
  }

  emit({
    t: "capability:call",
    taskId,
    step,
    capabilityId: cap.id,
    args: call.argumentsJson,
  });

  // 2) 解析参数。模型给的是 JSON 字符串，parse 失败要单独报，
  //    不能和 schema 校验失败混在一起——两者排障方式不同。
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.argumentsJson || "{}");
  } catch {
    return `错误：${cap.id} 的参数不是合法 JSON，无法执行。请重新给出完整参数。`;
  }

  // 3) 运行时校验。这是防幻觉参数的第一道闸。
  const result = cap.params.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return `错误：${cap.id} 参数校验未通过（${issues}）。请按 schema 修正后重试。`;
  }
  const input = result.data;

  // 4) 权限闸门。风险等级超过 maxAutoRisk 的动作必须人点头。
  if (needsConfirmation(cap.risk, policy)) {
    const approved = options.confirm
      ? await options.confirm({
          taskId,
          capabilityId: cap.id,
          capabilityTitle: cap.title,
          risk: cap.risk,
          reversible: cap.reversible,
          args: input,
        })
      : false;

    if (!approved) {
      emit({
        t: "gate:blocked",
        taskId,
        capabilityId: cap.id,
        risk: cap.risk,
      });
      return `已拒绝：${cap.title} 属于 ${cap.risk} 级操作，需要用户明确授权。请向用户说明你要做什么、为什么需要，然后等待批准。`;
    }
  }

  // 5) 可逆动作先做快照。内核负责存取，应用负责 restore。
  let snapshot: Snapshot | undefined;
  if (cap.reversible && manifest.snapshot) {
    const payload = await manifest.snapshot();
    snapshot = { id: randomUUID(), payload };
    emit({
      t: "snapshot:taken",
      taskId,
      capabilityId: cap.id,
      snapshotId: snapshot.id,
    });
  }

  // 6) 真正执行。
  try {
    const actionResult = await cap.handler(input, {
      taskId,
      capabilityId: cap.id,
      snapshot,
      emit,
    });
    emit({
      t: "capability:result",
      taskId,
      step,
      capabilityId: cap.id,
      ok: actionResult.ok,
      observation: actionResult.observation,
    });
    return actionResult.ok
      ? actionResult.observation
      : `失败：${actionResult.observation}`;
  } catch (err) {
    // handler 抛异常不能让整个任务崩掉。
    // 把错误变成一条观察结果喂回模型，让它自己决定重试还是汇报。
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      t: "capability:result",
      taskId,
      step,
      capabilityId: cap.id,
      ok: false,
      observation: msg,
    });
    return `异常：${cap.id} 执行时抛出错误（${msg}）。可以修正参数重试，或向用户报告。`;
  }
}

/* ------------------------------------------------------------------ *
 * 提示词装配
 *
 * 内核负责"框架"：你是谁、能看见什么、怎么用工具、什么时候停。
 * 应用负责"领域"：这个应用是干什么的、有哪些业务约束。
 * 两者分开，应用不会把内核的规则覆盖掉。
 * ------------------------------------------------------------------ */
function buildSystemPrompt(manifest: AppManifest): string {
  const appBlock = manifest.systemPrompt?.trim()
    ? `\n\n【应用说明】\n${manifest.systemPrompt.trim()}`
    : "";

  return `你是一个运行在应用内的智能体，可以通过工具控制当前应用。

工作要求：
1. 每一步只做一件事，做完看结果再决定下一步，不要凭空假设执行成功。
2. 工具参数必须严格符合 schema，不要编造不存在的字段或能力。
3. 遇到被拒绝或参数错误，按提示修正后重试；连续失败就停下来向用户说明。
4. 任务完成后，用简洁的中文向用户汇报你实际做了什么、结果如何。${appBlock}`;
}

function formatState(blocks: { id: string; text: string }[]): string {
  return [
    "【当前应用状态】",
    ...blocks.map((b) => `${b.id}:\n${b.text}`),
  ].join("\n\n");
}

function mergePolicy(
  manifestPolicy: Partial<Policy> | undefined,
  kernelPolicy: Partial<Policy> | undefined,
): Policy {
  return {
    ...DEFAULT_POLICY,
    ...manifestPolicy,
    ...kernelPolicy,
  };
}

/** 预算耗尽时也要给用户一个交代，不能静默 void。 */
function finish(
  taskId: string,
  messages: Message[],
  reason: StopReason,
  step: number,
  toolCalls: number,
  emit: (e: KernelEvent) => void,
): TaskResult {
  const answer =
    reason === "max-steps"
      ? "任务未完成：已达到最大步数上限，已停止以避免无限循环。"
      : "任务未完成：已达到工具调用预算上限，已停止。";
  emit({ t: "task:done", taskId, reason });
  return { taskId, answer, reason, steps: step, toolCalls };
}
