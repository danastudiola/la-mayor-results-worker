/**
 * LA Mayor 2026 — Election Results Cloudflare Worker v1.1
 * Fixes sticky cache: upstream CF cache disabled, ?fresh=1 bypass, TTL 60s
 */

const FEED_URL = 'https://results.lavote.net/electionresults/json?ElectionID=4338';
const MAYOR_TITLE = 'LOS ANGELES CITY PRIMARY NOMINATING ELECTION Mayor';
const CACHE_TTL = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(null, 204);
    if (url.pathname === '/results') return handleResults(request, ctx, url);
    if (url.pathname === '/mayor')   return handleMayor(request, ctx, url);

    return corsResponse(JSON.stringify({
      worker: 'LA Mayor 2026 Results Proxy v1.1',
      endpoints: {
        '/results': 'Full proxied JSON from LA County Registrar (ElectionID 4338)',
        '/mayor':   'Parsed LA Mayor race — candidates, totals, gap analysis'
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
  const bypass = url.searchParams.get('fresh') === '1';
  const cacheKey = new Request(url.origin + url.pathname, request);
  const cache = caches.default;

  if (!bypass) {
    const cached = await cache.match(cacheKey);
    if (cached) return corsResponse(await cached.text(), 200, 'HIT');
  }

  const upstream = await fetchUpstream();
  if (!upstream.ok) {
    return corsResponse(JSON.stringify({ error: `Upstream error: ${upstream.status}` }), 502);
  }

  const text = await upstream.text();
  const toCache = new Response(text, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL}`
    }
  });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return corsResponse(text, 200, bypass ? 'BYPASS' : 'MISS');
}

async function handleMayor(request, ctx, url) {
  const bypass = url.searchParams.get('fresh') === '1';
  const cacheKey = new Request(url.origin + url.pathname, request);
  const cache = caches.default;

  if (!bypass) {
    const cached = await cache.match(cacheKey);
    if (cached) return corsResponse(await cached.text(), 200, 'HIT');
  }

  const upstream = await fetchUpstream();
  if (!upstream.ok) {
    return corsResponse(JSON.stringify({ error: `Upstream error: ${upstream.status}` }), 502);
  }

  const json = await upstream.json();
  const parsed = parseMayor(json);
  const text = JSON.stringify(parsed, null, 2);

  const toCache = new Response(text, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL}`
    }
  });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return corsResponse(text, 200, bypass ? 'BYPASS' : 'MISS');
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE MAYOR RACE
// ─────────────────────────────────────────────────────────────────────────────

function parseMayor(data) {
  const allContests = data.Election.ContestGroups.flatMap(g => g.Contests);
  const mayor = allContests.find(c => c.Title === MAYOR_TITLE);

  if (!mayor) return { error: 'Mayor contest not found', timestamp: data.Timestamp };

  const sorted = [...mayor.Candidates].sort((a, b) => b.Votes - a.Votes);
  const total = sorted.reduce((s, c) => s + c.Votes, 0);

  const withPct = sorted.map((c, i) => ({
    rank: i + 1,
    name: c.Name,
    votes: c.Votes,
    pct: parseFloat((c.Votes / total * 100).toFixed(4)),
    advancing: i < 2
  }));

  const pratt = withPct.find(c => c.name.includes('PRATT'));
  const raman = withPct.find(c => c.name.includes('RAMAN'));
  const bass  = withPct.find(c => c.name.includes('BASS'));
  const gap     = pratt.votes - raman.votes;
  const gapPct  = parseFloat((pratt.pct - raman.pct).toFixed(4));

  const scenarios = [150000, 200000, 250000, 300000, 350000].map(remaining => {
    const rpShare = remaining * 0.60;
    const ramanNeeded = Math.round((gap + rpShare) / 2);
    const prattCeiling = Math.round(rpShare - ramanNeeded);
    const ramanPctNeeded = parseFloat((ramanNeeded / remaining * 100).toFixed(1));
    return {
      remaining_votes: remaining,
      raman_votes_needed: ramanNeeded,
      pratt_ceiling: prattCeiling,
      raman_pct_of_remaining: ramanPctNeeded,
      verdict: ramanPctNeeded > 45 ? 'very_hard' : ramanPctNeeded > 38 ? 'unlikely' : 'possible'
    };
  });

  return {
    timestamp: data.Timestamp,
    election_id: data.Election.ID,
    total_votes: total,
    candidates: withPct,
    margin_analysis: {
      pratt_raman_gap_votes: gap,
      pratt_raman_gap_pct: gapPct,
      bass_pratt_gap_votes: bass.votes - pratt.votes,
      raman_share_of_pratt_raman: parseFloat((raman.votes / (raman.votes + pratt.votes) * 100).toFixed(2))
    },
    overtake_scenarios: scenarios
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUpstream() {
  // cf.cacheTtl: 0 + cacheEverything: false forces Cloudflare to always
  // fetch fresh from lavote.net instead of serving its own edge-cached copy
  return fetch(FEED_URL, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'LA-Election-Worker/1.1'
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false
    }
  });
}

function corsResponse(body, status, cacheStatus) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'X-Worker': 'la-mayor-results',
    'Cache-Control': 'no-store'
  };
  if (cacheStatus) headers['X-Cache'] = cacheStatus;
  return new Response(body, { status, headers });
}
