/**
 * LA Mayor 2026 — Election Results Cloudflare Worker v2.0
 * Adds KV-backed snapshot history; exposes history[] in /mayor response.
 * Routes:
 *   GET  /          — worker info
 *   GET  /results   — full proxied JSON from LA County
 *   GET  /mayor     — parsed mayor race + history[]
 *   DELETE /mayor/history — clear KV history (requires KV binding SNAPSHOTS)
 */

const FEED_URL    = 'https://results.lavote.net/electionresults/json?ElectionID=4338';
const MAYOR_TITLE = 'LOS ANGELES CITY PRIMARY NOMINATING ELECTION Mayor';
const CACHE_TTL   = 60;
const MAX_SNAPSHOTS = 200;
const KV_KEY      = 'snapshots';

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
      worker: 'LA Mayor 2026 Results Proxy v2.0',
      endpoints: {
        'GET /results':         'Full proxied JSON from LA County Registrar (ElectionID 4338)',
        'GET /mayor':           'Parsed LA Mayor race — candidates, totals, gap analysis + KV history',
        'DELETE /mayor/history':'Clear KV snapshot history'
      },
      source: FEED_URL,
      cache_ttl_seconds: CACHE_TTL,
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

  // KV history — deduplicate by total_votes, store async
  const history = await loadHistory(env);
  const isDup   = history.length > 0 && history[history.length - 1].total_votes === parsed.total_votes;
  if (!isDup) {
    const snap = {
      fetched_at:   new Date().toISOString(),
      timestamp:    parsed.timestamp,
      total_votes:  parsed.total_votes,
      candidates:   parsed.candidates.slice(0, 3).map(c => ({ name: c.name, votes: c.votes, pct: c.pct })),
      pratt_raman_gap: parsed.margin_analysis.pratt_raman_gap_votes
    };
    history.push(snap);
    if (history.length > MAX_SNAPSHOTS) history.splice(0, history.length - MAX_SNAPSHOTS);
    ctx.waitUntil(saveHistory(env, history));
  }

  const result = { ...parsed, history, kv_snapshots: history.length };
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
    return corsResponse(JSON.stringify({ ok: true, message: 'History cleared' }), 200);
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
  const gap    = pratt.votes - raman.votes;
  const gapPct = parseFloat((pratt.pct - raman.pct).toFixed(4));

  const scenarios = [150000, 200000, 250000, 300000, 350000].map(remaining => {
    const rpShare        = remaining * 0.60;
    const ramanNeeded    = Math.round((gap + rpShare) / 2);
    const prattCeiling   = Math.round(rpShare - ramanNeeded);
    const ramanPctNeeded = parseFloat((ramanNeeded / remaining * 100).toFixed(1));
    return {
      remaining_votes:       remaining,
      raman_votes_needed:    ramanNeeded,
      pratt_ceiling:         prattCeiling,
      raman_pct_of_remaining: ramanPctNeeded,
      verdict: ramanPctNeeded > 45 ? 'very_hard' : ramanPctNeeded > 38 ? 'unlikely' : 'possible'
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
      bass_pratt_gap_votes:        bass.votes - pratt.votes,
      raman_share_of_pratt_raman:  parseFloat((raman.votes / (raman.votes + pratt.votes) * 100).toFixed(2))
    },
    overtake_scenarios: scenarios
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUpstream() {
  return fetch(FEED_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'LA-Election-Worker/2.0' },
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
