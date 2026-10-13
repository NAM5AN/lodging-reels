"use strict";
// ⑨ Sunburst 이미지 생성: Vercel AI SDK generateImage()에 원본 1장 + 사진별 레퍼런스를 이미지 입력으로 전달한다.
// 기존 Vercel 함수/스토리지/인증/프론트 결과 형식은 그대로 사용한다.
//
// 왜 Supabase Edge Function 이 아니라 Vercel 함수인가:
//   Vercel 함수는 OIDC 토큰으로 AI Gateway 에 키 없이 붙는다.
//   Edge Function 은 AI_GATEWAY_API_KEY 를 따로 넣어야 하는데, 지금 그 키가 없다
//   (lodging-reels-ai 로그가 전부 anthropic-direct). 키를 새로 만들지 않으려고 여기에 둔다.
//
// CommonJS 엔트리이며 ESM인 AI SDK는 이미지 생성 요청 때만 동적으로 import한다.
// 순수 함수는 module.exports._lib 로 내보내 tests/ 에서 검증한다.

const SUPA_URL = process.env.SUPABASE_URL || "https://kfgtvifupumjuewwxzmz.supabase.co";
// 브라우저(index.html)에 이미 들어 있는 공개용 키다. 비밀이 아니다.
const SUPA_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_KROAv1c1eX3wlEt8Mog8OQ_jNTMJzoM";
const BUCKET = "lodging-reels";

const MODEL = "openai/gpt-image-2.5-sunburst";

// 요청 크기는 원본 사진 비율에 가까운 16의 배수로 맞춘다.
// 긴 변은 최대 1920픽셀로 제한하고, 결과 비율은 브라우저에서 다시 확인한다.
const MAX_EDGE = 1920;
const QUALITIES = ["low", "medium", "high", "xhigh", "max"];
const MAX_REFS = 15;           // 사진별 추가 레퍼런스 최대 15장 (원본 포함 최대 16장).
const MAX_PROMPT = 32000;
const MAX_RESPONSE_B64 = 4200000; // Vercel 함수 응답 한도 4.5MB 아래로.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 48 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const UPSTREAM_TIMEOUT_MS = 280000; // Vercel 함수 300초 안에서 종료.

const IMG_EXT = /\.(jpe?g|png|webp)$/i;

// 남의 폴더나 임의 URL 을 Gateway 가 가져가게 두지 않는다.
// 경로는 newPath() 규칙 그대로 uid/projId/kind/file.ext 여야 한다.
function checkPath(path, uid, kinds) {
  if (typeof path !== "string" || !path) return false;
  if (path.length > 300 || path.indexOf("..") >= 0 || path.indexOf("\\") >= 0) return false;
  const parts = path.split("/");
  if (parts.length !== 4) return false;
  if (parts[0] !== uid) return false;
  if (!parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  if (kinds.indexOf(parts[2]) < 0) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(parts[3]) || !IMG_EXT.test(parts[3])) return false;
  return true;
}

function publicUrl(path) {
  return SUPA_URL + "/storage/v1/object/public/" + BUCKET + "/" + path.split("/").map(encodeURIComponent).join("/");
}

// 원본/레퍼런스 경로는 호출 사용자 폴더만 허용. 검증된 사진은 이미지 바이트로 로드한다.
function validate(body, uid) {
  if (!body || typeof body !== "object") return { error: "bad_json", message: "요청을 읽지 못했어요." };
  const base = body.base;
  if (!checkPath(base, uid, ["photo", "edited"])) {
    return { error: "bad_base", message: "기본 사진 경로가 올바르지 않아요." };
  }
  const refs = Array.isArray(body.refs) ? body.refs : [];
  if (refs.length > MAX_REFS) {
    return { error: "too_many_refs", message: "추가 레퍼런스는 " + MAX_REFS + "장까지예요." };
  }
  for (let i = 0; i < refs.length; i++) {
    if (!checkPath(refs[i], uid, ["ref"])) {
      return { error: "bad_ref", message: "레퍼런스 경로가 올바르지 않아요." };
    }
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { error: "empty_prompt", message: "프롬프트가 비었어요." };
  if (prompt.length > MAX_PROMPT) return { error: "too_long", message: "프롬프트가 너무 길어요." };
  const quality = QUALITIES.indexOf(body.quality) >= 0 ? body.quality : "high";
  const dim = function(n){ n=Number(n);return Number.isFinite(n)&&n>0&&n<=16384?Math.round(n):0; };
  const baseW=dim(body.baseW),baseH=dim(body.baseH);
  return { base: base, refs: refs, prompt: prompt, quality: quality, baseW:baseW, baseH:baseH };
}

function round16(n){return Math.max(16,Math.round(n/16)*16);}
function sizeForAspect(w,h){
  if(!(w>0 && h>0))return null;
  if(w>=h){
    const outW=round16(Math.min(w,MAX_EDGE));
    return outW+"x"+round16(outW*h/w);
  }
  const outH=round16(Math.min(h,MAX_EDGE));
  return round16(outH*w/h)+"x"+outH;
}

// Generate API 고수준 호출. 실제 이미지 입력은 prompt.images에 원본→레퍼런스 순서로 배치한다.
function buildPayload(v, images, minimal) {
  const payload = {
    model: MODEL,
    prompt: { text: v.prompt, images: images },
    n: 1,
    maxRetries: 0
  };
  if (!minimal) {
    const size = sizeForAspect(v.baseW, v.baseH);
    if (size) payload.size = size;
    payload.providerOptions = {
      openai: { quality: v.quality, outputFormat: "jpeg", outputCompression: 90 }
    };
  }
  return payload;
}

// 이미지 입력은 브라우저의 storage 경로에서만 불러온다. 임의 외부 URL을 요청하지 않는다.
// Image SDK에 이미지를 문자열로 흘려보내지 않고 실제 바이트를 전달한다.
async function loadPromptImages(v, fetcher) {
  const request = fetcher || fetch;
  const paths = [v.base].concat(v.refs);
  const buffers = await Promise.all(paths.map(async function(path) {
    const ctl = new AbortController();
    const timer = setTimeout(function(){ ctl.abort(); }, IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await request(publicUrl(path), { signal: ctl.signal });
      if (!response.ok) throw new Error("storage_read_" + response.status);
      const length = Number(response.headers && response.headers.get("content-length") || 0);
      if (length > MAX_IMAGE_BYTES) throw new Error("source_too_large");
      const mime = String(response.headers && response.headers.get("content-type") || "").toLowerCase();
      if (mime && !mime.startsWith("image/") && mime.indexOf("application/octet-stream") !== 0)
        throw new Error("source_not_image");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("source_bad_size");
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }));
  const total = buffers.reduce(function(sum, bytes) { return sum + bytes.byteLength; }, 0);
  if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("references_total_too_large");
  return buffers;
}

// createGateway({apiKey})는 기존 Vercel OIDC/API Gateway 토큰을 그대로 사용한다.
// 실제 이미지 생성은 generateImage()이며 입력 사진이 포함된 prompt를 전달한다.
async function generateWithReferences(v, images, token, minimal, signal, sdk) {
  const ai = sdk || await import("ai");
  const gateway = ai.createGateway({ apiKey: token });
  return ai.generateImage({
    ...buildPayload(v, images, minimal),
    model: gateway.imageModel(MODEL),
    abortSignal: signal
  });
}

function sniffMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

// 크기·품질 같은 선택 항목을 Gateway 가 거부했을 때만 한 번 더 보낸다.
function looksLikeParamError(status, text) {
  if (status !== 400 && status !== 422) return false;
  return /size|quality|output_format|output_compression|unknown|unsupported|unrecognized|not allowed|invalid param/i.test(text || "");
}

function gatewayToken(req) {
  // 명시 키가 있으면 그게 우선이다(Gateway 문서 규칙). 없으면 Vercel OIDC.
  return process.env.AI_GATEWAY_API_KEY ||
    (req.headers && req.headers["x-vercel-oidc-token"]) ||
    process.env.VERCEL_OIDC_TOKEN || "";
}

async function whoIs(auth) {
  if (!auth || auth.toLowerCase().indexOf("bearer ") !== 0) return null;
  try {
    const r = await fetch(SUPA_URL + "/auth/v1/user", { headers: { Authorization: auth, apikey: SUPA_KEY } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch (e) {
    return null;
  }
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { return null; }
}

async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method", message: "POST 만 받아요." });

  const uid = await whoIs(req.headers.authorization || req.headers.Authorization || "");
  if (!uid) return send(res, 401, { error: "unauthorized", message: "로그인이 필요해요." });

  const token = gatewayToken(req);
  if (!token) {
    return send(res, 500, {
      error: "no_gateway_auth",
      message: "AI Gateway 인증이 없어요. Vercel 프로젝트에서 OIDC 가 꺼져 있거나 AI_GATEWAY_API_KEY 가 없어요.",
    });
  }

  const v = validate(await readBody(req), uid);
  if (v.error) return send(res, 400, v);

  const t0 = Date.now();
  let images;
  try {
    images = await loadPromptImages(v);
  } catch (e) {
    console.error("image-generate input read failure", { reason: String(e).slice(0, 180), refs: v.refs.length });
    return send(res, 502, {
      error: "source_unavailable",
      message: "원본 또는 레퍼런스 사진을 읽지 못했어요. 파일 업로드 상태나 용량을 확인해 주세요."
    });
  }

  let result, minimal = false;
  const ctl = new AbortController();
  const timer = setTimeout(function(){ ctl.abort(); }, UPSTREAM_TIMEOUT_MS);
  try {
    try {
      result = await generateWithReferences(v, images, token, false, ctl.signal);
    } catch (e) {
      const status = Number(e && (e.statusCode || e.status) || 0);
      const reason = String(e && (e.responseBody || e.message) || e || "");
      if (!looksLikeParamError(status, reason)) throw e;
      console.warn("image-generate: optional params rejected; retry minimal", { status: status, reason: reason.slice(0, 220) });
      minimal = true;
      result = await generateWithReferences(v, images, token, true, ctl.signal);
    }
  } catch (e) {
    const status = Number(e && (e.statusCode || e.status) || 0);
    const aborted = ctl.signal.aborted || (e && e.name === "AbortError");
    const reason = String(e && (e.responseBody || e.message) || e || "");
    console.error("image-generate upstream failure", { status: status, aborted: aborted, reason: reason.slice(0, 320) });
    const code = aborted ? "timeout" : status === 429 ? "rate_limited"
      : status === 401 || status === 403 ? "gateway_auth"
      : status === 404 ? "bad_model" : "upstream_error";
    const message = aborted ? "이미지 생성 시간 초과예요. 품질을 낮춰 다시 시도해 주세요."
      : reason.slice(0, 400) || "AI Gateway 이미지 생성에 실패했어요.";
    return send(res, aborted ? 504 : status === 429 ? 429 : 502, { error: code, message: message });
  } finally {
    clearTimeout(timer);
  }

  const image = result && ((result.images && result.images[0]) || result.image);
  const b64 = image && (image.base64 || (image.uint8Array && Buffer.from(image.uint8Array).toString("base64")));
  if (!b64) {
    console.error("image-generate: empty generated result");
    return send(res, 502, { error: "no_image", message: "이미지가 응답에 없어요." });
  }
  if (b64.length > MAX_RESPONSE_B64) {
    console.error("image-generate: output too large", { length: b64.length });
    return send(res, 502, { error: "too_large", message: "결과 이미지가 너무 커서 받지 못했어요. 품질을 낮춰 다시 해보세요." });
  }

  console.log("image-generate ok", {
    model: MODEL, refs: v.refs.length, inputs: images.length,
    quality: v.quality, minimal: minimal, ms: Date.now() - t0, b64: b64.length
  });
  return send(res, 200, {
    b64: b64,
    mime: image.mediaType || sniffMime(b64),
    model: MODEL,
    mode: "generate-with-references",
    input_images: images.length,
    quality: minimal ? null : v.quality,
    requested_size: minimal ? null : sizeForAspect(v.baseW, v.baseH),
    minimal: minimal,
    ms: Date.now() - t0
  });
}

module.exports = handler;
module.exports._lib = {
  checkPath: checkPath, publicUrl: publicUrl, validate: validate, buildPayload: buildPayload,
  loadPromptImages: loadPromptImages, generateWithReferences: generateWithReferences,
  sizeForAspect: sizeForAspect, round16: round16,
  sniffMime: sniffMime, looksLikeParamError: looksLikeParamError,
  MODEL: MODEL, MAX_EDGE: MAX_EDGE, MAX_REFS: MAX_REFS,
};
