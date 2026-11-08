// まなびスキル研修室 API（Cloudflare Worker）
// 決済画面の作成・購入の記録・受講コードの確認・有料コンテンツの配信を行う。
//
// 必要な設定
//   KV:       SKILL_KV
//   vars:     SITE_URL, PRICES（プランID → Stripeの価格ID のJSON）
//   secrets:  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN
//
// KVのキー
//   code:<受講コード>   → { plans: {<plan>: <期限ISO>}, email, sessions: [..], created }
//   session:<id>        → 受講コード
//   content:<plan>      → { plan, levels: [{ title, slides, quiz }] }

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0,O,1,I を除く
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const route = `${request.method} ${url.pathname}`;
      let res;
      switch (route) {
        case 'POST /checkout': res = await checkout(request, env); break;
        case 'POST /claim': res = await claim(request, env); break;
        case 'POST /webhook': return await webhook(request, env);
        case 'POST /verify': res = await verify(request, env); break;
        case 'POST /content': res = await content(request, env); break;
        case 'POST /progress/load': res = await progressLoad(request, env); break;
        case 'POST /progress/save': res = await progressSave(request, env); break;
        case 'PUT /admin/content': res = await adminPut(request, env); break;
        case 'GET /admin/status': res = await adminStatus(request, env); break;
        case 'GET /': res = json({ ok: true, service: 'manabi-skill-api' }); break;
        default: res = json({ error: '見つかりません' }, 404);
      }
      return withHeaders(res, cors);
    } catch (e) {
      return withHeaders(json({ error: e.publicMessage || 'エラーが発生しました。時間をおいてもう一度お試しください。' }, e.status || 500), cors);
    }
  },
};

// ---------- 公開API ----------

async function checkout(request, env) {
  const { plan, code } = await readJson(request);
  const prices = JSON.parse(env.PRICES || '{}');
  const price = prices[plan];
  if (!price) throw fail(400, 'コースの指定が正しくありません。');
  const params = {
    mode: 'payment',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    success_url: `${env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/pricing.html`,
    locale: 'ja',
    'metadata[plan]': plan,
    // Stripe が販売者になる Managed Payments は使わない（特商法の表記は当サイトで行う）
    'managed_payments[enabled]': 'false',
  };
  if (code && CODE_RE.test(code) && (await env.SKILL_KV.get(`code:${code}`))) params['metadata[code]'] = code;
  const session = await stripe(env, 'POST', '/v1/checkout/sessions', params);
  return json({ url: session.url });
}

async function claim(request, env) {
  const { session_id } = await readJson(request);
  if (!/^cs_[A-Za-z0-9_]+$/.test(session_id || '')) throw fail(400, '購入の情報が見つかりません。');
  const session = await stripe(env, 'GET', `/v1/checkout/sessions/${session_id}`);
  if (session.payment_status !== 'paid') throw fail(402, 'お支払いの確認ができていません。少し待ってから、もう一度ページを開いてください。');
  const code = await fulfill(env, session);
  const rec = await getRecord(env, code);
  return json({ code, plans: activePlans(rec), plan: session.metadata && session.metadata.plan });
}

async function webhook(request, env) {
  const body = await request.text();
  const ok = await verifyStripeSignature(body, request.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response('invalid signature', { status: 400 });
  const event = JSON.parse(body);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    if (session.payment_status === 'paid') await fulfill(env, session);
  }
  return new Response('ok');
}

async function verify(request, env) {
  const { code } = await readJson(request);
  const c = normalizeCode(code);
  const rec = c && (await getRecord(env, c));
  if (!rec) throw fail(404, '受講コードが見つかりません。入力に間違いがないか確かめてください。');
  return json({ code: c, plans: activePlans(rec) });
}

async function content(request, env) {
  const { code, plan } = await readJson(request);
  const c = normalizeCode(code);
  const rec = c && (await getRecord(env, c));
  if (!rec || !activePlans(rec)[plan]) throw fail(403, 'このコースの受講期間が確認できません。');
  const data = await env.SKILL_KV.get(`content:${plan}`, 'json');
  if (!data) throw fail(404, 'コースの内容を準備中です。');
  return json(data);
}

// ---------- 学習の記録（端末をまたいで共有） ----------
// progress:<受講コード> → { "<コースの保存キー>": { "<レベルID>": { read, passed, best } } }

const PROGRESS_KEY_RE = /^manabi-skill-[a-z0-9]+-v1$/;

async function progressLoad(request, env) {
  const { code } = await readJson(request);
  const c = normalizeCode(code);
  if (!c || !(await getRecord(env, c))) throw fail(404, '受講コードが見つかりません。');
  return json({ data: (await env.SKILL_KV.get(`progress:${c}`, 'json')) || {} });
}

async function progressSave(request, env) {
  const { code, key, data } = await readJson(request);
  const c = normalizeCode(code);
  if (!c || !(await getRecord(env, c))) throw fail(404, '受講コードが見つかりません。');
  if (!PROGRESS_KEY_RE.test(key || '') || !data || typeof data !== 'object') throw fail(400, '記録の形式が正しくありません。');
  const all = (await env.SKILL_KV.get(`progress:${c}`, 'json')) || {};
  all[key] = mergeProgress(all[key] || {}, data);
  const text = JSON.stringify(all);
  if (text.length > 50000) throw fail(413, '記録が大きすぎます。');
  await env.SKILL_KV.put(`progress:${c}`, text);
  return json({ data: all[key] });
}

// 合格や既読は消さず、最高点は大きいほうを残す（古い端末の記録で上書きしないため）
function mergeProgress(a, b) {
  const out = { ...a };
  for (const [id, v] of Object.entries(b)) {
    if (!/^\d{1,3}$/.test(id) || !v || typeof v !== 'object') continue;
    const o = out[id] || {};
    out[id] = { read: !!(o.read || v.read), passed: !!(o.passed || v.passed), best: Math.max(Number(o.best) || 0, Number(v.best) || 0) };
    if (o.skip || v.skip) out[id].skip = true;
  }
  return out;
}

// ---------- 管理API ----------

async function adminPut(request, env) {
  requireAdmin(request, env);
  const data = await readJson(request);
  if (!data || !/^[a-z0-9]+$/.test(data.plan || '') || !Array.isArray(data.levels)) throw fail(400, 'ファイルの形式が正しくありません。');
  await env.SKILL_KV.put(`content:${data.plan}`, JSON.stringify(data));
  return json({ ok: true, plan: data.plan, levels: data.levels.length });
}

async function adminStatus(request, env) {
  requireAdmin(request, env);
  const prices = JSON.parse(env.PRICES || '{}');
  const out = {};
  for (const plan of Object.keys(prices)) {
    const d = await env.SKILL_KV.get(`content:${plan}`, 'json');
    out[plan] = d ? d.levels.length : 0;
  }
  return json({ content: out });
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) throw fail(401, '管理用パスワードが違います。');
}

// ---------- 購入の記録 ----------

async function fulfill(env, session) {
  const done = await env.SKILL_KV.get(`session:${session.id}`);
  if (done) return done;
  const plan = session.metadata && session.metadata.plan;
  if (!plan) throw fail(400, '購入したコースが分かりません。');
  let code = session.metadata.code;
  let rec = code && CODE_RE.test(code) ? await getRecord(env, code) : null;
  if (!rec) {
    code = await codeFromSession(session.id, env.STRIPE_WEBHOOK_SECRET || 'manabi');
    rec = (await getRecord(env, code)) || { plans: {}, sessions: [], created: new Date().toISOString() };
  }
  if (!rec.sessions.includes(session.id)) {
    const now = Date.now();
    const current = rec.plans[plan] ? Date.parse(rec.plans[plan]) : 0;
    rec.plans[plan] = new Date(Math.max(now, current) + YEAR_MS).toISOString();
    rec.sessions.push(session.id);
    const email = session.customer_details && session.customer_details.email;
    if (email) rec.email = email;
    await env.SKILL_KV.put(`code:${code}`, JSON.stringify(rec));
  }
  await env.SKILL_KV.put(`session:${session.id}`, code);
  return code;
}

async function getRecord(env, code) {
  return env.SKILL_KV.get(`code:${code}`, 'json');
}

function activePlans(rec) {
  const now = Date.now();
  const out = {};
  for (const [plan, until] of Object.entries(rec.plans || {})) if (Date.parse(until) > now) out[plan] = until;
  return out;
}

// 同じ購入からは必ず同じコードができるようにする（購入完了ページとWebhookが同時に動いても1つになる）
async function codeFromSession(id, secret) {
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(id)));
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_CHARS[sig[i] % CODE_CHARS.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function normalizeCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 12) return null;
  const f = `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
  return CODE_RE.test(f) ? f : null;
}

// ---------- Stripe ----------

async function stripe(env, method, path, params) {
  const init = { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } };
  if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params).toString();
  }
  const res = await fetch(`https://api.stripe.com${path}`, init);
  const data = await res.json();
  if (!res.ok) {
    const reason = (data && data.error && (data.error.code || data.error.type)) || res.status;
    console.error('stripe error', res.status, data && data.error && data.error.message);
    throw fail(502, `決済サービスとの通信に失敗しました（理由：${reason}）。時間をおいてもう一度お試しください。`);
  }
  return data;
}

async function verifyStripeSignature(payload, header, secret) {
  if (!secret) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')).filter((p) => p.length === 2));
  const t = parts.t;
  const v1s = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(`${t}.${payload}`)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  return v1s.some((v) => timingSafeEqual(v, hex));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- 共通 ----------

function enc(s) { return new TextEncoder().encode(s); }

async function readJson(request) {
  try { return await request.json(); } catch { throw fail(400, '送られた内容を読み取れませんでした。'); }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function fail(status, publicMessage) {
  const e = new Error(publicMessage);
  e.status = status;
  e.publicMessage = publicMessage;
  return e;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.SITE_URL, 'https://www.manabiskill.com'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : env.SITE_URL,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

function withHeaders(res, headers) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
