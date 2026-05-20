'use strict';

/* ============================================================
   JSv6 Checkout + BCDC Server-Side Demo — Client app
   ─────────────────────────────────────────────────────────────
   Toda la firma con client_secret vive en el servidor; este
   archivo solo:
     • Carga el SDK v6 con el clientId público devuelto por /api/config
     • Llama a los endpoints /api/oauth/token, /api/orders,
       /api/orders/:id/capture y /api/stc para operar con PayPal.
     • Renderiza el log con la respuesta COMPLETA enmascarada
       (los primeros 5 caracteres + "*" para info sensible).
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN — se carga desde /api/config en init()
// ─────────────────────────────────────────────────────────────

let PAYPAL_CONFIG = {
  sandbox: { clientId: '', merchantId: '', apiBase: 'https://api-m.sandbox.paypal.com', sdkUrl: 'https://www.sandbox.paypal.com/web-sdk/v6/core' },
  live:    { clientId: '', merchantId: '', apiBase: 'https://api-m.paypal.com',         sdkUrl: 'https://www.paypal.com/web-sdk/v6/core' }
};

const BUYER = {
  email_address: 'jdoe@paypal.com',
  phone_number: { national_number: '5546723845' },
  name: { given_name: 'John', surname: 'Doe' },
  address: {
    address_line_1: 'Mariano Escobedo 476',
    address_line_2: 'Col Anzures',
    admin_area_2:   'Miguel Hidalgo',
    admin_area_1:   'DF',
    postal_code:    '11590',
    country_code:   'MX'
  }
};

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────

const state = {
  cmid: '',
  sdkInstance: null,
  paymentMethods: null,
  sdkScriptId: 'paypal-jsv6-script',
  sdkLoadGeneration: 0,
  sdkLoadedUrl: null,
  lastUsedFlow: null,
  isResetting: false,
  bcdcSession: null,
  bcdcInitialized: false,
  bcdcClickBound: false,
  orderRequestIds: {}
};

// ─────────────────────────────────────────────────────────────
// HELPERS BÁSICOS
// ─────────────────────────────────────────────────────────────

const $ = (selector) => document.querySelector(selector);

function getEnvName() {
  const checked = document.querySelector('input[name="paypal-env"]:checked');
  return checked && checked.value === 'live' ? 'live' : 'sandbox';
}

function getEnvConfig() { return PAYPAL_CONFIG[getEnvName()]; }

function getCurrency() {
  const checked = document.querySelector('input[name="currency"]:checked');
  return (checked && checked.value === 'USD') ? 'USD' : 'MXN';
}

function getLocale() { return getCurrency() === 'USD' ? 'en-US' : 'es-MX'; }

function getNegativeTestMode() {
  const checked = document.querySelector('input[name="neg-test"]:checked');
  const v = checked && checked.value;
  return v === 'INSTRUMENT_DECLINED' || v === 'TRANSACTION_REFUSED' ? v : 'none';
}

function getAmount() {
  const raw = Number($('#amount').value);
  return Number.isFinite(raw) && raw > 0 ? raw.toFixed(2) : '1.00';
}

function formatMoney(value, currencyCode) {
  currencyCode = currencyCode || getCurrency();
  const n = Number(value);
  const formatted = Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(value || '0.00');
  return `$${formatted} ${currencyCode}`;
}

function showNotification(message, type = 'info') {
  const node = $('#notification');
  node.textContent = message;
  node.className = `notice ${type} show`;
}

function hideNotification() {
  const node = $('#notification');
  node.className = 'notice';
  node.textContent = '';
}

function setLoading(isLoading) {
  $('#loader').classList.toggle('show', isLoading);
}

function generateCMID() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function generateRequestId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function updateEnvHint() {
  document.getElementById('env-bar').classList.toggle('is-live', getEnvName() === 'live');
}

function updateAmtLabel() {
  const cur = getCurrency();
  const label = document.getElementById('amt-label');
  if (label) label.textContent = `AMT ${cur}`;
  document.documentElement.lang = getLocale();
}

function updateSummaryTotal() {
  $('#summary-total').textContent = formatMoney(getAmount());
}

function updateNavPills(flow) {
  const navPaypal = document.getElementById('nav-paypal');
  const navBcdc   = document.getElementById('nav-bcdc');
  if (!navPaypal || !navBcdc) return;
  navPaypal.classList.toggle('active-flow', flow !== 'card');
  navBcdc.classList.toggle('active-flow', flow === 'card');
}

// ─────────────────────────────────────────────────────────────
// HELPERS DE PARSEO / ESCAPE / MASKING
// ─────────────────────────────────────────────────────────────

function safeParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlForJson(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function syntaxHighlightJson(value) {
  const json = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? {}, null, 2);
  return escapeHtmlForJson(json).replace(
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) cls = /:\s*$/.test(match) ? 'json-key' : 'json-string';
      else if (/^(?:true|false)$/.test(match)) cls = 'json-boolean';
      else if (/^null$/.test(match)) cls = 'json-null';
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

/** Enmascara un string mostrando los primeros 5 caracteres y "*"
 *  para el resto, preservando la longitud original.            */
function maskString(v) {
  if (typeof v !== 'string') return v;
  if (v.length <= 5) return v + '*'.repeat(Math.max(0, 5 - v.length));
  return v.slice(0, 5) + '*'.repeat(v.length - 5);
}

const SENSITIVE_KEYS = new Set([
  'access_token', 'refresh_token', 'id_token',
  'client_secret', 'clientSecret',
  'authorization', 'Authorization',
  'nonce', 'app_id', 'appId'
]);

/** Recorrido profundo: enmascara claves sensibles preservando estructura. */
function maskSecrets(input) {
  if (Array.isArray(input)) return input.map(maskSecrets);
  if (input && typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' && typeof v === 'string') {
        // "Bearer xxx" o "Basic xxx" → mostrar 5 caracteres del valor
        const m = v.match(/^(Bearer|Basic)\s+(.+)$/i);
        out[k] = m ? `${m[1]} ${maskString(m[2])}` : maskString(v);
      } else if (SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(lower)) {
        out[k] = typeof v === 'string' ? maskString(v) : maskSecrets(v);
      } else {
        out[k] = maskSecrets(v);
      }
    }
    return out;
  }
  return input;
}

// ─────────────────────────────────────────────────────────────
// LOGGING — entradas colapsables
// ─────────────────────────────────────────────────────────────

function methodClass(method) {
  const m = String(method || '').toLowerCase();
  if (m === 'sdk') return 'sdk';
  if (m === 'script') return 'script';
  return ['get', 'post', 'put', 'delete'].includes(m) ? m : '';
}

function addLog({ method, endpoint, request, response, status, error }) {
  const stream = $('#log-stream');
  const empty = stream.querySelector('.empty-logs');
  if (empty) empty.remove();

  const code = status || (error ? 'ERR' : '...');
  let statusClass = 'pending';
  if (typeof status === 'number') {
    statusClass = `s${String(status)[0]}`;
  } else if (status === 'PASS' || status === 'OK') {
    statusClass = 's2';
  } else if (status === 'BLOCKED' || status === 'WARN') {
    statusClass = 'warn';
  } else if (status === 'ERROR' || status === 'FAIL') {
    statusClass = 's4';
  }
  const ts = new Date().toLocaleTimeString('en-US');

  const entry = document.createElement('article');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <div class="log-head" role="button" tabindex="0" aria-expanded="false">
      <span class="toggle-arrow" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="method ${methodClass(method)}">${escapeHtml(method)}</span>
      <span class="endpoint" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</span>
      <span class="status ${statusClass}">${escapeHtml(String(code))}</span>
      <button class="log-copy" type="button" title="Copy log entry" aria-label="Copy log entry">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path fill="currentColor" d="M10 1H4a2 2 0 0 0-2 2v8h2V3h6V1zm3 3H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 10H7V6h6v8z"/>
        </svg>
      </button>
    </div>
    <div class="log-body">
      <div class="log-section">
        <h4>Request <span class="ts">${ts}</span></h4>
        <div class="log-url">
          <span class="log-url-method ${methodClass(method)}">${escapeHtml(method)}</span>
          <span class="log-url-text">${escapeHtml(endpoint)}</span>
        </div>
        <pre>${syntaxHighlightJson(maskSecrets(request))}</pre>
      </div>
      <div class="log-section">
        <h4>${error ? 'Error' : 'Response'}</h4>
        <pre>${syntaxHighlightJson(error ? { message: error.message || String(error) } : maskSecrets(response))}</pre>
      </div>
    </div>
  `;

  const head = entry.querySelector('.log-head');
  const toggleOpen = () => {
    const isOpen = entry.classList.toggle('is-open');
    head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  };
  head.addEventListener('click', toggleOpen);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(); }
  });

  const copyBtn = entry.querySelector('.log-copy');
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = formatLogForCopy({ method, endpoint, status: code, request, response, error, ts });
    const onDone = () => {
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onDone).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); onDone(); } catch (_) {}
      ta.remove();
    }
  });

  stream.appendChild(entry);
  stream.scrollTop = stream.scrollHeight;
}

function formatLogForCopy({ method, endpoint, status, request, response, error, ts }) {
  const lines = [];
  lines.push(`${method} ${endpoint}`);
  lines.push(`Status: ${status}`);
  lines.push(`Time: ${ts}`);
  lines.push('');
  lines.push('Request:');
  lines.push(JSON.stringify(maskSecrets(request), null, 2));
  lines.push('');
  if (error) {
    lines.push('Error:');
    lines.push(JSON.stringify({ message: error.message || String(error) }, null, 2));
  } else {
    lines.push('Response:');
    lines.push(JSON.stringify(maskSecrets(response), null, 2));
  }
  return lines.join('\n');
}

function clearLogs() {
  $('#log-stream').innerHTML = `
    <div class="empty-logs">
      PayPal API + JSv6 SDK events will appear here.<br>
      Click each entry to expand request and response.
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// HELPER PARA LOGUEAR EVENTOS DEL SDK v6
// ─────────────────────────────────────────────────────────────

function logSdkEvent(label, flow, payload, sdkStatus) {
  let logEndpoint = label;
  let logResponse;
  let logStatus = sdkStatus;
  let body = null;

  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    logEndpoint = payload.data.url || label;
    logResponse = payload.data.body || payload.data;
    if (typeof payload.data.status === 'number') logStatus = payload.data.status;
    body = payload.data.body || null;
  } else if (payload && typeof payload === 'object') {
    logResponse = {
      name: payload.name,
      message: payload.message,
      details: payload.details,
      debug_id: payload.debug_id,
      links: payload.links
    };
    body = {
      name: payload.name,
      message: payload.message,
      details: payload.details,
      debug_id: payload.debug_id
    };
  } else {
    logResponse = { message: String(payload) };
  }

  addLog({
    method: 'SDK',
    endpoint: logEndpoint,
    request: { flow: flow || '—' },
    response: logResponse,
    status: logStatus
  });

  return body;
}

// ─────────────────────────────────────────────────────────────
// PROXY DE LLAMADAS REST AL SERVER
// ─────────────────────────────────────────────────────────────

/** Helper genérico para llamar a un endpoint /api del server.
 *  El server devuelve { log, oauthLog, data } — esta función emite
 *  los logs (oauthLog primero, luego log) y devuelve `data`.
 *  Lanza un Error si la llamada upstream falló (status >= 400). */
async function callApi(method, path, body, { silent = false } = {}) {
  const fetchOpts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body !== undefined) fetchOpts.body = JSON.stringify(body);

  let resp;
  try {
    resp = await fetch(path, fetchOpts);
  } catch (networkErr) {
    addLog({
      method, endpoint: path,
      request: body || {},
      error: networkErr,
      status: 'ERROR'
    });
    throw networkErr;
  }

  let json;
  try { json = await resp.json(); } catch (_) { json = null; }

  // Logs que el servidor adjunta a la respuesta (orden: oauth → main)
  if (!silent) {
    if (json?.oauthLog) addLog(json.oauthLog);
    if (json?.stcLog)   addLog(json.stcLog);
    if (json?.log)      addLog(json.log);
  }

  if (!resp.ok) {
    const msg = json?.error
      || json?.log?.response?.message
      || json?.log?.response?.error_description
      || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.response = json?.data ?? json;
    err.status = resp.status;
    throw err;
  }

  return json?.data ?? json;
}

// ─────────────────────────────────────────────────────────────
// /api/oauth/token  — registra una entrada de log con la respuesta
// completa enmascarada del endpoint /v1/oauth2/token de PayPal.
// ─────────────────────────────────────────────────────────────

async function pingAccessToken() {
  // El servidor mantiene su propio cache; aquí solo forzamos una entrada
  // de log para exhibir la operación de OAuth.
  try {
    await callApi('POST', '/api/oauth/token', { env: getEnvName() });
  } catch (err) {
    // El log ya se emitió desde callApi
    console.warn('[pingAccessToken]', err);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// PAYLOAD DE ORDEN
// ─────────────────────────────────────────────────────────────

function buildOrderPayload() {
  const amount    = getAmount();
  const amtNum    = parseFloat(amount);
  const discount  = 10.00;
  const itemTotal = (amtNum + discount).toFixed(2);
  const item1Num  = parseFloat((amtNum * (260 / 500)).toFixed(2));
  const item2Num  = parseFloat((itemTotal - item1Num).toFixed(2));

  return {
    intent: 'CAPTURE',
    application_context: {
      shipping_preference: 'SET_PROVIDED_ADDRESS'
    },
    payer: {
      email_address: BUYER.email_address,
      phone: { phone_number: { national_number: BUYER.phone_number.national_number } },
      name:    BUYER.name,
      address: BUYER.address
    },
    purchase_units: [{
      description: 'Item bought at ACDC store',
      invoice_id:  `INV-${state.cmid.slice(0, 10).toUpperCase()}`,
      custom_id:   `ORD-${state.cmid.slice(0, 8).toUpperCase()}`,
      amount: {
        currency_code: getCurrency(),
        value: amount,
        breakdown: {
          item_total: { currency_code: getCurrency(), value: itemTotal },
          tax_total:  { currency_code: getCurrency(), value: '0.00' },
          discount:   { currency_code: getCurrency(), value: discount.toFixed(2) }
        }
      },
      items: [
        {
          name: 'T-Shirt', description: 'Green XL', sku: 'sku01',
          unit_amount: { currency_code: getCurrency(), value: item1Num.toFixed(2) },
          quantity: '1'
        },
        {
          name: 'Shoes', description: 'Running, Size 10.5', sku: 'sku02',
          unit_amount: { currency_code: getCurrency(), value: item2Num.toFixed(2) },
          quantity: '1'
        }
      ],
      shipping: {
        name:    { full_name: 'Miguel Barrientos' },
        address: BUYER.address
      }
    }]
  };
}

// ─────────────────────────────────────────────────────────────
// CREATE / CAPTURE ORDER (vía server)
// ─────────────────────────────────────────────────────────────

async function createOrder() {
  const payload = buildOrderPayload();
  const createRequestId = generateRequestId();
  const data = await callApi('POST', '/api/orders', {
    env:  getEnvName(),
    cmid: state.cmid,
    requestId: createRequestId,
    payload
  });
  if (!data?.id) throw new Error('PayPal did not return an order ID.');
  state.orderRequestIds[data.id] = {
    createRequestId,
    captureRequestId: generateRequestId()
  };
  return { orderId: data.id };
}

async function captureOrder({ orderId }) {
  const ids = state.orderRequestIds[orderId] || {};
  if (!ids.captureRequestId) {
    ids.captureRequestId = generateRequestId();
    state.orderRequestIds[orderId] = ids;
  }
  return callApi('POST', `/api/orders/${encodeURIComponent(orderId)}/capture`, {
    env:     getEnvName(),
    cmid:    state.cmid,
    requestId: ids.captureRequestId,
    negTest: getNegativeTestMode()
  });
}

/** GET /v2/checkout/orders/{id} — devuelve la orden enriquecida.
 *  Se invoca inmediatamente después del capture para que el panel de
 *  logs muestre installments, processor_response, payment_source
 *  completo, etc. Es no bloqueante: si falla solo se loguea. */
async function getOrderDetails(orderId) {
  try {
    return await callApi(
      'GET',
      `/api/orders/${encodeURIComponent(orderId)}?env=${encodeURIComponent(getEnvName())}`
    );
  } catch (e) {
    console.warn('Non-blocking getOrderDetails failed:', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// CALLBACKS COMPARTIDOS
// ─────────────────────────────────────────────────────────────

async function onApprove(data) {
  logSdkEvent(
    `${state.lastUsedFlow === 'card' ? 'BCDC' : 'PayPal'} onApprove`,
    state.lastUsedFlow,
    data,
    'OK'
  );
  setLoading(true);
  hideNotification();
  try {
    const captured = await captureOrder({ orderId: data.orderId });
    // Inmediatamente después del capture: GET de la orden para traer
    // installments, processor_response y demás metadata enriquecida.
    // Llamada no bloqueante — su entrada de log aparece igualmente.
    await getOrderDetails(data.orderId);
    const captureObj = captured?.purchase_units?.[0]?.payments?.captures?.[0];
    if (captureObj?.status === 'COMPLETED') {
      renderResult(captured, 'success');
      showNotification('Payment captured successfully.', 'success');
    } else {
      const status = captureObj?.status || captured?.status || 'DECLINED';
      renderResult({
        error:     `Payment ${status.toLowerCase()}`,
        errorName: `Capture ${status}`,
        orderID:   captured?.id
      }, 'error');
      showNotification(`Payment ${status.toLowerCase()}.`, 'error');
    }
  } catch (error) {
    // La entrada REST de POST …/capture ya se logueó dentro de callApi
    // (con la respuesta completa enmascarada de PayPal). No duplicamos
    // con un "SDK capture error" — el SDK no genera ese evento, la
    // captura es 100% REST.
    console.error('[onApprove → captureOrder]', error);
    renderResult({ error: error.message || 'Capture failed' }, 'error');
    showNotification(`Capture error: ${error.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

function onCancel(data) {
  logSdkEvent(
    `${state.lastUsedFlow === 'card' ? 'BCDC' : 'PayPal'} onCancel`,
    state.lastUsedFlow,
    data,
    'WARN'
  );
  showNotification('Payment cancelled by user.', 'warning');
}

function onError(error) {
  console.error('[PayPal onError]', error);
  const body = logSdkEvent(
    `${state.lastUsedFlow === 'card' ? 'BCDC' : 'PayPal'} onError`,
    state.lastUsedFlow,
    error,
    'ERROR'
  );
  const shortMessage = (body?.details?.[0]?.description)
    || body?.message
    || body?.name
    || error?.message
    || 'PayPal SDK error';
  showNotification(`Error: ${shortMessage}`, 'error');
  renderResult({
    error:        shortMessage,
    errorName:    body?.name,
    errorDebugId: body?.debug_id,
    errorDetails: body?.details
  }, 'error');
  setLoading(false);
}

function onWarn(warning) {
  console.warn('[BCDC onWarn]', warning);
  const body = logSdkEvent('BCDC onWarn', state.lastUsedFlow, warning, 'WARN');
  const shortMessage = (body?.details?.[0]?.description)
    || body?.message
    || body?.name
    || warning?.message
    || 'PayPal SDK warning';
  showNotification(`Warning: ${shortMessage}`, 'warning');
}

// ─────────────────────────────────────────────────────────────
// SDK v6 — carga (una sola vez por entorno)
// ─────────────────────────────────────────────────────────────

async function loadPayPalWebSdkV6() {
  const generation = ++state.sdkLoadGeneration;
  const cfg = getEnvConfig();
  const sdkUrl = cfg.sdkUrl;

  state.sdkInstance = null;
  state.paymentMethods = null;
  state.bcdcSession = null;
  state.bcdcInitialized = false;

  ['paypal-button', 'paylater-button', 'paypal-credit-button'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn && btn.parentNode) {
      const fresh = btn.cloneNode(false);
      fresh.setAttribute('hidden', '');
      btn.parentNode.replaceChild(fresh, btn);
    }
  });

  if (!state.sdkLoadedUrl) {
    addLog({
      method: 'SCRIPT',
      endpoint: sdkUrl,
      request: { env: getEnvName(), cmid: state.cmid },
      response: { loading: true },
      status: 'OK'
    });

    const script = document.createElement('script');
    script.id = state.sdkScriptId;
    script.async = true;
    script.src = sdkUrl;
    document.body.appendChild(script);

    await new Promise((res, rej) => {
      script.onload = () => { state.sdkLoadedUrl = sdkUrl; res(); };
      script.onerror = () => rej(new Error('Could not load PayPal Web SDK v6.'));
    });
  } else {
    addLog({
      method: 'SCRIPT',
      endpoint: sdkUrl,
      request: { env: getEnvName(), cmid: state.cmid, cached: true },
      response: { reusing: true },
      status: 'OK'
    });
  }

  if (generation !== state.sdkLoadGeneration) return;

  if (!window.paypal || typeof window.paypal.createInstance !== 'function') {
    throw new Error('PayPal Web SDK v6 unavailable. Check the browser console.');
  }

  // Forzamos un primer call a /api/oauth/token para mostrar la entrada
  // de OAuth en el panel de logs (ahora el secret vive en el server).
  try { await pingAccessToken(); }
  catch (e) { console.warn('initial pingAccessToken failed', e); }

  let sdkInstance;
  try {
    sdkInstance = await window.paypal.createInstance({
      clientId: cfg.clientId,
      components: ['paypal-payments', 'paypal-guest-payments'],
      pageType: 'checkout',
      locale:  getLocale()
    });
  } catch (createErr) {
    addLog({
      method: 'SDK',
      endpoint: 'createInstance',
      request: { env: getEnvName(), locale: getLocale() },
      response: { name: createErr?.name, message: String(createErr?.message || createErr) },
      status: 'ERROR'
    });
    throw createErr;
  }

  const paymentMethods = await sdkInstance.findEligibleMethods({ currencyCode: getCurrency() });

  state.sdkInstance = sdkInstance;
  state.paymentMethods = paymentMethods;
  await initializeBcdcSession(sdkInstance);

  addLog({
    method: 'SDK',
    endpoint: 'createInstance + findEligibleMethods',
    request: {
      components:   ['paypal-payments', 'paypal-guest-payments'],
      currencyCode: getCurrency(),
      locale:       getLocale()
    },
    response: {
      paypal:   paymentMethods.isEligible('paypal'),
      paylater: paymentMethods.isEligible('paylater'),
      credit:   paymentMethods.isEligible('credit')
    },
    status: 'OK'
  });

  activateFlow(getSelectedFlow());
}

// ─────────────────────────────────────────────────────────────
// FLUJOS
// ─────────────────────────────────────────────────────────────

function getSelectedFlow() {
  const checked = document.querySelector('input[name="payment-method"]:checked');
  return (checked && checked.value === 'card') ? 'card' : 'paypal';
}

function activateFlow(flow) {
  const paypalSection = $('#payment-section-paypal');
  const cardSection   = $('#payment-section-card');
  updateNavPills(flow);

  if (flow === 'card') {
    paypalSection.classList.add('hide');
    cardSection.classList.remove('hide');
    renderBcdcButton();
  } else {
    paypalSection.classList.remove('hide');
    cardSection.classList.add('hide');
    renderPayPalButtons();
  }
}

// FLUJO 1 — botones PayPal / PayLater / Credit

function renderPayPalButtons() {
  const { sdkInstance, paymentMethods } = state;
  if (!sdkInstance || !paymentMethods) return;

  ['paypal-button', 'paylater-button', 'paypal-credit-button'].forEach((id) => {
    const old = document.getElementById(id);
    if (!old || !old.parentNode) return;
    const fresh = old.cloneNode(false);
    fresh.setAttribute('hidden', '');
    old.parentNode.replaceChild(fresh, old);
  });

  if (paymentMethods.isEligible('paypal'))   configurePayPalButton(sdkInstance);
  else addLog({ method: 'SDK', endpoint: 'eligibility paypal',   request: { currencyCode: getCurrency() }, response: { eligible: false }, status: 'WARN' });

  if (paymentMethods.isEligible('paylater')) setupPayLaterButton(sdkInstance, paymentMethods.getDetails('paylater'));
  else addLog({ method: 'SDK', endpoint: 'eligibility paylater', request: { currencyCode: getCurrency() }, response: { eligible: false }, status: 'WARN' });

  if (paymentMethods.isEligible('credit'))   setupPayPalCreditButton(sdkInstance, paymentMethods.getDetails('credit'));
  else addLog({ method: 'SDK', endpoint: 'eligibility credit',   request: { currencyCode: getCurrency() }, response: { eligible: false }, status: 'WARN' });
}

async function initializeBcdcSession(sdkInstance) {
  state.bcdcSession = null;
  state.bcdcInitialized = false;
  state.bcdcClickBound = false;

  try {
    state.bcdcSession = await sdkInstance.createPayPalGuestOneTimePaymentSession({
      onApprove, onCancel, onWarn, onError
    });
    state.bcdcInitialized = true;
    addLog({
      method: 'SDK',
      endpoint: 'createPayPalGuestOneTimePaymentSession',
      request: { trigger: 'sdk:init', currencyCode: getCurrency() },
      response: { ready: true },
      status: 'OK'
    });
  } catch (error) {
    console.error('[BCDC init]', error);
    addLog({
      method: 'SDK',
      endpoint: 'createPayPalGuestOneTimePaymentSession',
      request: { trigger: 'sdk:init' },
      response: { name: error?.name, message: error?.message },
      status: 'ERROR'
    });
  }
}

function configurePayPalButton(sdkInstance) {
  const session = sdkInstance.createPayPalOneTimePaymentSession({ onApprove, onCancel, onError });
  const btn = document.getElementById('paypal-button');
  btn.removeAttribute('hidden');

  btn.addEventListener('click', () => {
    state.lastUsedFlow = 'paypal';
    hideNotification();
    const p = createOrder(); // ⚠ NO await — preserva transient activation
    session.start({ presentationMode: 'auto' }, p).catch(onError);
  });
}

function setupPayLaterButton(sdkInstance, details) {
  const session = sdkInstance.createPayLaterOneTimePaymentSession({ onApprove, onCancel, onError });
  const { productCode, countryCode } = details || {};
  const btn = document.getElementById('paylater-button');
  if (productCode) btn.productCode = productCode;
  if (countryCode) btn.countryCode = countryCode;
  btn.removeAttribute('hidden');

  btn.addEventListener('click', () => {
    state.lastUsedFlow = 'paylater';
    hideNotification();
    const p = createOrder();
    session.start({ presentationMode: 'auto' }, p).catch(onError);
  });
}

function setupPayPalCreditButton(sdkInstance, details) {
  const session = sdkInstance.createPayPalCreditOneTimePaymentSession({ onApprove, onCancel, onError });
  const { countryCode } = details || {};
  const btn = document.getElementById('paypal-credit-button');
  if (countryCode) btn.countryCode = countryCode;
  btn.removeAttribute('hidden');

  btn.addEventListener('click', () => {
    state.lastUsedFlow = 'credit';
    hideNotification();
    const p = createOrder();
    session.start({ presentationMode: 'auto' }, p).catch(onError);
  });
}

// FLUJO 2 — BCDC inline (lazy)

function renderBcdcButton() {
  if (!state.bcdcSession) {
    showNotification('BCDC session is not ready yet. Try again in a moment.', 'warning');
    return;
  }

  let btn = document.getElementById('paypal-basic-card-button');
  if (!state.bcdcClickBound) {
    const fresh = btn.cloneNode(false);
    btn.parentNode.replaceChild(fresh, btn);
    btn = fresh;
    btn.addEventListener('click', () => {
      startGuest(btn, state.bcdcSession);
    });
    state.bcdcClickBound = true;
  }
  startGuest(btn, state.bcdcSession);
}

function startGuest(btn, session) {
  state.lastUsedFlow = 'card';
  hideNotification();
  const p = createOrder();
  session.start({ targetElement: btn, presentationMode: 'auto' }, p).catch(onError);
}

// ─────────────────────────────────────────────────────────────
// SELECTOR DE MÉTODO
// ─────────────────────────────────────────────────────────────

function setupPaymentMethodSelector() {
  document.querySelectorAll('input[name="payment-method"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      hideNotification();
      activateFlow(e.target.value);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// RESULTADO
// ─────────────────────────────────────────────────────────────

function renderResult(payload, type) {
  const result = $('#result');
  const capture = payload?.purchase_units?.[0]?.payments?.captures?.[0];
  const status  = capture?.status || payload?.status || 'ERROR';
  const orderId = payload?.id || payload?.orderID || '';
  const captureId = capture?.id || '';
  const amount = capture?.amount
    ? formatMoney(capture.amount.value, capture.amount.currency_code)
    : formatMoney(getAmount());

  result.className = `result show ${type}`;

  if (type === 'success') {
    result.innerHTML = `
      <h2>Payment completed</h2>
      <p><strong>Status:</strong> ${escapeHtml(status)}</p>
      <p><strong>Order:</strong> <span class="code">${escapeHtml(orderId)}</span></p>
      <p><strong>Capture:</strong> <span class="code">${escapeHtml(captureId || 'N/A')}</span></p>
      <p><strong>Total:</strong> ${escapeHtml(amount)}</p>
    `;
    return;
  }

  const hasStructured = payload?.errorName || payload?.errorDebugId
    || (Array.isArray(payload?.errorDetails) && payload.errorDetails.length > 0);

  let html = `<h2>Payment stopped</h2>`;
  if (hasStructured) {
    if (payload.errorDebugId) html += `<p><strong>Corr ID:</strong> <span class="code">${escapeHtml(payload.errorDebugId)}</span></p>`;
    if (payload.errorName)    html += `<p><strong>Name:</strong> ${escapeHtml(payload.errorName)}</p>`;
    if (Array.isArray(payload.errorDetails) && payload.errorDetails.length) {
      const items = payload.errorDetails.map((d) => {
        const field = d.field ? `<code>${escapeHtml(d.field)}</code>` : '';
        const issue = d.issue ? ` (${escapeHtml(d.issue)})` : '';
        const desc  = d.description ? `: ${escapeHtml(d.description)}` : '';
        return `<li>${field}${issue}${desc}</li>`;
      }).join('');
      html += `<p><strong>Details:</strong></p><ul class="error-details">${items}</ul>`;
    }
  } else {
    html += `<p>${escapeHtml(payload?.error || 'Transaction could not be completed.')}</p>`;
  }
  if (orderId) html += `<p><strong>Order:</strong> <span class="code">${escapeHtml(orderId)}</span></p>`;
  result.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// RESET
// ─────────────────────────────────────────────────────────────

async function resetFlow({ clearLogPanel = true } = {}) {
  if (state.isResetting) return;
  state.isResetting = true;
  setLoading(false);
  hideNotification();
  $('#result').className = 'result';
  $('#result').innerHTML = '';
  if (clearLogPanel) clearLogs();
  updateSummaryTotal();
  updateAmtLabel();
  updateEnvHint();

  state.cmid = generateCMID();
  state.lastUsedFlow = null;
  state.bcdcSession = null;
  state.bcdcInitialized = false;
  state.bcdcClickBound = false;
  state.orderRequestIds = {};

  try {
    await loadPayPalWebSdkV6();
    showNotification('Flow restarted with the selected configuration.', 'info');
  } catch (error) {
    console.error('[resetFlow]', error);
    showNotification(`Could not initialize JSv6 SDK: ${error.message}`, 'error');
  } finally {
    state.isResetting = false;
  }
}

// ─────────────────────────────────────────────────────────────
// MODAL CREDS — fetch + save
// ─────────────────────────────────────────────────────────────

async function openCredsModal() {
  const modal  = document.getElementById('creds-modal');
  const status = document.getElementById('creds-status');
  status.textContent = '';
  status.className = 'creds-status';

  // Carga creds actuales
  try {
    const r = await fetch('/api/credentials');
    const data = await r.json();

    document.getElementById('cred-sandbox-client-id').value     = data.sandbox?.clientId     || '';
    document.getElementById('cred-sandbox-client-secret').value = data.sandbox?.clientSecret || '';
    document.getElementById('cred-sandbox-merchant-id').value   = data.sandbox?.merchantId   || '';
    document.getElementById('cred-live-client-id').value        = data.live?.clientId        || '';
    document.getElementById('cred-live-client-secret').value    = data.live?.clientSecret    || '';
    document.getElementById('cred-live-merchant-id').value      = data.live?.merchantId      || '';
  } catch (e) {
    status.textContent = `Could not load credentials: ${e.message}`;
    status.className   = 'creds-status error';
  }

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('cred-sandbox-client-id').focus(), 50);
}

function closeCredsModal() {
  const modal = document.getElementById('creds-modal');
  modal.hidden = true;
  document.body.style.overflow = '';
}

async function saveCreds() {
  const status = document.getElementById('creds-status');
  status.textContent = 'Saving…';
  status.className   = 'creds-status';

  const payload = {
    sandbox: {
      clientId:     document.getElementById('cred-sandbox-client-id').value.trim(),
      clientSecret: document.getElementById('cred-sandbox-client-secret').value.trim(),
      merchantId:   document.getElementById('cred-sandbox-merchant-id').value.trim()
    },
    live: {
      clientId:     document.getElementById('cred-live-client-id').value.trim(),
      clientSecret: document.getElementById('cred-live-client-secret').value.trim(),
      merchantId:   document.getElementById('cred-live-merchant-id').value.trim()
    }
  };

  try {
    const r = await fetch('/api/credentials', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    status.textContent = 'Saved. Reloading…';
    status.className   = 'creds-status success';

    // Refresca la config en memoria y recarga el SDK con las nuevas creds.
    setTimeout(() => { window.location.reload(); }, 500);
  } catch (e) {
    status.textContent = `Could not save: ${e.message}`;
    status.className   = 'creds-status error';
  }
}

function setupCredsModal() {
  document.getElementById('creds-button').addEventListener('click', openCredsModal);
  document.getElementById('creds-close').addEventListener('click', closeCredsModal);
  document.getElementById('creds-cancel').addEventListener('click', closeCredsModal);
  document.getElementById('creds-save').addEventListener('click', saveCreds);

  // Cerrar con click en el overlay
  document.getElementById('creds-modal').addEventListener('click', (e) => {
    if (e.target.id === 'creds-modal') closeCredsModal();
  });
  // Cerrar con Esc
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('creds-modal').hidden) closeCredsModal();
  });

  // Toggle ojo de los secretos
  document.querySelectorAll('.cred-eye').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      target.type = target.type === 'password' ? 'text' : 'password';
    });
  });
}

// ─────────────────────────────────────────────────────────────
// RESTAURAR ENTORNO
// ─────────────────────────────────────────────────────────────

function restoreEnvSelection() {
  try {
    const saved = localStorage.getItem('pp-demo-env');
    if (saved === 'live' || saved === 'sandbox') {
      const radio = document.querySelector(`input[name="paypal-env"][value="${saved}"]`);
      if (radio) radio.checked = true;
    }
  } catch (_) {}
  try {
    const savedCurrency = localStorage.getItem('pp-demo-currency');
    if (savedCurrency === 'USD' || savedCurrency === 'MXN') {
      const radio = document.querySelector(`input[name="currency"][value="${savedCurrency}"]`);
      if (radio) radio.checked = true;
    }
  } catch (_) {}
  updateEnvHint();
}

// ─────────────────────────────────────────────────────────────
// BIND EVENTS
// ─────────────────────────────────────────────────────────────

function bindEvents() {
  setupPaymentMethodSelector();
  setupCredsModal();

  $('#reset-button').addEventListener('click', () => resetFlow({ clearLogPanel: true }));
  $('#clear-logs-button').addEventListener('click', clearLogs);

  $('#amount').addEventListener('change', () => {
    const amount = getAmount();
    $('#amount').value = amount;
    updateSummaryTotal();
    resetFlow({ clearLogPanel: false });
  });

  document.querySelectorAll('input[name="paypal-env"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      try { localStorage.setItem('pp-demo-env', radio.value); } catch (_) {}
      window.location.reload();
    });
  });

  document.querySelectorAll('input[name="neg-test"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const mode = getNegativeTestMode();
      if (mode !== 'none') showNotification(`Negative test active: ${mode}`, 'warning');
      else hideNotification();
    });
  });

  document.querySelectorAll('input[name="currency"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      try { localStorage.setItem('pp-demo-currency', radio.value); } catch (_) {}
      window.location.reload();
    });
  });
}

// ─────────────────────────────────────────────────────────────
// LISTENERS GLOBALES
// ─────────────────────────────────────────────────────────────

window.addEventListener('error', (e) => {
  console.error('[Window error]', e.message, e);
  addLog({
    method: 'SDK', endpoint: 'window.onerror',
    request: {},
    response: { message: e.message, source: e.filename, line: e.lineno },
    status: 'ERROR'
  });
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled rejection]', e.reason);
  addLog({
    method: 'SDK', endpoint: 'window.onunhandledrejection',
    request: {},
    response: { reason: String(e.reason) },
    status: 'ERROR'
  });
});

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────

async function loadPublicConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cfg = await r.json();
    PAYPAL_CONFIG = {
      sandbox: { ...PAYPAL_CONFIG.sandbox, ...cfg.sandbox },
      live:    { ...PAYPAL_CONFIG.live,    ...cfg.live    }
    };
    addLog({
      method: 'GET', endpoint: '/api/config',
      request: {}, response: cfg, status: 200
    });
  } catch (e) {
    addLog({
      method: 'GET', endpoint: '/api/config',
      request: {}, error: e, status: 'ERROR'
    });
    throw e;
  }
}

async function init() {
  restoreEnvSelection();
  bindEvents();
  updateAmtLabel();
  updateSummaryTotal();
  state.cmid = generateCMID();

  try {
    await loadPublicConfig();
  } catch (e) {
    showNotification(
      `Could not load /api/config — make sure the server is running (npm start). Error: ${e.message}`,
      'error'
    );
    return;
  }

  const cfg = getEnvConfig();
  if (!cfg.clientId) {
    showNotification(
      `No client_id configured for ${getEnvName().toUpperCase()}. Click CREDS to add one.`,
      'warning'
    );
    return;
  }

  try {
    await loadPayPalWebSdkV6();
  } catch (error) {
    console.error('[init]', error);
    showNotification(
      `Could not initialize JSv6 SDK: ${error.message}. See logs panel.`,
      'error'
    );
  }
}

init();
