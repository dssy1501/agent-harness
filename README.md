# agent-harness

一个受 **DeepSeek Harness（dsh）** 启发的智能体：provider 无关的内核 + 可组合的"插件"式工具，接上 DeepSeek 就能在本地工作目录上自主编码。

> 设计哲学对齐 dsh 的 *Everything is a plugin*：**模型是灵魂，harness 让智能体理解环境、用工具、在真实环境里持续工作。** 本项目把 dsh 的 Cordis 内核类比物做成了不依赖任何业务的内核，再把"插件"实现成内核契约里的 `Capability`——于是安全（权限闸门 / 快照 / 预算）天然对插件生效，插件不需要自己操心安全。

## 它和 DeepSeek Harness 的关系

| DeepSeek Harness (dsh) | 本项目 | 说明 |
|---|---|---|
| Cordis 内核 | `src/kernel.ts` + `src/contract.ts` | 只认契约，零业务代码 |
| Plugin（模型/工具/技能/…） | `Capability` + `StateProvider` | 应用/插件只声明"能做什么、危险几级" |
| 工具集（file / shell / search） | `harness/plugins/*` | 文件系统、终端等可替换插件 |
| 可追溯会话日志（Trajectory） | `harness/trajectory.ts` | append-only JSONL，可回放/审计 |
| 多种运行时（Standard/Code/Minimal） | `harness/manifest.ts` 装配不同插件集 | 换工具 = 换个 manifest |
| 模型接入 | `OpenAICompatibleProvider` | 接 DeepSeek 只需填 baseURL/model |

## 架构

```
src/                内核（不认识任何业务）
  contract.ts       契约：内核/应用边界、风险词汇表、事件
  tools.ts          Capability → 模型工具定义（zod schema 翻译）
  provider.ts       模型接入：OpenAI 兼容实现 + 可脚本化 Mock
  kernel.ts         任务循环、上下文装配、权限闸门、预算控制
harness/            在"内核"这层之上长出的 harness（就是 dsh 的插件运行时）
  deepseek.ts       把内核接到 api.deepseek.com（OpenAI 兼容）
  plugins/          文件 / 终端 等插件（每个都是 Capability）
  manifest.ts       把插件装配成一个"编码 harness"
  trajectory.ts     每次运行的 append-only 日志
  cli.ts            命令行入口
examples/           probe 探针应用 + 确定性测试
```

## 快速开始

```bash
npm install
npm test                # 内核 + harness 共 13 个确定性用例，全绿才算立住
```

跑一个真实任务（需要 DeepSeek key）：

```bash
export DEEPSEEK_API_KEY=sk-xxxx
node --experimental-strip-types harness/cli.ts \
  --task "给 src 下的 .ts 文件加一行版权头" \
  --root ./your-project
```

不接真模型也能跑通整条管线（用脚本化 Mock，不联网不花钱）：

```bash
node --experimental-strip-types harness/cli.ts --mock --task "demo"
```

### 权限旋钮（对应 dsh 的"逐步放权"）

`--max-auto-risk` 控制"免确认自动执行"的最高风险等级，默认 `read`：

- `read`：只有读操作自动跑，任何写/命令都弹确认（最安全）
- `reversible-write`：文件写也自动跑，但命令仍要确认
- `irreversible-write`：文件写和命令都自动跑（把信任交给智能体）

## 已实现的插件

- **文件系统**（`harness/plugins/filesystem.ts`）：`fs.read_file` / `fs.write_file` / `fs.edit_file`（局部精确替换，要求片段唯一）/ `fs.list_dir` / `fs.glob` / `fs.grep` / `fs.undo`（撤销本会话改写）。全部限制在 `--root` 沙箱内，越界即拒。
- **终端**（`harness/plugins/shell.ts`）：`shell.run`，风险 `irreversible-write`，默认需确认。

## 测试策略

真实模型不可复现，所以测试用 `MockProvider` 把"第一步调 A、第二步调 B、第三步收尾"固定下来，断言循环/闸门/预算/改盘都正确。`examples/harness.test.ts` 覆盖：默认策略下写被拦、旋钮抬起后编辑+撤销回到原样、shell 默认被拦、轨迹落盘。

## 内核设计决策（精华）

1. 一份 zod schema 同时驱动：模型工具定义 / 运行时校验 / TS 类型。
2. 风险等级由内核定义、应用只能选用；分级依据是"出错代价"不是"动作类型"。
3. 权限是单旋钮 `maxAutoRisk`，默认 `read`，宁可停下放权也别一上来全开。
4. 动作观察返回 string（给模型的上下文），长度控制权交给应用。
5. 执行顺序死定：寻址 → 解析 → 校验 → 闸门 → 快照 → 执行；校验必须在确认之前。

## 路线图

- [ ] 记忆层（跨会话/跨应用，对治"重复犯同样错误"）
- [ ] Plan-and-Execute 长任务规划
- [ ] 交互外壳（确认/diff/打断的共用 UI）
- [ ] 接更多模型（通义/智谱/Kimi，内核已 provider 无关）

---

*本项目为 dsh 启发下的从零实现，并非 DeepSeek 官方仓库的 fork。内核契约与 dsh 的插件哲学一致，但代码独立编写。*
