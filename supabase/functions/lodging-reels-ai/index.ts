// 대본 생성. 아티팩트의 sample 자리를 대신한다.
// 대본 규칙/프롬프트는 건드리지 않고, AI 호출 경로만 Vercel AI Gateway 대응으로 바꾼다.
// 비밀키는 Edge Function Secret 에만 두고 브라우저로 내보내지 않는다.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cors, preflight, fail, requireUser } from "./_shared.ts";
import { SCRIPT_PURPOSES, opusJsonSchema, scriptJsonProblem } from "./schema.ts";

const DEFAULT_GATEWAY_MODEL =
  Deno.env.get("AI_GATEWAY_MODEL") || "anthropic/claude-sonnet-5";
const DIRECT_MODEL_ALLOW = new Set([
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
]);
const configuredDirectModel = Deno.env.get("ANTHROPIC_MODEL") || "";
const DIRECT_ANTHROPIC_MODEL = DIRECT_MODEL_ALLOW.has(configuredDirectModel)
  ? configuredDirectModel
  : "claude-sonnet-5";
// The script, brief, review, line repair and extension stages use Opus 5.5. OCR stays on Sonnet.
const OPUS_GATEWAY_MODEL = "anthropic/claude-opus-5.5";
const OPUS_DIRECT_MODEL = "claude-opus-5-5";
const MAX_PROMPT = 60000;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, 405, "method", "POST 만 받아요.");

  const user = await requireUser(req);
  if (!user) return fail(req, 401, "unauthorized", "로그인이 필요해요.");

  const gatewayKey = Deno.env.get("AI_GATEWAY_API_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!gatewayKey && !anthropicKey) {
    return fail(
      req,
      500,
      "no_key",
      "AI_GATEWAY_API_KEY 가 설정되지 않았어요."
    );
  }

  let body: {
    prompt?: string;
    json?: boolean;
    max_tokens?: number;
    model?: string;
    purpose?: string;
    repair_indices?: number[];
  };
  try {
    body = await req.json();
  } catch {
    return fail(req, 400, "bad_json", "요청을 읽지 못했어요.");
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return fail(req, 400, "empty", "prompt 가 비었어요.");
  if (prompt.length > MAX_PROMPT) {
    return fail(req, 400, "too_long", "prompt 가 너무 길어요.");
  }

  const purpose = String(body.purpose || "").trim();
  if (purpose && !SCRIPT_PURPOSES.has(purpose)) {
    return fail(req, 400, "bad_purpose", "지원하지 않는 대본 생성 단계예요.");
  }
  const isScriptRequest = SCRIPT_PURPOSES.has(purpose);
  if (isScriptRequest && !body.json) {
    return fail(req, 400, "json_required", "대본 생성에는 JSON 응답이 필요해요.");
  }

  const repairIndices: number[] = [];
  if (purpose === "script_repair") {
    const indices = body.repair_indices;
    if (!Array.isArray(indices) || indices.length < 1 || indices.length > 8 ||
        indices.some((n) => !Number.isInteger(n) || n < 1 || n > 30) ||
        new Set(indices).size !== indices.length) {
      return fail(req, 400, "bad_repair_indices", "고칠 줄 번호를 확인해주세요.");
    }
    repairIndices.push(...indices);
  }

  const requestedModel = String(body.model || "").trim();
  if (requestedModel && !MODEL_ID.test(requestedModel)) {
    return fail(
      req,
      400,
      "bad_model",
      "model 은 provider/model 형식이어야 해요."
    );
  }

  // Gateway 키가 있으면 Vercel AI Gateway를 우선 사용한다.
  // body.model 이 있으면 Claude/GPT/Gemini 등 Gateway 모델을 요청별로 바꿀 수 있다.
  const useGateway = Boolean(gatewayKey);
  const model = useGateway
    ? (isScriptRequest ? OPUS_GATEWAY_MODEL : (requestedModel || DEFAULT_GATEWAY_MODEL))
    : (isScriptRequest ? OPUS_DIRECT_MODEL : DIRECT_ANTHROPIC_MODEL);

  const payload: Record<string, unknown> = {
    model,
    max_tokens: Math.min(Math.max(body.max_tokens || 2000, 256), 8000),
    messages: [{ role: "user", content: prompt }],
  };

  // 프롬프트 문자열은 그대로 둔 채, JSON 응답 형식만 API 레벨에서 강제한다.
  // 최신 Claude 계열은 assistant prefill을 허용하지 않으므로 tool_use를 구조화 출력 채널로 쓴다.
  if (body.json) {
    if (isScriptRequest) {
      // Opus 5.5 always uses adaptive thinking and REJECTS forced tool_choice (HTTP 400).
      // Native structured output preserves the prompt and returns JSON in a text block.
      payload.output_config = {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: opusJsonSchema(purpose, repairIndices),
        },
      };
    } else {
      // Preserve existing Sonnet JSON behavior for OCR and other non-script requests.
      payload.tools = [{
        name: "return_json",
        description: "Structured JSON return channel.",
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      }];
      payload.tool_choice = { type: "tool", name: "return_json" };
    }
  }

  const url = useGateway
    ? "https://ai-gateway.vercel.sh/v1/messages"
    : "https://api.anthropic.com/v1/messages";

  const headers: Record<string, string> = useGateway
    ? {
        Authorization: `Bearer ${gatewayKey}`,
        "Content-Type": "application/json",
      }
    : {
        "x-api-key": anthropicKey as string,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      };

  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return fail(req, 502, "upstream_unreachable", String(e));
  }

  if (!r.ok) {
    const t = await r.text();
    console.error("lodging-reels-ai upstream error", {
      gateway: useGateway ? "vercel-ai-gateway" : "anthropic-direct",
      model,
      purpose: purpose || "default",
      status: r.status,
      body: t.slice(0, 500),
    });
    const code =
      r.status === 429
        ? "rate_limited"
        : r.status === 401
        ? "bad_key"
        : r.status === 404
        ? "bad_model"
        : "upstream_error";
    return fail(req, r.status === 429 ? 429 : 502, code, t.slice(0, 500));
  }

  const out = await r.json();
  let text = "";
  let structured: unknown = null;
  const blockTypes: string[] = [];
  for (const b of out.content || []) {
    blockTypes.push(String(b.type || "unknown"));
    if (b.type === "tool_use" && b.name === "return_json") structured = b.input;
    if (b.type === "text") text += b.text;
  }

  if (body.json && structured && typeof structured === "object") {
    text = JSON.stringify(structured);
  }

  let nativeStructured = false;
  if (isScriptRequest && body.json) {
    if (out.stop_reason === "max_tokens") {
      return fail(req, 502, "max_tokens", "Opus 5.5 응답이 중간에 잘렸어요. 다시 시도해주세요.");
    }
    if (out.stop_reason === "refusal") {
      return fail(req, 502, "model_refusal", "모델이 대본 요청을 처리하지 않았어요.");
    }
    let problem = "";
    try {
      problem = scriptJsonProblem(purpose, JSON.parse(text));
    } catch {
      problem = "parse";
    }
    if (problem) {
      console.error("lodging-reels-ai bad script json", { purpose, problem, text_preview: text.slice(0, 300) });
      return fail(req, 502, "bad_json", "Opus 5.5 JSON 응답을 읽지 못했어요.");
    }
    nativeStructured = true;
  }

  console.log("lodging-reels-ai response", {
    gateway: useGateway ? "vercel-ai-gateway" : "anthropic-direct",
    model,
    prompt_chars: prompt.length,
    json_mode: Boolean(body.json),
    block_types: blockTypes,
    structured: Boolean(structured) || nativeStructured,
    purpose: purpose || "default",
    stop_reason: out.stop_reason || null,
    usage: out.usage || null,
  });

  if (body.json && !structured && !nativeStructured) {
    console.error("lodging-reels-ai structured output missing", {
      model,
      prompt_chars: prompt.length,
      block_types: blockTypes,
      stop_reason: out.stop_reason || null,
      text_preview: text.slice(0, 300),
    });
  }

  return new Response(
    JSON.stringify({
      text,
      model,
      gateway: useGateway ? "vercel-ai-gateway" : "anthropic-direct",
      structured: Boolean(structured) || nativeStructured,
      usage: out.usage || null,
    }),
    {
      headers: { ...cors(req), "Content-Type": "application/json" },
    }
  );
});
