/**
 * provider.ts —— 模型接入层。
 *
 * 内核只认识 Provider 这一个接口。换模型 = 换实现类，
 * 内核一行不改。这是"不绑死某一家 API"的具体落地。
 *
 * 两个实现：
 *   OpenAICompatibleProvider —— 面向云端 API 的真实现。
 *     注意这是"OpenAI 兼容协议"而不是"OpenAI"：国内主流云服务
 *     （DeepSeek / 通义 / 智谱 / Kimi / 混元）几乎都提供兼容端点，
 *     所以一个实现覆盖绝大多数情况。
 *   MockProvider —— 脚本化的假模型，用来离线开发和自测。
 *     不接真实 API 也能把内核逻辑跑通、不花钱、结果可复现。
 */

import type { ToolDefinition } from "./tools.ts";

/** 一次补全请求。内核只管攒这个对象，怎么发是 Provider 的事。 */
export interface CompleteRequest {
  /** 完整的对话历史，内核负责维护。 */
  messages: Message[];
  /** 可用工具列表，由契约里的 capabilities 转来。 */
  tools?: ToolDefinition[];
  temperature?: number;
  /** 强制模型走工具调用的策略。 */
  toolChoice?: "auto" | "required" | "none";
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** 模型发起的工具调用。 */
export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串。故意不在这里 parse——parse 失败要能定位到具体那次调用。 */
  argumentsJson: string;
}

/** 一次补全的返回。 */
export interface CompleteResponse {
  /** 模型的自然语言输出。可能是最终答复，也可能是思考过程。 */
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

/** 内核对模型的全部要求就是一个方法。 */
export interface Provider {
  readonly name: string;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

/* ------------------------------------------------------------------ *
 * 真实现：OpenAI 兼容端点
 * ------------------------------------------------------------------ */
export interface OpenAICompatibleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  // 刻意不用 TS 的"参数属性"简写（constructor(private cfg: ...)）。
  // Node 原生的 TS 类型擦除不支持那种语法，会直接报错。
  // 显式声明字段虽然多两行，但换来"不依赖编译链也能跑"。
  private readonly cfg: OpenAICompatibleConfig;

  constructor(cfg: OpenAICompatibleConfig) {
    this.cfg = cfg;
    // name 里带上模型名，日志里一眼看得出是哪次调用用的什么。
    this.name = `openai-compatible:${cfg.model}`;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toWireMessages(req.messages),
      temperature: req.temperature ?? 0.2,
    };

    // 有工具才带 tools 字段。空数组会让部分 API 报错。
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    }

    const res = await fetch(
      `${this.cfg.baseURL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      // 把响应体一起抛出来。云端 API 的错误信息全在 body 里，
      // 只报状态码等于没报。
      const text = await res.text().catch(() => "");
      throw new Error(
        `${this.name} HTTP ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as OpenAIWireResponse;
    const msg = json.choices?.[0]?.message;
    if (!msg) {
      throw new Error(`${this.name}: 响应里没有 choices[0].message`);
    }

    return {
      content: msg.content ?? null,
      toolCalls: (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      })),
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** 内部消息格式 → OpenAI 线格式。两者刻意分开，换协议时只改这一处。 */
function toWireMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: tc.argumentsJson,
                  },
                })),
              }
            : {}),
        };
      case "tool":
        return {
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.content,
        };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

type OpenAIWireResponse = {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/* ------------------------------------------------------------------ *
 * 假实现：脚本化 Mock
 *
 * 价值不在于"能跑"，在于能把内核逻辑测成确定性的：
 * 真实模型每次回答都不一样，你的测试就没法断言结果。
 * 用 Mock 设定"第一步调 A、第二步调 B、第三步收尾"，
 * 循环逻辑对不对立刻见分晓。
 * ------------------------------------------------------------------ */
export class MockProvider implements Provider {
  readonly name = "mock";
  private cursor = 0;
  private readonly scripts: CompleteResponse[];

  /** scripts 按顺序逐条返回；用完后重复最后一条。 */
  constructor(scripts: CompleteResponse[]) {
    this.scripts = scripts;
  }

  async complete(_req: CompleteRequest): Promise<CompleteResponse> {
    if (this.scripts.length === 0) {
      throw new Error("MockProvider 没有配置任何脚本响应");
    }
    const i = Math.min(this.cursor, this.scripts.length - 1);
    this.cursor += 1;
    return this.scripts[i];
  }

  /** 已经消耗到第几条，测试里用来断言调用次数。 */
  get calls(): number {
    return this.cursor;
  }
}

/** 快速构造一条"只要文本、不调工具"的脚本响应。 */
export function mockText(text: string): CompleteResponse {
  return {
    content: text,
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0 },
  };
}

/** 快速构造一条"发起工具调用"的脚本响应。 */
export function mockToolCall(
  name: string,
  args: Record<string, unknown>,
): CompleteResponse {
  return {
    content: null,
    toolCalls: [
      {
        id: `mock-${name}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        argumentsJson: JSON.stringify(args),
      },
    ],
    usage: { promptTokens: 0, completionTokens: 0 },
  };
}
