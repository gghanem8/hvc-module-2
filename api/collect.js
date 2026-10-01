/**
 * /api/collect — Vercel serverless function
 *
 * WHY THIS EXISTS
 * The module used to POST straight to the Google Apps Script endpoint, with the
 * endpoint URL and its shared key both sitting in index.html. Since index.html is
 * downloaded by every browser, both were public: anyone who opened view-source
 * could read the whole dataset and write fabricated rows into it.
 *
 * Now the browser posts same-origin to /api/collect. This function holds the real
 * endpoint and key in Vercel environment variables, which never reach the client,
 * and forwards the payload. Nothing secret is left in the page.
 *
 * SETUP (once)
 *   1. Put this file at api/collect.js in the repo root.
 *   2. Vercel dashboard > your project > Settings > Environment Variables, add:
 *        SHEETS_ENDPOINT   the full Apps Script /exec URL
 *        SHEETS_KEY        the shared key (must match SHARED_KEY in Code.gs)
 *        ALLOWED_ORIGIN    your site's origin, e.g. https://hvc-module-2.vercel.app
 *      Set all three for Production and Preview.
 *   3. Redeploy.
 *
 * WHAT THIS DOES AND DOES NOT DEFEND
 *   Does:     removes the secret from the client; blocks cross-origin posts;
 *             rate-limits per IP; rejects oversized and malformed payloads;
 *             rejects event types that are not part of the module.
 *   Does not: stop someone who reads the page, copies a legitimate payload and
 *             replays it from a browser on your own origin. That requires real
 *             per-participant authentication, which means an LMS or SSO.
 */

const MAX_BODY_BYTES = 64 * 1024;

const ALLOWED_TYPES = new Set([
  'landing_view',
  'module_start',
  'pretest_submission',
  'posttest_submission',
  'case_submission',
  'case5_skipped',
  'module_complete'
]);

/* Per-IP rate limit. In-memory, so it resets when the lambda goes cold and is
   per-instance rather than global — enough to stop a script hammering the
   endpoint, not a distributed effort. Vercel KV would make it durable if that
   ever matters. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 40;          // a full run is ~13 events, so this is generous
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const bucket = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  bucket.push(now);
  hits.set(ip, bucket);

  // Keep the map from growing without bound on a long-lived instance.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > RATE_LIMIT_WINDOW_MS) hits.delete(k);
    }
  }
  return bucket.length > RATE_LIMIT_MAX;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/* Always answer 204. The browser sends these with sendBeacon and cannot read a
   response anyway, and a talkative error tells a prober what passed and what did
   not. Problems are logged server-side instead, where you can see them in the
   Vercel function logs. */
function done(res, note) {
  if (note) console.log('[collect]', note);
  res.status(204).end();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return done(res, 'non-POST ' + req.method);

  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';

  // sendBeacon sends an Origin header for cross-origin requests; same-origin
  // beacons may omit it, so an absent Origin is allowed and a present-but-wrong
  // one is not.
  if (allowedOrigin && origin && origin !== allowedOrigin) {
    return done(res, 'origin rejected: ' + origin);
  }
  if (allowedOrigin && !origin && referer && !referer.startsWith(allowedOrigin)) {
    return done(res, 'referer rejected: ' + referer);
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) return done(res, 'rate limited');

  // Body: Vercel parses JSON, but these arrive as text/plain from sendBeacon.
  let raw = req.body;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') {
    try { raw = JSON.stringify(raw); } catch (e) { return done(res, 'unstringifiable body'); }
  }
  if (!raw) return done(res, 'empty body');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return done(res, 'body too large: ' + Buffer.byteLength(raw, 'utf8'));
  }

  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return done(res, 'bad json'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return done(res, 'payload not an object');
  }
  if (!ALLOWED_TYPES.has(payload.type)) {
    return done(res, 'type rejected: ' + payload.type);
  }

  const endpoint = process.env.SHEETS_ENDPOINT;
  if (!endpoint) return done(res, 'SHEETS_ENDPOINT not configured');

  // Stamp server-side facts the client should not be trusted to assert.
  payload.serverReceivedAt = new Date().toISOString();
  payload.key = process.env.SHEETS_KEY || '';

  const url = endpoint + (endpoint.includes('?') ? '&' : '?')
            + 'key=' + encodeURIComponent(process.env.SHEETS_KEY || '')
            + '&action=collect';

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);
  } catch (err) {
    // The client keeps its own outbox and will retry, so a failure here is not
    // the end of that record.
    console.error('[collect] forward failed:', err && err.message);
  }

  return done(res);
};
