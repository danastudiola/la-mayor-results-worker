/**
 * LA Mayor 2026 — Election Results Cloudflare Worker v2.1
 * Full seeded batch history from election night through Jun 7.
 * Routes:
 *   GET  /          — worker info
 *   GET  /results   — full proxied JSON from LA County
 *   GET  /mayor     — parsed mayor race + full history[]
 *   DELETE /mayor/history — clear KV live snapshots (seed preserved)
 */

const FEED_URL    = 'https://results.lavote.net/electionresults/json?ElectionID=4338';
const MAYOR_TITLE = 'LOS ANGELES CITY PRIMARY NOMINATING ELECTION Mayor';
const CACHE_TTL   = 60;
const MAX_SNAPSHOTS = 200;
const KV_KEY      = 'snapshots';

// Seeded batch history — authoritative cumulative totals from theballotbook.com
// 17 official release batches, Jun 2 8:23pm through Jun 7 4:53pm
const SEED_HISTORY = [
  { timestamp:'2026-06-02T20:23:00', total_votes:308878, bass:117579, pratt:86323, raman:61949, bass_pct:38.07, pratt_pct:27.95, raman_pct:20.06, pratt_raman_gap:24374 },
  { timestamp:'2026-06-02T20:35:00', total_votes:357311, bass:130429, pratt:108193, raman:71470, bass_pct:36.50, pratt_pct:30.28, raman_pct:20.00, pratt_raman_gap:36723 },
  { timestamp:'2026-06-02T20:51:00', total_votes:361764, bass:132172, pratt:108949, raman:73008, bass_pct:36.54, pratt_pct:30.12, raman_pct:20.18, pratt_raman_gap:35941 },
  { timestamp:'2026-06-02T21:23:00', total_votes:366293, bass:133964, pratt:109847, raman:74400, bass_pct:36.57, pratt_pct:29.99, raman_pct:20.31, pratt_raman_gap:35447 },
  { timestamp:'2026-06-02T21:36:00', total_votes:372265, bass:136208, pratt:111021, raman:76375, bass_pct:36.59, pratt_pct:29.82, raman_pct:20.52, pratt_raman_gap:34646 },
  { timestamp:'2026-06-02T22:54:00', total_votes:380597, bass:139485, pratt:112453, raman:79133, bass_pct:36.65, pratt_pct:29.55, raman_pct:20.79, pratt_raman_gap:33320 },
  { timestamp:'2026-06-02T22:54:00', total_votes:386435, bass:141199, pratt:113811, raman:81230, bass_pct:36.54, pratt_pct:29.45, raman_pct:21.02, pratt_raman_gap:32581 },
  { timestamp:'2026-06-02T23:33:00', total_votes:399726, bass:145752, pratt:116572, raman:85412, bass_pct:36.46, pratt_pct:29.16, raman_pct:21.37, pratt_raman_gap:31160 },
  { timestamp:'2026-06-03T00:14:00', total_votes:416875, bass:151638, pratt:121166, raman:90231, bass_pct:36.37, pratt_pct:29.07, raman_pct:21.64, pratt_raman_gap:30935 },
  { timestamp:'2026-06-03T00:55:00', total_votes:436452, bass:157096, pratt:128319, raman:95054, bass_pct:35.99, pratt_pct:29.40, raman_pct:21.78, pratt_raman_gap:33265 },
  { timestamp:'2026-06-03T01:32:00', total_votes:444003, bass:159109, pratt:131384, raman:96835, bass_pct:35.84, pratt_pct:29.59, raman_pct:21.81, pratt_raman_gap:34549 },
  { timestamp:'2026-06-03T02:11:00', total_votes:496608, bass:172720, pratt:151149, raman:110848, bass_pct:34.78, pratt_pct:30.44, raman_pct:22.32, pratt_raman_gap:40301 },
  { timestamp:'2026-06-03T16:12:00', total_votes:525326, bass:183701, pratt:157116, raman:119809, bass_pct:34.97, pratt_pct:29.91, raman_pct:22.81, pratt_raman_gap:37307 },
  { timestamp:'2026-06-04T16:13:00', total_votes:557165, bass:195449, pratt:163549, raman:130473, bass_pct:35.08, pratt_pct:29.35, raman_pct:23.42, pratt_raman_gap:33076 },
  { timestamp:'2026-06-05T16:42:00', total_votes:617095, bass:215868, pratt:174260, raman:153588, bass_pct:34.98, pratt_pct:28.24, raman_pct:24.89, pratt_raman_gap:20672 },
  { timestamp:'2026-06-06T16:53:00', total_votes:675653, bass:235180, pratt:184596, raman:177102, bass_pct:34.81, pratt_pct:27.32, raman_pct:26.21, pratt_raman_gap:7494  },
  { timestamp:'2026-06-07T16:53:00', total_votes:723472, bass:250871, pratt:193085, raman:196198, bass_pct:34.68, pratt_pct:26.69, raman_pct:27.12, pratt_raman_gap:-3113 },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    if (request.method === 'DELETE' && url.pathname === '/mayor/history') {
      return handleClearHistory(env);
    }
    if (url.pathname === '/results') return handleResults(request, ctx, url);
    if (url.pathname === '/mayor')   return handleMayor(request, ctx, url, env);

    return corsResponse(JSON.stringify({
      worker: 'LA Mayor 2026 Results Proxy v2.1',
      endpoints: {
        'GET /results':         'Full proxied JSON from LA County Registrar (ElectionID 4338)',
        'GET /mayor':           'Parsed LA Mayor race — candidates, totals, gap analysis + full history',
        'DELETE /mayor/history':'Clear KV live snapshots (seed history is always preserved)'
      },
      source: FEED_URL,
      cache_ttl_seconds: CACHE_TTL,
      seed_batches: SEED_HISTORY.length,
      tip: 'Append ?fresh=1 to any endpoint to bypass edge cache'
    }), 200);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleResults(request, ctx, url) {
  const bypass   = url.searchParams.get('fresh') === '1';
  const cacheKey = new Request(url.origin + url.pathname, request);
  const cache    = caches.default;

  if (!bypass) {
    const cached = await cache.match(cacheKey);
    if (cached) return corsResponse(await cached.text(), 200, 'HIT');
  }

  const upstream = await fetchUpstream();
  if (!upstream.ok) {
    return corsResponse(JSON.stringify({ error: `Upstream error: ${upstream.status}` }), 502);
  }

  const text    = await upstream.text();
  const toCache = new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` }
  });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return corsResponse(text, 200, bypass ? 'BYPASS' : 'MISS');
}

async function handleMayor(request, ctx, url, env) {
  const bypass   = url.searchParams.get('fresh') === '1';
  const cacheKey = new Request(url.origin + url.pathname, request);
  const cache    = caches.default;

  if (!bypass) {
    const cached = await cache.match(cacheKey);
    if (cached) return corsResponse(await cached.text(), 200, 'HIT');
  }

  const upstream = await fetchUpstream();
  if (!upstream.ok) {
    return corsResponse(JSON.stringify({ error: `Upstream error: ${upstream.status}` }), 502);
  }

  const json   = await upstream.json();
  const parsed = parseMayor(json);

  // Merge seed history with KV live snapshots — only keep KV entries newer than seed
  const kvHistory = await loadHistory(env);
  const seedMax   = SEED_HISTORY[SEED_HISTORY.length - 1].total_votes;
  const newKv     = kvHistory.filter(s => s.total_votes > seedMax);

  // Append current live snapshot if not a duplicate
  const allHistory = [...SEED_HISTORY, ...newKv];
  const isDup      = parsed.total_votes === allHistory[allHistory.length - 1].total_votes;

  if (!isDup) {
    const snap = {
      timestamp:       new Date().toISOString(),
      total_votes:     parsed.total_votes,
      bass:            parsed.candidates.find(c => c.name.includes('BASS'))?.votes,
      pratt:           parsed.candidates.find(c => c.name.includes('PRATT'))?.votes,
      raman:           parsed.candidates.find(c => c.name.includes('RAMAN'))?.votes,
      bass_pct:        parsed.candidates.find(c => c.name.includes('BASS'))?.pct,
      pratt_pct:       parsed.candidates.find(c => c.name.includes('PRATT'))?.pct,
      raman_pct:       parsed.candidates.find(c => c.name.includes('RAMAN'))?.pct,
      pratt_raman_gap: parsed.margin_analysis.pratt_raman_gap_votes
    };
    newKv.push(snap);
    if (newKv.length > MAX_SNAPSHOTS) newKv.splice(0, newKv.length - MAX_SNAPSHOTS);
    ctx.waitUntil(saveHistory(env, newKv));
    allHistory.push(snap);
  }

  const result = { ...parsed, history: allHistory, seed_batches: SEED_HISTORY.length, kv_snapshots: newKv.length };
  const text   = JSON.stringify(result, null, 2);

  const toCache = new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` }
  });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return corsResponse(text, 200, bypass ? 'BYPASS' : 'MISS');
}

async function handleClearHistory(env) {
  try {
    if (env.SNAPSHOTS) await env.SNAPSHOTS.delete(KV_KEY);
    return corsResponse(JSON.stringify({ ok: true, message: 'KV live snapshots cleared. Seed history preserved.' }), 200);
  } catch (e) {
    return corsResponse(JSON.stringify({ ok: false, error: e.message }), 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KV HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function loadHistory(env) {
  try {
    if (!env.SNAPSHOTS) return [];
    const raw = await env.SNAPSHOTS.get(KV_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveHistory(env, history) {
  try {
    if (!env.SNAPSHOTS) return;
    await env.SNAPSHOTS.put(KV_KEY, JSON.stringify(history));
  } catch { /* silent */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE MAYOR RACE
// ─────────────────────────────────────────────────────────────────────────────

function parseMayor(data) {
  const allContests = data.Election.ContestGroups.flatMap(g => g.Contests);
  const mayor       = allContests.find(c => c.Title === MAYOR_TITLE);

  if (!mayor) return { error: 'Mayor contest not found', timestamp: data.Timestamp };

  const sorted = [...mayor.Candidates].sort((a, b) => b.Votes - a.Votes);
  const total  = sorted.reduce((s, c) => s + c.Votes, 0);

  const withPct = sorted.map((c, i) => ({
    rank:      i + 1,
    name:      c.Name,
    votes:     c.Votes,
    pct:       parseFloat((c.Votes / total * 100).toFixed(4)),
    advancing: i < 2
  }));

  const pratt = withPct.find(c => c.name.includes('PRATT'));
  const raman = withPct.find(c => c.name.includes('RAMAN'));
  const bass  = withPct.find(c => c.name.includes('BASS'));
  const gap    = pratt.votes - raman.votes;  // negative = Raman leads
  const gapPct = parseFloat((pratt.pct - raman.pct).toFixed(4));

  // Scenarios: what Pratt needs to retake 2nd (since Raman now leads)
  const scenarios = [50000, 100000, 150000, 200000, 250000].map(remaining => {
    const rpShare        = remaining * 0.60;
    const prattNeeded    = Math.round((-gap + rpShare) / 2);
    const ramanCeiling   = Math.round(rpShare - prattNeeded);
    const prattPctNeeded = parseFloat((prattNeeded / remaining * 100).toFixed(1));
    return {
      remaining_votes:        remaining,
      pratt_votes_needed:     prattNeeded,
      raman_ceiling:          ramanCeiling,
      pratt_pct_of_remaining: prattPctNeeded,
      verdict: prattPctNeeded > 45 ? 'very_hard' : prattPctNeeded > 38 ? 'unlikely' : 'possible'
    };
  });

  return {
    timestamp:    data.Timestamp,
    election_id:  data.Election.ID,
    total_votes:  total,
    candidates:   withPct,
    margin_analysis: {
      pratt_raman_gap_votes:       gap,
      pratt_raman_gap_pct:         gapPct,
      raman_leads:                 gap < 0,
      raman_lead_votes:            gap < 0 ? Math.abs(gap) : null,
      bass_pratt_gap_votes:        bass.votes - pratt.votes,
      raman_share_of_pratt_raman:  parseFloat((raman.votes / (raman.votes + pratt.votes) * 100).toFixed(2))
    },
    pratt_overtake_scenarios: scenarios
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUpstream() {
  return fetch(FEED_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'LA-Election-Worker/2.1' },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
}

function corsResponse(body, status, cacheStatus) {
  const headers = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Max-Age':      '86400',
    'X-Worker':                    'la-mayor-results',
    'Cache-Control':               'no-store'
  };
  if (cacheStatus) headers['X-Cache'] = cacheStatus;
  return new Response(body, { status, headers });
}
