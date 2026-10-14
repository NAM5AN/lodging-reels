// ⑨ 영상화 — Kling 3.0 (Omni, Pro) 직접 호출. 본체는 clip.ts.
// 비밀키는 Supabase Edge Function Secret 에만 둔다. 브라우저로 내보내지 않는다.
//
// Secrets
//   KLINGAI_API_KEY   필수. Kling API 키. Authorization: Bearer 로 그대로 보낸다.
//   KLINGAI_API_BASE  선택. 비우면 https://api-singapore.klingai.com
//   ALLOWED_ORIGINS   선택. 다른 lodging-reels 함수와 같은 규칙 (기본 *)
// 자동 제공: SUPABASE_URL, SUPABASE_ANON_KEY
//
// 배포: verify_jwt = false (함수 안에서 사용자 토큰을 Supabase Auth 에 되물어 확인한다).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handle } from "./clip.ts";

Deno.serve((req: Request) =>
  handle(req, {
    klingKey: Deno.env.get("KLINGAI_API_KEY") || "",
    klingBase: Deno.env.get("KLINGAI_API_BASE") || "",
    supabaseUrl: Deno.env.get("SUPABASE_URL") || "",
    anonKey: Deno.env.get("SUPABASE_ANON_KEY") || "",
    allowedOrigins: Deno.env.get("ALLOWED_ORIGINS") || "*",
  })
);
