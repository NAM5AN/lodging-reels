// ⑨ 영상화 Edge Function(supabase/functions/lodging-reels-clip) 검사. Deno 로 돌린다:
//   deno test tests/clip-function.test.ts
// 실제 Kling 호출은 하지 않는다(돈이 든다). 네트워크는 전부 가짜.
import assert from "node:assert/strict";
import {
  ASPECT, checkPath, createBody, DEFAULT_BASE, ENDPOINT, handle, MAX_DURATION, MAX_INPUTS, MAX_PROMPT, MIN_DURATION,
  MAX_VIDEO_BYTES, MODE, MODEL, publicUrl, readVideo, validateStart, validateStatus, videoPath,
} from "../supabase/functions/lodging-reels-clip/clip.ts";

const UID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const P = "pabc123";
const SUPA = "https://kfgtvifupumjuewwxzmz.supabase.co";
const EDITED = `${UID}/${P}/edited/e1.jpg`;
const ORIGINAL = `${UID}/${P}/photo/o1.jpg`;
const REF = (n: number) => `${UID}/${P}/ref/r${n}.jpg`;
const START = { action: "start", projectId: P, edited: EDITED, original: ORIGINAL, refs: [REF(1)], prompt: "<<<image_1>>> 장면", duration: 5 };
const ENV = { klingKey: "TEST_ONLY_KLING_KEY", supabaseUrl: SUPA, anonKey: "anon", allowedOrigins: "*" };

Deno.test("paths: only the caller's own edited/photo/ref jpg·png files in one project", () => {
  assert.equal(checkPath(EDITED, UID, ["edited"]), true);
  assert.equal(checkPath(`${OTHER}/${P}/edited/e1.jpg`, UID, ["edited"]), false);
  assert.equal(checkPath(`${UID}/${P}/edited/e1.webp`, UID, ["edited"]), false, "Kling takes jpg/png only");
  assert.equal(checkPath(`${UID}/../x/edited/e1.jpg`, UID, ["edited"]), false);
  assert.equal(checkPath("https://evil.example/a.jpg", UID, ["edited"]), false);
  const ok = validateStart(START, UID);
  assert.ok(!("error" in ok));
  if (!("error" in ok)) assert.deepEqual(ok.inputs, [EDITED, ORIGINAL, REF(1)], "image_1 edited, image_2 original, image_3 ref");
  const err = (b: unknown) => { const v = validateStart(b, UID); return "error" in v ? v.error : null; };
  assert.equal(err({ ...START, edited: ORIGINAL }), "bad_edited");
  assert.equal(err({ ...START, original: EDITED }), "bad_original");
  assert.equal(err({ ...START, refs: [ORIGINAL] }), "bad_ref");
  assert.equal(err({ ...START, refs: [`${UID}/pother/ref/r1.jpg`] }), "bad_ref", "other project");
  assert.equal(err({ ...START, projectId: "a/b" }), "bad_project");
});

Deno.test("limits: 7 images, 2500 chars, any whole 3-15 s per video", () => {
  assert.equal(MAX_INPUTS, 7);
  const err = (b: unknown) => { const v = validateStart(b, UID); return "error" in v ? v.error : null; };
  assert.equal(err({ ...START, refs: [1, 2, 3, 4, 5].map(REF) }), null, "edited + original + 5 refs = 7");
  assert.equal(err({ ...START, refs: [1, 2, 3, 4, 5, 6].map(REF) }), "too_many_refs");
  assert.equal(err({ ...START, prompt: "  " }), "empty_prompt");
  assert.equal(err({ ...START, prompt: "가".repeat(MAX_PROMPT + 1) }), "too_long");
  const d = (x: unknown) => { const v = validateStart({ ...START, duration: x }, UID); return "error" in v ? v.error : v.duration; };
  assert.equal(MIN_DURATION, 3);
  assert.equal(MAX_DURATION, 15);
  assert.equal(d(3), 3);
  assert.equal(d(7), 7, "any whole second, typed per video");
  assert.equal(d("12"), 12);
  assert.equal(d(15), 15);
  assert.equal(d(undefined), 5, "blank → 5 s");
  assert.equal(d(""), 5);
  assert.equal(d(2), "bad_duration");
  assert.equal(d(16), "bad_duration");
  assert.equal(d(4.5), "bad_duration");
  assert.equal(d("abc"), "bad_duration");
});

Deno.test("create body: kling-v3-omni pro, 9:16, references in order, no first frame, no sound", () => {
  const v = validateStart({ ...START, refs: [REF(1), REF(2)], duration: 7 }, UID);
  assert.ok(!("error" in v));
  if ("error" in v) return;
  const b = createBody(v, SUPA);
  assert.equal(b.model_name, "kling-v3-omni");
  assert.equal(b.mode, "pro");
  assert.equal(b.aspect_ratio, "9:16");
  assert.equal(b.duration, "7", "Kling takes duration as a string");
  assert.equal(b.sound, "off");
  assert.equal(b.prompt, "<<<image_1>>> 장면");
  assert.deepEqual(b.image_list, [EDITED, ORIGINAL, REF(1), REF(2)].map((p) => ({ image_url: publicUrl(SUPA, p) })));
  for (const it of b.image_list as Record<string, unknown>[]) assert.equal(it.type, undefined, "reference, not first_frame");
  assert.equal(b.image, undefined);
  assert.equal(b.image_tail, undefined);
});

Deno.test("status input and result path", async () => {
  const e = (b: unknown) => { const v = validateStatus(b); return "error" in v ? v.error : null; };
  assert.equal(e({ projectId: P }), "bad_operation");
  assert.equal(e({ projectId: P, operation: { taskId: "../x" } }), "bad_operation", "no path injection into the Kling URL");
  assert.equal(e({ projectId: P, operation: { taskId: "8642abc_DEF-1" } }), null);
  const a = await videoPath(UID, P, "t1"), b = await videoPath(UID, P, "t1"), c = await videoPath(UID, P, "t2");
  assert.equal(a, b, "same task → same file");
  assert.notEqual(a, c);
  assert.match(a, new RegExp(`^${UID}/${P}/video/v[0-9a-f]{24}\\.mp4$`));
});

Deno.test("video download: 50MB cap", async () => {
  const big = () => Promise.resolve(new Response("x", { headers: { "content-length": String(MAX_VIDEO_BYTES + 1) } }));
  await assert.rejects(readVideo("https://cdn/x.mp4", { fetch: big as typeof fetch }), /video_too_large/);
  const gone = () => Promise.resolve(new Response("no", { status: 403 }));
  await assert.rejects(readVideo("https://cdn/x.mp4", { fetch: gone as typeof fetch }), /video_download_403/);
});

// ---------- 함수 전체 ----------
type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
function net(routes: [string, (url: string, init: RequestInit) => Response][]) {
  const seen: Seen[] = [];
  const f = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const raw = init.body;
    let body: unknown = raw;
    if (typeof raw === "string") { try { body = JSON.parse(raw); } catch { body = raw; } }
    seen.push({ url, method: init.method || "GET", headers: (init.headers || {}) as Record<string, string>, body });
    for (const [m, r] of routes) if (url.includes(m)) return Promise.resolve(r(url, init));
    return Promise.reject(new Error("unexpected fetch " + url));
  };
  return { seen, fetch: f as typeof fetch };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const user = (_u: string, init: RequestInit) =>
  (init.headers as Record<string, string>).Authorization === "Bearer user-jwt" ? json({ id: UID }) : json({ msg: "bad" }, 401);
function post(body: unknown, auth = "Bearer user-jwt") {
  return new Request("https://x.supabase.co/functions/v1/lodging-reels-clip", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json", origin: "https://lodging-reels-git.vercel.app" },
    body: JSON.stringify(body),
  });
}
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

Deno.test("start → processing → succeed: Bearer key, omni endpoint, video stored in the user's folder", async () => {
  let polls = 0;
  const n = net([
    ["/auth/v1/user", user],
    [`${ENDPOINT}/task_123`, () => (++polls === 1)
      ? json({ code: 0, message: "SUCCEED", data: { task_id: "task_123", task_status: "processing" } })
      : json({ code: 0, message: "SUCCEED", data: { task_id: "task_123", task_status: "succeed",
          task_result: { videos: [{ id: "v1", url: "https://cdn.klingai.example/out.mp4", duration: "5.1" }] } } })],
    [ENDPOINT, () => json({ code: 0, message: "SUCCEED", request_id: "req1", data: { task_id: "task_123", task_status: "submitted" } })],
    ["https://cdn.klingai.example/out.mp4", () => new Response(MP4, { headers: { "content-type": "video/mp4", "content-length": String(MP4.length) } })],
    ["/storage/v1/object/lodging-reels/", () => json({ Key: "ok" })],
  ]);
  const s = await handle(post(START), ENV, { fetch: n.fetch });
  assert.equal(s.status, 200);
  assert.equal(s.headers.get("Access-Control-Allow-Origin"), "*");
  const sb = await s.json();
  assert.deepEqual(sb.operation, { taskId: "task_123" });
  assert.equal(sb.model, MODEL);
  assert.equal(sb.mode, MODE);
  assert.equal(sb.aspect, ASPECT);
  const create = n.seen.find((x) => x.method === "POST" && x.url === DEFAULT_BASE + ENDPOINT);
  assert.ok(create, "POST " + DEFAULT_BASE + ENDPOINT);
  assert.equal(create!.headers.Authorization, "Bearer TEST_ONLY_KLING_KEY", "API key sent as-is as Bearer");
  assert.equal((create!.body as Record<string, unknown>).model_name, "kling-v3-omni");

  const p = await handle(post({ action: "status", projectId: P, operation: sb.operation }), ENV, { fetch: n.fetch });
  assert.deepEqual(await p.json(), { status: "pending", kling: "processing" });
  assert.ok(!n.seen.some((x) => x.url.includes("/storage/")), "nothing stored while pending");
  const poll = n.seen.find((x) => x.url.endsWith("/task_123"))!;
  assert.equal(poll.method, "GET");
  assert.equal(poll.url, DEFAULT_BASE + ENDPOINT + "/task_123");

  const d = await handle(post({ action: "status", projectId: P, operation: sb.operation }), ENV, { fetch: n.fetch });
  const db = await d.json();
  assert.equal(d.status, 200);
  assert.equal(db.status, "completed");
  assert.equal(db.id, await videoPath(UID, P, "task_123"));
  assert.equal(db.size, MP4.length);
  assert.equal(db.duration, 5.1);
  const up = n.seen.find((x) => x.url.includes("/storage/v1/object/lodging-reels/"))!;
  assert.equal(up.method, "POST");
  assert.ok(up.url.endsWith("/" + db.id));
  assert.equal(up.headers.Authorization, "Bearer user-jwt", "stored with the user's own token");
  assert.equal(up.headers.apikey, "anon");
  assert.equal(up.headers["x-upsert"], "true");
  assert.equal(up.headers["Content-Type"], "video/mp4");
});

Deno.test("Kling errors become readable messages; failed task stops", async () => {
  const cases: [Response, number, string][] = [
    [json({ code: 1002, message: "Authorization is invalid" }, 401), 502, "kling_auth"],
    [json({ code: 1102, message: "Account balance not enough" }, 429), 402, "kling_account"],
    [json({ code: 1303, message: "parallel task over resource pack limit" }, 429), 429, "rate_limited"],
    [json({ code: 1201, message: "image_list invalid" }, 400), 400, "kling_rejected"],
    [json({ code: 5000, message: "server error" }, 500), 502, "upstream_error"],
  ];
  for (const [res, http, code] of cases) {
    const n = net([["/auth/v1/user", user], [ENDPOINT, () => res.clone()]]);
    const r = await handle(post(START), ENV, { fetch: n.fetch });
    const b = await r.json();
    assert.equal(r.status, http, code);
    assert.equal(b.error, code);
    assert.ok(b.message.includes(((await res.clone().json()) as { message: string }).message), "Kling's own message is kept");
    assert.equal(n.seen.filter((x) => x.url.includes(ENDPOINT)).length, 1, "start is never retried");
  }
  const n = net([["/auth/v1/user", user],
    [ENDPOINT, () => json({ code: 0, data: { task_id: "t9", task_status: "failed", task_status_msg: "content risk" } })]]);
  const f = await handle(post({ action: "status", projectId: P, operation: { taskId: "t9" } }), ENV, { fetch: n.fetch });
  assert.deepEqual(await f.json(), { status: "error", message: "content risk" });
});

Deno.test("login, key, preflight, action", async () => {
  const n = net([["/auth/v1/user", user]]);
  assert.equal((await handle(post(START, "Bearer nope"), ENV, { fetch: n.fetch })).status, 401);
  const nk = await handle(post(START), { ...ENV, klingKey: "" }, { fetch: n.fetch });
  assert.equal(nk.status, 500);
  assert.equal((await nk.json()).error, "no_key");
  const pre = await handle(new Request("https://x/f", { method: "OPTIONS" }), ENV);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers") || "", /authorization, apikey, content-type/);
  assert.equal((await (await handle(post({ action: "nope" }), ENV, { fetch: n.fetch })).json()).error, "bad_action");
  const base = net([["/auth/v1/user", user], [ENDPOINT, () => json({ code: 0, data: { task_id: "t1" } })]]);
  await handle(post(START), { ...ENV, klingBase: "https://api.klingai.com/" }, { fetch: base.fetch });
  assert.ok(base.seen.some((x) => x.url === "https://api.klingai.com" + ENDPOINT), "KLINGAI_API_BASE overrides the host");
});
