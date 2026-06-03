# Worker setup

One-time onboarding to get the Steam API proxy deployed. The Worker
code itself is already written — these steps connect it to your
Cloudflare account and provision the secrets it needs.

Roughly 30 minutes the first time. Subsequent deploys are one
command (`npm run deploy`).

---

## 0. What you'll do

1. Create a Cloudflare account (free).
2. Install `wrangler`, the Cloudflare Workers CLI.
3. Provision a KV namespace for the rate-limit counter.
4. Register a Steam Web API key under the `rankuprl.app` domain.
5. Stash the Steam key as a Worker secret.
6. Deploy.
7. Sanity-check with `curl`.
8. (Later) bind `api.rankuprl.app` as a custom domain.

---

## 1. Cloudflare account

If you don't already have one, sign up at
<https://dash.cloudflare.com/sign-up>. Free tier is fine — we'll
stay under the limits for the foreseeable future.

After signup, note your **Account ID**: dashboard → Workers & Pages →
right sidebar. You'll need it if any wrangler command asks.

---

## 2. Install wrangler

```bash
cd worker
npm install
npx wrangler login
```

`wrangler login` pops the browser, asks you to authorize the CLI
against your Cloudflare account, and stashes a token under
`~/.wrangler/`. One-time per machine.

Sanity check:

```bash
npx wrangler whoami
```

Should print your email and account ID.

---

## 3. Create the KV namespace for rate limiting

```bash
npx wrangler kv namespace create RATE_LIMIT
```

Output looks like:

```
🌀  Creating namespace with title "rankuprl-steam-proxy-RATE_LIMIT"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "abc123def456abc123def456abc123de"
```

Copy that `id` value and paste it into `wrangler.toml`, replacing
`<PLACEHOLDER_KV_ID>` in the existing `[[kv_namespaces]]` block.

---

## 4. Register the Steam Web API key

1. Go to <https://steamcommunity.com/dev/apikey>.
2. Sign in with the Steam account you want as the operator (a
   dedicated dev account beats your personal main, but either
   works).
3. **Domain Name**: `rankuprl.app`. This is the field Steam asks
   you to fill in — putting the production domain here aligns the
   API key's operator identity with the app.
4. Accept the Steam Web API Terms of Use.
5. Steam shows you a 32-character hex key. Copy it.

Don't commit this key anywhere. The next step stores it in
Cloudflare, not in the repo.

---

## 5. Stash the Steam key as a Worker secret

```bash
npx wrangler secret put STEAM_WEB_API_KEY
```

Wrangler prompts for the value — paste the Steam key, hit Enter.
The secret is encrypted at rest in Cloudflare and made available to
the Worker as `env.STEAM_WEB_API_KEY`. It does not appear in
`wrangler.toml`, in your git history, or in any deploy artifact.

To rotate later: re-register a new key with Steam, then re-run the
same `wrangler secret put` command. Worker code doesn't change.

---

## 6. Deploy

```bash
npx wrangler deploy
```

First deploy takes ~30 seconds. Output ends with:

```
Published rankuprl-steam-proxy
  https://rankuprl-steam-proxy.<your-account>.workers.dev
```

That `.workers.dev` URL is your live API. Bookmark it — we'll
sanity-check it next and then bind `api.rankuprl.app` to it in step 8.

---

## 7. Sanity check

### a. Health endpoint (no auth required)

```bash
curl https://rankuprl-steam-proxy.<your-account>.workers.dev/health
```

Should return `{"ok":true}`.

### b. Auth check (should reject without a token)

```bash
curl -i https://rankuprl-steam-proxy.<your-account>.workers.dev/steam/friends?steamid=76561199068163942
```

Should return `401 Unauthorized` with body
`{"error":"missing_bearer"}`. Good — proves auth is wired.

### c. Auth check with a real Epic token

Grab a fresh Epic access token from the RankupRL app:

```bash
sqlite3 ~/Library/Application\ Support/com.rlrankup.app/rlrankup.db \
  "SELECT oauth_data FROM connections WHERE provider='epic';" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
```

Then:

```bash
TOKEN=<paste it here>
curl -H "Authorization: Bearer $TOKEN" \
  "https://rankuprl-steam-proxy.<your-account>.workers.dev/steam/friends?steamid=76561199068163942"
```

Should return the same JSON Steam returns from `GetFriendList/v1`.

### d. Rate limit

Run that same curl 61 times in a tight loop. The 61st should return
`429 Too Many Requests`.

```bash
for i in $(seq 1 61); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "Authorization: Bearer $TOKEN" \
    "https://rankuprl-steam-proxy.<your-account>.workers.dev/health"
done
echo
```

The trailing few should print `429`.

---

## 8. Bind `api.rankuprl.app` (required for Slice B)

The `.workers.dev` URL is fine for testing, but the desktop migration
(Slice B) hits `api.rankuprl.app`. There are **two** "bind a domain"
features in Cloudflare and they're not the same — use **Custom
Domain**, not Routes.

| Feature | Where | Auto-creates DNS? |
|---|---|---|
| Workers Routes (zone level) | Websites → rankuprl.app → Workers Routes | ❌ No — needs a DNS record to exist already |
| **Workers Custom Domain (worker level)** | **Workers & Pages → click the worker → Settings → Domains & Routes → Custom Domains** | ✅ Yes — proxied CNAME + TLS cert auto-provisioned |

1. Cloudflare dashboard → **Workers & Pages** → click `rankuprl-steam-proxy`.
2. **Settings** tab → scroll to **Domains & Routes**.
3. Under **Custom Domains**, hit **+ Add**.
4. Enter `api.rankuprl.app` → **Add Domain**.

Cloudflare proxied-CNAME + Let's-Encrypt cert provision in <1
minute.

Then uncomment the `routes = [...]` block in `wrangler.toml` so
subsequent `wrangler deploy` runs declare the same binding (idempotent
— Cloudflare won't double-create):

```toml
routes = [
  { pattern = "api.rankuprl.app/*", custom_domain = true }
]
```

Test from a fresh DNS cache (macOS `sudo dscacheutil -flushcache`
then `sudo killall -HUP mDNSResponder` if your local resolver is
stale):

```bash
curl https://api.rankuprl.app/health
```

Should return `{"ok":true}`. If your local cache won't clear, you
can verify externally with:

```bash
curl --resolve api.rankuprl.app:443:104.21.60.62 https://api.rankuprl.app/health
```

(Resolves to a Cloudflare anycast IP directly — bypasses local DNS.)

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `wrangler deploy` says "Authentication error" | `wrangler login` token expired. Re-run `wrangler login`. |
| Worker returns 500 with no body | Check `npx wrangler tail` while reproducing — Workers log to stderr. |
| `epic_token_invalid` on every request | The Epic access token expired (~2 hours). Re-run RankupRL's Epic check or grab a fresh token from oauth_data. |
| `429 rate_limited` immediately | Bumped `RATE_LIMIT_PER_MINUTE` too low, or a previous test loop hasn't aged out yet. Wait 60s. |
| `epic_userinfo_missing_sub` | Epic's `/userInfo` is returning a non-standard response — check `wrangler tail` for the raw body. |
| Steam returns 401 inside the proxy | The Steam Web API key was revoked or expired. Re-register at <https://steamcommunity.com/dev/apikey> and re-run `wrangler secret put STEAM_WEB_API_KEY`. |

---

## Cost tracking

Cloudflare dashboard → **Workers & Pages** → click `rankuprl-steam-proxy`
→ **Metrics**. Shows requests/day. Free tier is 100k/day.

KV usage: **Workers KV** → click the namespace. Free tier is 100k
reads + 1k writes per day. Each Worker request = ~1 read + 1 write
(rate limit bump). Stays well under at single-digit users.

**Set a billing alert** at $5 in Cloudflare dashboard → **Billing**
so you're warned before any surprise costs.
