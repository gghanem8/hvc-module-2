/**
 * /api/health — chain diagnostic for the collection pipeline.
 *
 * WHY THIS EXISTS
 * /api/collect always answers 204 by design: the browser sends with sendBeacon
 * and cannot read a response, and a talkative error tells a prober what passed.
 * The cost is that every failure downstream is invisible from the page, and on
 * the Hobby plan the function logs only go back one hour, so a run that failed
 * yesterday leaves no evidence at all.
 *
 * This endpoint tests the same chain /api/collect uses and says where it breaks.
 * It is READ ONLY. It sends a GET to the Apps Script deployment, which hits
 * doGet, which writes nothing. No row is added to the dataset.
 *
 * WHAT IT NEVER RETURNS
 * Not SHEETS_KEY, not the Apps Script URL. Only whether each value is set, the
 * host it points at, and what the far end answered. Safe to leave deployed.
 *
 * HOW TO READ THE RESULT
 *   appsScript.status 200 + body {"status":"ok"}  the deployment is live and
 *                                                 reachable; the break is the
 *                                                 shared key, the script's
 *                                                 spreadsheet binding, or a
 *                                                 rejected payload. Run diag()
 *                                                 in the Apps Script editor.
 *   appsScript.status 404                         SHEETS_ENDPOINT points at a
 *                                                 deployment that no longer
 *                                                 exists. Redeploy the web app
 *                                                 and update the variable.
 *   appsScript.status 401/403, or an HTML body    the web app is not deployed
 *                                                 with access set to "Anyone".
 *   env.sheetsEndpoint false                      the variable is not set on
 *                                                 this environment, or was set
 *                                                 after the last deployment.
 *                                                 Vercel applies variable
 *                                                 changes to NEW deployments
 *                                                 only — redeploy.
 *   originMatchesHost false                       ALLOWED_ORIGIN does not match
 *                                                 the address students opened,
 *                                                 so every event is dropped at
 *                                                 the origin check.
 */

module.exports = async function handler(req, res) {
  const endpoint = process.env.SHEETS_ENDPOINT || '';
  const key = process.env.SHEETS_KEY || '';
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const thisOrigin = host ? proto + '://' + host : '';

  const out = {
    checkedAt: new Date().toISOString(),
    env: {
      sheetsEndpoint: Boolean(endpoint),
      sheetsKey: Boolean(key),
      sheetsKeyLength: key.length,                  // length only, never the value
      keyIsPlaceholder: /CHANGE-?ME/i.test(key),
      allowedOrigin: allowedOrigin || null
    },
    request: {
      origin: thisOrigin || null,
      originMatchesHost: allowedOrigin ? allowedOrigin === thisOrigin : null
    },
    endpointShape: null,
    appsScript: null
  };

  if (endpoint) {
    let host2 = null, pathname = null;
    try { const u = new URL(endpoint); host2 = u.host; pathname = u.pathname; } catch (e) {}
    out.endpointShape = {
      host: host2,
      endsWithExec: Boolean(pathname && /\/exec$/.test(pathname)),
      looksLikeAppsScript: host2 === 'script.google.com'
    };

    // GET, not POST. doGet writes nothing, so this cannot touch the dataset.
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(endpoint + (endpoint.includes('?') ? '&' : '?') + 'action=ping', {
        method: 'GET',
        signal: ctl.signal,
        redirect: 'follow'
      });
      clearTimeout(timer);
      const text = (await r.text()).slice(0, 300);
      out.appsScript = {
        status: r.status,
        finalHost: (() => { try { return new URL(r.url).host; } catch (e) { return null; } })(),
        bodyIsJson: /^\s*\{/.test(text),
        body: text
      };
    } catch (err) {
      out.appsScript = { status: null, error: String(err && err.message || err) };
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end(JSON.stringify(out, null, 2));
};
