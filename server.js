'use strict';

/* ============================================================
   JSv6 Checkout + BCDC — Server-side proxy
   ─────────────────────────────────────────────────────────────
   Express server que:
     • Sirve los estáticos (index.html, app.js, styles.css)
     • Proxea las llamadas REST a PayPal (OAuth, Orders, STC)
     • Lee/escribe credenciales en .env (Sandbox y Live)
     • Enmascara info sensible en las respuestas (access_token,
       client_secret, etc.) preservando los primeros 5 caracteres
       y enmascarando el resto con "*", manteniendo la respuesta
       COMPLETA (no truncada).
   client_secret nunca abandona el servidor.
   ============================================================ */

const express = require('express');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');
const PORT = process.env.PORT || 8080;

// ─────────────────────────────────────────────────────────────
// .env helpers — crea el archivo si no existe
// ─────────────────────────────────────────────────────────────

const DEFAULT_ENV = `# PayPal Sandbox credentials
SANDBOX_CLIENT_ID=AetBG_tJkcdYQ8tzjbBSTeSXUC4TpV8wDjIhEcdeIprHKMa4daLFsraioWHNMZQ8qsTj6H_Bao1_BRF6
SANDBOX_CLIENT_SECRET=EEpDEyOsZf98F_dd-brLGIkSSoeo6VfYzWXvYu-IEXwqrMlugzcvGcWVTEbJURLKYJF3BPvORTyvxHq0
SANDBOX_MERCHANT_ID=SCNFPFK46FW9L

# PayPal Live credentials
LIVE_CLIENT_ID=
LIVE_CLIENT_SECRET=
LIVE_MERCHANT_ID=
`;

function ensureEnvExists() {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, DEFAULT_ENV, { mode: 0o600 });
    console.log(`[server] .env not found — generated default at ${ENV_PATH}`);
  }
}

function readEnvFile() {
  ensureEnvExists();
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  return dotenv.parse(raw);
}

function writeEnvFile(parsed) {
  const lines = [];
  lines.push('# PayPal Sandbox credentials');
  lines.push(`SANDBOX_CLIENT_ID=${parsed.SANDBOX_CLIENT_ID || ''}`);
  lines.push(`SANDBOX_CLIENT_SECRET=${parsed.SANDBOX_CLIENT_SECRET || ''}`);
  lines.push(`SANDBOX_MERCHANT_ID=${parsed.SANDBOX_MERCHANT_ID || ''}`);
  lines.push('');
  lines.push('# PayPal Live credentials');
  lines.push(`LIVE_CLIENT_ID=${parsed.LIVE_CLIENT_ID || ''}`);
  lines.push(`LIVE_CLIENT_SECRET=${parsed.LIVE_CLIENT_SECRET || ''}`);
  lines.push(`LIVE_MERCHANT_ID=${parsed.LIVE_MERCHANT_ID || ''}`);
  lines.push('');
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
}

function getCreds() {
  const e = readEnvFile();
  return {
    sandbox: {
      clientId:     e.SANDBOX_CLIENT_ID     || '',
      clientSecret: e.SANDBOX_CLIENT_SECRET || '',
      merchantId:   e.SANDBOX_MERCHANT_ID   || '',
      apiBase: 'https://api-m.sandbox.paypal.com',
      sdkUrl:  'https://www.sandbox.paypal.com/web-sdk/v6/core'
    },
    live: {
      clientId:     e.LIVE_CLIENT_ID     || '',
      clientSecret: e.LIVE_CLIENT_SECRET || '',
      merchantId:   e.LIVE_MERCHANT_ID   || '',
      apiBase: 'https://api-m.paypal.com',
      sdkUrl:  'https://www.paypal.com/web-sdk/v6/core'
    }
  };
}

// ─────────────────────────────────────────────────────────────
// MASKING — primer 5 caracteres + "*" para el resto.
// Preserva la respuesta COMPLETA (estructura, longitud, claves).
// ─────────────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  'access_token', 'refresh_token', 'id_token',
  'client_secret', 'clientSecret',
  'authorization', 'Authorization',
  'nonce',
  'app_id', 'appId'        // info propietario, conviene enmascarar también
]);

function maskValue(v) {
  if (typeof v !== 'string') return v;
  if (v.length <= 5)   return v + '*'.repeat(Math.max(0, 5 - v.length));
  return v.slice(0, 5) + '*'.repeat(v.length - 5);
}

function maskBasicAuthHeader(v) {
  // "Basic xxxxxxxxxxxx" → muestra los primeros 5 chars del valor base64
  if (typeof v !== 'string') return v;
  const m = v.match(/^Basic\s+(.+)$/i);
  if (m) return `Basic ${maskValue(m[1])}`;
  const b = v.match(/^Bearer\s+(.+)$/i);
  if (b) return `Bearer ${maskValue(b[1])}`;
  return maskValue(v);
}

function maskDeep(value) {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (lower === 'authorization') {
        out[k] = maskBasicAuthHeader(v);
      } else if (SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(lower)) {
        out[k] = typeof v === 'string' ? maskValue(v) : maskDeep(v);
      } else {
        out[k] = maskDeep(v);
      }
    }
    return out;
  }
  return value;
}

function isValidCMID(cmid) {
  return typeof cmid === 'string'
    && cmid.length >= 1
    && cmid.length <= 32
    && /^[0-9A-Za-z]+$/.test(cmid);
}

function buildSTCBody() {
  return {
    additional_data: [
      { key: 'sender_account_id',   value: '518ec6feed47eb04601be72bec147d96' },
      { key: 'sender_first_name',   value: 'JHON' },
      { key: 'sender_last_name',    value: 'DOE DOE' },
      { key: 'sender_email',        value: 'jdoe@paypal.com' },
      { key: 'sender_phone',        value: '9511688216' },
      { key: 'sender_country_code', value: 'MX' },
      { key: 'sender_create_date',  value: '2020-12-10T13:52:19-06:00' },
      { key: 'highrisk_txn_flag',   value: '0' },
      { key: 'vertical',            value: 'Retail' },
      { key: 'cd_string_one',       value: '1' },
      { key: 'cd_string_two',       value: 'Playera Nike etc' }
    ]
  };
}

// ─────────────────────────────────────────────────────────────
// Token cache (en memoria) — un access_token por entorno
// ─────────────────────────────────────────────────────────────

const tokenCache = {
  sandbox: { token: '', expiresAt: 0 },
  live:    { token: '', expiresAt: 0 }
};

async function fetchAccessTokenRaw(env) {
  const creds = getCreds()[env];
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error(`Missing ${env.toUpperCase()} credentials in .env`);
  }
  const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const url  = `${creds.apiBase}/v1/oauth2/token`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }

  return {
    status: r.status,
    rawData: data,
    log: {
      method:   'POST',
      endpoint: url,
      status:   r.status,
      request: {
        headers: {
          'Authorization': maskBasicAuthHeader(`Basic ${auth}`),
          'Content-Type':  'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      },
      response: maskDeep(data)
    }
  };
}

async function getAccessToken(env) {
  const cache = tokenCache[env];
  const now = Date.now();
  if (cache.token && cache.expiresAt - 60_000 > now) {
    return { token: cache.token, log: null };
  }
  const { status, rawData, log } = await fetchAccessTokenRaw(env);
  if (status >= 400 || !rawData?.access_token) {
    return { token: '', log, error: rawData };
  }
  cache.token = rawData.access_token;
  cache.expiresAt = now + Number(rawData.expires_in || 300) * 1000;
  return { token: cache.token, log };
}

async function callSTCRaw(env, cmid, stcBody, accessToken) {
  const creds = getCreds()[env];
  const url = `${creds.apiBase}/v1/risk/transaction-contexts/${encodeURIComponent(creds.merchantId)}/${encodeURIComponent(cmid)}`;
  const sentHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type':  'application/json'
  };
  const r = await fetch(url, {
    method:  'PUT',
    headers: sentHeaders,
    body:    JSON.stringify(stcBody)
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text || null; }

  return {
    status: r.status,
    data,
    log: {
      method:   'PUT',
      endpoint: url,
      status:   r.status,
      request: {
        headers: maskDeep(sentHeaders),
        body:    stcBody
      },
      response: maskDeep(data)
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '2mb' }));

// No-cache para todos los estáticos: este es un demo de desarrollo y
// queremos que cualquier cambio en index.html/app.js/styles.css se
// refleje en el siguiente refresh sin tener que hacer hard-reload.
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(ROOT, {
  extensions: ['html'],
  etag: false,
  lastModified: false,
  cacheControl: false
}));

// GET /api/config — datos PÚBLICOS necesarios para iniciar el SDK v6
app.get('/api/config', (_req, res) => {
  const creds = getCreds();
  res.json({
    sandbox: {
      clientId:   creds.sandbox.clientId,
      apiBase:    creds.sandbox.apiBase,
      sdkUrl:     creds.sandbox.sdkUrl
    },
    live: {
      clientId:   creds.live.clientId,
      apiBase:    creds.live.apiBase,
      sdkUrl:     creds.live.sdkUrl
    }
  });
});

// GET /api/credentials — devuelve client_id, client_secret, merchant_id
// (se usan para precargar el modal CREDS — solo accesible desde el host).
app.get('/api/credentials', (_req, res) => {
  const creds = getCreds();
  res.json({
    sandbox: {
      clientId:     creds.sandbox.clientId,
      clientSecret: creds.sandbox.clientSecret,
      merchantId:   creds.sandbox.merchantId
    },
    live: {
      clientId:     creds.live.clientId,
      clientSecret: creds.live.clientSecret,
      merchantId:   creds.live.merchantId
    }
  });
});

// POST /api/credentials — sobreescribe .env, invalida el cache de tokens.
app.post('/api/credentials', (req, res) => {
  const { sandbox, live } = req.body || {};
  if (!sandbox || !live) {
    return res.status(400).json({ error: 'Both sandbox and live credentials are required' });
  }
  const parsed = readEnvFile();
  parsed.SANDBOX_CLIENT_ID     = String(sandbox.clientId     || '').trim();
  parsed.SANDBOX_CLIENT_SECRET = String(sandbox.clientSecret || '').trim();
  parsed.SANDBOX_MERCHANT_ID   = String(sandbox.merchantId   || '').trim();
  parsed.LIVE_CLIENT_ID        = String(live.clientId        || '').trim();
  parsed.LIVE_CLIENT_SECRET    = String(live.clientSecret    || '').trim();
  parsed.LIVE_MERCHANT_ID      = String(live.merchantId      || '').trim();

  try {
    writeEnvFile(parsed);
    tokenCache.sandbox = { token: '', expiresAt: 0 };
    tokenCache.live    = { token: '', expiresAt: 0 };
    res.json({ ok: true, message: 'Credentials saved to .env' });
  } catch (e) {
    res.status(500).json({ error: 'Could not write .env: ' + e.message });
  }
});

// POST /api/oauth/token — fuerza la obtención de un token y devuelve
// la entrada de log con la respuesta completa enmascarada.
app.post('/api/oauth/token', async (req, res) => {
  const env = req.body?.env === 'live' ? 'live' : 'sandbox';
  try {
    // Forzamos siempre una llamada real para que el log refleje la operación.
    const { status, rawData, log } = await fetchAccessTokenRaw(env);
    if (status < 400 && rawData?.access_token) {
      tokenCache[env].token = rawData.access_token;
      tokenCache[env].expiresAt = Date.now() + Number(rawData.expires_in || 300) * 1000;
    }
    res.status(status).json({ log });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders — crea una orden en PayPal
app.post('/api/orders', async (req, res) => {
  const env  = req.body?.env === 'live' ? 'live' : 'sandbox';
  const cmid = String(req.body?.cmid || '');
  const payload = req.body?.payload;
  const requestId = String(req.body?.requestId || crypto.randomUUID());
  if (!payload) return res.status(400).json({ error: 'Missing payload' });
  if (!isValidCMID(cmid)) return res.status(400).json({ error: 'Invalid CMID' });
  const creds = getCreds()[env];

  try {
    const tokenRes = await getAccessToken(env);
    if (!tokenRes.token) {
      return res.status(401).json({ error: 'Could not obtain access token', oauthLog: tokenRes.log });
    }

    let stcLog = null;
    if (creds.merchantId) {
      try {
        stcLog = (await callSTCRaw(env, cmid, buildSTCBody(), tokenRes.token)).log;
      } catch (stcErr) {
        stcLog = {
          method: 'PUT',
          endpoint: `${creds.apiBase}/v1/risk/transaction-contexts/${encodeURIComponent(creds.merchantId)}/${encodeURIComponent(cmid)}`,
          status: 'WARN',
          request: { cmid },
          response: { ok: false, message: stcErr.message }
        };
      }
    }

    const url = `${creds.apiBase}/v2/checkout/orders`;
    const sentHeaders = {
      'Authorization':              `Bearer ${tokenRes.token}`,
      'Content-Type':               'application/json',
      'PayPal-Client-Metadata-Id':  cmid,
      'PayPal-Request-Id':          requestId
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: sentHeaders,
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }

    res.status(r.status).json({
      oauthLog: tokenRes.log || null,
      stcLog,
      log: {
        method:   'POST',
        endpoint: url,
        status:   r.status,
        request: {
          headers: maskDeep(sentHeaders),
          body:    payload
        },
        response: maskDeep(data)
      },
      data: maskDeep(data)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/:id — detalles enriquecidos de la orden (incluye installments,
// processor_response, payment_source completo, etc.)  Útil para llamarse
// inmediatamente DESPUÉS de un capture y ver la metadata final.
app.get('/api/orders/:id', async (req, res) => {
  const env = req.query.env === 'live' ? 'live' : 'sandbox';
  const orderId = req.params.id;
  const creds = getCreds()[env];

  try {
    const tokenRes = await getAccessToken(env);
    if (!tokenRes.token) {
      return res.status(401).json({ error: 'Could not obtain access token', oauthLog: tokenRes.log });
    }
    const url = `${creds.apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}`;
    const sentHeaders = {
      'Authorization': `Bearer ${tokenRes.token}`,
      'Content-Type':  'application/json'
    };
    const r = await fetch(url, { method: 'GET', headers: sentHeaders });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }

    res.status(r.status).json({
      oauthLog: tokenRes.log || null,
      log: {
        method:   'GET',
        endpoint: url,
        status:   r.status,
        request:  { headers: maskDeep(sentHeaders) },
        response: maskDeep(data)
      },
      data: maskDeep(data)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders/:id/capture
app.post('/api/orders/:id/capture', async (req, res) => {
  const env  = req.body?.env === 'live' ? 'live' : 'sandbox';
  const cmid = String(req.body?.cmid || '');
  const negTest = String(req.body?.negTest || 'none');
  const requestId = String(req.body?.requestId || crypto.randomUUID());
  const orderId = req.params.id;
  const creds = getCreds()[env];
  if (!isValidCMID(cmid)) return res.status(400).json({ error: 'Invalid CMID' });

  try {
    const tokenRes = await getAccessToken(env);
    if (!tokenRes.token) {
      return res.status(401).json({ error: 'Could not obtain access token', oauthLog: tokenRes.log });
    }
    const url = `${creds.apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;
    const sentHeaders = {
      'Authorization':              `Bearer ${tokenRes.token}`,
      'Content-Type':               'application/json',
      'PayPal-Client-Metadata-Id':  cmid,
      'PayPal-Request-Id':          requestId
    };
    if (negTest === 'INSTRUMENT_DECLINED' || negTest === 'TRANSACTION_REFUSED') {
      sentHeaders['PayPal-Mock-Response'] = JSON.stringify({ mock_application_codes: negTest });
    }

    const r = await fetch(url, {
      method: 'POST',
      headers: sentHeaders,
      body: '{}'
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }

    res.status(r.status).json({
      oauthLog: tokenRes.log || null,
      log: {
        method:   'POST',
        endpoint: url,
        status:   r.status,
        request: {
          headers: maskDeep(sentHeaders),
          body:    {}
        },
        response: maskDeep(data)
      },
      data: maskDeep(data)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/stc — Sender Transaction Context
app.put('/api/stc', async (req, res) => {
  const env  = req.body?.env === 'live' ? 'live' : 'sandbox';
  const cmid = String(req.body?.cmid || '');
  const stcBody = req.body?.body;
  const creds = getCreds()[env];

  if (!creds.merchantId || !cmid) {
    return res.json({ skipped: true, reason: 'missing merchantId or cmid' });
  }
  if (!isValidCMID(cmid)) return res.status(400).json({ error: 'Invalid CMID' });
  try {
    const tokenRes = await getAccessToken(env);
    if (!tokenRes.token) {
      return res.status(401).json({ error: 'Could not obtain access token', oauthLog: tokenRes.log });
    }
    const { status, data, log } = await callSTCRaw(env, cmid, stcBody, tokenRes.token);

    res.status(status).json({
      oauthLog: tokenRes.log || null,
      log,
      data: maskDeep(data)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback: cualquier ruta no-API → index.html (SPA-friendly)
app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────

ensureEnvExists();

if (typeof fetch !== 'function') {
  console.error('✗ This server needs Node.js 18+ (built-in fetch).');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`✓ JSv6 + BCDC demo server running at http://localhost:${PORT}`);
  console.log(`  .env path: ${ENV_PATH}`);
});
