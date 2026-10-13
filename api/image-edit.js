"use strict";
// ⑨ Generate 실험 — 이미지 입력 없이 텍스트 프롬프트로 새 장면을 생성한다.
// 기존 원본/레퍼런스 이미지는 AI에 전송하지 않으며 원본 가로세로 비율만 활용한다.
//
// 왜 Supabase Edge Function 이 아니라 Vercel 함수인가:
//   Vercel 함수는 OIDC 토큰으로 AI Gateway 에 키 없이 붙는다.
//   Edge Function 은 AI_GATEWAY_API_KEY 를 따로 넣어야 하는데, 지금 그 키가 없다
//   (lodging-reels-ai 로그가 전부 anthropic-direct). 키를 새로 만들지 않으려고 여기에 둔다.
//
// 이 파일은 CommonJS 다. 저장소에 package.json 이 없어서 .js 는 CJS 로 읽힌다.
// 순수 함수는 module.exports._lib 로 내보내 tests/ 에서 그대로 검사한다.

const SUPA_URL = process.env.SUPABASE_URL || "https://kfgtvifupumjuewwxzmz.supabase.co";
// 브라우저(index.html)에 이미 들어 있는 공개용 키다. 비밀이 아니다.
const SUPA_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_KROAv1c1eX3wlEt8Mog8OQ_jNTMJzoM";
const BUCKET = "lodging-reels";

const GATEWAY_GENERATIONS = "https://ai-gateway.vercel.sh/v1/images/generations";
const MODEL = "openai/gpt-image-2.5-sunburst";

// 요청 크기는 원본 사진 비율에 가까운 16의 배수로 맞춘다.
// 긴 변은 최대 1920픽셀로 제한하고, 결과 비율은 브라우저에서 다시 확인한다.
const MAX_EDGE = 1920;
const QUALITIES = ["low", "medium", "high", "xhigh", "max"];
const MAX_REFS = 15;           // 기존 UI 저장 구조의 호환용 한도. Generate API에는 사진을 첨부하지 않는다.
const MAX_PROMPT = 32000;
const MAX_RESPONSE_B64 = 4200000; // Vercel 함수 응답 한도 4.5MB 아래로.
const UPSTREAM_TIMEOUT_MS = 280000; // Hobby 최대 300초 안에서 끊는다.

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

// 기존 UI와 호환되도록 원본·레퍼런스 경로를 검증하되 Generate API에는 사진 URL을 전달하지 않는다.
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

// OpenAI-compatible /images/generations accepts text; neither base nor refs are sent.
function buildPayload(v, minimal) {
  const payload = { model: MODEL, prompt: v.prompt, n: 1 };
  if (!minimal) {
    const size=sizeForAspect(v.baseW,v.baseH);
    if(size)payload.size=size;
    payload.quality = v.quality;
    payload.output_format = "jpeg";
    payload.output_compression = 90;
  }
  return payload;
}

// Gateway 문서에 data[].b64_json 과 data[] 문자열 두 형태가 다 나온다. 둘 다 받는다.
function pickImage(out) {
  const d = out && Array.isArray(out.data) ? out.data[0] : null;
  if (!d) return null;
  if (typeof d === "string") return { b64: d };
  if (d.b64_json) return { b64: d.b64_json };
  if (d.url) return { url: d.url };
  return null;
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

async function callGateway(token, payload) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(GATEWAY_GENERATIONS, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await r.text();
    return { status: r.status, ok: r.ok, text: text };
  } finally {
    clearTimeout(timer);
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
  let minimal = false;
  let up;
  try {
    up = await callGateway(token, buildPayload(v, false));
    if (!up.ok && looksLikeParamError(up.status, up.text)) {
      console.warn("image-edit: optional params rejected, retrying minimal", { status: up.status, body: up.text.slice(0, 300) });
      minimal = true;
      up = await callGateway(token, buildPayload(v, true));
    }
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    console.error("image-edit upstream failure", { aborted: aborted, reason: String(e).slice(0, 200) });
    return send(res, aborted ? 504 : 502, {
      error: aborted ? "timeout" : "upstream_unreachable",
      message: aborted ? "이미지 생성이 너무 오래 걸려서 끊었어요. 품질을 한 단계 낮춰 다시 해보세요." : "AI Gateway 에 연결하지 못했어요.",
    });
  }

  if (!up.ok) {
    console.error("image-edit gateway error", { status: up.status, minimal: minimal, body: up.text.slice(0, 500) });
    const code = up.status === 429 ? "rate_limited"
      : (up.status === 401 || up.status === 403) ? "gateway_auth"
      : up.status === 404 ? "bad_model"
      : "upstream_error";
    return send(res, up.status === 429 ? 429 : 502, { error: code, message: up.text.slice(0, 400) });
  }

  let out;
  try { out = JSON.parse(up.text); } catch (e) { out = null; }
  let img = pickImage(out);
  if (img && img.url) {
    // GPT image 모델은 url 을 안 주지만, 다른 경로로 오면 여기서 받아 base64 로 바꾼다.
    try {
      const r = await fetch(img.url);
      img = { b64: Buffer.from(await r.arrayBuffer()).toString("base64") };
    } catch (e) { img = null; }
  }
  if (!img || !img.b64) {
    console.error("image-edit: no image in response", { preview: up.text.slice(0, 300) });
    return send(res, 502, { error: "no_image", message: "이미지가 응답에 없어요." });
  }
  if (img.b64.length > MAX_RESPONSE_B64) {
    console.error("image-edit: result too large", { b64: img.b64.length, minimal: minimal });
    return send(res, 502, { error: "too_large", message: "결과 이미지가 너무 커서 받지 못했어요. 품질을 낮춰 다시 해보세요." });
  }

  console.log("image-generate ok", {
    model: MODEL, quality: v.quality, refs: v.refs.length, minimal: minimal,
    ms: Date.now() - t0, b64: img.b64.length,
  });
  return send(res, 200, {
    b64: img.b64,
    mime: sniffMime(img.b64),
    model: MODEL,
    mode: "generate",
    quality: minimal ? null : v.quality,
    requested_size: minimal ? null : sizeForAspect(v.baseW,v.baseH),
    minimal: minimal,
    ms: Date.now() - t0,
  });
}

module.exports = handler;
module.exports._lib = {
  checkPath: checkPath, publicUrl: publicUrl, validate: validate, buildPayload: buildPayload,
  sizeForAspect: sizeForAspect, round16: round16,
  pickImage: pickImage, sniffMime: sniffMime, looksLikeParamError: looksLikeParamError,
  MODEL: MODEL, MAX_EDGE: MAX_EDGE, MAX_REFS: MAX_REFS,
};
