/**
 * RankupRL Steam Web API proxy.
 *
 * One server-side Steam Web API key behind a Cloudflare Worker so end users
 * don't have to register their own key at steamcommunity.com/dev/apikey.
 * The desktop app authenticates with its Epic OAuth access_token; we verify
 * that token against Epic's /userInfo and rate-limit per Epic Account ID.
 *
 * See worker/README.md for design rationale + ToS reasoning. See SETUP.md
 * for one-time Cloudflare setup steps.
 */

interface Env {
  RATE_LIMIT: KVNamespace;
  STEAM_WEB_API_KEY: string;
  ALLOWED_ORIGINS: string;
  RATE_LIMIT_PER_MINUTE: string;
}

const EPIC_USERINFO_URL = "https://api.epicgames.dev/epic/oauth/v1/userInfo";
const STEAM_API_BASE = "https://api.steampowered.com";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — must respond before any other check or the
    // browser will treat the actual request as blocked.
    if (request.method === "OPTIONS") {
      return cors(env, request, new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health") {
      return cors(env, request, json({ ok: true }));
    }

    if (request.method !== "GET") {
      return cors(env, request, json({ error: "method_not_allowed" }, 405));
    }

    if (
      url.pathname !== "/steam/friends" &&
      url.pathname !== "/steam/summaries"
    ) {
      return cors(env, request, json({ error: "not_found" }, 404));
    }

    // Auth: every /steam/* call must carry a valid Epic bearer token.
    // Verify against Epic's /userInfo (free, fast, source of truth) and
    // use the returned `sub` (Epic Account ID) as the rate-limit bucket.
    const accountId = await verifyEpicToken(request.headers.get("Authorization"));
    if (accountId instanceof Response) {
      return cors(env, request, accountId);
    }

    // Per-account sliding-window rate limit. Keeps a single misbehaving
    // install from torching the shared Steam quota.
    const limited = await rateLimit(env, accountId);
    if (limited) {
      return cors(env, request, limited);
    }

    try {
      if (url.pathname === "/steam/friends") {
        return cors(env, request, await proxyFriendList(env, url));
      }
      return cors(env, request, await proxyPlayerSummaries(env, url));
    } catch (e) {
      console.error("proxy failure:", e);
      return cors(env, request, json({ error: "upstream_failure" }, 502));
    }
  },
} satisfies ExportedHandler<Env>;

// ─────────── Endpoint handlers ──────────────────────────────────────

async function proxyFriendList(env: Env, url: URL): Promise<Response> {
  const steamId = url.searchParams.get("steamid");
  if (!steamId || !/^\d{17}$/.test(steamId)) {
    return json({ error: "invalid_steamid" }, 400);
  }
  const upstream = new URL(`${STEAM_API_BASE}/ISteamUser/GetFriendList/v1/`);
  upstream.searchParams.set("key", env.STEAM_WEB_API_KEY);
  upstream.searchParams.set("steamid", steamId);
  upstream.searchParams.set("relationship", "friend");
  return forward(upstream);
}

async function proxyPlayerSummaries(env: Env, url: URL): Promise<Response> {
  const steamIds = url.searchParams.get("steamids");
  if (!steamIds) {
    return json({ error: "missing_steamids" }, 400);
  }
  const ids = steamIds.split(",");
  if (ids.length > 100) {
    return json({ error: "too_many_steamids", max: 100 }, 400);
  }
  if (!ids.every((id) => /^\d{17}$/.test(id))) {
    return json({ error: "invalid_steamid_in_list" }, 400);
  }
  const upstream = new URL(`${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v0002/`);
  upstream.searchParams.set("key", env.STEAM_WEB_API_KEY);
  upstream.searchParams.set("steamids", steamIds);
  return forward(upstream);
}

async function forward(upstream: URL): Promise<Response> {
  const res = await fetch(upstream.toString(), {
    cf: {
      // Cache for 60s edge-side. Trims repeat fetches when the same
      // friend's summary is requested twice within the cache window.
      cacheTtl: 60,
      cacheEverything: true,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    return json({ error: "steam_upstream_error", status: res.status, body: body.slice(0, 200) }, 502);
  }
  // Pass the Steam response body through verbatim; the desktop app
  // already parses Steam's JSON shapes directly.
  return new Response(res.body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─────────── Auth ──────────────────────────────────────────────────

/**
 * Verify an Epic OAuth bearer token by hitting Epic's /userInfo. On
 * success returns the Epic Account ID (`sub`). On failure returns a
 * 401 Response — callers must check `instanceof Response`.
 *
 * /userInfo is cheap (~50ms) and Epic doesn't rate-limit it
 * aggressively. We could cache by token hash if it becomes hot, but
 * the per-Epic-account rate limit below dominates anyway.
 */
async function verifyEpicToken(
  authHeader: string | null,
): Promise<string | Response> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json({ error: "missing_bearer" }, 401);
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return json({ error: "empty_bearer" }, 401);
  }

  const res = await fetch(EPIC_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return json({ error: "epic_token_invalid", status: res.status }, 401);
  }
  const info = (await res.json()) as { sub?: string };
  if (!info.sub) {
    return json({ error: "epic_userinfo_missing_sub" }, 401);
  }
  return info.sub;
}

// ─────────── Rate limit ────────────────────────────────────────────

/**
 * Sliding 60-second window per Epic Account ID. Uses KV's TTL so
 * old counts expire on their own — no cleanup job. Returns a 429
 * Response when the user has exceeded the limit.
 */
async function rateLimit(env: Env, accountId: string): Promise<Response | null> {
  const limit = parseInt(env.RATE_LIMIT_PER_MINUTE, 10) || 60;
  const key = `rl:${accountId}`;

  const current = parseInt((await env.RATE_LIMIT.get(key)) ?? "0", 10);
  if (current >= limit) {
    return new Response(
      JSON.stringify({ error: "rate_limited", retry_after: 60 }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      },
    );
  }

  // Bump the counter. ExpirationTtl of 60s means the bucket resets
  // 60s after the first request in the window.
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 60 });
  return null;
}

// ─────────── CORS + helpers ────────────────────────────────────────

function cors(env: Env, request: Request, response: Response): Response {
  const origin = request.headers.get("Origin") ?? "";
  const allowedSet = new Set(
    env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  );
  // Tauri webviews send `Origin: tauri://localhost` in prod and
  // `http://localhost:1420` in vite dev. We only echo a matching
  // origin back — open CORS for unknown origins would let any other
  // app's webview leech the proxy.
  if (allowedSet.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
  }
  return response;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
