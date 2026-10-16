// 대본 Edge Function(supabase/functions/lodging-reels-ai) 응답 형식 검사. Deno 로 돌린다:
//   deno test --no-check tests/ai-function.test.ts
// 실제 Opus 호출은 하지 않는다. 단계별 json_schema 와 응답 검사만 본다.
import assert from "node:assert/strict";
import {
  opusJsonSchema, REVIEW_KINDS, SCRIPT_PURPOSES, scriptJsonProblem,
} from "../supabase/functions/lodging-reels-ai/schema.ts";

// deno-lint-ignore no-explicit-any
type Obj = any;

Deno.test("all script stages are allowed, old 'script' stays for the current screen", () => {
  for (const p of ["script", "script_brief", "script_review", "script_repair", "script_extend"]) {
    assert.ok(SCRIPT_PURPOSES.has(p), p);
  }
  assert.ok(!SCRIPT_PURPOSES.has("ocr"));
});

Deno.test("old 'script' schema is unchanged (cover + script only)", () => {
  const s: Obj = opusJsonSchema("script", []);
  assert.deepEqual(Object.keys(s.properties), ["cover", "script"]);
  assert.deepEqual(s.required, ["cover", "script"]);
  assert.equal(s.additionalProperties, false);
});

Deno.test("script_brief puts brief first so the model decides the trip before writing lines", () => {
  const s: Obj = opusJsonSchema("script_brief", []);
  assert.deepEqual(Object.keys(s.properties), ["brief", "cover", "script"]);
  assert.deepEqual(s.required, ["brief", "cover", "script"]);
  const b = s.properties.brief;
  assert.deepEqual(Object.keys(b.properties), ["party", "priceBasis", "paid", "premise", "flow", "unclear"]);
  assert.deepEqual(b.required, Object.keys(b.properties));
  assert.equal(b.additionalProperties, false);
  assert.equal(b.properties.paid.type, "array");
  assert.equal(b.properties.unclear.items.type, "string");
});

Deno.test("script_review returns line-numbered issues of four fixed kinds", () => {
  const s: Obj = opusJsonSchema("script_review", []);
  assert.deepEqual(s.required, ["issues"]);
  const it = s.properties.issues.items;
  assert.equal(it.properties.line.type, "integer");
  assert.deepEqual(it.properties.kind.enum, REVIEW_KINDS);
  assert.deepEqual(REVIEW_KINDS, ["사실", "일관성", "오해", "흐름"]);
  assert.deepEqual(it.required, ["line", "kind", "why", "fix"]);
  assert.equal(it.additionalProperties, false);
});

Deno.test("repair and extend schemas keep their shapes", () => {
  const r: Obj = opusJsonSchema("script_repair", [2, 5]);
  assert.deepEqual(r.properties.fixed.required, ["2", "5"]);
  const e: Obj = opusJsonSchema("script_extend", []);
  assert.deepEqual(e.required, ["more"]);
});

Deno.test("scriptJsonProblem catches empty or wrong-shaped answers per stage", () => {
  assert.equal(scriptJsonProblem("script", { cover: [], script: [] }), "");
  assert.equal(scriptJsonProblem("script", { cover: [] }), "missing_script");
  assert.equal(scriptJsonProblem("script_brief", { cover: [], script: [] }), "missing_brief");
  assert.equal(scriptJsonProblem("script_brief", { brief: [], cover: [], script: [] }), "missing_brief");
  assert.equal(scriptJsonProblem("script_brief", { brief: {}, cover: [], script: [] }), "");
  assert.equal(scriptJsonProblem("script_review", { issues: [] }), "");
  assert.equal(scriptJsonProblem("script_review", {}), "missing_issues");
  assert.equal(scriptJsonProblem("script_extend", { more: [] }), "");
  assert.equal(scriptJsonProblem("script_repair", { fixed: {} }), "");
  assert.equal(scriptJsonProblem("script_repair", {}), "missing_fixed");
  assert.equal(scriptJsonProblem("script", []), "not_object");
  assert.equal(scriptJsonProblem("script", null), "not_object");
});
