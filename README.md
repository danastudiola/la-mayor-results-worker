# LA Mayor 2026 — Results Worker

Cloudflare Worker that proxies the LA County Registrar election results feed and strips CORS, so any browser or app can fetch live results without restriction.

**Election:** Statewide Direct Primary — June 2, 2026  
**Election ID:** 4338  
**Source feed:** `https://results.lavote.net/electionresults/json?ElectionID=4338`

---

## Endpoints

| Route | Returns |
|---|---|
| `GET /` | Worker info + endpoint list |
| `GET /results` | Full proxied JSON from LA County (all 172 contests) |
| `GET /mayor` | Parsed LA Mayor race — candidates, vote totals, gap analysis, overtake scenarios |

### Example `/mayor` response

```json
{
  "timestamp": "2026-06-02T23:29:15.387",
  "total_votes": 399726,
  "candidates": [
    { "rank": 1, "name": "KAREN RUTH BASS", "votes": 145752, "pct": 36.4627, "advancing": true },
    { "rank": 2, "name": "SPENCER PRATT",   "votes": 116572, "pct": 29.1617, "advancing": true },
    { "rank": 3, "name": "NITHYA RAMAN",    "votes": 85412,  "pct": 21.3672, "advancing": false }
  ],
  "margin_analysis": {
    "pratt_raman_gap_votes": 31160,
    "pratt_raman_gap_pct": 7.7945,
    "raman_share_of_pratt_raman": 42.27
  },
  "overtake_scenarios": [...]
}
```

---

## Deploy

### 1. Install Wrangler
```bash
npm install
```

### 2. Authenticate
```bash
npx wrangler login
```

### 3. Add your account ID to `wrangler.toml`
```toml
account_id = "your_cloudflare_account_id"
```
Find it at: Cloudflare Dashboard → right sidebar on any zone.

### 4. Deploy
```bash
npm run deploy
```

Your worker URL will be:
```
https://la-mayor-results-worker.<your-subdomain>.workers.dev
```

### 5. Update the dashboard

In `la-mayor-live.html`, replace the `FEED_URL` constant:
```javascript
// Before (direct, CORS-blocked):
const FEED_URL = 'https://results.lavote.net/electionresults/json?ElectionID=4338';

// After (through your worker):
const FEED_URL = 'https://la-mayor-results-worker.<your-subdomain>.workers.dev/mayor';
```

---

## Caching

The worker caches the upstream response for **120 seconds** using Cloudflare's edge cache. This means:
- Max data lag: 2 minutes
- Protects lavote.net from rapid polling
- `X-Cache: HIT` or `MISS` header on every response

Adjust `CACHE_TTL` in `src/index.js` if you want more frequent updates.

---

## Local dev

```bash
npm run dev
# Worker runs at http://localhost:8787
```
