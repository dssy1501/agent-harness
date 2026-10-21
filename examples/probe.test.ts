/**
 * probe.test.ts —— 用 MockProvider 做确定性测试。
 *
 * 为什么必须用 Mock 而不是真模型：
 *   真实模型每次回答都不同，你的断言就没法写。
 *   Mock 让你固定"第一步调 A、第二步调 B、第三步收尾"，
 *   于是循环逻辑、闸门、预算这些内核行为全部可断言。
 *
 * 这七个用例对应契约里七个必须成立的分支。全绿，契约才算立住。
 *
 * 注意用的是 node:test + node:assert，而不是 vitest。
 * 理由：内核的测试不想要多余框架——平台项目里，
 * 测试依赖越少，"换机器能不能跑起来"的不确定性就越小。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../src/kernel.ts";
import type { KernelEvent } from "../src/contract.ts";
import {
  MockProvider,
  mockText,
  mockToolCall,
} from "../src/provider.ts";
import {
  getProbeState,
  probeManifest,
  resetProbeState,
} from "./probe-manifest.ts";

/** 收事件流到一个数组，方便断言全过程。 */
function collect() {
  const events: KernelEvent[] = [];
  return {
    events,
    onEvent: (e: KernelEvent) => events.push(e),
  };
}

/** 默认全部批准。 */
const approveAll = async () => true;

/** 默认全部拒绝。用来验证闸门真的会拦。 */
const rejectAll = async () => false;

function setup() {
  resetProbeState();
}

test("1. 只读能力自动执行，不弹确认", async () => {
  setup();
  const sink = collect();
  let confirmCalled = 0;

  const provider = new MockProvider([
    mockToolCall("probe.list_items", { includeDone: true }),
    mockText("当前有 2 项，其中 1 项已完成。"),
  ]);

  const res = await runTask(probeManifest, "列一下现在有什么", {
    provider,
    confirm: async () => {
      confirmCalled += 1;
      return true;
    },
    onEvent: sink.onEvent,
  });

  assert.equal(res.reason, "model-finished");
  assert.equal(confirmCalled, 0); // 关键断言：只读不该打扰用户
  assert.equal(
    sink.events.some((e) => e.t === "gate:blocked"),
    false,
  );
});

test("2. 可逆写必须先做人确认，拒绝后不执行", async () => {
  setup();
  const sink = collect();
  const before = getProbeState().items.length;

  const provider = new MockProvider([
    mockToolCall("probe.add_item", { label: "被拒绝的条目" }),
    mockText("用户拒绝了，我没有新增。"),
  ]);

  const res = await runTask(probeManifest, "加一个条目", {
    provider,
    confirm: rejectAll,
    onEvent: sink.onEvent,
  });

  assert.equal(sink.events.some((e) => e.t === "gate:blocked"), true);
  assert.equal(getProbeState().items.length, before); // 状态没变
  assert.equal(res.reason, "model-finished");
});

test("3. 不可逆动作不做快照——快照只服务于'能撤销'的动作", async () => {
  setup();
  const sink = collect();

  const provider = new MockProvider([
    mockToolCall("probe.purge_done", { confirm: true }),
    mockText("已清除 1 个已完成条目。"),
  ]);

  await runTask(probeManifest, "清掉已完成的", {
    provider,
    confirm: approveAll,
    onEvent: sink.onEvent,
  });

  // 关键断言：irreversible + reversible:false 的动作，内核不该白做快照。
  // 快照的存在意义是"能撤销"，不能撤销的动作存了也没用。
  const snaps = sink.events.filter((e) => e.t === "snapshot:taken");
  assert.equal(snaps.length, 0);
  // 但动作本身确实执行了
  assert.equal(getProbeState().items.every((i) => !i.done), true);
});

test("3b. 可逆动作被批准后，事前快照由内核自动做", async () => {
  setup();
  const sink = collect();

  const provider = new MockProvider([
    mockToolCall("probe.add_item", { label: "新条目" }),
    mockText("已新增 #3。"),
  ]);

  await runTask(probeManifest, "加一个条目", {
    provider,
    confirm: approveAll,
    onEvent: sink.onEvent,
  });

  const snaps = sink.events.filter((e) => e.t === "snapshot:taken");
  assert.equal(snaps.length, 1, "可逆动作执行前应有快照");
  assert.equal(snaps[0].capabilityId, "probe.add_item");
  assert.equal(getProbeState().items.length, 3);
});

test("4. 幻觉能力名被拒绝，不会被执行", async () => {
  setup();
  const sink = collect();

  const provider = new MockProvider([
    mockToolCall("probe.delete_everything", { force: true }),
    mockText("没有这个能力，我已停止。"),
  ]);

  await runTask(probeManifest, "把整个应用删了", {
    provider,
    confirm: approveAll,
    onEvent: sink.onEvent,
  });

  // 幻觉能力连闸门都不该走到，而是被寻址阶段直接拒掉
  const called = sink.events.filter((e) => e.t === "capability:call");
  assert.equal(called.length, 0);
});

test("5. 幻觉参数被 schema 拒绝，handler 没有被调用", async () => {
  setup();
  const sink = collect();
  const before = getProbeState().items.length;

  const provider = new MockProvider([
    // includeDone 是 boolean，这里故意传字符串 "yes"
    mockToolCall("probe.list_items", { includeDone: "yes" }),
    mockText("参数不对，我用默认值重试。"),
  ]);

  await runTask(probeManifest, "列一下", {
    provider,
    onEvent: sink.onEvent,
  });

  // 校验失败会在执行前返回，所以不会有成功的 result 事件
  const results = sink.events.filter(
    (e) =>
      e.t === "capability:result" &&
      e.capabilityId === "probe.list_items",
  );
  assert.equal(results.length, 0);
  assert.equal(getProbeState().items.length, before);
});

test("6. handler 抛异常不会让任务崩溃", async () => {
  setup();
  const sink = collect();

  const provider = new MockProvider([
    mockToolCall("probe.flaky_action", { force: true }),
    mockText("动作失败了，我向用户报告。"),
  ]);

  const res = await runTask(probeManifest, "触发一次失败", {
    provider,
    confirm: approveAll,
    onEvent: sink.onEvent,
  });

  assert.equal(res.reason, "model-finished"); // 没有崩，正常收尾
  const failed = sink.events.find(
    (e) => e.t === "capability:result" && !e.ok,
  );
  assert.ok(failed, "应记录一条失败结果");
});

test("7. 步数预算硬上限生效，不会无限循环", async () => {
  setup();
  const sink = collect();

  // 无限供给工具调用，看内核会不会自己停。
  const provider = new MockProvider(
    Array.from({ length: 50 }, () => mockToolCall("probe.list_items", {})),
  );

  const res = await runTask(probeManifest, "一直列下去", {
    provider,
    onEvent: sink.onEvent,
  });

  assert.equal(res.reason, "max-steps");
  const maxSteps = probeManifest.policy?.maxSteps ?? 12;
  assert.ok(res.steps <= maxSteps, "步数不得超过预算");
  assert.equal(sink.events.some((e) => e.t === "budget:hit"), true);
});

test("8. 易变状态每轮都会被重新注入", async () => {
  setup();
  const sink = collect();

  const provider = new MockProvider([
    mockToolCall("probe.list_items", {}),
    mockToolCall("probe.list_items", {}),
    mockText("看完了。"),
  ]);

  await runTask(probeManifest, "看两遍", {
    provider,
    onEvent: sink.onEvent,
  });

  const injects = sink.events.filter((e) => e.t === "state:inject");
  // 一次初始注入 + 前两轮各一次 = 至少 3 次
  assert.ok(injects.length >= 3, `实际注入 ${injects.length} 次`);
});
