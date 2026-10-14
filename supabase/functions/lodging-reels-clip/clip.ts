// ⑨ 영상화 — Kling 3.0 (Omni, Pro) 를 Kling 공식 API 로 직접 부른다.
// Supabase Edge Function `lodging-reels-clip` 의 본체. index.ts 는 환경변수만 넘겨준다.
//
// Deno 전용 API 를 쓰지 않는다(Request / Response / fetch / crypto 만). 설정은 env 로 받는다.
// 그래서 tests/clip-function.test.ts 가 가짜 네트워크로 그대로 돌린다.
//
// 왜 start → status 두 번에 나누나:
//   Kling 영상은 몇 분씩 걸린다. Edge Function 요청은 그만큼 붙잡고 있을 수 없다.
//   start 는 Kling 에 작업만 걸고 task_id 를 바로 돌려준다. 브라우저가 그걸 프로젝트에 저장하고
//   status 를 몇 초마다 부른다. 끝나면 이 함수가 영상을 받아 사용자 Storage 폴더에 올린다.
//
// 왜 Kling 3.0 Omni 인가:
//   Kling 3.0 에서 레퍼런스 이미지 여러 장으로 영상을 만드는 건 Omni 모델(kling-v3-omni)만 된다.
//   mode "pro" 가 1080p(Pro). 이미지는 프롬프트에서 <<<image_1>>> 처럼 순서로 가리킨다.

export const MODEL = "kling-v3-omni";
export const MODE = "pro";
export const ASPECT = "9:16";                 // 릴스 세로 화면
export const MIN_DURATION = 3;               // Kling 3.0 은 3~15초 정수. 사진마다 따로 적는다.
export const MAX_DURATION = 15;
export const DEFAULT_DURATION = 5;            // 길이를 비워 보내면
export const MAX_INPUTS = 7;                  // Omni: 영상 입력 없이 이미지 최대 7장
export const MAX_PROMPT = 2500;               // Kling 프롬프트 한도
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // lodging-reels 버킷 파일 한도 50MB
export const DEFAULT_BASE = "https://api-singapore.klingai.com";
export const ENDPOINT = "/v1/videos/omni-video";
const BUCKET = "lodging-reels";
const KLING_TIMEOUT_MS = 30000;
const VIDEO_FETCH_TIMEOUT_MS = 60000;
const STORE_TIMEOUT_MS = 60000;

const IMG_EXT = /\.(jpe?g|png)$/i;            // Kling 은 jpg/png 만 받는다
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
  inputs: string[];
  prompt: string;
  duration: number;
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

// start 요청 검사. 이미지 순서는 가공 사진(1) → 원본(2) → 그 사진의 레퍼런스(3~).
// 프롬프트의 <<<image_N>>> 번호가 이 순서를 가리킨다.
export function validateStart(body: unknown, uid: string): StartInput | Fail {
  if (!body || typeof body !== "object") return fail("bad_json", "요청을 읽지 못했어요.");
  const b = body as Record<string, unknown>;
  const projectId = b.projectId;
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    return fail("bad_project", "숙소 id 가 올바르지 않아요.");
  }
  const inProject = (p: string) => p.split("/")[1] === projectId;
  if (!checkPath(b.edited, uid, ["edited"]) || !inProject(b.edited)) {
    return fail("bad_edited", "가공 사진 경로가 올바르지 않아요. 사진을 먼저 만들어주세요.");
  }
  if (!checkPath(b.original, uid, ["photo"]) || !inProject(b.original)) {
    return fail("bad_original", "원본 사진 경로가 올바르지 않아요.");
  }
  const refs = Array.isArray(b.refs) ? b.refs : [];
  for (const r of refs) {
    if (!checkPath(r, uid, ["ref"]) || !inProject(r)) return fail("bad_ref", "레퍼런스 경로가 올바르지 않아요.");
  }
  const inputs = [b.edited, b.original, ...refs] as string[];
  if (inputs.length > MAX_INPUTS) {
    return fail("too_many_refs", "영상 레퍼런스는 가공·원본 포함 " + MAX_INPUTS + "장까지예요.");
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
  return { projectId, inputs, prompt, duration };
}

// Kling omni-video 작업 생성 본문. type 을 주지 않은 이미지는 레퍼런스로 쓰인다(첫 프레임 고정 아님).
export function createBody(v: StartInput, supabaseUrl: string): Record<string, unknown> {
  return {
    model_name: MODEL,
    prompt: v.prompt,
    image_list: v.inputs.map((p) => ({ image_url: publicUrl(supabaseUrl, p) })),
    mode: MODE,
    aspect_ratio: ASPECT,
    duration: String(v.duration),
    sound: "off",               // 릴스는 TTS 를 따로 깐다
  };
}

export function validateStatus(body: unknown): { projectId: string; taskId: string } | Fail {
  if (!body || typeof body !== "object") return fail("bad_json", "요청을 읽지 못했어요.");
  const b = body as Record<string, unknown>;
  const projectId = b.projectId;
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    return fail("bad_project", "숙소 id 가 올바르지 않아요.");
  }
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
    !!reply.json.data && typeof reply.json.data === "object";
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

  if (action === "start") {
    const v = validateStart(body, uid);
    if ("error" in v) return reply(req, env, 400, v);
    const t0 = Date.now();
    let k: KlingReply;
    try {
      k = await callKling(env, deps, "POST", ENDPOINT, createBody(v, env.supabaseUrl || ""));
    } catch (e) {
      console.error("lodging-reels-clip start unreachable", { reason: String(e).slice(0, 200) });
      return reply(req, env, 502, fail("upstream_unreachable", "Kling 에 연결하지 못했어요."));
    }
    const data = k.json && k.json.data as Record<string, unknown> | undefined;
    if (!klingOk(k) || !data || typeof data.task_id !== "string" || !TASK_ID.test(data.task_id)) {
      const e = klingError(k);
      console.error("lodging-reels-clip start failure", { http: k.http, code: k.json && k.json.code, body: k.text.slice(0, 400) });
      return reply(req, env, e.http, e.body);
    }
    console.log("lodging-reels-clip started", {
      model: MODEL, mode: MODE, inputs: v.inputs.length, duration: v.duration, ms: Date.now() - t0,
      task: data.task_id, request_id: k.json && k.json.request_id,
    });
    return reply(req, env, 200, {
      operation: { taskId: data.task_id }, model: MODEL, mode: MODE, aspect: ASPECT,
      duration: v.duration, inputs: v.inputs.length,
    });
  }

  if (action === "status") {
    const v = validateStatus(body);
    if ("error" in v) return reply(req, env, 400, v);
    let k: KlingReply;
    try {
      k = await callKling(env, deps, "GET", ENDPOINT + "/" + encodeURIComponent(v.taskId));
    } catch (e) {
      console.error("lodging-reels-clip status unreachable", { reason: String(e).slice(0, 200) });
      return reply(req, env, 502, fail("upstream_unreachable", "Kling 에 연결하지 못했어요."));
    }
    if (!klingOk(k)) {
      const e = klingError(k);
      console.error("lodging-reels-clip status failure", { http: k.http, code: k.json && k.json.code, body: k.text.slice(0, 400) });
      return reply(req, env, e.http, e.body);
    }
    const data = (k.json as Record<string, unknown>).data as Record<string, unknown>;
    const st = String(data.task_status || "");
    if (st === "submitted" || st === "processing") return reply(req, env, 200, { status: "pending", kling: st });
    if (st === "failed") {
      const msg = String(data.task_status_msg || "영상 생성에 실패했어요.").slice(0, 400);
      console.error("lodging-reels-clip task failed", { task: v.taskId, msg });
      return reply(req, env, 200, { status: "error", message: msg });
    }
    if (st !== "succeed") return reply(req, env, 502, fail("bad_status", "알 수 없는 작업 상태예요: " + st.slice(0, 40)));

    const result = data.task_result as Record<string, unknown> | undefined;
    const videos = result && Array.isArray(result.videos) ? result.videos as Record<string, unknown>[] : [];
    const first = videos.find((x) => x && typeof x.url === "string");
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

  return reply(req, env, 400, fail("bad_action", "action 은 start 또는 status 여야 해요."));
}
