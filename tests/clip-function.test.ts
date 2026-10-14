// ⑨ 영상화 + 요소 Edge Function(supabase/functions/lodging-reels-clip) 검사. Deno 로 돌린다:
//   deno test --no-check tests/clip-function.test.ts
// 실제 Kling 호출은 하지 않는다(돈이 든다). 네트워크는 전부 가짜.
// 요청·응답 모양은 Kling 공식 문서(video-omni.md / elements.md) 그대로다.
import assert from "node:assert/strict";
import {
  ASPECT, checkPath, createBody, DEFAULT_BASE, elementBody, ELEMENT_DELETE_PATH, ELEMENTS_PATH, handle,
  MAX_DURATION, MAX_INPUTS, MAX_PROMPT, MAX_VIDEO_BYTES, MIN_DURATION, publicUrl, readVideo, RESOLUTION,
  TASKS_PATH, validateElement, validateStart, validateTask, VIDEO_PATH, videoPath,
} from "../supabase/functions/lodging-reels-clip/clip.ts";

const UID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const P = "pabc123";
const SUPA = "https://kfgtvifupumjuewwxzmz.supabase.co";
const EDITED = `${UID}/${P}/edited/e1.jpg`;
const ORIGINAL = `${UID}/${P}/photo/o1.jpg`;
const REF = (n: number) => `${UID}/${P}/ref/r${n}.jpg`;
const EL = (n: number) => `${UID}/${P}/element/x${n}.jpg`;
const START = { action: "start", projectId: P, edited: EDITED, original: ORIGINAL, refs: [REF(1)], elements: [], prompt: "@image_1 장면", duration: 5 };
const ELEMENT = { action: "element_create", projectId: P, name: "아이", desc: "7세 여자아이, 단발머리", front: EL(1), angles: [EL(2), EL(3)] };
const ENV = { klingKey: "TEST_ONLY_KLING_KEY", supabaseUrl: SUPA, anonKey: "anon", allowedOrigins: "*" };

const err = (v: unknown) => (v && typeof v === "object" && "error" in v ? (v as { error: string }).error : null);

Deno.test("paths: only the caller's own edited/photo/ref jpg·png files in one project", () => {
  assert.equal(checkPath(EDITED, UID, ["edited"]), true);
  assert.equal(checkPath(`${OTHER}/${P}/edited/e1.jpg`, UID, ["edited"]), false);
  assert.equal(checkPath(`${UID}/${P}/edited/e1.webp`, UID, ["edited"]), false, "Kling takes jpg/png only");
  assert.equal(checkPath(`${UID}/../x/edited/e1.jpg`, UID, ["edited"]), false);
  assert.equal(checkPath("https://evil.example/a.jpg", UID, ["edited"]), false);
  const ok = validateStart(START, UID);
  assert.equal(err(ok), null);
  if (!("error" in ok)) assert.deepEqual(ok.images, [EDITED, ORIGINAL, REF(1)], "image_1 edited, image_2 original, image_3 ref");
  assert.equal(err(validateStart({ ...START, edited: ORIGINAL }, UID)), "bad_edited");
  assert.equal(err(validateStart({ ...START, original: EDITED }, UID)), "bad_original");
  assert.equal(err(validateStart({ ...START, refs: [ORIGINAL] }, UID)), "bad_ref");
  assert.equal(err(validateStart({ ...START, refs: [EL(1)] }, UID)), "bad_ref", "element photos go in as elements, not images");
  assert.equal(err(validateStart({ ...START, refs: [`${UID}/pother/ref/r1.jpg`] }, UID)), "bad_ref", "other project");
  assert.equal(err(validateStart({ ...START, projectId: "a/b" }, UID)), "bad_project");
  assert.equal(err(validateStart({ ...START, elements: ["12a"] }, UID)), "bad_element");
});

Deno.test("limits: images + elements ≤ 7, 2500 chars, any whole 3-15 s per video", () => {
  assert.equal(MAX_INPUTS, 7);
  assert.equal(err(validateStart({ ...START, refs: [1, 2, 3].map(REF), elements: ["11", "12"] }, UID)), null, "3 images + 2 refs + 2 elements = 7");
  assert.equal(err(validateStart({ ...START, refs: [1, 2, 3].map(REF), elements: ["11", "12", "13"] }, UID)), "too_many_inputs");
  assert.equal(err(validateStart({ ...START, refs: [1, 2, 3, 4, 5, 6].map(REF) }, UID)), "too_many_inputs");
  const dup = validateStart({ ...START, elements: ["11", 11, "11"] }, UID);
  if (!("error" in dup)) assert.deepEqual(dup.elements, ["11"], "same element counted once");
  assert.equal(err(validateStart({ ...START, prompt: "  " }, UID)), "empty_prompt");
  assert.equal(err(validateStart({ ...START, prompt: "가".repeat(MAX_PROMPT + 1) }, UID)), "too_long");
  const d = (x: unknown) => { const v = validateStart({ ...START, duration: x }, UID); return "error" in v ? v.error : v.duration; };
  assert.equal(MIN_DURATION, 3);
  assert.equal(MAX_DURATION, 15);
  assert.equal(d(3), 3);
  assert.equal(d(7), 7);
  assert.equal(d("12"), 12);
  assert.equal(d(undefined), 5, "blank → 5 s");
  assert.equal(d(""), 5);
  assert.equal(d(2), "bad_duration");
  assert.equal(d(16), "bad_duration");
  assert.equal(d(4.5), "bad_duration");
});

Deno.test("create body: official omni format — contents/settings, refer_image ids, element items, 1080p 9:16 single shot", () => {
  const v = validateStart({ ...START, refs: [REF(1), REF(2)], elements: ["162", "999"], duration: 7 }, UID);
  assert.equal(err(v), null);
  if ("error" in v) return;
  const b = createBody(v, SUPA) as { contents: Record<string, unknown>[]; settings: Record<string, unknown> };
  assert.deepEqual(b.contents[0], { type: "prompt", text: "@image_1 장면" });
  assert.deepEqual(b.contents.slice(1, 5), [EDITED, ORIGINAL, REF(1), REF(2)].map((p, i) =>
    ({ type: "refer_image", url: publicUrl(SUPA, p), id: "image_" + (i + 1) })));
  assert.deepEqual(b.contents.slice(5), [
    { type: "element", element_id: "162", id: "element_1" },
    { type: "element", element_id: "999", id: "element_2" },
  ]);
  assert.ok(!b.contents.some((c) => c.type === "first_frame"), "reference, not first frame");
  assert.deepEqual(b.settings, { resolution: "1080p", aspect_ratio: "9:16", duration: 7, audio: "off", multi_shot: false });
  assert.equal(RESOLUTION, "1080p");
  assert.equal(ASPECT, "9:16");
  assert.equal(VIDEO_PATH, "/omni-video/kling-3.0-omni");
});

Deno.test("element create: name/desc limits, front + 1-3 angles in the project's element folder", () => {
  const ok = validateElement(ELEMENT, UID);
  assert.equal(err(ok), null);
  if (!("error" in ok)) {
    assert.deepEqual(elementBody(ok, SUPA), {
      element_name: "아이",
      element_description: "7세 여자아이, 단발머리",
      reference_type: "image_refer",
      element_image_list: {
        frontal_image: publicUrl(SUPA, EL(1)),
        refer_images: [{ image_url: publicUrl(SUPA, EL(2)) }, { image_url: publicUrl(SUPA, EL(3)) }],
      },
    });
  }
  const e = (b: unknown) => err(validateElement(b, UID));
  assert.equal(e({ ...ELEMENT, name: "가".repeat(21) }), "bad_name");
  assert.equal(e({ ...ELEMENT, name: "원본" }), "bad_name", "reserved");
  assert.equal(e({ ...ELEMENT, name: "레퍼런스2" }), "bad_name", "reserved");
  assert.equal(e({ ...ELEMENT, name: "[아이]" }), "bad_name");
  assert.equal(e({ ...ELEMENT, desc: "" }), "bad_desc");
  assert.equal(e({ ...ELEMENT, desc: "가".repeat(101) }), "bad_desc");
  assert.equal(e({ ...ELEMENT, angles: [] }), "bad_angles");
  assert.equal(e({ ...ELEMENT, angles: [EL(2), EL(3), EL(4), EL(5)] }), "bad_angles");
  assert.equal(e({ ...ELEMENT, angles: [EL(1)] }), "bad_angles", "angle must differ from front");
  assert.equal(e({ ...ELEMENT, front: REF(1) }), "bad_front", "element photos live in the element folder");
  assert.equal(e({ ...ELEMENT, front: `${UID}/pother/element/x1.jpg` }), "bad_front", "other project");
});

Deno.test("task input and result path", async () => {
  assert.equal(err(validateTask({ projectId: P })), "bad_operation");
  assert.equal(err(validateTask({ projectId: P, operation: { taskId: "../x" } })), "bad_operation", "no path injection");
  assert.equal(err(validateTask({ projectId: P, operation: { taskId: "893605946402811985" } })), null);
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

Deno.test("video: create → processing → succeeded, Bearer key, video stored in the user's folder", async () => {
  let polls = 0;
  const n = net([
    ["/auth/v1/user", user],
    [TASKS_PATH + "?task_ids=893605946402811985", () => (++polls === 1)
      ? json({ code: 0, message: "SUCCEED", data: [{ id: "893605946402811985", status: "processing", outputs: [] }] })
      : json({ code: 0, message: "SUCCEED", data: [{ id: "893605946402811985", status: "succeeded",
          outputs: [{ type: "video", id: "v1", url: "https://cdn.klingai.example/out.mp4", duration: "5.1" }] }] })],
    [VIDEO_PATH, () => json({ code: 0, message: "SUCCEED", request_id: "req1", data: { id: "893605946402811985", status: "submitted" } })],
    ["https://cdn.klingai.example/out.mp4", () => new Response(MP4, { headers: { "content-type": "video/mp4", "content-length": String(MP4.length) } })],
    ["/storage/v1/object/lodging-reels/", () => json({ Key: "ok" })],
  ]);
  const s = await handle(post({ ...START, elements: ["162"] }), ENV, { fetch: n.fetch });
  assert.equal(s.status, 200);
  assert.equal(s.headers.get("Access-Control-Allow-Origin"), "*");
  const sb = await s.json();
  assert.deepEqual(sb.operation, { taskId: "893605946402811985" });
  assert.equal(sb.elements, 1);
  const create = n.seen.find((x) => x.method === "POST" && x.url === DEFAULT_BASE + VIDEO_PATH);
  assert.ok(create, "POST " + DEFAULT_BASE + VIDEO_PATH);
  assert.equal(create!.headers.Authorization, "Bearer TEST_ONLY_KLING_KEY", "API key sent as-is as Bearer");
  const cb = create!.body as { contents: Record<string, unknown>[] };
  assert.deepEqual(cb.contents.at(-1), { type: "element", element_id: "162", id: "element_1" });

  const p = await handle(post({ action: "status", projectId: P, operation: sb.operation }), ENV, { fetch: n.fetch });
  assert.deepEqual(await p.json(), { status: "pending", kling: "processing" });
  assert.ok(!n.seen.some((x) => x.url.includes("/storage/")), "nothing stored while pending");
  const poll = n.seen.find((x) => x.url.includes(TASKS_PATH + "?"))!;
  assert.equal(poll.method, "GET");
  assert.equal(poll.url, DEFAULT_BASE + TASKS_PATH + "?task_ids=893605946402811985");

  const d = await handle(post({ action: "status", projectId: P, operation: sb.operation }), ENV, { fetch: n.fetch });
  const db = await d.json();
  assert.equal(d.status, 200);
  assert.equal(db.status, "completed");
  assert.equal(db.id, await videoPath(UID, P, "893605946402811985"));
  assert.equal(db.size, MP4.length);
  assert.equal(db.duration, 5.1);
  const up = n.seen.find((x) => x.url.includes("/storage/v1/object/lodging-reels/"))!;
  assert.equal(up.method, "POST");
  assert.ok(up.url.endsWith("/" + db.id));
  assert.equal(up.headers.Authorization, "Bearer user-jwt", "stored with the user's own token");
  assert.equal(up.headers["x-upsert"], "true");
  assert.equal(up.headers["Content-Type"], "video/mp4");
});

Deno.test("element: create → processing → succeed gives element_id; delete; failure message", async () => {
  let polls = 0;
  const n = net([
    ["/auth/v1/user", user],
    [ELEMENTS_PATH + "/el_task_1", () => (++polls === 1)
      ? json({ code: 0, data: { task_id: "el_task_1", task_status: "processing" } })
      : json({ code: 0, data: { task_id: "el_task_1", task_status: "succeed",
          task_result: { elements: [{ element_id: 834521, element_name: "아이", status: "succeed" }] } } })],
    [ELEMENTS_PATH, () => json({ code: 0, message: "SUCCEED", data: { task_id: "el_task_1", task_status: "submitted" } })],
    [ELEMENT_DELETE_PATH, () => json({ code: 0, data: { task_id: "d1", task_status: "succeed" } })],
  ]);
  const c = await handle(post(ELEMENT), ENV, { fetch: n.fetch });
  assert.deepEqual(await c.json(), { operation: { taskId: "el_task_1" } });
  const create = n.seen.find((x) => x.method === "POST" && x.url === DEFAULT_BASE + ELEMENTS_PATH)!;
  assert.equal((create.body as Record<string, unknown>).reference_type, "image_refer");
  assert.equal(create.headers.Authorization, "Bearer TEST_ONLY_KLING_KEY");

  const st = (op: unknown) => handle(post({ action: "element_status", projectId: P, operation: op }), ENV, { fetch: n.fetch }).then((r) => r.json());
  assert.deepEqual(await st({ taskId: "el_task_1" }), { status: "pending", kling: "processing" });
  assert.deepEqual(await st({ taskId: "el_task_1" }), { status: "ready", elementId: "834521" }, "numeric id comes back as a string");
  const q = n.seen.find((x) => x.url.endsWith(ELEMENTS_PATH + "/el_task_1"))!;
  assert.equal(q.method, "GET");

  const d = await handle(post({ action: "element_delete", elementId: "834521" }), ENV, { fetch: n.fetch });
  assert.deepEqual(await d.json(), { ok: true });
  const del = n.seen.find((x) => x.url === DEFAULT_BASE + ELEMENT_DELETE_PATH)!;
  assert.equal(del.method, "POST");
  assert.deepEqual(del.body, { element_id: "834521" });

  const f = net([["/auth/v1/user", user],
    [ELEMENTS_PATH, () => json({ code: 0, data: { task_id: "t9", task_status: "failed", task_status_msg: "content moderation" } })]]);
  const fr = await handle(post({ action: "element_status", projectId: P, operation: { taskId: "t9" } }), ENV, { fetch: f.fetch });
  assert.deepEqual(await fr.json(), { status: "error", message: "content moderation" });
});

Deno.test("Kling errors become readable messages; failed video task stops", async () => {
  const cases: [Response, number, string][] = [
    [json({ code: 1002, message: "Authorization is invalid" }, 401), 502, "kling_auth"],
    [json({ code: 1102, message: "Account balance not enough" }, 429), 402, "kling_account"],
    [json({ code: 1303, message: "parallel task over resource pack limit" }, 429), 429, "rate_limited"],
    [json({ code: 1201, message: "contents invalid" }, 400), 400, "kling_rejected"],
    [json({ code: 5000, message: "server error" }, 500), 502, "upstream_error"],
  ];
  for (const [res, http, code] of cases) {
    const n = net([["/auth/v1/user", user], [VIDEO_PATH, () => res.clone()]]);
    const r = await handle(post(START), ENV, { fetch: n.fetch });
    const b = await r.json();
    assert.equal(r.status, http, code);
    assert.equal(b.error, code);
    assert.ok(b.message.includes(((await res.clone().json()) as { message: string }).message), "Kling's own message is kept");
    assert.equal(n.seen.filter((x) => x.url.includes(VIDEO_PATH)).length, 1, "start is never retried");
  }
  const n = net([["/auth/v1/user", user],
    [TASKS_PATH, () => json({ code: 0, data: [{ id: "t9", status: "failed", message: "content risk" }] })]]);
  const f = await handle(post({ action: "status", projectId: P, operation: { taskId: "t9" } }), ENV, { fetch: n.fetch });
  assert.deepEqual(await f.json(), { status: "error", message: "content risk" });
});

Deno.test("login, key, preflight, action, base override", async () => {
  const n = net([["/auth/v1/user", user]]);
  assert.equal((await handle(post(START, "Bearer nope"), ENV, { fetch: n.fetch })).status, 401);
  const nk = await handle(post(START), { ...ENV, klingKey: "" }, { fetch: n.fetch });
  assert.equal(nk.status, 500);
  assert.equal((await nk.json()).error, "no_key");
  const pre = await handle(new Request("https://x/f", { method: "OPTIONS" }), ENV);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers") || "", /authorization, apikey, content-type/);
  assert.equal((await (await handle(post({ action: "nope" }), ENV, { fetch: n.fetch })).json()).error, "bad_action");
  assert.equal((await (await handle(post({ action: "element_delete", elementId: "x" }), ENV, { fetch: n.fetch })).json()).error, "bad_element");
  const base = net([["/auth/v1/user", user], [VIDEO_PATH, () => json({ code: 0, data: { id: "t1" } })]]);
  await handle(post(START), { ...ENV, klingBase: "https://api-beijing.klingai.com/" }, { fetch: base.fetch });
  assert.ok(base.seen.some((x) => x.url === "https://api-beijing.klingai.com" + VIDEO_PATH), "KLINGAI_API_BASE overrides the host");
});
