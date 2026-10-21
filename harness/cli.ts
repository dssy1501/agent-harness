/**
 * cli.ts —— harness 的命令行入口。
 *
 * 用法示例：
 *   node --experimental-strip-types harness/cli.ts \
 *     --task "给 src 下的所有 .ts 文件加一行版权头" \
 *     --root ./my-project \
 *     --model deepseek-chat
 *
 * 不传 --task 时进入交互式读入。真实模型需要 DEEPSEEK_API_KEY；
 * 加 --mock 用脚本化假模型跑通流程（不联网、不花钱），适合自测。
 *
 * 权限旋钮：--max-auto-risk 控制免确认自动执行的最高风险等级，
 * 默认 "read"（只读自动跑，任何写/命令都弹确认）。想让文件写自动跑，
 * 提到 "reversible-write"；想连命令也自动跑，提到 "irreversible-write"。
 */

import { createInterface } from "node:readline";
import { codingHarnessManifest } from "./manifest.ts";
import { createDeepSeekProvider } from "./deepseek.ts";
import { MockProvider, mockText, mockToolCall } from "../src/provider.ts";
import { runTask } from "../src/kernel.ts";
import { createTrajectory, consoleLogger } from "./trajectory.ts";
import type { Provider } from "../src/provider.ts";
import type { ConfirmRequest, KernelOptions } from "../src/kernel.ts";
import type { RiskLevel } from "../src/contract.ts";

interface CliArgs {
  task?: string;
  root: string;
  model: string;
  maxAutoRisk: RiskLevel;
  mock: boolean;
  autoApprove: boolean;
  sandbox: string;
}

const RISK_LEVELS: RiskLevel[] = [
  "read",
  "reversible-write",
  "irreversible-write",
  "privileged",
];

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    root: process.cwd(),
    model: "deepseek-chat",
    maxAutoRisk: "read",
    mock: false,
    autoApprove: false,
    sandbox: "runs",
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--task") a.task = argv[++i];
    else if (t === "--root") a.root = argv[++i];
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--max-auto-risk") {
      const v = argv[++i] as RiskLevel;
      a.maxAutoRisk = RISK_LEVELS.includes(v) ? v : "read";
    } else if (t === "--sandbox") a.sandbox = argv[++i];
    else if (t === "--mock") a.mock = true;
    else if (t === "--auto-approve") a.autoApprove = true;
  }
  return a;
}

function buildProvider(a: CliArgs): Provider {
  if (a.mock) {
    // 一个最小脚本：看目录 → 读 README → 收尾。仅用于跑通管线。
    return new MockProvider([
      mockToolCall("fs.list_dir", {}),
      mockToolCall("fs.read_file", { path: "README.md" }),
      mockText("已了解项目结构，结束演示。"),
    ]);
  }
  return createDeepSeekProvider({ model: a.model });
}

async function askConfirm(req: ConfirmRequest): Promise<boolean> {
  if (process.env["AGENT_AUTO_APPROVE"] === "1") return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) =>
    rl.question(
      `  允许执行 [${req.risk}] ${req.capabilityTitle} ?\n  ${JSON.stringify(
        req.args,
      ).slice(0, 200)}\n  (y/N) `,
      (ans) => res(ans),
    ),
  );
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

async function readTask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((res) => rl.question(prompt, (a) => res(a)));
  rl.close();
  return ans;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));

  let task = a.task;
  if (!task) {
    task = await readTask("请输入任务（回车结束）：");
  }
  if (!task || !task.trim()) {
    console.error("没有任务，退出。");
    process.exit(1);
  }

  const manifest = codingHarnessManifest({
    root: a.root,
    policy: { maxSteps: 24, maxToolCalls: 40 },
  });
  const provider = buildProvider(a);

  const traj = await createTrajectory(a.sandbox);
  const confirm =
    a.autoApprove || process.env["AGENT_AUTO_APPROVE"] === "1"
      ? async () => true
      : askConfirm;

  const kernelOpts: KernelOptions = {
    provider,
    confirm,
    policy: { maxAutoRisk: a.maxAutoRisk },
    onEvent: (e) => {
      consoleLogger(e);
      traj.onEvent(e);
    },
  };

  const res = await runTask(manifest, task, kernelOpts);

  console.log("\n==== 最终答复 ====");
  console.log(res.answer);
  console.log(
    `\n步数 ${res.steps} / 工具调用 ${res.toolCalls} / 结束原因 ${res.reason}`,
  );
  console.log(`轨迹已写入 ${traj.path}`);
}

main().catch((err) => {
  console.error("运行失败：", err);
  process.exit(1);
});
