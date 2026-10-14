// ⑨ 영상화 + 요소(Element) — Kling 3.0 Omni 를 Kling 공식 API 로 직접 부른다.
// Supabase Edge Function `lodging-reels-clip` 의 본체. index.ts 는 환경변수만 넘겨준다.
//
// Deno 전용 API 를 쓰지 않는다(Request / Response / fetch / crypto 만). 설정은 env 로 받는다.
// 그래서 tests/clip-function.test.ts 가 가짜 네트워크로 그대로 돌린다.
//
// 근거: Kling 공식 문서(markdown 판)
//   영상  https://kling.ai/document-api/api/video/3-0-omni/video-omni.md
//         POST /omni-video/kling-3.0-omni   { contents[], settings{}, options{} }
//         GET  /tasks?task_ids=<id>          data[].status / outputs[]
//   요소  https://kling.ai/document-api/api/video/3-0-omni/elements.md
//         POST /v1/general/advanced-custom-elements          (비동기 작업)
//         GET  /v1/general/advanced-custom-elements/{id}     task_result.elements[].element_id
//         POST /v1/general/delete-advanced-elements          { element_id }
//   인증  Authorization: Bearer <API Key>   도메인 https://api-singapore.klingai.com
//
// 왜 start → status 두 번에 나누나:
//   Kling 영상·요소 등록은 시간이 걸린다. Edge Function 요청은 그만큼 붙잡고 있을 수 없다.
//   start 는 작업만 걸고 작업 번호를 바로 돌려준다. 브라우저가 그걸 프로젝트에 저장하고 몇 초마다 확인한다.
//   영상이 끝나면 이 함수가 영상을 받아 사용자 Storage 폴더에 올린다.
//
// 프롬프트에서 입력물은 @id 로 가리킨다. id 는 이 함수가 붙인다:
//   image_1 가공 사진, image_2 원본, image_3~ 그 사진의 레퍼런스, element_1~ 요소.

export const VIDEO_PATH = "/omni-video/kling-3.0-omni";
export const TASKS_PATH = "/tasks";
export const ELEMENTS_PATH = "/v1/general/advanced-custom-elements";
export const ELEMENT_DELETE_PATH = "/v1/general/delete-advanced-elements";
export const RESOLUTION = "1080p";            // Kling 3.0 Pro 화질
export const ASPECT = "9:16";                 // 릴스 세로 화면
export const MIN_DURATION = 3;                // Kling 3.0 은 3~15초 정수. 사진마다 따로 적는다.
export const MAX_DURATION = 15;
export const DEFAULT_DURATION = 5;            // 길이를 비워 보내면
export const MAX_INPUTS = 7;                  // 레퍼런스 이미지 + 요소 합계 (영상 입력이 없을 때)
export const MAX_PROMPT = 2500;               // Kling 권장 한도
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // lodging-reels 버킷 파일 한도 50MB
export const ELEMENT_NAME_MAX = 20;
export const ELEMENT_DESC_MAX = 100;
export const ELEMENT_ANGLES_MAX = 3;          // 정면 1 + 다른 각도 1~3
export const DEFAULT_BASE = "https://api-singapore.klingai.com";
const BUCKET = "lodging-reels";
const KLING_TIMEOUT_MS = 30000;
const VIDEO_FETCH_TIMEOUT_MS = 60000;
const STORE_TIMEOUT_MS = 60000;

const IMG_EXT = /\.(jpe?g|png)$/i;            // Kling 은 jpg/png 만 받는다
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ELEMENT_ID = /^\d{1,24}$/;

export type Env = {
  klingKey?: string;        // KLINGAI_API_KEY — Bearer 로 그대로 보낸다
  klingBase?: string;       // KLINGAI_API_BASE — 비우면 싱가포르(글로벌)
  supabaseUrl?: string;     // SUPABASE_URL
  anonKey?: string;         // SUPABASE_ANON_KEY
  allowedOrigins?: string;  // ALLOWED_ORIGINS — 다른 lodging-reels 함수와 같은 규칙
};
export type Deps = { fetch?: typeof fetch };

type Fail = { error: string; message: string };
export type StartInput = {
  projectId: string;
  images: string[];         // 가공 → 원본 → 레퍼런스 (Storage 경로)
  elements: string[];       // Kling element_id
  prompt: string;
  duration: number;
};
export type ElementInput = {
  projectId: string;
  name: string;
  desc: string;
  front: string;
  angles: string[];
};

function fail(error: string, message: string): Fail {
  return { error, message };
}

// 남의 폴더나 임의 URL 을 Kling 이 가져가게 두지 않는다. 경로는 uid/projId/kind/file.ext.
export function checkPath(path: unknown, uid: string, kinds: string[]): path is string {
  if (typeof path !== "string" || !path) return false;
  if (path.length > 300 || path.includes("..") || path.includes("\\")) return false;
  const parts = path.split("/");
  if (parts.length !== 4) return false;
  if (parts[0] !== uid) return false;
  if (!PROJECT_ID.test(parts[1])) return false;
  if (!kinds.includes(parts[2])) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(parts[3]) || !IMG_EXT.test(parts[3])) return false;
  return true;
}

export function publicUrl(supabaseUrl: string, path: string): string {
  return supabaseUrl + "/storage/v1/object/public/" + BUCKET + "/" +
    path.split("/").map(encodeURIComponent).join("/");
}

function projectOf(b: Record<string, unknown>): string | null {
  const p = b.projectId;
  return typeof p === "string" && PROJECT_ID.test(p) ? p : null;
}

// ---------- 영상 ----------

// start 요청 검사. 이미지 순서는 가공 사진 → 원본 → 그 사진의 레퍼런스, 그 뒤에 요소.
export function validateStart(body: unknown, uid: string): StartInput | Fail {
  if (!body || typeof body !== "object") return fail("bad_json", "요청을 읽지 못했어요.");
  const b = body as Record<string, unknown>;
  const projectId = projectOf(b);
  if (!projectId) return fail("bad_project", "숙소 id 가 올바르지 않아요.");
  const inProject = (p: string) => p.split("/")[1] === projectId;
  if (!checkPath(b.edited, uid, ["edited"]) || !inProject(b.edited)) {
    return fail("bad_edited", "가공 사진 경로가 올바르지 않아요. 사진을 먼저 만들어주세요.");
  }
  if (!checkPath(b.original, uid, ["photo"]) || !inProject(b.original)) {
    return fail("bad_original", "원본 사진 경로가 올바르지 않아요.");
  }
  const refs = Array.isArray(b.refs) ? b.refs : [];
  for (const r of refs) {
    // 프롬프트의 1장짜리/미등록 요소는 사용자 본인의 element 폴더 사진으로 참조할 수 있다.
    if (!checkPath(r, uid, ["ref", "element"]) || !inProject(r)) return fail("bad_ref", "레퍼런스 경로가 올바르지 않아요.");
  }
  const rawElements = Array.isArray(b.elements) ? b.elements : [];
  const elements: string[] = [];
  for (const e of rawElements) {
    const id = String(e ?? "");
    if (!ELEMENT_ID.test(id)) return fail("bad_element", "요소 번호가 올바르지 않아요.");
    if (!elements.includes(id)) elements.push(id);
  }
  const images = [b.edited, b.original, ...refs] as string[];
  if (images.length + elements.length > MAX_INPUTS) {
    return fail("too_many_inputs", "영상 이미지·요소는 합쳐서 " + MAX_INPUTS + "개까지예요 (지금 " + (images.length + elements.length) + "개).");
  }
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt) return fail("empty_prompt", "영상화 프롬프트가 비었어요.");
  if (prompt.length > MAX_PROMPT) {
    return fail("too_long", "영상화 프롬프트가 너무 길어요 (앞 문장 포함 " + prompt.length + "자, 최대 " + MAX_PROMPT + "자).");
  }
  // 비워 보내면 5초. 적었는데 3~15 정수가 아니면 거부한다(조용히 바꾸면 요금이 예상과 달라진다).
  let duration = DEFAULT_DURATION;
  if (b.duration !== undefined && b.duration !== null && String(b.duration).trim() !== "") {
    const d = Number(b.duration);
    if (!Number.isInteger(d) || d < MIN_DURATION || d > MAX_DURATION) {
      return fail("bad_duration", "영상 길이는 " + MIN_DURATION + "~" + MAX_DURATION + "초 사이 정수여야 해요.");
    }
    duration = d;
  }
  return { projectId, images, elements, prompt, duration };
}

// Kling omni-video 작업 생성 본문. refer_image 는 레퍼런스(첫 프레임 고정 아님).
export function createBody(v: StartInput, supabaseUrl: string): Record<string, unknown> {
  return {
    contents: [
      { type: "prompt", text: v.prompt },
      ...v.images.map((p, i) => ({ type: "refer_image", url: publicUrl(supabaseUrl, p), id: "image_" + (i + 1) })),
      ...v.elements.map((e, i) => ({ type: "element", element_id: e, id: "element_" + (i + 1) })),
    ],
    settings: {
      resolution: RESOLUTION,
      aspect_ratio: ASPECT,
      duration: v.duration,
      audio: "off",           // 릴스는 TTS 를 따로 깐다
      multi_shot: false,      // 사진 한 장 → 한 컷
    },
  };
}

export function validateTask(body: unknown): { projectId: string; taskId: string } | Fail {
  if (!body || typeof body !== "object") return fail("bad_json", "요청을 읽지 못했어요.");
  const b = body as Record<string, unknown>;
  const projectId = projectOf(b);
  if (!projectId) return fail("bad_project", "숙소 id 가 올바르지 않아요.");
  const op = b.operation as Record<string, unknown> | null | undefined;
  const taskId = op && typeof op === "object" ? op.taskId : undefined;
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) {
    return fail("bad_operation", "작업 정보가 올바르지 않아요.");
  }
  return { projectId, taskId };
}

// 같은 작업은 늘 같은 파일 이름. 완료 확인이 두 번 와도 파일이 하나만 남는다.
export async function videoPath(uid: string, projectId: string, taskId: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kling:" + taskId));
  const hex = Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
  return uid + "/" + projectId + "/video/v" + hex.slice(0, 24) + ".mp4";
}

// ---------- 요소 ----------

const RESERVED = /^(원본|가공|삭제됨|레퍼런스\s*\d+)$/;

// 요소 등록 요청 검사. 정면 1장 + 다른 각도 1~3장, 모두 이 숙소의 element 폴더.
export function validateElement(body: unknown, uid: string): ElementInput | Fail {
  if (!body || typeof body !== "object") return fail("bad_json", "요청을 읽지 못했어요.");
  const b = body as Record<string, unknown>;
  const projectId = projectOf(b);
  if (!projectId) return fail("bad_project", "숙소 id 가 올바르지 않아요.");
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return fail("bad_name", "요소 이름이 비었어요.");
  if (name.length > ELEMENT_NAME_MAX) return fail("bad_name", "요소 이름은 " + ELEMENT_NAME_MAX + "자까지예요.");
  if (/[\[\]@]/.test(name) || RESERVED.test(name)) return fail("bad_name", "쓸 수 없는 요소 이름이에요.");
  // Kling 고정 요소 등록 API는 description 필수. 앱 입력은 선택사항이라 이름으로 기본값을 채운다.
  const typedDesc = typeof b.desc === "string" ? b.desc.trim() : "";
  const desc = typedDesc || name;
  if (desc.length > ELEMENT_DESC_MAX) return fail("bad_desc", "요소 설명은 " + ELEMENT_DESC_MAX + "자까지예요.");
  const inProject = (p: string) => p.split("/")[1] === projectId;
  if (!checkPath(b.front, uid, ["element"]) || !inProject(b.front)) return fail("bad_front", "정면 사진 경로가 올바르지 않아요.");
  const angles = Array.isArray(b.angles) ? b.angles : [];
  if (angles.length < 1 || angles.length > ELEMENT_ANGLES_MAX) {
    return fail("bad_angles", "다른 각도 사진은 1~" + ELEMENT_ANGLES_MAX + "장이어야 해요.");
  }
  for (const a of angles) {
    if (!checkPath(a, uid, ["element"]) || !inProject(a) || a === b.front) {
      return fail("bad_angles", "다른 각도 사진 경로가 올바르지 않아요.");
    }
  }
  return { projectId, name, desc, front: b.front, angles: angles as string[] };
}

export function elementBody(v: ElementInput, supabaseUrl: string): Record<string, unknown> {
  return {
    element_name: v.name,
    element_description: v.desc,
    reference_type: "image_refer",
    element_image_list: {
      frontal_image: publicUrl(supabaseUrl, v.front),
      refer_images: v.angles.map((p) => ({ image_url: publicUrl(supabaseUrl, p) })),
    },
  };
}

// ---------- 공통 ----------

function withTimeout(ms: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

// Kling 응답은 { code, message, request_id, data }. code 0 이 성공이다.
type KlingReply = { http: number; json: Record<string, unknown> | null; text: string };

async function callKling(env: Env, deps: Deps, method: string, path: string, body?: unknown): Promise<KlingReply> {
  const t = withTimeout(KLING_TIMEOUT_MS);
  try {
    const r = await (deps.fetch || fetch)((env.klingBase || DEFAULT_BASE).replace(/\/+$/, "") + path, {
      method,
      headers: {
        Authorization: "Bearer " + env.klingKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: t.signal,
    });
    const text = await r.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { http: r.status, json, text };
  } finally {
    t.done();
  }
}

// Kling 오류를 화면에 보여줄 말로. 원문 message 는 그대로 덧붙인다.
export function klingError(reply: KlingReply): { http: number; body: Fail } {
  const code = Number(reply.json && reply.json.code);
  const raw = String((reply.json && reply.json.message) || reply.text || "").slice(0, 300);
  const detail = raw ? " (" + raw + ")" : "";
  if (reply.http === 401 || reply.http === 403 || (code >= 1000 && code <= 1004)) {
    return { http: 502, body: fail("kling_auth", "Kling API 키가 거부됐어요. Supabase Secret KLINGAI_API_KEY 를 확인해주세요." + detail) };
  }
  if (code >= 1100 && code <= 1103) {
    return { http: 402, body: fail("kling_account", "Kling 계정 잔액·이용권을 확인해주세요." + detail) };
  }
  if (reply.http === 429 || code === 1302 || code === 1303) {
    return { http: 429, body: fail("rate_limited", "Kling 동시 작업·요청 한도에 걸렸어요. 잠시 뒤 다시 해주세요." + detail) };
  }
  if (reply.http === 400 || (code >= 1200 && code < 1300)) {
    return { http: 400, body: fail("kling_rejected", "Kling 이 요청을 거부했어요." + detail) };
  }
  return { http: 502, body: fail("upstream_error", "Kling 응답 오류예요 (HTTP " + reply.http + ")." + detail) };
}

function klingOk(reply: KlingReply): boolean {
  return reply.http >= 200 && reply.http < 300 && !!reply.json && Number(reply.json.code) === 0 &&
    reply.json.data !== undefined && reply.json.data !== null;
}

// 영상 바이트. 50MB 를 넘으면 끊는다.
export async function readVideo(url: string, deps: Deps): Promise<Uint8Array> {
  const t = withTimeout(VIDEO_FETCH_TIMEOUT_MS);
  try {
    const r = await (deps.fetch || fetch)(url, { signal: t.signal });
    if (!r.ok) throw new Error("video_download_" + r.status);
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > MAX_VIDEO_BYTES) throw new Error("video_too_large");
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length) throw new Error("video_empty");
    if (buf.length > MAX_VIDEO_BYTES) throw new Error("video_too_large");
    return buf;
  } finally {
    t.done();
  }
}

// 사용자 토큰으로 사용자 폴더에 올린다. Storage 정책이 자기 uid 폴더만 허용한다.
export async function storeVideo(env: Env, deps: Deps, auth: string, path: string, bytes: Uint8Array): Promise<void> {
  const t = withTimeout(STORE_TIMEOUT_MS);
  try {
    const r = await (deps.fetch || fetch)(env.supabaseUrl + "/storage/v1/object/" + BUCKET + "/" + path, {
      method: "POST",
      headers: { Authorization: auth, apikey: env.anonKey || "", "Content-Type": "video/mp4", "x-upsert": "true" },
      // TS 버전에 따라 Uint8Array 제네릭 판정이 달라서 BodyInit 로 맞춘다(런타임 동작은 같다).
      body: bytes as unknown as BodyInit,
      signal: t.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error("store_" + r.status + " " + text.slice(0, 160));
    }
  } finally {
    t.done();
  }
}

export function cors(req: Request, env: Env): Record<string, string> {
  const origins = (env.allowedOrigins || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const allow = origins.includes("*") ? "*" : (origins.includes(origin) ? origin : "");
  return {
    "Access-Control-Allow-Origin": allow || "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(req: Request, env: Env, status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(req, env), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// 로그인한 사용자만. verify_jwt 는 anon 키도 통과시켜서, 토큰을 Supabase Auth 에 되물어 확인한다.
async function whoIs(env: Env, deps: Deps, auth: string): Promise<string | null> {
  if (!auth.toLowerCase().startsWith("bearer ") || !env.supabaseUrl || !env.anonKey) return null;
  try {
    const r = await (deps.fetch || fetch)(env.supabaseUrl + "/auth/v1/user", {
      headers: { Authorization: auth, apikey: env.anonKey },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? String(u.id) : null;
  } catch {
    return null;
  }
}

// Kling 호출 + 실패 응답. 성공이면 null 이 아닌 reply 를 돌려준다.
async function kling(
  req: Request, env: Env, deps: Deps, label: string, method: string, path: string, body?: unknown,
): Promise<{ ok: KlingReply } | { res: Response }> {
  let k: KlingReply;
  try {
    k = await callKling(env, deps, method, path, body);
  } catch (e) {
    console.error("lodging-reels-clip " + label + " unreachable", { reason: String(e).slice(0, 200) });
    return { res: reply(req, env, 502, fail("upstream_unreachable", "Kling 에 연결하지 못했어요.")) };
  }
  if (!klingOk(k)) {
    const e = klingError(k);
    console.error("lodging-reels-clip " + label + " failure", { http: k.http, code: k.json && k.json.code, body: k.text.slice(0, 400) });
    return { res: reply(req, env, e.http, e.body) };
  }
  return { ok: k };
}

export async function handle(req: Request, env: Env, deps: Deps = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, env) });
  if (req.method !== "POST") return reply(req, env, 405, fail("method", "POST 만 받아요."));

  const auth = req.headers.get("Authorization") || "";
  const uid = await whoIs(env, deps, auth);
  if (!uid) return reply(req, env, 401, fail("unauthorized", "로그인이 필요해요."));
  if (!env.klingKey) {
    return reply(req, env, 500, fail("no_key", "Supabase Secret KLINGAI_API_KEY 가 없어요."));
  }

  let body: Record<string, unknown> | null = null;
  try { body = await req.json(); } catch { body = null; }
  const action = body && body.action;

  // ----- 영상 만들기 -----
  if (action === "start") {
    const v = validateStart(body, uid);
    if ("error" in v) return reply(req, env, 400, v);
    const t0 = Date.now();
    const k = await kling(req, env, deps, "start", "POST", VIDEO_PATH, createBody(v, env.supabaseUrl || ""));
    if ("res" in k) return k.res;
    const data = k.ok.json!.data as Record<string, unknown>;
    const id = data && data.id !== undefined ? String(data.id) : "";
    if (!TASK_ID.test(id)) return reply(req, env, 502, fail("no_task", "Kling 이 작업 번호를 주지 않았어요."));
    console.log("lodging-reels-clip started", {
      path: VIDEO_PATH, images: v.images.length, elements: v.elements.length, duration: v.duration,
      ms: Date.now() - t0, task: id, request_id: k.ok.json!.request_id,
    });
    return reply(req, env, 200, {
      operation: { taskId: id }, resolution: RESOLUTION, aspect: ASPECT,
      duration: v.duration, images: v.images.length, elements: v.elements.length,
    });
  }

  // ----- 영상 확인 -----
  if (action === "status") {
    const v = validateTask(body);
    if ("error" in v) return reply(req, env, 400, v);
    const k = await kling(req, env, deps, "status", "GET", TASKS_PATH + "?task_ids=" + encodeURIComponent(v.taskId));
    if ("res" in k) return k.res;
    const list = k.ok.json!.data;
    const tasks = Array.isArray(list) ? list as Record<string, unknown>[] : [];
    const task = tasks.find((t) => t && String(t.id) === v.taskId) || tasks[0];
    if (!task) return reply(req, env, 502, fail("no_task", "Kling 에서 작업을 찾지 못했어요."));
    const st = String(task.status || "");
    if (st === "submitted" || st === "processing") return reply(req, env, 200, { status: "pending", kling: st });
    if (st === "failed") {
      const msg = String(task.message || "영상 생성에 실패했어요.").slice(0, 400);
      console.error("lodging-reels-clip task failed", { task: v.taskId, msg });
      return reply(req, env, 200, { status: "error", message: msg });
    }
    if (st !== "succeeded") return reply(req, env, 502, fail("bad_status", "알 수 없는 작업 상태예요: " + st.slice(0, 40)));

    const outputs = Array.isArray(task.outputs) ? task.outputs as Record<string, unknown>[] : [];
    const first = outputs.find((x) => x && x.type === "video" && typeof x.url === "string") ||
      outputs.find((x) => x && typeof x.url === "string");
    if (!first) return reply(req, env, 502, fail("no_video", "완료됐다는데 영상 주소가 없어요."));

    const t0 = Date.now();
    let bytes: Uint8Array;
    try {
      bytes = await readVideo(String(first.url), deps);
    } catch (e) {
      const big = /too_large/.test(String(e));
      console.error("lodging-reels-clip download failure", { reason: String(e).slice(0, 200) });
      return reply(req, env, 502, fail(
        big ? "too_large" : "download_failed",
        big ? "영상이 50MB 를 넘어서 저장하지 못했어요. 길이를 줄여 다시 만들어주세요."
            : "완성된 영상을 받아오지 못했어요. 잠시 뒤 다시 확인할게요.",
      ));
    }
    const path = await videoPath(uid, v.projectId, v.taskId);
    try {
      await storeVideo(env, deps, auth, path, bytes);
    } catch (e) {
      console.error("lodging-reels-clip store failure", { reason: String(e).slice(0, 240) });
      return reply(req, env, 502, fail("store_failed", "영상을 저장하지 못했어요. 저장 공간을 확인해주세요."));
    }
    console.log("lodging-reels-clip stored", { task: v.taskId, bytes: bytes.length, ms: Date.now() - t0 });
    return reply(req, env, 200, {
      status: "completed", id: path, size: bytes.length, mime: "video/mp4",
      duration: first.duration ? Number(first.duration) : null,
    });
  }

  // ----- 요소 등록 -----
  if (action === "element_create") {
    const v = validateElement(body, uid);
    if ("error" in v) return reply(req, env, 400, v);
    const k = await kling(req, env, deps, "element_create", "POST", ELEMENTS_PATH, elementBody(v, env.supabaseUrl || ""));
    if ("res" in k) return k.res;
    const data = k.ok.json!.data as Record<string, unknown>;
    const id = data && data.task_id !== undefined ? String(data.task_id) : "";
    if (!TASK_ID.test(id)) return reply(req, env, 502, fail("no_task", "Kling 이 등록 작업 번호를 주지 않았어요."));
    console.log("lodging-reels-clip element started", { task: id, angles: v.angles.length });
    return reply(req, env, 200, { operation: { taskId: id } });
  }

  // ----- 요소 등록 확인 -----
  if (action === "element_status") {
    const v = validateTask(body);
    if ("error" in v) return reply(req, env, 400, v);
    const k = await kling(req, env, deps, "element_status", "GET", ELEMENTS_PATH + "/" + encodeURIComponent(v.taskId));
    if ("res" in k) return k.res;
    const data = k.ok.json!.data as Record<string, unknown>;
    const st = String((data && data.task_status) || "");
    if (st === "submitted" || st === "processing") return reply(req, env, 200, { status: "pending", kling: st });
    if (st === "failed") {
      const msg = String(data.task_status_msg || "요소 등록에 실패했어요.").slice(0, 400);
      console.error("lodging-reels-clip element failed", { task: v.taskId, msg });
      return reply(req, env, 200, { status: "error", message: msg });
    }
    if (st !== "succeed") return reply(req, env, 502, fail("bad_status", "알 수 없는 등록 상태예요: " + st.slice(0, 40)));
    const result = data.task_result as Record<string, unknown> | undefined;
    const els = result && Array.isArray(result.elements) ? result.elements as Record<string, unknown>[] : [];
    const el = els.find((x) => x && x.element_id !== undefined && x.element_id !== null);
    const elementId = el ? String(el.element_id) : "";
    if (!ELEMENT_ID.test(elementId)) return reply(req, env, 502, fail("no_element", "등록은 끝났는데 요소 번호가 없어요."));
    console.log("lodging-reels-clip element ready", { task: v.taskId, element: elementId });
    return reply(req, env, 200, { status: "ready", elementId });
  }

  // ----- 요소 지우기 (Kling 쪽, 실패해도 화면 쪽 삭제는 그대로) -----
  if (action === "element_delete") {
    const id = String((body && body.elementId) ?? "");
    if (!ELEMENT_ID.test(id)) return reply(req, env, 400, fail("bad_element", "요소 번호가 올바르지 않아요."));
    const k = await kling(req, env, deps, "element_delete", "POST", ELEMENT_DELETE_PATH, { element_id: id });
    if ("res" in k) return k.res;
    return reply(req, env, 200, { ok: true });
  }

  return reply(req, env, 400, fail("bad_action", "action 은 start · status · element_create · element_status · element_delete 중 하나여야 해요."));
}
