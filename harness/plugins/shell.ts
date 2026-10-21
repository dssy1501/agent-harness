/**
 * shell.ts —— harness 的"终端"插件（对应 dsh 的 shell 工具）。
 *
 * 跑命令是有外部副作用的，所以风险定为 irreversible-write，
 * 默认需要人确认（内核单旋钮 maxAutoRisk 默认 "read"）。
 * 想让它自己跑，就把旋钮提到 irreversible-write 以上（--max-auto-risk）。
 */

import { exec } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { Capability } from "../../src/contract.ts";

export function createShellCapability(root: string): Capability<{
  command: string;
}> {
  return {
    id: "shell.run",
    title: "运行终端命令",
    description:
      "在工作目录中运行一条 shell 命令，并返回 stdout/stderr（截断到前 4000 字）。" +
      "命令可能改变系统状态、安装依赖或删除文件，属于不可逆操作——执行前必须确认。" +
      "请一次只跑一条命令。",
    risk: "irreversible-write",
    reversible: false,
    params: z.object({
      command: z.string().describe("要执行的 shell 命令"),
    }),
    async handler({ command }) {
      const workdir = path.resolve(root);
      return await new Promise((resolve) => {
        exec(
          command,
          { cwd: workdir, timeout: 60_000, maxBuffer: 4_000_000 },
          (err, stdout, stderr) => {
            const out = (stdout ?? "").slice(0, 4000);
            const serr = (stderr ?? "").slice(0, 2000);
            if (err) {
              resolve({
                ok: false,
                observation: `命令退出码 ${err.code ?? "?"}：\n${(
                  serr + "\n" + out
                ).trim()}`,
              });
              return;
            }
            resolve({
              ok: true,
              observation: `${
                serr ? "stderr:\n" + serr + "\n" : ""
              }stdout:\n${out || "（无输出）"}`,
            });
          },
        );
      });
    },
  };
}
