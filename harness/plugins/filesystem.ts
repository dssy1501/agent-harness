/**
 * filesystem.ts —— harness 的"文件"插件（对应 dsh 的 file editor 工具）。
 *
 * 这些能力就是 dsh Standard mode 里"读文件 / 改文件 / 列目录"那一套。
 * 每个能力都是内核契约里的 Capability，所以内核的权限闸门、快照、预算
 * 对它一视同仁地生效——插件不需要关心安全，安全是内核给的。
 *
 * 全部操作被限制在 root 之内（沙箱），逃逸会被拒绝。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Capability } from "../../src/contract.ts";

/** 朴素的撤销栈：路径 → 该文件被改写前的若干份内容。 */
const undoStack = new Map<string, string[]>();

function pushUndo(resolved: string, prev: string): void {
  const arr = undoStack.get(resolved) ?? [];
  arr.push(prev);
  undoStack.set(resolved, arr);
}

/* ---------- 安全：把路径限制在 root 内 ---------- */
function resolveSafe(root: string, p: string): string {
  const absRoot = path.resolve(root);
  const combined = path.isAbsolute(p) ? p : path.join(absRoot, p);
  const resolved = path.resolve(combined);
  const rel = path.relative(absRoot, resolved);
  if (rel.startsWith("..")) {
    throw new Error(`路径越界：'${p}' 不在工作目录 ${absRoot} 之内`);
  }
  return resolved;
}

/* ---------- 最小 glob（支持 * 和 **） ---------- */
function patternToRegExp(pattern: string): RegExp {
  // 支持 ** 匹配任意层，* 匹配单层（不含 /）
  const escaped = pattern
    .split("/")
    .map((seg) => {
      if (seg === "**") return "(?:.*)";
      return seg
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*");
    })
    .join("/");
  return new RegExp("^" + escaped + "$");
}

async function walkFiles(root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      await walkFiles(full, out);
    } else {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
}

async function globFiles(root: string, pattern: string): Promise<string[]> {
  const re = patternToRegExp(pattern);
  const all: string[] = [];
  await walkFiles(root, all);
  return all.filter((p) => re.test(p)).sort();
}

/* ------------------------------------------------------------------ */
export function createFileSystemCapabilities(root: string): Capability[] {
  const readFile: Capability<{ path: string }> = {
    id: "fs.read_file",
    title: "读取文件",
    description:
      "读取指定文件的文本内容。当你需要查看某个文件的内容、了解其结构或确认现有实现时使用。仅读取，无任何副作用。路径相对于工作目录。",
    risk: "read",
    reversible: true,
    params: z.object({ path: z.string().describe("文件路径，相对于工作目录") }),
    async handler({ path: p }) {
      const full = resolveSafe(root, p);
      try {
        const text = await fs.readFile(full, "utf8");
        return {
          ok: true,
          observation: `文件 ${p}（${text.length} 字）：\n---\n${text}`,
        };
      } catch (err) {
        return {
          ok: false,
          observation: `读取失败：${(err as Error).message}`,
        };
      }
    },
  };

  const writeFile: Capability<{ path: string; content: string }> = {
    id: "fs.write_file",
    title: "写入文件",
    description:
      "用给定内容整体覆盖写入一个文件（不存在则创建）。会改动磁盘文件，属于可逆写——执行前需确认，且会保留撤销点。用于新建文件或整体重写。局部修改优先用 fs.edit_file。",
    risk: "reversible-write",
    reversible: true,
    params: z.object({
      path: z.string().describe("目标文件路径，相对于工作目录"),
      content: z.string().describe("要写入的完整文件内容"),
    }),
    async handler({ path: p, content }) {
      const full = resolveSafe(root, p);
      let prev = "";
      try {
        prev = await fs.readFile(full, "utf8");
      } catch {
        prev = "";
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      pushUndo(full, prev);
      return {
        ok: true,
        observation: `已写入 ${p}（${content.length} 字）。可用 fs.undo 撤销。`,
      };
    },
  };

  const editFile: Capability<{
    path: string;
    old_string: string;
    new_string: string;
  }> = {
    id: "fs.edit_file",
    title: "局部改写文件",
    description:
      "在文件中把 old_string 精确替换为 new_string（纯字符串匹配，不做正则）。用于局部修改。old_string 必须在文件里唯一，否则拒绝以避免改错位置。改动前会保留撤销点。",
    risk: "reversible-write",
    reversible: true,
    params: z.object({
      path: z.string().describe("文件路径，相对于工作目录"),
      old_string: z.string().describe("要被替换的原文片段，必须唯一存在"),
      new_string: z.string().describe("替换后的新内容"),
    }),
    async handler({ path: p, old_string, new_string }) {
      const full = resolveSafe(root, p);
      let text: string;
      try {
        text = await fs.readFile(full, "utf8");
      } catch (err) {
        return {
          ok: false,
          observation: `读不到文件，无法编辑：${(err as Error).message}`,
        };
      }
      const idx = text.indexOf(old_string);
      if (idx === -1) {
        return {
          ok: false,
          observation: `old_string 在 ${p} 中不存在，未做任何修改。`,
        };
      }
      if (text.indexOf(old_string, idx + 1) !== -1) {
        return {
          ok: false,
          observation:
            `old_string 在 ${p} 中出现多次，不唯一，为防改错已拒绝。` +
            `请提供更多上下文使其唯一。`,
        };
      }
      const next =
        text.slice(0, idx) + new_string + text.slice(idx + old_string.length);
      pushUndo(full, text);
      await fs.writeFile(full, next, "utf8");
      return {
        ok: true,
        observation: `已在 ${p} 完成一次局部替换。可用 fs.undo 撤销。`,
      };
    },
  };

  const listDir: Capability<{ path?: string }> = {
    id: "fs.list_dir",
    title: "列出目录",
    description:
      "列出某目录下的文件和子目录（不含递归）。路径缺省为工作目录根。用于了解项目结构。",
    risk: "read",
    reversible: true,
    params: z.object({
      path: z.string().optional().describe("目录路径，相对于工作目录，缺省为根"),
    }),
    async handler({ path: p }) {
      const full = resolveSafe(root, p ?? ".");
      try {
        const entries = await fs.readdir(full, { withFileTypes: true });
        const lines = entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git")
          .map((e) => `${e.isDirectory() ? "[D]" : "[F]"} ${e.name}`);
        return {
          ok: true,
          observation: lines.length ? lines.join("\n") : "（空目录）",
        };
      } catch (err) {
        return {
          ok: false,
          observation: `列目录失败：${(err as Error).message}`,
        };
      }
    },
  };

  const globCap: Capability<{ pattern: string }> = {
    id: "fs.glob",
    title: "按模式搜索文件",
    description:
      "按 glob 模式（支持 * 和 **）列出匹配的文件路径，相对于工作目录。用于快速定位一批文件，例如 \"src/**/*.ts\"。",
    risk: "read",
    reversible: true,
    params: z.object({
      pattern: z.string().describe("glob 模式，例如 src/**/*.ts"),
    }),
    async handler({ pattern }) {
      try {
        const matches = await globFiles(root, pattern);
        return {
          ok: true,
          observation: matches.length
            ? `匹配 ${matches.length} 个：\n${matches.join("\n")}`
            : `无匹配：${pattern}`,
        };
      } catch (err) {
        return {
          ok: false,
          observation: `glob 失败：${(err as Error).message}`,
        };
      }
    },
  };

  const grepCap: Capability<{
    pattern: string;
    path?: string;
    glob?: string;
  }> = {
    id: "fs.grep",
    title: "在文件中搜索文本",
    description:
      "在文件内容里按正则搜索。pattern 为正则字符串。可选 path 限定目录（缺省根），可选 glob 限定文件类型（如 \"*.ts\"）。返回匹配行。",
    risk: "read",
    reversible: true,
    params: z.object({
      pattern: z.string().describe("正则表达式"),
      path: z.string().optional().describe("搜索目录，相对于工作目录，缺省根"),
      glob: z.string().optional().describe("只搜这类文件，例如 *.ts"),
    }),
    async handler({ pattern, path: p, glob }) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "g");
      } catch (err) {
        return {
          ok: false,
          observation: `正则无效：${(err as Error).message}`,
        };
      }
      const base = resolveSafe(root, p ?? ".");
      const files = await globFiles(root, glob ?? "**");
      const hits: string[] = [];
      for (const rel of files) {
        const full = path.join(base, rel);
        let text: string;
        try {
          text = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      return {
        ok: true,
        observation: hits.length
          ? `找到 ${hits.length} 处：\n` + hits.slice(0, 200).join("\n")
          : "无匹配",
      };
    },
  };

  const undo: Capability<{ path: string }> = {
    id: "fs.undo",
    title: "撤销最近一次文件改写",
    description:
      "把某个文件恢复到最近一次被 fs.write_file / fs.edit_file 改写之前的内容。仅能撤销本会话改写栈记录的版本。",
    risk: "reversible-write",
    reversible: true,
    params: z.object({
      path: z.string().describe("要撤销的文件路径"),
    }),
    async handler({ path: p }) {
      const full = resolveSafe(root, p);
      const stack = undoStack.get(full);
      if (!stack || stack.length === 0) {
        return {
          ok: false,
          observation: `没有可撤销的改写记录：${p}`,
        };
      }
      const prev = stack.pop() as string;
      await fs.writeFile(full, prev, "utf8");
      return {
        ok: true,
        observation: `已撤销最近一次对 ${p} 的改写。`,
      };
    },
  };

  return [readFile, writeFile, editFile, listDir, globCap, grepCap, undo];
}
