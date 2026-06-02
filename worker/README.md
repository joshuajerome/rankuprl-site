# rankuprl-steam-proxy

Cloudflare Worker that proxies Steam Web API calls for the RankupRL
desktop app. One server-side Steam Web API key behind here so end
users don't have to register their own.

> See `SETUP.md` for one-time Cloudflare onboarding steps.

## Endpoints

All `/steam/*` endpoints require an `Authorization: Bearer <epic_access_token>`
header. The Worker verifies the token against Epic's `/userInfo`
and rate-limits per Epic Account ID.

| Method | Path | Maps to |
|---|---|---|
| `GET` | `/steam/friends?steamid={id}` | `ISteamUser/GetFriendList/v1/` |
| `GET` | `/steam/summaries?steamids={csv}` | `ISteamUser/GetPlayerSummaries/v0002/` (≤100 ids) |
| `GET` | `/health` | Liveness probe (no auth) |

The proxy is **pure pass-through**. Steam's JSON response bodies are
returned verbatim — the desktop app already parses them directly.

## Auth model

- Bearer token = the user's Epic OAuth access token (RankupRL
  already requires Epic sign-in to do anything useful).
- Worker hits `https://api.epicgames.dev/epic/oauth/v1/userInfo` to
  validate the token. The returned `sub` (Epic Account ID) becomes
  the rate-limit bucket.
- No app-level static token to extract from the binary, no per-user
  registration step. If the user can sign into Epic in the desktop
  app, the proxy works.

## Rate limiting

Per-Epic-Account-ID sliding 60-second window, default 60 req/min.
Configurable via `RATE_LIMIT_PER_MINUTE` in `wrangler.toml`. State
lives in Workers KV with TTL-based expiry — no cleanup job needed.

The natural call pattern from the desktop app (one friends-list
fetch + one summaries batch per drawer open + occasional manual
refresh) stays well under.

## Why server-side, not baked into the binary

Steam Web API Terms when you register a key:

> "You may not disclose, distribute, or share your Steam Web API key."

Baking a key into the desktop binary distributes it to every user —
ToS violation, key is extractable, single revocation kills the
feature for everyone. Server-side use from a single trusted
environment is the intended pattern (every commercial Steam-aware
service works this way).

See the project memory at
`docs/dev/claude-context/project_steam_api_proxy.md` in the main
RankupRL repo for the full decision rationale.

## Development

```bash
cd worker
npm install
npx wrangler dev    # Local dev at http://localhost:8787
```

In dev mode, secrets come from `.dev.vars` (gitignored). Create one
with:

```
STEAM_WEB_API_KEY=<your-key>
```

Production deploy:

```bash
npm run deploy
```

Type check (CI-friendly, no Cloudflare calls):

```bash
npm run typecheck
```

Tail live logs from production:

```bash
npm run tail
```

## Cost

Operating cost at single-developer scale: **$0/mo**. Free tier
covers 100k requests/day on Workers and ~100k KV ops/day. Realistic
multi-hundred-MAU worst case: **$5/mo** flat (Workers paid tier
ceiling).

## File map

```
worker/
├── src/
│   └── index.ts       Worker handler — all logic in one file (~200 LOC)
├── wrangler.toml      Cloudflare deploy config
├── tsconfig.json      TypeScript settings (workers-types lib)
├── package.json
├── README.md          This file
├── SETUP.md           Step-by-step Cloudflare onboarding
└── .gitignore
```
