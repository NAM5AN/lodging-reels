// 공통: CORS 와 사용자 인증.
// verify_jwt 를 끄고 여기서 직접 확인한다. 게이트웨이의 verify_jwt 는 anon 키도 통과시켜서
// "로그인한 사람" 을 가려내지 못한다. 토큰을 Supabase Auth 에 되물어 실제 사용자만 들여보낸다.

const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allow = ORIGINS.includes("*") ? "*"
              : (ORIGINS.includes(origin) ? origin : "");
  return {
    "Access-Control-Allow-Origin": allow || "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  } as Record<string, string>;
}

export function preflight(req: Request) {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: cors(req) });
}

export function fail(req: Request, status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

/** 로그인한 사용자만. 아니면 null. */
export async function requireUser(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: anon },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id } : null;
  } catch {
    return null;
  }
}
