// 대본 단계별 응답 형식. Opus 5.5 의 구조화 출력(json_schema)으로 강제한다.
// index.ts 와 테스트가 같이 쓴다. 네트워크·환경변수를 건드리지 않는 순수 모듈.

// script        : 예전 화면용. 커버+대본만.
// script_brief  : 여행 설정(brief)을 먼저 정하고 커버+대본. 속성 순서대로 만들어서 설정이 먼저 나온다.
// script_review : 대본을 고치지 않고 문제 줄만 찾는다.
// script_repair : 지정한 줄만 고친다.
// script_extend : 모자란 줄만 더 받는다.
export const SCRIPT_PURPOSES = new Set([
  "script",
  "script_brief",
  "script_review",
  "script_repair",
  "script_extend",
]);

export const REVIEW_KINDS = ["사실", "일관성", "오해", "흐름"];

const strList = { type: "array", items: { type: "string" } };

const briefSchema = {
  type: "object",
  properties: {
    party: { type: "string" },
    priceBasis: { type: "string" },
    paid: strList,
    premise: { type: "string" },
    flow: strList,
    unclear: strList,
  },
  required: ["party", "priceBasis", "paid", "premise", "flow", "unclear"],
  additionalProperties: false,
};

const reviewSchema = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "integer" },
          kind: { type: "string", enum: REVIEW_KINDS },
          why: { type: "string" },
          fix: { type: "string" },
        },
        required: ["line", "kind", "why", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
};

export function opusJsonSchema(purpose: string, repairIndices: number[]): Record<string, unknown> {
  if (purpose === "script") {
    return {
      type: "object",
      properties: { cover: strList, script: strList },
      required: ["cover", "script"],
      additionalProperties: false,
    };
  }
  if (purpose === "script_brief") {
    return {
      type: "object",
      properties: { brief: briefSchema, cover: strList, script: strList },
      required: ["brief", "cover", "script"],
      additionalProperties: false,
    };
  }
  if (purpose === "script_review") return reviewSchema;
  if (purpose === "script_extend") {
    return {
      type: "object",
      properties: { more: strList },
      required: ["more"],
      additionalProperties: false,
    };
  }
  const fixedProps: Record<string, { type: string }> = {};
  for (const line of repairIndices) fixedProps[String(line)] = { type: "string" };
  return {
    type: "object",
    properties: {
      fixed: {
        type: "object",
        properties: fixedProps,
        required: Object.keys(fixedProps),
        additionalProperties: false,
      },
    },
    required: ["fixed"],
    additionalProperties: false,
  };
}

// 모델이 형식은 지켰는데 핵심 칸이 비어 온 경우를 걸러낸다. 문제 없으면 "".
// deno-lint-ignore no-explicit-any
export function scriptJsonProblem(purpose: string, parsed: any): string {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not_object";
  if ((purpose === "script" || purpose === "script_brief") &&
      (!Array.isArray(parsed.script) || !Array.isArray(parsed.cover))) {
    return "missing_script";
  }
  if (purpose === "script_brief" &&
      (!parsed.brief || typeof parsed.brief !== "object" || Array.isArray(parsed.brief))) {
    return "missing_brief";
  }
  if (purpose === "script_review" && !Array.isArray(parsed.issues)) return "missing_issues";
  if (purpose === "script_extend" && !Array.isArray(parsed.more)) return "missing_more";
  if (purpose === "script_repair" && (!parsed.fixed || typeof parsed.fixed !== "object")) {
    return "missing_fixed";
  }
  return "";
}
