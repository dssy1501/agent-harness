/**
 * deepseek.ts —— 把内核接到 DeepSeek 的 OpenAI 兼容端点。
 *
 * DeepSeek 的 API 完全兼容 OpenAI 协议（/v1/chat/completions），
 * 所以直接复用内核自带的 OpenAICompatibleProvider，只需填上 baseURL 和模型。
 * 这正是"内核不绑死任何一家"的设计兑现：换供应商 = 换这一处配置。
 */

import { OpenAICompatibleProvider } from "../src/provider.ts";

export interface DeepSeekOptions {
  /** 模型名。默认 deepseek-chat（通用）；深度推理用 deepseek-reasoner（R1）。 */
  model?: string;
  /** API Key。缺省读环境变量 DEEPSEEK_API_KEY。 */
  apiKey?: string;
  /** 端点。一般不用改。 */
  baseURL?: string;
}

export function createDeepSeekProvider(
  opts: DeepSeekOptions = {},
): OpenAICompatibleProvider {
  const apiKey = opts.apiKey ?? process.env["DEEPSEEK_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "缺少 DeepSeek API Key：请设置环境变量 DEEPSEEK_API_KEY，或在调用时传入 apiKey。",
    );
  }
  return new OpenAICompatibleProvider({
    baseURL: opts.baseURL ?? "https://api.deepseek.com/v1",
    model: opts.model ?? "deepseek-chat",
    apiKey,
  });
}
