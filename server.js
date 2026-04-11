/**
 * Serves this folder and proxies Roblox username lookup.
 * Browsers cannot call Roblox APIs directly from your site (CORS). This route runs on the server instead.
 *
 * Usage: npm install && npm start
 * Then open http://localhost:8080 (not file://, not a static host without this server).
 *
 * Account data: Supabase (user_balances + transactions). Set SUPABASE_URL and SUPABASE_ANON_KEY.
 * On Render/production, set SUPABASE_SERVICE_ROLE_KEY so the server can read any row (admin search, tips by name).
 * Never expose the service role to the browser â€” server env only.
 * Node 18+ recommended (global fetch).
 */
require('dotenv').config();
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const noblox = require('noblox.js');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { Server } = require('socket.io');

// Check Node.js fetch availability early
if (typeof fetch === 'undefined') {
    console.warn('[System] Global fetch is not available. Webhooks and Supabase may fail. Node 18+ is recommended.');
}

const app = express();
/** Render, Fly, Heroku, etc. sit behind a reverse proxy â€” required for correct req.ip and WebSocket upgrades */
app.set('trust proxy', 1);

app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

/** Create the HTTP server to attach Socket.io */
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const TOURNAMENTS_FILE = path.join(ROOT, 'data', 'tournaments.json');
const CRYPTO_WD_FILE = path.join(ROOT, 'data', 'crypto_withdrawals.json');
const CHAT_HISTORY_FILE = path.join(ROOT, 'data', 'chat_history.json');
const LIVE_FEED_MEMORY_FILE = path.join(ROOT, 'data', 'live_feed_memory.json');

let _supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
if (/\/rest\/v1\/?$/i.test(_supabaseUrl)) {
    _supabaseUrl = _supabaseUrl.replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');
}
const SUPABASE_URL = _supabaseUrl;
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

/** Profile JSON is stored in one synthetic transactions row (type account_profile) so stats/username sync cross-device. */
const PROFILE_REF_ID = 'zephrs_profile';
/** Stable UUID for profile row when `reference_id` is a uuid column (legacy text id still read in load). */
const PROFILE_REF_UUID = 'a0000000-0000-4000-8000-000000000001';

function isUuidString(s) {
    return (
        typeof s === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
    );
}

/** Pack client tx id into game_name so we can use a DB-safe reference_id (uuid). */
function packTxGameName(desc, clientId) {
    const d = typeof desc === 'string' ? desc : '';
    const id =
        clientId != null
            ? String(clientId)
                  .replace(/[^a-zA-Z0-9_-]/g, '')
                  .slice(0, 24)
            : '';
    if (!id) return d.slice(0, 4000);
    return (`__id:${id}__|` + d).slice(0, 4000);
}

function unpackTxGameName(gameName) {
    const g = typeof gameName === 'string' ? gameName : '';
    const m = g.match(/^__id:([a-zA-Z0-9_-]{1,24})__\|(.*)$/s);
    if (m) return { clientId: m[1], desc: m[2] };
    return { clientId: null, desc: g };
}

function normalizeDbTxType(t) {
    let s = String(t || 'deposit')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 48);
    return s || 'deposit';
}

function coerceTxReferenceId(clientRef) {
    if (isUuidString(clientRef)) return clientRef;
    return crypto.randomUUID();
}

/** Last PostgREST error from getUserBalance (for 503 responses; no secrets). */
let lastSupabaseBalanceError = '';

function supabaseEnabled() {
    return Boolean(SUPABASE_URL && (SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY));
}

/**
 * Prefer service role on the Node server so PostgREST obeys RLS as the service role (full access).
 * Required for admin username search and reading other users' rows when your Supabase RLS restricts anon reads.
 */
function supabaseServerRestHeaders() {
    const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    const headers = {
        apikey: key,
        'Content-Type': 'application/json'
    };
    if (typeof key === 'string' && key.startsWith('eyJ')) {
        headers.Authorization = `Bearer ${key}`;
    }
    return headers;
}

/**
 * Supabase REST auth headers.
 * - Legacy `anon` keys are JWTs (`eyJ...`) â€” send `Authorization: Bearer` + `apikey`.
 * - New publishable keys (`sb_publishable_...`) are NOT JWTs â€” use only `apikey`.
 *   Sending Bearer with a publishable string can cause 401 / invalid JWT errors.
 * @see https://supabase.com/docs/guides/api/api-keys
 */
function supabaseRestHeaders() {
    const key = SUPABASE_ANON_KEY;
    const headers = {
        apikey: key,
        'Content-Type': 'application/json'
    };
    if (typeof key === 'string' && key.startsWith('eyJ')) {
        headers.Authorization = `Bearer ${key}`;
    }
    return headers;
}

/** Undici/Node often throws TypeError("fetch failed") with the real reason on `cause` (ENOTFOUND, cert, etc.). */
function formatNodeFetchError(err) {
    if (!err || typeof err !== 'object') return String(err);
    const bits = [err.message || 'fetch failed'];
    const c = err.cause;
    if (c != null && typeof c === 'object') {
        if (typeof c.message === 'string' && c.message) bits.push(c.message);
        if (c.code) bits.push(`syscall_code=${c.code}`);
        if (typeof c.errno === 'number') bits.push(`errno=${c.errno}`);
    } else if (c != null) {
        bits.push(String(c));
    }
    if (err.code && !bits.some((b) => String(b).includes(String(err.code)))) bits.push(`code=${err.code}`);
    return bits.join(' — ').slice(0, 700);
}

function validateSupabaseUrlShape() {
    const u = SUPABASE_URL;
    if (!u) return 'SUPABASE_URL is empty.';
    if (!/^https:\/\//i.test(u)) return 'SUPABASE_URL must start with https://';
    try {
        const parsed = new URL(u);
        if (!parsed.hostname) return 'SUPABASE_URL has no hostname.';
        if (parsed.pathname && parsed.pathname !== '/') {
            return 'SUPABASE_URL should be only the project root, e.g. https://xxxx.supabase.co (no /rest/v1 — the server adds that).';
        }
    } catch (e) {
        return 'SUPABASE_URL is not a valid URL.';
    }
    return '';
}

async function supabaseFetch(pathAndQuery, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
    const method = options.method || 'GET';
    const base =
        options.useAnon === true ? supabaseRestHeaders() : supabaseServerRestHeaders();
    const headers = {
        ...base,
        ...(options.headers || {})
    };
    const init = { method, headers };
    if (options.body !== undefined) init.body = options.body;
    return fetch(url, init);
}

/** Thousands separators for chat/notifications (e.g. 10,000). */
function formatAmountDisplay(n) {
    const x = typeof n === 'number' ? n : Number(n);
    if (!Number.isFinite(x)) return String(n);
    if (Math.abs(x - Math.round(x)) < 1e-9) return Math.round(x).toLocaleString('en-US');
    return x.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const DISCORD_AUDIT_WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();

function getOnlineUsernameByUserId(userId) {
    const needle = String(userId || '').trim();
    if (!needle) return null;
    for (const p of onlinePlayers.values()) {
        if (String(p.userId) === needle) {
            const u = typeof p.username === 'string' ? p.username.trim() : '';
            return u || null;
        }
    }
    return null;
}

async function postDiscordAudit(text) {
    if (!DISCORD_AUDIT_WEBHOOK) {
        console.warn('[Webhook] No webhook URL configured, skipping audit.');
        return;
    }
    try {
        const res = await fetch(DISCORD_AUDIT_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text })
        });
        if (res.ok) {
            console.log(`[Webhook] Audit sent successfully: ${text.slice(0, 50)}...`);
        } else {
            const body = await res.text();
            console.error(`[Webhook] Failed to send audit (HTTP ${res.status}):`, body);
        }
    } catch (e) {
        console.error('[Webhook] Network error during send:', e && e.message);
    }
}

/** Roblox user id from presence payloads (number or numeric string). Guest socket ids return null. */
function parseRobloxNumericId(val) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) return Math.floor(val);
    if (typeof val === 'string') {
        const t = val.trim();
        if (/^\d+$/.test(t)) {
            const n = parseInt(t, 10);
            return n > 0 ? n : null;
        }
    }
    return null;
}

/**
 * Scan account_profile rows for a matching username (display name in saved profile JSON).
 * Paginates so we are not limited to the first 500 rows (common admin-search miss on prod).
 */
async function findUserIdByAccountProfileUsername(usernameNeedle) {
    if (!supabaseEnabled() || !usernameNeedle) return null;
    const target = String(usernameNeedle).trim().toLowerCase();
    if (!target) return null;
    const BATCH = 500;
    let offset = 0;
    const MAX_SCAN = 20000;
    while (offset < MAX_SCAN) {
        let res;
        try {
            res = await supabaseFetch(
                `transactions?type=eq.account_profile&select=user_id,game_name&order=created_at.asc&limit=${BATCH}&offset=${offset}`
            );
        } catch (e) {
            console.error('[Supabase] profile username scan:', e && e.message);
            return null;
        }
        if (!res.ok) {
            const detail = await readSupabaseErrorBody(res);
            console.error('[Supabase] profile username scan failed:', res.status, detail);
            return null;
        }
        let rows;
        try {
            rows = await res.json();
        } catch (e) {
            return null;
        }
        if (!Array.isArray(rows) || rows.length === 0) return null;
        for (const row of rows) {
            try {
                const p = JSON.parse(row.game_name || '{}');
                const un = p && p.username != null ? String(p.username).trim().toLowerCase() : '';
                if (un && un === target) {
                    const uid = parseInt(String(row.user_id).replace(/\D/g, ''), 10);
                    if (!Number.isNaN(uid) && uid > 0) return uid;
                }
            } catch (_) {}
        }
        if (rows.length < BATCH) return null;
        offset += BATCH;
    }
    return null;
}

/** One-shot read of PostgREST / Supabase error body for logs and API `detail` fields. */
async function readSupabaseErrorBody(res) {
    try {
        const t = await res.text();
        if (!t) return `HTTP ${res.status}`;
        try {
            const j = JSON.parse(t);
            if (typeof j.message === 'string' && j.message) return j.message;
            if (typeof j.error === 'string' && j.error) return j.error;
            if (typeof j.hint === 'string' && j.hint) return j.hint;
            if (typeof j.details === 'string' && j.details) return j.details;
            return t.slice(0, 500);
        } catch (_) {
            return t.slice(0, 500);
        }
    } catch (e) {
        return `HTTP ${res.status}`;
    }
}

function num(v, fallback = 0) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

// =====================================================================
// PER-USER ASYNC MUTEX â€” prevents race conditions / multi-tab dupes
// =====================================================================
const _userLocks = new Map();
async function withUserLock(userId, fn) {
    const key = String(userId || 'anon');
    const prev = _userLocks.get(key) || Promise.resolve();
    let resolveLock;
    const current = new Promise(r => { resolveLock = r; });
    _userLocks.set(key, current);
    try {
        await prev;
        return await fn();
    } finally {
        resolveLock();
        if (_userLocks.get(key) === current) _userLocks.delete(key);
    }
}

// Server-side Blackjack score (mirrors client getScore)
function serverBjScore(hand) {
    if (!Array.isArray(hand)) return 0;
    let score = 0, aces = 0;
    for (const card of hand) {
        score += (typeof card.score === 'number' ? card.score : 0);
        if (card.value === 'A') aces++;
    }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

// Server-side Plinko multiplier table (mirrors client getMultipliers)
const SERVER_PLINKO_MULTIPLIERS = {
    8:  { easy:[5.6,2.1,1.1,1.0,0.5,1.0,1.1,2.1,5.6], normal:[14,3,1.3,0.7,0.4,0.7,1.3,3,14], hard:[29,4,1.5,0.3,0.2,0.3,1.5,4,29] },
    10: { easy:[8.9,3,1.4,1.1,1.0,0.5,1.0,1.1,1.4,3,8.9], normal:[22,5,2,1.4,0.6,0.4,0.6,1.4,2,5,22], hard:[76,10,3,0.9,0.3,0.2,0.3,0.9,3,10,76] },
    12: { easy:[11,4,1.6,1.4,1.1,1.0,0.5,1.0,1.1,1.4,1.6,4,11], normal:[33,8.9,3,1.7,1.1,0.6,0.3,0.6,1.1,1.7,3,8.9,33], hard:[170,24,8.1,1.9,0.7,0.2,0.2,0.2,0.7,1.9,8.1,24,170] },
    14: { easy:[15,7.1,2.1,1.6,1.3,1.1,1.0,0.5,1.0,1.1,1.3,1.6,2.1,7.1,15], normal:[58,15,6,2,1.3,1.1,0.3,0.2,0.3,1.1,1.3,2,6,15,58], hard:[420,56,18,5,1.9,0.3,0.2,0.2,0.2,0.3,1.9,5,18,56,420] },
    16: { easy:[16,9,2.4,1.7,1.4,1.3,1.1,1.0,0.5,1.0,1.1,1.3,1.4,1.7,2.4,9,16], normal:[110,41,10,5,3,1.5,1.0,0.5,0.3,0.5,1.0,1.5,3,5,10,41,110], hard:[1000,130,26,9,2,0.5,0.2,0.2,0.2,0.2,0.2,0.5,2,9,26,130,1000] }
};
function getServerPlinkoMultiplier(rows, diff, idx) {
    const r = parseInt(rows) || 16;
    const table = SERVER_PLINKO_MULTIPLIERS[r];
    if (!table) return 0;
    const arr = table[String(diff)] || table['easy'];
    return (arr && arr[idx] != null) ? arr[idx] : 0;
}

/** Legacy: fold flipBalance into balance and drop the field (single RoBet balance). */
function mergeFlipIntoBalance(save) {
    if (!save || typeof save !== 'object') return;
    if (typeof save.flipBalance === 'number' && save.flipBalance > 0) {
        const b = typeof save.balance === 'number' && save.balance >= 0 ? save.balance : 0;
        save.balance = b + save.flipBalance;
    }
    delete save.flipBalance;
}

/**
 * @param {number} userId
 * @returns {Promise<{ balance_zr: number, balance_zh: number } | null>}
 */
async function getUserBalance(userId) {
    if (!supabaseEnabled()) return null;
    const uid = encodeURIComponent(String(userId));
    let res;
    try {
        res = await supabaseFetch(`user_balances?user_id=eq.${uid}&select=balance_zr,balance_zh`);
    } catch (e) {
        lastSupabaseBalanceError = formatNodeFetchError(e);
        console.error('getUserBalance network error:', lastSupabaseBalanceError);
        return null;
    }
    if (!res.ok) {
        let errText = '';
        try {
            errText = await readSupabaseErrorBody(res);
        } catch (_) {
            try {
                errText = await res.text();
            } catch (_e) {
                errText = '';
            }
        }
        lastSupabaseBalanceError = `HTTP ${res.status} ${errText}`.trim().slice(0, 800);
        console.error('getUserBalance failed:', res.status, errText);
        return null;
    }
    let rows;
    try {
        rows = await res.json();
    } catch (e) {
        lastSupabaseBalanceError = 'Invalid JSON from user_balances';
        return null;
    }
    if (!Array.isArray(rows)) {
        lastSupabaseBalanceError = 'user_balances response was not a JSON array';
        return null;
    }
    lastSupabaseBalanceError = '';
    // Empty DB (e.g. new Supabase project): no row yet — treat as 0 so games/sync work; first write upserts via updateUserBalance.
    if (rows.length === 0) {
        return { balance_zr: 0, balance_zh: 0 };
    }
    return {
        balance_zr: num(rows[0].balance_zr, 0),
        balance_zh: num(rows[0].balance_zh, 0)
    };
}

/**
 * Upsert user_balances without relying on PostgREST `on_conflict` (needs UNIQUE on user_id).
 * Flow: SELECT row â†’ PATCH if exists, else INSERT.
 * @returns {Promise<{ ok: true } | { ok: false, step: string, detail: string, status?: number }>}
 */
async function updateUserBalance(userId, balanceZr, legacyBalanceZh = 0) {
    if (!supabaseEnabled()) {
        return { ok: false, step: 'config', detail: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY' };
    }
    const uid = encodeURIComponent(String(userId));
    const row = {
        user_id: String(userId),
        balance_zr: balanceZr + legacyBalanceZh,
        balance_zh: 0,
        updated_at: new Date().toISOString()
    };

    let getRes;
    try {
        getRes = await supabaseFetch(`user_balances?user_id=eq.${uid}&select=user_id&limit=1`);
    } catch (e) {
        return { ok: false, step: 'user_balances_select', detail: String(e && e.message) };
    }
    if (!getRes.ok) {
        const detail = await readSupabaseErrorBody(getRes);
        console.error('updateUserBalance SELECT failed:', getRes.status, detail);
        return { ok: false, step: 'user_balances_select', detail, status: getRes.status };
    }

    let rows;
    try {
        rows = await getRes.json();
    } catch (e) {
        return { ok: false, step: 'user_balances_select', detail: 'Invalid JSON from Supabase' };
    }

    const exists = Array.isArray(rows) && rows.length > 0;

    if (exists) {
        let patchRes;
        try {
            patchRes = await supabaseFetch(`user_balances?user_id=eq.${uid}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({
                    balance_zr: row.balance_zr,
                    balance_zh: 0,
                    updated_at: row.updated_at
                })
            });
        } catch (e) {
            return { ok: false, step: 'user_balances_patch', detail: String(e && e.message) };
        }
        if (patchRes.ok) return { ok: true };
        const detail = await readSupabaseErrorBody(patchRes);
        console.error('updateUserBalance PATCH failed:', patchRes.status, detail);
        return { ok: false, step: 'user_balances_patch', detail, status: patchRes.status };
    }

    let insRes;
    try {
        insRes = await supabaseFetch('user_balances', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(row)
        });
    } catch (e) {
        return { ok: false, step: 'user_balances_insert', detail: String(e && e.message) };
    }
    if (insRes.ok) return { ok: true };
    const detail = await readSupabaseErrorBody(insRes);
    console.error('updateUserBalance INSERT failed:', insRes.status, detail);
    return { ok: false, step: 'user_balances_insert', detail, status: insRes.status };
}

/**
 * @param {number} userId
 * @param {number} amount
 * @param {string} currency
 * @param {string} type
 * @param {string} [gameName] stored in game_name (transaction description)
 * @returns {Promise<boolean>}
 */
async function addTransaction(userId, amount, currency, type, gameName) {
    if (!supabaseEnabled()) return false;
    const row = {
        user_id: String(userId),
        amount: num(amount, 0),
        currency: currency || 'zr',
        type: normalizeDbTxType(type),
        status: 'completed',
        game_name: gameName != null ? String(gameName) : '',
        reference_id: crypto.randomUUID()
    };
    let res;
    try {
        res = await supabaseFetch('transactions', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(row)
        });
    } catch (e) {
        console.error('addTransaction network error:', e && e.message);
        return false;
    }
    if (!res.ok) {
        try {
            console.error('addTransaction failed:', res.status, await res.text());
        } catch (_) {}
        return false;
    }
    return true;
}

function formatTxDateFromIso(iso) {
    if (!iso) return formatTxDateServer();
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return formatTxDateServer();
    const str = d.toDateString();
    return str.substring(0, 10) + ' ' + d.getFullYear() + ' ' + d.toTimeString().substring(0, 5);
}

function mapDbTxToClient(row) {
    const ref = row.reference_id != null ? String(row.reference_id) : '';
    const unpacked = unpackTxGameName(row.game_name);
    const id =
        unpacked.clientId ||
        (ref.length > 0 && !isUuidString(ref)
            ? ref
            : typeof row.id === 'string' && row.id.length
              ? row.id.slice(0, 8)
              : Math.floor(Math.random() * 0xffffffff)
                    .toString(16)
                    .padStart(8, '0'));
    return {
        id,
        desc: unpacked.desc,
        date: formatTxDateFromIso(row.created_at),
        amount: num(row.amount, 0),
        type: typeof row.type === 'string' ? row.type : 'deposit'
    };
}

function clientTxToRow(userId, tx) {
    const clientRef = tx.id != null ? String(tx.id) : null;
    return {
        user_id: String(userId),
        amount: num(tx.amount, 0),
        currency: 'zr',
        type: normalizeDbTxType(tx.type),
        status: 'completed',
        game_name: packTxGameName(tx.desc, tx.id),
        reference_id: coerceTxReferenceId(clientRef)
    };
}

function buildProfilePayload(save) {
    return {
        username: save.username,
        robloxAvatarUrl: save.robloxAvatarUrl,
        referralEarned: save.referralEarned,
        referredCount: save.referredCount,
        stats: save.stats && typeof save.stats === 'object' ? save.stats : {},
        savedAt: typeof save.savedAt === 'number' ? save.savedAt : Date.now()
    };
}

/**
 * Replace all transaction rows for user with client txs + one profile row.
 * @returns {Promise<{ ok: true } | { ok: false, step: string, detail: string, status?: number }>}
 */
async function persistAccountSave(userId, save, ignoreBalance = false) {
    if (!supabaseEnabled()) {
        return { ok: false, step: 'config', detail: 'Supabase not configured' };
    }
    const uid = encodeURIComponent(String(userId));

    if (!ignoreBalance) {
        const balanceZr = typeof save.balance === 'number' && save.balance >= 0 ? save.balance : 0;
        const balResult = await updateUserBalance(userId, balanceZr, 0);
        if (!balResult.ok) {
            return {
                ok: false,
                step: balResult.step || 'user_balances',
                detail: balResult.detail || 'Balance update failed',
                status: balResult.status
            };
        }
    }

    let delRes;
    try {
        delRes = await supabaseFetch(`transactions?user_id=eq.${uid}`, { method: 'DELETE' });
    } catch (e) {
        console.error('persistAccountSave delete txs network error:', e && e.message);
        return { ok: false, step: 'transactions_delete', detail: String(e && e.message) };
    }
    if (!delRes.ok) {
        const detail = await readSupabaseErrorBody(delRes);
        console.error('persistAccountSave delete failed:', delRes.status, detail);
        return { ok: false, step: 'transactions_delete', detail, status: delRes.status };
    }

    let profileJson;
    try {
        profileJson = JSON.stringify(buildProfilePayload(save));
    } catch (e) {
        profileJson = '{}';
    }

    const profileRow = {
        user_id: String(userId),
        amount: 0,
        currency: 'zr',
        type: 'account_profile',
        status: 'ok',
        game_name: profileJson,
        reference_id: PROFILE_REF_UUID
    };

    let profRes;
    try {
        profRes = await supabaseFetch('transactions', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(profileRow)
        });
    } catch (e) {
        console.error('persistAccountSave profile network error:', e && e.message);
        return { ok: false, step: 'transactions_profile_insert', detail: String(e && e.message) };
    }
    if (!profRes.ok) {
        const detail = await readSupabaseErrorBody(profRes);
        console.error('persistAccountSave profile failed:', profRes.status, detail);
        return { ok: false, step: 'transactions_profile_insert', detail, status: profRes.status };
    }

    const txs = Array.isArray(save.transactions) ? save.transactions.slice(0, 100) : [];
    const rows = txs.map((tx) => clientTxToRow(userId, tx));
    if (rows.length > 0) {
        let insRes;
        try {
            insRes = await supabaseFetch('transactions', {
                method: 'POST',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(rows)
            });
        } catch (e) {
            console.error('persistAccountSave insert txs network error:', e && e.message);
            return { ok: false, step: 'transactions_rows_insert', detail: String(e && e.message) };
        }
        if (!insRes.ok) {
            const detail = await readSupabaseErrorBody(insRes);
            console.error('persistAccountSave insert txs failed:', insRes.status, detail);
            return { ok: false, step: 'transactions_rows_insert', detail, status: insRes.status };
        }
    }

    return { ok: true };
}

/**
 * Client account-sync (POST): upsert account_profile row without DELETE (many RLS policies allow INSERT/PATCH but not DELETE).
 * Balance is never taken from the client.
 */
async function persistAccountProfileOnly(userId, save) {
    if (!supabaseEnabled()) {
        return { ok: false, step: 'config', detail: 'Supabase not configured' };
    }
    const uid = encodeURIComponent(String(userId));

    let profileJson;
    try {
        profileJson = JSON.stringify(buildProfilePayload(save));
    } catch (e) {
        profileJson = '{}';
    }

    let selRes;
    try {
        selRes = await supabaseFetch(
            `transactions?user_id=eq.${uid}&type=eq.account_profile&select=id&limit=5`
        );
    } catch (e) {
        return { ok: false, step: 'transactions_profile_select', detail: String(e && e.message) };
    }
    if (!selRes.ok) {
        const detail = await readSupabaseErrorBody(selRes);
        console.error('persistAccountProfileOnly SELECT failed:', selRes.status, detail);
        return { ok: false, step: 'transactions_profile_select', detail, status: selRes.status };
    }

    let existing = [];
    try {
        existing = await selRes.json();
    } catch (e) {
        existing = [];
    }

    if (Array.isArray(existing) && existing.length > 0 && existing[0].id != null) {
        const rowId = encodeURIComponent(String(existing[0].id));
        let patchRes;
        try {
            patchRes = await supabaseFetch(`transactions?id=eq.${rowId}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({ game_name: profileJson })
            });
        } catch (e) {
            return { ok: false, step: 'transactions_profile_patch', detail: String(e && e.message) };
        }
        if (patchRes.ok) return { ok: true };
        const patchDetail = await readSupabaseErrorBody(patchRes);
        console.warn('persistAccountProfileOnly PATCH failed, will try INSERT:', patchRes.status, patchDetail);
    }

    const profileRow = {
        user_id: String(userId),
        amount: 0,
        currency: 'zr',
        type: 'account_profile',
        status: 'ok',
        game_name: profileJson,
        reference_id: PROFILE_REF_UUID
    };

    let profRes;
    try {
        profRes = await supabaseFetch('transactions', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(profileRow)
        });
    } catch (e) {
        return { ok: false, step: 'transactions_profile_insert', detail: String(e && e.message) };
    }
    if (!profRes.ok) {
        const detail = await readSupabaseErrorBody(profRes);
        console.error('persistAccountProfileOnly INSERT failed:', profRes.status, detail);
        return { ok: false, step: 'transactions_profile_insert', detail, status: profRes.status };
    }

    return { ok: true };
}

/**
 * Full save object for the frontend (robloxUserId, balance, balanceZh, transactions, stats, â€¦).
 * @returns {Promise<object | null>}
 */
async function loadAccountFromSupabase(userId) {
    if (!supabaseEnabled()) return null;
    const uid = encodeURIComponent(String(userId));
    const bal = await getUserBalance(userId);
    if (!bal) return null;

    // Build a minimal save we can always return if transactions fail
    const baseSave = {
        robloxUserId: userId,
        balance: bal.balance_zr + (bal.balance_zh || 0),
        transactions: [],
        savedAt: Date.now()
    };

    let txRes;
    try {
        txRes = await supabaseFetch(
            `transactions?user_id=eq.${uid}&select=*&order=created_at.desc.nullslast`
        );
    } catch (e) {
        console.error('loadAccountFromSupabase txs network error:', e && e.message);
        return baseSave; // â† fallback: balance is known, just no tx history
    }
    if (!txRes.ok) {
        try {
            console.error('loadAccountFromSupabase txs failed:', txRes.status, await txRes.text());
        } catch (_) {}
        return baseSave; // â† fallback: balance is known, just no tx history
    }

    let all;
    try {
        all = await txRes.json();
    } catch (e) {
        return baseSave;
    }
    if (!Array.isArray(all)) return baseSave;

    let profile = {};
    const clientTxs = [];
    for (const row of all) {
        const refStr = row.reference_id != null ? String(row.reference_id) : '';
        if (
            row.type === 'account_profile' &&
            (refStr === PROFILE_REF_ID || refStr === PROFILE_REF_UUID)
        ) {
            try {
                profile = JSON.parse(row.game_name || '{}');
            } catch (e) {
                profile = {};
            }
        } else if (row.type !== 'account_profile') {
            clientTxs.push(mapDbTxToClient(row));
        }
    }

    const save = {
        robloxUserId: userId,
        balance: bal.balance_zr + (bal.balance_zh || 0),
        transactions: clientTxs.slice(0, 100),
        savedAt: typeof profile.savedAt === 'number' ? profile.savedAt : Date.now()
    };

    if (typeof profile.username === 'string') save.username = profile.username;
    if (profile.robloxAvatarUrl != null) save.robloxAvatarUrl = profile.robloxAvatarUrl;
    if (typeof profile.referralEarned === 'number') save.referralEarned = profile.referralEarned;
    if (typeof profile.referredCount === 'number') save.referredCount = profile.referredCount;
    if (profile.stats && typeof profile.stats === 'object') save.stats = profile.stats;

    mergeFlipIntoBalance(save);
    return save;
}

/** @deprecated name kept for game-pass merge flow */
async function readAccountJson(userId) {
    return loadAccountFromSupabase(userId);
}

/** Positive Roblox user id for DB ops, or null. */
function parseRobloxUserIdStrict(val) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) return Math.floor(val);
    if (typeof val === 'string') {
        const t = val.trim();
        if (/^\d+$/.test(t)) {
            const n = parseInt(t, 10);
            return n > 0 ? n : null;
        }
    }
    return null;
}

/**
 * Split `total` RoBet across `count` recipients in whole cents so the sum matches exactly (e.g. 100k / 2 => 50k each).
 * @param {number} total
 * @param {number} count
 * @returns {number[]}
 */
function splitAmountEqually(total, count) {
    if (count < 1 || typeof total !== 'number' || !Number.isFinite(total) || total < 0) return [];
    const cents = Math.round(total * 100);
    const base = Math.floor(cents / count);
    const rem = cents % count;
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push((base + (i < rem ? 1 : 0)) / 100);
    }
    return out;
}

/**
 * Load Supabase save or return a minimal new save so rain/tip payouts can create `user_balances` rows.
 */
async function loadOrCreateAccountSave(rawUserId) {
    const uid = parseRobloxUserIdStrict(rawUserId);
    if (uid == null) return null;
    const existing = await readAccountJson(uid);
    if (existing) return existing;
    if (!supabaseEnabled()) return null;
    return {
        robloxUserId: uid,
        balance: 0,
        balanceZh: 0,
        stats: {},
        transactions: [],
        savedAt: Date.now()
    };
}

/** CDN URL from Roblox thumbnails API â€” works in <img>; www.roblox.com headshot URLs often fail off-site. */
function fetchRobloxAvatarHeadshotUrl(userId) {
    const path = `/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=420x420&format=Png&isCircular=true`;
    return new Promise((resolve) => {
        https
            .get(
                {
                    hostname: 'thumbnails.roblox.com',
                    port: 443,
                    path
                },
                (robRes) => {
                    const chunks = [];
                    robRes.on('data', (c) => chunks.push(c));
                    robRes.on('end', () => {
                        try {
                            const json = JSON.parse(Buffer.concat(chunks).toString());
                            const row = json.data && json.data[0];
                            const url = row && row.imageUrl;
                            resolve(typeof url === 'string' && url.startsWith('http') ? url : null);
                        } catch (e) {
                            resolve(null);
                        }
                    });
                }
            )
            .on('error', () => resolve(null));
    });
}

/** Safe charset: letters + digits that are unlikely to be censored as profanity; no spaces/symbols Roblox may strip. */
const VERIFY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VERIFY_CODE_LEN = 12;

function fetchRobloxUserDescription(userId) {
    const id = parseInt(String(userId), 10);
    if (!id || id < 1) return Promise.resolve(null);
    return new Promise((resolve) => {
        https
            .get(
                {
                    hostname: 'users.roblox.com',
                    port: 443,
                    path: `/v1/users/${encodeURIComponent(id)}`
                },
                (robRes) => {
                    const chunks = [];
                    robRes.on('data', (c) => chunks.push(c));
                    robRes.on('end', () => {
                        try {
                            const json = JSON.parse(Buffer.concat(chunks).toString());
                            const desc =
                                json && typeof json.description === 'string' ? json.description : '';
                            resolve(desc);
                        } catch (e) {
                            resolve(null);
                        }
                    });
                }
            )
            .on('error', () => resolve(null));
    });
}

function isValidVerificationCode(code) {
    if (typeof code !== 'string' || code.length !== VERIFY_CODE_LEN) return false;
    for (let i = 0; i < code.length; i++) {
        if (VERIFY_CODE_CHARS.indexOf(code[i]) === -1) return false;
    }
    return true;
}

function lookupRobloxUsername(username) {
    const trimmed = String(username || '').trim();
    if (trimmed.length < 2) {
        return Promise.resolve({ ok: false, status: 400, body: { error: 'Username too short' } });
    }
    const payload = JSON.stringify({
        usernames: [trimmed],
        excludeBannedUsers: false
    });
    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: 'users.roblox.com',
                port: 443,
                path: '/v1/usernames/users',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            },
            (robRes) => {
                const chunks = [];
                robRes.on('data', (c) => chunks.push(c));
                robRes.on('end', () => {
                    const raw = Buffer.concat(chunks).toString();
                    try {
                        const json = JSON.parse(raw);
                        const row = json.data && json.data[0];
                        if (!row || typeof row.id !== 'number') {
                            resolve({ ok: false, status: 404, body: { error: 'User not found' } });
                            return;
                        }
                        resolve({
                            ok: true,
                            body: {
                                id: row.id,
                                name: row.name,
                                displayName: row.displayName || row.name
                            }
                        });
                    } catch (e) {
                        resolve({ ok: false, status: 502, body: { error: 'Bad response from Roblox' } });
                    }
                });
            }
        );
        req.on('error', () => {
            resolve({ ok: false, status: 502, body: { error: 'Could not reach Roblox' } });
        });
        req.write(payload);
        req.end();
    });
}

function formatTxDateServer() {
    const d = new Date();
    const str = d.toDateString();
    return str.substring(0, 10) + ' ' + d.getFullYear() + ' ' + d.toTimeString().substring(0, 5);
}

app.use(express.json({ limit: '2mb' }));

/**
 * Recent wager outcomes for the home â€œLive feedâ€.
 * Uses Supabase table `live_feed_events` when configured; otherwise an in-memory buffer (lost on restart).
 *
 * Example SQL:
 *   create table live_feed_events (
 *     id bigint generated always as identity primary key,
 *     username text not null,
 *     game_key text not null,
 *     bet_amount double precision not null,
 *     multiplier double precision not null,
 *     payout double precision not null,
 *     created_at timestamptz not null default now()
 *   );
 *   create index on live_feed_events (created_at desc);
 *   alter table live_feed_events enable row level security;
 *   create policy "live_feed_read" on live_feed_events for select using (true);
 *   create policy "live_feed_write" on live_feed_events for insert with check (true);
 */
const LIVE_FEED_MEMORY_CAP = 250;
const liveFeedMemory = [];
const liveFeedRateByIp = new Map();
const LIVE_FEED_RATE_WINDOW_MS = 60000;
const LIVE_FEED_RATE_MAX = 50;
const LIVE_FEED_GAME_KEYS = new Set([
    'crash',
    'blackjack',
    'dice',
    'mines',
    'towers',
    'plinko',
    'rooms',
    'aviamasters'
]);

function sanitizeLiveFeedUsername(u) {
    let s = String(u == null ? 'Guest' : u)
        .trim()
        .slice(0, 40);
    s = s.replace(/[\x00-\x1f\x7f]/g, '');
    return s || 'Guest';
}

function liveFeedCheckRateLimit(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    let rec = liveFeedRateByIp.get(key);
    if (!rec || now - rec.start > LIVE_FEED_RATE_WINDOW_MS) {
        liveFeedRateByIp.set(key, { start: now, n: 1 });
        return true;
    }
    if (rec.n >= LIVE_FEED_RATE_MAX) return false;
    rec.n += 1;
    return true;
}

function liveFeedMemoryPush(ev) {
    liveFeedMemory.unshift(ev);
    if (liveFeedMemory.length > LIVE_FEED_MEMORY_CAP) liveFeedMemory.length = LIVE_FEED_MEMORY_CAP;
    saveLiveFeedMemorySync();
}

function loadLiveFeedMemorySync() {
    try {
        if (!fs.existsSync(LIVE_FEED_MEMORY_FILE)) return;
        const raw = fs.readFileSync(LIVE_FEED_MEMORY_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        liveFeedMemory.length = 0;
        for (const e of parsed.slice(0, LIVE_FEED_MEMORY_CAP)) {
            if (!e || typeof e !== 'object') continue;
            liveFeedMemory.push({
                id: e.id != null ? e.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                userId: e.userId || null,
                username: sanitizeLiveFeedUsername(e.username),
                gameKey: LIVE_FEED_GAME_KEYS.has(String(e.gameKey || '').toLowerCase()) ? String(e.gameKey).toLowerCase() : 'dice',
                bet: num(e.bet, 0),
                multiplier: num(e.multiplier, 0),
                payout: num(e.payout, 0),
                createdAt: Number.isFinite(Number(e.createdAt)) ? Number(e.createdAt) : Date.now()
            });
        }
    } catch (e) {
        console.error('[LiveFeed] load fallback memory failed:', e && e.message);
        liveFeedMemory.length = 0;
    }
}

function saveLiveFeedMemorySync() {
    try {
        fs.mkdirSync(path.dirname(LIVE_FEED_MEMORY_FILE), { recursive: true });
        fs.writeFileSync(
            LIVE_FEED_MEMORY_FILE,
            JSON.stringify(liveFeedMemory.slice(0, LIVE_FEED_MEMORY_CAP), null, 2),
            'utf8'
        );
    } catch (e) {
        console.error('[LiveFeed] save fallback memory failed:', e && e.message);
    }
}

async function liveFeedInsertSupabase(row) {
    if (!supabaseEnabled()) return false;
    const body = {
        username: row.username,
        game_key: row.gameKey,
        bet_amount: row.bet,
        multiplier: row.multiplier,
        payout: row.payout
    };
    try {
        const res = await supabaseFetch('live_feed_events', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(body)
        });
        return res.ok;
    } catch (e) {
        return false;
    }
}

async function liveFeedListSupabase(limit) {
    if (!supabaseEnabled()) return null;
    const lim = encodeURIComponent(String(limit));
    try {
        const res = await supabaseFetch(
            `live_feed_events?select=*&order=created_at.desc&limit=${lim}`
        );
        if (!res.ok) return null;
        const rows = await res.json();
        if (!Array.isArray(rows)) return null;
        return rows.map((r) => ({
            id: r.id,
            username: r.username,
            gameKey: r.game_key,
            bet: num(r.bet_amount, 0),
            multiplier: num(r.multiplier, 0),
            payout: num(r.payout, 0),
            createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now()
        }));
    } catch (e) {
        return null;
    }
}

// ==== CUSTOM GAME MECHANICS (CUS) AND SERVER OUTCOMES ====
const activeMinesGames = new Map();
const activeTowersGames = new Map();
const activeBlackjackGames = new Map();
/** Case battles — entry fees, rolls, and payouts are server-side only */
const caseBattles = new Map();
const caseBattleStarting = new Set();
const userCusStates = new Map();
/** Comma-separated Roblox user IDs; set ADMIN_ROBLOX_IDS on Render (omit or leave empty to keep defaults below) */
const _adminEnv = process.env.ADMIN_ROBLOX_IDS;
const ADMIN_IDS =
    _adminEnv != null && String(_adminEnv).trim().length > 0
        ? String(_adminEnv)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : ['1873471419', '9113981616'];
const adminRigOverrides = new Map(); // 'win', 'lose', 'default'

function getCusState(userId) {
    const id = String(userId || 'guest');
    if (!userCusStates.has(id)) {
        userCusStates.set(id, { winStreak: 0, forceLossNext: false });
    }
    const state = userCusStates.get(id);
    return {
        check: function() { // returns true if forced loss
            const override = adminRigOverrides.get(id);
            if (override === 'lose') return true;
            if (override === 'win') return false; // Never naturally lose if forcing win
            
            if (state.forceLossNext) {
                state.forceLossNext = false;
                state.winStreak = 0;
                return true;
            }
            if (state.winStreak > 3.5) {
                let chance = 0.042 + (state.winStreak * 0.05); 
                if (chance > 0.342) chance = 0.342; 
                if (state.winStreak >= 5 && Math.random() < 0.02) chance = 1.0; 
                
                if (Math.random() < chance) {
                    state.winStreak = 0;
                    return true;
                }
            }
            return false;
        },
        checkWin: function() { // returns true if forced win
            return adminRigOverrides.get(id) === 'win';
        },
        recordWin: function(isBigWin) {
            state.winStreak++;
            if (isBigWin && Math.random() < 0.115) { 
                state.forceLossNext = true;
            }
        },
        recordLoss: function() {
            state.winStreak = 0;
            state.forceLossNext = false;
        }
    };
}

// =====================================================================
// SERVER-SIDE BET DEDUCTION & WIN CREDIT â€” prevents multi-tab exploit
// =====================================================================

/**
 * Atomically deduct a bet from Supabase. Returns { ok, newBalance, balanceZh } or { ok:false, error }.
 * Tolerates up to 0.001 floating-point error.
 */
async function deductUserBet(userId, betAmount) {
    const uid = parseRobloxNumericId(userId);
    if (!uid) return { ok: false, error: 'Invalid userId' };
    const bet = num(betAmount, 0);
    if (bet <= 0) return { ok: false, error: 'Invalid bet amount' };
    if (!supabaseEnabled()) return { ok: false, error: 'Database not configured' };
    const bal = await getUserBalance(uid);
    if (!bal) return { ok: false, error: 'Could not read balance. Try again.' };
    if (bal.balance_zr < bet - 0.001) return { ok: false, error: 'Insufficient balance.' };
    const newBalance = Math.max(0, Math.round((bal.balance_zr - bet) * 100) / 100);
    const result = await updateUserBalance(uid, newBalance, bal.balance_zh);
    if (!result.ok) return { ok: false, error: 'Could not update balance. Try again.' };
    return { ok: true, newBalance, balanceZh: bal.balance_zh };
}

/**
 * Credit a win to Supabase and push balance:remote_sync to ALL tabs for this user.
 * Pass winAmount=0 to only sync (e.g. after a loss already deducted at start).
 */
async function creditUserWin(userId, winAmount) {
    const uid = parseRobloxNumericId(userId);
    if (!uid) return { ok: false, error: 'Invalid userId' };
    if (!supabaseEnabled()) return { ok: false, error: 'Database not configured' };
    const bal = await getUserBalance(uid);
    if (!bal) return { ok: false, error: 'Could not read balance' };
    let newBalance = bal.balance_zr;
    let result = { ok: true };
    if (winAmount > 0) {
        newBalance = Math.round((bal.balance_zr + winAmount) * 100) / 100;
        result = await updateUserBalance(uid, newBalance, bal.balance_zh);
    }
    // Push the authoritative balance to every open tab for this user
    emitBalanceRemoteSync(io, uid, { balance: newBalance, balanceZh: bal.balance_zh, stats: {} });
    return { ok: result.ok, newBalance, balanceZh: bal.balance_zh };
}

/** Server-side mines multiplier (mirrors client getMulti) */
function computeMinesMultiplier(bombs, revealed) {
    if (revealed <= 0) return 1.0;
    let prob = 1.0;
    for (let i = 0; i < revealed; i++) {
        prob *= (25 - bombs - i) / (25 - i);
    }
    return parseFloat((0.95 / prob).toFixed(2));
}

/** Server-side towers multiplier (mirrors client getDiffConfig / Math.pow) */
function computeTowersMultiplier(diff, row) {
    const base = diff === 'hard' ? 2.85 : diff === 'normal' ? 1.42 : 1.28;
    return parseFloat(Math.pow(base, row).toFixed(4));
}

app.post('/api/game/dice', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, target, isOver, bet } = req.body;
    
    await withUserLock(userId, async () => {
        // SECURITY: multi is computed SERVER-SIDE from target/isOver â€” client value ignored entirely.
        const betVal = num(bet, 0);
        const targetVal = parseFloat(target);
        if (!Number.isFinite(targetVal) || targetVal <= 0 || targetVal >= 100) {
            return res.status(400).json({ error: 'Invalid target.' });
        }
        // Compute the fair multiplier server-side (mirrors client formula)
        const serverMulti = parseFloat(((isOver ? (100 - targetVal) : targetVal) / 99 * 0.95).toFixed(4));
        if (!Number.isFinite(serverMulti) || serverMulti <= 0) {
            return res.status(400).json({ error: 'Invalid multiplier computation.' });
        }
        // Atomically deduct bet before computing outcome
        if (betVal > 0 && supabaseEnabled()) {
            const deduct = await deductUserBet(userId, betVal);
            if (!deduct.ok) return res.status(400).json({ error: deduct.error });
        }
        let forceLoss = getCusState(userId).check();
        let forceWin = getCusState(userId).checkWin();
        let roll;
        if (forceWin) {
            if (isOver) roll = targetVal + Math.max(0.01, (Math.random() * (99.99 - targetVal)));
            else roll = (Math.random() * targetVal);
            if (roll >= 100) roll = 99.99;
        } else if (forceLoss) {
            if (isOver) roll = (Math.random() * targetVal);
            else {
                roll = targetVal + (Math.random() * (100 - targetVal));
                if (roll >= 100) roll = 99.99;
            }
        } else {
            roll = (Math.random() * 100);
        }
        roll = parseFloat(roll.toFixed(2));
        const win = isOver ? (roll > targetVal) : (roll < targetVal);
        // Credit win (or just sync balance on loss) â€” all tabs get updated via socket
        if (betVal > 0 && supabaseEnabled()) {
            const winAmount = win ? betVal * serverMulti : 0;
            await creditUserWin(userId, winAmount);
        }
        if (win) getCusState(userId).recordWin(serverMulti >= 3);
        else getCusState(userId).recordLoss();
        res.json({ roll, win, multi: serverMulti });
    });
});

app.post('/api/game/plinko', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, pRows, pDiff, bet } = req.body;
    const betVal = num(bet, 0);
    const uid = parseRobloxNumericId(userId);

    await withUserLock(userId, async () => {
        // STEP 1: Atomically deduct bet server-side before any outcome
        if (betVal > 0 && uid && supabaseEnabled()) {
            const deduct = await deductUserBet(userId, betVal);
            if (!deduct.ok) return res.status(400).json({ error: deduct.error });
            emitBalanceRemoteSync(io, uid, { balance: deduct.newBalance, balanceZh: deduct.balanceZh, stats: {} });
        }

        const rows = parseInt(pRows) || 16;
        const diff = String(pDiff || 'hard');

        // STEP 2: Weighted bucket selection (same weights as client)
        const weightTables = {
            8:  { easy:[0.5,3,8,17,25,17,8,3,0.5], normal:[0.3,2,7,16,24,16,7,2,0.3], hard:[0.3,2,8,18,26,18,8,2,0.3] },
            10: { easy:[0.5,2,5,10,17,23,17,10,5,2,0.5], normal:[0.3,1.5,4,9,16,22,16,9,4,1.5,0.3], hard:[0.3,2,5,12,20,25,20,12,5,2,0.3] },
            12: { easy:[0.5,1.5,3,6,10,16,20,16,10,6,3,1.5,0.5], normal:[0.3,1,3,6,10,17,22,17,10,6,3,1,0.3], hard:[0.25,1.5,4,6,15,20,20,20,15,6,4,1.5,0.25] },
            14: { easy:[0.4,1,2,4,7,12,16,17,16,12,7,4,2,1,0.4], normal:[0.3,0.7,2,4,7,12,17,20,17,12,7,4,2,0.7,0.3], hard:[0.25,1.5,3,5,5,15,15,15,15,15,5,5,3,1.5,0.25] },
            16: { easy:[0.3,0.8,1.5,3,5,7,10,14,18,14,10,7,5,3,1.5,0.8,0.3], normal:[0.2,0.5,1.5,3,6,10,15,20,20,20,15,10,6,3,1.5,0.5,0.2], hard:[0.25,1.25,3.35,5,3,5,13,13,13,13,13,5,3,5,3.35,1.25,0.25] }
        };
        const table = weightTables[rows];
        const weights = table ? (table[diff] || table['easy']) : null;
        let idx;
        if (weights) {
            const total = weights.reduce((s, w) => s + w, 0);
            let r = Math.random() * total;
            idx = weights.length - 1;
            for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }
        } else {
            idx = Math.floor(rows / 2);
        }

        // STEP 3: Apply CUS bias
        const forceLoss = getCusState(userId).check();
        const forceWin = getCusState(userId).checkWin();
        if (forceWin) {
            const edges = [0, rows];
            idx = edges[Math.floor(Math.random() * edges.length)];
            getCusState(userId).recordWin(true);
        } else if (forceLoss) {
            const center = Math.floor(rows / 2);
            idx = center + (Math.random() < 0.5 ? -1 : 1) * Math.floor(Math.random() * 2);
            if (idx < 0) idx = 0;
            if (idx > rows) idx = rows;
            getCusState(userId).recordLoss();
        }

        // STEP 4: Credit win server-side
        let newBalance = null;
        if (betVal > 0 && uid && supabaseEnabled()) {
            const multiplier = getServerPlinkoMultiplier(rows, diff, idx);
            const winAmt = betVal * multiplier;
            const credit = await creditUserWin(userId, winAmt);
            if (credit.ok) newBalance = credit.newBalance;
            const bigWin = multiplier >= 3.0;
            if (!forceLoss && !forceWin) {
                if (multiplier >= 1.0) getCusState(userId).recordWin(bigWin);
                else getCusState(userId).recordLoss();
            }
        }

        res.json({ customOutcome: true, idx, newBalance });
    });
});

/**
 * Avia Masters — server-side RNG round (no manual cash-out). Outcome + event log for client animation.
 * CUS: forceLoss / forceWin bias terminal rolls like dice/plinko.
 */
function simulateAviaMastersRound(forceLoss, forceWin) {
    let mult = 1;
    const events = [];
    const maxSteps = 48;
    for (let step = 0; step < maxSteps; step++) {
        let crashP = forceLoss ? 0.26 : 0.085;
        let landP = forceWin ? 0.22 : 0.065;
        if (mult >= 75) landP += 0.12;
        if (step < 2) crashP *= 0.45;
        const r = Math.random();
        if (r < crashP) {
            events.push({ type: 'crash' });
            return { won: false, mult: 0, events, tier: 'loss' };
        }
        if (r < crashP + landP) {
            const fm = Math.min(Math.max(0.5, mult), 80);
            events.push({ type: 'land', mult: fm });
            const tier =
                fm >= 50 ? 'superMega' : fm >= 20 ? 'mega' : fm >= 8 ? 'big' : 'win';
            return { won: true, mult: fm, events, tier };
        }
        const r2 = Math.random();
        if (r2 < 0.34) {
            const adds = [1, 1, 2, 2, 2, 5, 5, 10];
            const add = adds[Math.floor(Math.random() * adds.length)];
            mult += add;
            events.push({ type: 'prize', add });
        } else if (r2 < 0.52) {
            const boosts = [2, 2, 3, 4, 5];
            const b = boosts[Math.floor(Math.random() * boosts.length)];
            mult *= b;
            events.push({ type: 'boost', mult: b });
        } else if (r2 < 0.68) {
            const before = mult;
            mult = Math.max(0.35, mult * 0.5);
            events.push({ type: 'rocket', before, after: mult });
        } else {
            events.push({ type: 'cruise' });
        }
        mult = Math.min(Math.max(0.35, mult), 130);
    }
    if (forceLoss) {
        events.push({ type: 'crash' });
        return { won: false, mult: 0, events, tier: 'loss' };
    }
    const fm = Math.min(Math.max(0.5, mult), 80);
    events.push({ type: 'land', mult: fm });
    const tier = fm >= 50 ? 'superMega' : fm >= 20 ? 'mega' : fm >= 8 ? 'big' : 'win';
    return { won: true, mult: fm, events, tier };
}

app.post('/api/game/aviamasters/play', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, bet, speed } = req.body || {};
    const speedIdx = Math.max(0, Math.min(3, parseInt(speed, 10) || 1));

    await withUserLock(userId, async () => {
        const betVal = num(bet, 0);
        if (betVal > 0 && supabaseEnabled()) {
            const deduct = await deductUserBet(userId, betVal);
            if (!deduct.ok) return res.status(400).json({ error: deduct.error });
            emitBalanceRemoteSync(io, parseRobloxNumericId(userId), {
                balance: deduct.newBalance,
                balanceZh: deduct.balanceZh,
                stats: {}
            });
        }

        const forceLoss = getCusState(userId).check();
        const forceWin = getCusState(userId).checkWin();
        const round = simulateAviaMastersRound(forceLoss, forceWin);

        let winAmount = 0;
        if (betVal > 0 && supabaseEnabled()) {
            winAmount = round.won ? Math.round(betVal * round.mult * 100) / 100 : 0;
            await creditUserWin(userId, winAmount);
        }

        if (round.won) getCusState(userId).recordWin(round.mult >= 3);
        else getCusState(userId).recordLoss();

        res.json({
            ok: true,
            won: round.won,
            finalMultiplier: round.mult,
            tier: round.tier,
            events: round.events,
            speed: speedIdx
        });
    });
});

// REMOVED: /api/game/record-result was a public endpoint that allowed console manipulation of game outcomes.

app.post('/api/game/towers/start', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, rows, width, bombs, bet, diff } = req.body;
    await withUserLock(userId, async () => {
        const betVal = num(bet, 0);
        if (betVal > 0 && supabaseEnabled()) {
            const deduct = await deductUserBet(userId, betVal);
            if (!deduct.ok) return res.status(400).json({ error: deduct.error });
            // Immediately push depleted balance to all tabs
            emitBalanceRemoteSync(io, parseRobloxNumericId(userId), { balance: deduct.newBalance, balanceZh: deduct.balanceZh, stats: {} });
        }
        let logic = [];
        for(let r=0; r<rows; r++) {
            let rArr = Array(width).fill(false);
            let placed = 0;
            while(placed < bombs) {
                let i = Math.floor(Math.random()*width);
                if(!rArr[i]) { rArr[i] = true; placed++; }
            }
            logic.push(rArr);
        }
        // SECURITY: Server must track curRow to prevent fake cashouts
        activeTowersGames.set(String(userId), { logic, bet: betVal, diff: String(diff || 'easy'), curRow: 0 });
        res.json({ ok: true });
    });
});

app.post('/api/game/towers/click', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, row, col } = req.body;
    const g = activeTowersGames.get(String(userId));
    if (!g) return res.status(400).json({ error: 'No active game' });
    
    setTimeout(async () => {
        // SECURITY: Verify user is clicking the correct sequential row
        if (row !== g.curRow) return res.json({ error: 'Wrong row' });
        
        let logicRow = g.logic[row];
        if (!logicRow) return res.json({ error: 'Invalid row' });
        
        let forceLoss = getCusState(userId).check();
        let forceWin = getCusState(userId).checkWin();
        let isBomb = logicRow[col];
        
        if (forceWin && isBomb) {
            let safeIdx = logicRow.indexOf(false);
            if (safeIdx !== -1) {
                logicRow[safeIdx] = true;
                logicRow[col] = false;
                isBomb = false;
            }
        } else if (!isBomb && forceLoss) {
            let bIdx = logicRow.indexOf(true);
            if (bIdx !== -1) {
                logicRow[bIdx] = false;
                logicRow[col] = true;
                isBomb = true;
            }
        }
        
        if (isBomb) {
            getCusState(userId).recordLoss();
            activeTowersGames.delete(String(userId));
            // Bet was deducted at start â€” sync the true balance to all tabs
            if (supabaseEnabled()) await creditUserWin(userId, 0);
        } else {
            // SECURITY: Track progress server-side
            g.curRow++;
        }
        res.json({ isBomb, rowData: logicRow });
    }, Math.floor(Math.random() * 2500));
});

app.post('/api/game/towers/cashout', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, curRow: reqCurRow } = req.body;
    await withUserLock(userId, async () => {
        const g = activeTowersGames.get(String(userId));
        if (!g) return res.status(400).json({ error: 'No active game' });
        // SECURITY: Use server-tracked curRow, completely ignore req.body.curRow
        const targetRow = g.curRow || 0;
        activeTowersGames.delete(String(userId));
        if (g.bet > 0 && targetRow > 0 && supabaseEnabled()) {
            const multi = computeTowersMultiplier(g.diff || 'easy', targetRow);
            const winAmount = g.bet * multi;
            const result = await creditUserWin(userId, winAmount);
            getCusState(userId).recordWin(multi >= 3.0);
            return res.json({ ok: true, winAmount, multiplier: multi, newBalance: result.newBalance });
        }
        res.json({ ok: true });
    });
});

app.post('/api/game/mines/start', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, bombs, bet } = req.body;
    await withUserLock(userId, async () => {
        const betVal = num(bet, 0);
        if (betVal > 0 && supabaseEnabled()) {
            const deduct = await deductUserBet(userId, betVal);
            if (!deduct.ok) return res.status(400).json({ error: deduct.error });
            // Immediately push depleted balance to all tabs
            emitBalanceRemoteSync(io, parseRobloxNumericId(userId), { balance: deduct.newBalance, balanceZh: deduct.balanceZh, stats: {} });
        }
        const nb = Math.min(Math.max(parseInt(bombs) || 3, 1), 24);
        let mGrid = Array(25).fill(false);
        let placed = 0;
        while(placed < nb) {
            let idx = Math.floor(Math.random() * 25);
            if(!mGrid[idx]) { mGrid[idx] = true; placed++; }
        }
        // SECURITY: Server must track safeRevealed to prevent fake cashouts
        activeMinesGames.set(String(userId), { logic: mGrid, bet: betVal, bombs: nb, safeRevealed: new Set() });
        res.json({ ok: true });
    });
});

app.post('/api/game/mines/click', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, tileIdx } = req.body;
    const g = activeMinesGames.get(String(userId));
    if (!g) return res.status(400).json({ error: 'No active game' });
    
    setTimeout(async () => {
        // SECURITY: Prevent clicking the same tile twice
        if (g.safeRevealed.has(tileIdx)) return res.json({ error: 'Already clicked' });
        
        let isBomb = g.logic[tileIdx];
        let forceLoss = getCusState(userId).check();
        let forceWin = getCusState(userId).checkWin();
        
        if (forceWin && isBomb) {
            let safeIdx = g.logic.indexOf(false);
            if (safeIdx !== -1) {
                g.logic[safeIdx] = true;
                g.logic[tileIdx] = false;
                isBomb = false;
            }
        } else if (!isBomb && forceLoss) {
            let bIdx = g.logic.indexOf(true);
            if (bIdx !== -1) {
                g.logic[bIdx] = false;
                g.logic[tileIdx] = true;
                isBomb = true;
            }
        }
        if (isBomb) {
            getCusState(userId).recordLoss();
            activeMinesGames.delete(String(userId));
            // Bet was deducted at start â€” sync true balance to all tabs
            if (supabaseEnabled()) await creditUserWin(userId, 0);
        } else {
            // SECURITY: Track safely clicked tiles server-side
            g.safeRevealed.add(tileIdx);
        }
        res.json({ isBomb, mGridFull: isBomb ? g.logic : null });
    }, Math.floor(Math.random() * 2500));
});

app.post('/api/game/mines/cashout', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, revealed } = req.body;
    await withUserLock(userId, async () => {
        const g = activeMinesGames.get(String(userId));
        if (!g) return res.json({ error: 'No active game' });
        // SECURITY: Use server-tracked safeRevealed size, completely ignore req.body.revealed
        const revealedCount = (g.safeRevealed && g.safeRevealed.size) || 0;
        activeMinesGames.delete(String(userId));
        if (g.bet > 0 && revealedCount > 0 && supabaseEnabled()) {
            const multi = computeMinesMultiplier(g.bombs || 3, revealedCount);
            const winAmount = g.bet * multi;
            const result = await creditUserWin(userId, winAmount);
            getCusState(userId).recordWin(multi >= 3.0);
            return res.json({ logic: g.logic, winAmount, multiplier: multi, newBalance: result.newBalance });
        }
        // No tiles revealed or no bet â€” just sync balance (loss already deducted at start)
        if (supabaseEnabled()) await creditUserWin(userId, 0);
        res.json({ logic: g.logic });
    });
});

/** Session-restore: check if server still has an active mines game for this user */
app.get('/api/game/mines/status', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const g = activeMinesGames.get(userId);
    res.json({ active: !!g, bombs: g ? g.logic.filter(Boolean).length : 0 });
});

/** Session-restore: functionally disabled for security (prevent fake bet inflation) */
app.post('/api/game/mines/restore', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ok: false, restored: false, error: 'Session restoration disabled' });
});

/** Session-restore: check if server still has an active towers game for this user */
app.get('/api/game/towers/status', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const g = activeTowersGames.get(userId);
    res.json({ active: !!g });
});

/** Session-restore: functionally disabled for security */
app.post('/api/game/towers/restore', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ok: false, restored: false, error: 'Session restoration disabled' });
});

/** Blackjack hand total (aces count 11 then downgrade while busting). Mirrors client getScore. */
function bjHandScore(hand) {
    if (!Array.isArray(hand)) return 0;
    let score = 0;
    let aces = 0;
    for (const card of hand) {
        if (!card || typeof card.score !== 'number') continue;
        score += card.score;
        if (card.value === 'A') aces++;
    }
    while (score > 21 && aces > 0) {
        score -= 10;
        aces--;
    }
    return score;
}

/** Build a standard 52-card deck and shuffle it server-side (Fisher-Yates). */
function buildServerDeck() {
    const suits = [
        { letter: 'S', isRed: false }, { letter: 'C', isRed: false },
        { letter: 'H', isRed: true  }, { letter: 'D', isRed: true  }
    ];
    const faces = [
        { value: 'A', score: 11 }, { value: '2', score: 2  }, { value: '3', score: 3  },
        { value: '4', score: 4  }, { value: '5', score: 5  }, { value: '6', score: 6  },
        { value: '7', score: 7  }, { value: '8', score: 8  }, { value: '9', score: 9  },
        { value: '10', score: 10 }, { value: 'J', score: 10 }, { value: 'Q', score: 10 },
        { value: 'K', score: 10 }
    ];
    const deck = [];
    for (const s of suits) {
        for (const f of faces) {
            deck.push({ suitLetter: s.letter, isRed: s.isRed, value: f.value, score: f.score });
        }
    }
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

app.post('/api/game/blackjack/start', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // SECURITY: Deck is generated SERVER-SIDE â€” client deck is ignored entirely.
    const { userId, bet } = req.body;
    await withUserLock(userId, async () => {
        const betVal = num(bet, 0);
        if (betVal > 0 && supabaseEnabled()) {
            const deduct = await deductUserBet(userId, betVal);
            if (!deduct.ok) return res.status(400).json({ error: deduct.error });
            emitBalanceRemoteSync(io, parseRobloxNumericId(userId), { balance: deduct.newBalance, balanceZh: deduct.balanceZh, stats: {} });
        }
        let forceLoss = getCusState(userId).check();
        let forceWin = getCusState(userId).checkWin();

        // Build and shuffle deck on the server
        const deck = buildServerDeck();

        let pHand = [deck.pop(), deck.pop()];
        let dHand = [deck.pop(), deck.pop()];
        
        if (forceWin) {
            pHand = [
                {suitLetter: 'S', value: 'A', score: 11, isRed: false},
                {suitLetter: 'H', value: 'K', score: 10, isRed: true}
            ];
        } else if (forceLoss) {
            dHand = [
                {suitLetter: 'S', value: 'A', score: 11, isRed: false},
                {suitLetter: 'H', value: 'K', score: 10, isRed: true}
            ];
            let pScore = 0, aces = 0;
            for(let c of pHand) { pScore += c.score; if(c.value==='A') aces++; }
            while(pScore>21 && aces>0) { pScore-=10; aces--; }
            if (pScore === 21) pHand[0] = {suitLetter: 'C', value: '5', score: 5, isRed: false};
        }
        // Store FULL hand + deck state so server can authoritatively compute outcomes
        activeBlackjackGames.set(String(userId), {
            bet: betVal,
            pHand: [...pHand],
            dHand: [...dHand],
            deck: [...deck],
            forceLoss,
            forceWin
        });
        res.json({ deck, pHand, dHand });
    });
});

app.post('/api/game/blackjack/hit', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId } = req.body || {};
    await withUserLock(userId, async () => {
        const g = activeBlackjackGames.get(String(userId));
        if (!g) return res.status(400).json({ error: 'No active game' });
        if (!Array.isArray(g.deck) || g.deck.length === 0) {
            return res.status(400).json({ error: 'Deck empty' });
        }
        const card = g.deck.pop();
        g.pHand.push(card);
        const pScore = bjHandScore(g.pHand);
        if (pScore > 21) {
            activeBlackjackGames.delete(String(userId));
            if (g.bet > 0 && supabaseEnabled()) {
                await creditUserWin(userId, 0);
            }
            getCusState(userId).recordLoss();
            return res.json({ card, bust: true, pScore });
        }
        return res.json({ card, bust: false, pScore });
    });
});

app.post('/api/game/blackjack/stand', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId } = req.body || {};
    await withUserLock(userId, async () => {
        const g = activeBlackjackGames.get(String(userId));
        if (!g) return res.status(400).json({ error: 'No active game' });
        const bet = num(g.bet, 0);

        while (bjHandScore(g.dHand) < 17 && g.deck.length > 0) {
            g.dHand.push(g.deck.pop());
        }

        const pScore = bjHandScore(g.pHand);
        const dScore = bjHandScore(g.dHand);
        const pNatural = g.pHand.length === 2 && pScore === 21;
        const dNatural = g.dHand.length === 2 && dScore === 21;

        let outcome = 'push';
        if (dScore > 21) {
            outcome = 'win';
        } else if (pNatural && dNatural) {
            outcome = 'push';
        } else if (pNatural) {
            outcome = 'blackjack';
        } else if (dNatural) {
            outcome = 'lose';
        } else if (pScore > dScore) {
            outcome = 'win';
        } else if (pScore < dScore) {
            outcome = 'lose';
        } else {
            outcome = 'push';
        }

        activeBlackjackGames.delete(String(userId));

        if (bet > 0 && supabaseEnabled()) {
            if (outcome === 'blackjack') {
                const r = await creditUserWin(userId, 2.5 * bet);
                getCusState(userId).recordWin(true);
                return res.json({
                    outcome,
                    dHand: g.dHand,
                    pScore,
                    dScore,
                    newBalance: r.newBalance
                });
            }
            if (outcome === 'win') {
                const r = await creditUserWin(userId, 2 * bet);
                getCusState(userId).recordWin(false);
                return res.json({
                    outcome,
                    dHand: g.dHand,
                    pScore,
                    dScore,
                    newBalance: r.newBalance
                });
            }
            if (outcome === 'push') {
                const r = await creditUserWin(userId, bet);
                return res.json({
                    outcome,
                    dHand: g.dHand,
                    pScore,
                    dScore,
                    newBalance: r.newBalance
                });
            }
            const r = await creditUserWin(userId, 0);
            getCusState(userId).recordLoss();
            return res.json({
                outcome,
                dHand: g.dHand,
                pScore,
                dScore,
                newBalance: r.newBalance
            });
        }

        if (outcome === 'lose') getCusState(userId).recordLoss();
        else if (outcome === 'blackjack') getCusState(userId).recordWin(true);
        else if (outcome === 'win') getCusState(userId).recordWin(false);
        res.json({ outcome, dHand: g.dHand, pScore, dScore });
    });
});

app.post('/api/game/blackjack/result', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, outcome } = req.body || {};
    if (String(outcome) !== 'blackjack') {
        return res.status(400).json({ error: 'invalid outcome' });
    }
    await withUserLock(userId, async () => {
        const g = activeBlackjackGames.get(String(userId));
        if (!g) return res.status(400).json({ error: 'No active game' });
        const pScore = bjHandScore(g.pHand);
        if (g.pHand.length !== 2 || pScore !== 21) {
            return res.status(400).json({ error: 'Not a natural blackjack' });
        }
        const dScore = bjHandScore(g.dHand);
        const dNatural = g.dHand.length === 2 && dScore === 21;
        const bet = num(g.bet, 0);
        activeBlackjackGames.delete(String(userId));

        if (bet > 0 && supabaseEnabled()) {
            if (dNatural) {
                await creditUserWin(userId, bet);
                return res.json({ ok: true, outcome: 'push' });
            }
            await creditUserWin(userId, 2.5 * bet);
            getCusState(userId).recordWin(true);
            return res.json({ ok: true, outcome: 'blackjack' });
        }
        res.json({ ok: true, outcome: dNatural ? 'push' : 'blackjack' });
    });
});

app.options('/api/live-feed', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.get('/api/live-feed', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    let fromDb = null;
    try {
        fromDb = await liveFeedListSupabase(Math.max(limit, 80));
    } catch (e) {
        console.error('GET /api/live-feed:', e);
    }
    if (fromDb === null) {
        return res.json({ events: liveFeedMemory.slice(0, limit).map((e) => ({ ...e })) });
    }
    const mem = liveFeedMemory.map((e) => ({ ...e }));
    const merged = [...fromDb, ...mem].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const seen = new Set();
    const out = [];
    for (const e of merged) {
        const k = String(e.id != null ? e.id : `${e.username}|${e.gameKey}|${e.createdAt}|${e.payout}`);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
        if (out.length >= limit) break;
    }
    res.json({ events: out });
});

app.post('/api/live-feed', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!liveFeedCheckRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many feed updates. Slow down.' });
    }
    const body = req.body || {};
    const gameKey = String(body.gameKey || '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');
    if (!LIVE_FEED_GAME_KEYS.has(gameKey)) {
        return res.status(400).json({ error: 'invalid gameKey' });
    }
    const username = sanitizeLiveFeedUsername(body.username);
    const bet = num(body.bet, 0);
    const multiplier = num(body.multiplier, 0);
    const payout = num(body.payout, 0);
    if (bet < 0 || bet > 1e9 || multiplier < 0 || multiplier > 1e6 || payout < -1e9 || payout > 1e9) {
        return res.status(400).json({ error: 'invalid amounts' });
    }
    const ev = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        userId: body.userId || null,
        username,
        gameKey,
        bet,
        multiplier,
        payout,
        createdAt: Date.now()
    };
    let persisted = false;
    try {
        persisted = await liveFeedInsertSupabase(ev);
    } catch (e) {
        persisted = false;
    }
    if (!persisted) liveFeedMemoryPush(ev);
    res.json({ ok: true });
});

app.options('/api/account-sync', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.get('/api/account-sync', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const id = parseInt(String(req.query.userId || ''), 10);
    if (!id) return res.status(400).json({ error: 'missing userId' });
    
    // BAN CHECK
    const ip = req.ip || req.socket.remoteAddress;
    const banStatus = checkBanStatus(id, ip);
    if (banStatus.banned) {
        return res.status(403).json({ error: 'BANNED', reason: banStatus.reason });
    }

    if (!supabaseEnabled()) {
        return res.status(200).json({ ok: true, _isDisabled: true });
    }
    try {
        const save = await loadAccountFromSupabase(id);
        if (!save) {
            return res.status(503).json({
                error:
                    'Could not read user_balances from Supabase (see lastDbError). On Render set SUPABASE_URL and the secret SUPABASE_SERVICE_ROLE_KEY (Project Settings → API). The anon key alone is often blocked by RLS.',
                lastDbError: lastSupabaseBalanceError || undefined,
                tableHint:
                    'If lastDbError is "fetch failed", the server never reached Supabase (bad SUPABASE_URL, DNS, TLS, or typo). It is not RLS. Copy Project URL from Supabase → Settings → API (https://xxxx.supabase.co).',
                urlHint: validateSupabaseUrlShape() || undefined
            });
        }
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(save));
    } catch (e) {
        console.error('GET /api/account-sync:', e);
        res.status(503).json({ error: 'Could not load account data. Try again later.' });
    }
});

// REMOVED: /api/debug/balance was a public endpoint that leaked raw Supabase balance data.


app.post('/api/account-sync', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = req.body || {};
    const userId = parseInt(String(body.userId != null ? body.userId : ''), 10);
    const save = body.save;
    if (!userId || !save || typeof save !== 'object') {
        return res.status(400).json({ error: 'expected { userId, save }' });
    }
    if (save.robloxUserId !== userId) {
        return res.status(400).json({ error: 'robloxUserId mismatch' });
    }
    mergeFlipIntoBalance(save);
    save.savedAt = Date.now();
    if (!save.stats || typeof save.stats !== 'object') {
        save.stats = {};
    }
    // SECURITY: Strip any balance fields â€” client CANNOT set balance via account-sync.
    // Balance is ONLY ever written by deductUserBet / creditUserWin on the server.
    delete save.balance;
    delete save.balanceZh;
    delete save.flipBalance;
    if (!supabaseEnabled()) {
        return res.status(200).json({ ok: true, _isDisabled: true });
    }
    try {
        // Protect server-managed access controls from client-side sync overwrites.
        // Otherwise older/stale browser saves can silently re-enable revoked access.
        const current = await readAccountJson(userId);
        if (current && current.stats && typeof current.stats === 'object') {
            const managedFlags = ['withdrawAccessRevoked', 'rainAccessRevoked', 'tipAccessRevoked'];
            for (const flag of managedFlags) {
                if (typeof current.stats[flag] === 'boolean') {
                    save.stats[flag] = current.stats[flag];
                }
            }
        }

        const result = await persistAccountProfileOnly(userId, save);
        if (!result.ok) {
            return res.status(503).json({
                error: 'Could not save account profile. Storage may be unavailable.',
                step: result.step,
                detail: result.detail
            });
        }
        try {
            await tournamentsOnAccountSync(userId, save);
        } catch (te) {
            console.error('[Tournaments] onAccountSync:', te && te.message);
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('POST /api/account-sync:', e);
        res.status(503).json({ error: 'write failed', detail: String(e && e.message) });
    }
});

app.get('/api/tournaments', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ tournaments: getPublicTournamentsSnapshot() });
});

app.get('/api/tournaments/:id/leaderboard', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const top = await computeTournamentLeaderboard(req.params.id, 50);
        res.json({ leaderboard: top });
    } catch (e) {
        console.error('[Tournaments] leaderboard:', e);
        res.status(500).json({ error: 'Could not load leaderboard.' });
    }
});

app.get('/api/roblox-headshot', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const id = parseInt(String(req.query.userId || ''), 10);
    if (!id) return res.status(400).json({ error: 'missing userId' });
    const avatarUrl = await fetchRobloxAvatarHeadshotUrl(id);
    if (!avatarUrl) return res.status(404).json({ error: 'no avatar' });
    res.json({ avatarUrl });
});

app.options('/api/roblox-lookup', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/api/roblox-lookup', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const username = req.body && req.body.username;
    const result = await lookupRobloxUsername(username);
    if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
    }
    const avatarUrl = await fetchRobloxAvatarHeadshotUrl(result.body.id);
    const body = { ...result.body };
    if (avatarUrl) body.avatarUrl = avatarUrl;
    res.status(200).json(body);
});

app.options('/api/roblox-verify', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/api/roblox-verify', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = req.body || {};
    const userId = parseInt(String(body.userId != null ? body.userId : ''), 10);
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!userId || userId < 1) {
        return res.status(400).json({ error: 'missing userId' });
    }
    if (!isValidVerificationCode(code)) {
        return res.status(400).json({ error: 'invalid code format' });
    }
    const description = await fetchRobloxUserDescription(userId);
    if (description === null) {
        return res.status(502).json({ error: 'Could not read Roblox profile' });
    }
    const bio = description.toLowerCase();
    const needle = code.toLowerCase();
    if (!bio.includes(needle)) {
        return res.status(400).json({
            error:
                'Verification code not found in your profile About section. Add the exact code, save, wait a few seconds, then try again.'
        });
    }
    res.json({ ok: true });
});

// --- NOWPayments Crypto Deposit ---
const processedCryptoPayments = new Set();

app.options('/api/deposit/crypto/create', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.get('/api/deposit/crypto/min-amount', async (req, res) => {
    const coin = String(req.query.coin || 'btc').toLowerCase();
    const fiat = String(req.query.fiat || 'eur').toLowerCase();
    
    try {
        const response = await fetch(`https://api.nowpayments.io/v1/min-amount?currency_from=${coin}&currency_to=${fiat}&fiat_equivalent=${fiat}`, {
            headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
        });
        const data = await response.json();
        let minFiat = data.fiat_equivalent ? parseFloat(data.fiat_equivalent) : 1.00;
        // add 5% buffer to be safe against market drops before user pays
        minFiat = minFiat * 1.05; 
        res.json({ min_fiat: minFiat });
    } catch (e) {
        console.error('NOWPayments min-amount error:', e);
        res.json({ min_fiat: 1.00 });
    }
});

app.post('/api/deposit/crypto/create', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = req.body || {};
    const userId = parseInt(String(body.userId || ''), 10);
    const currency = String(body.currency || '').toLowerCase();
    const fiatCurrency = String(body.fiatCurrency || 'eur').toLowerCase();
    const fiatAmount = parseFloat(body.fiatAmount || 0);
    
    if (!userId || !currency || fiatAmount < 1.00) {
        return res.status(400).json({ error: 'Invalid request. Minimum deposit is 1.00 Fiat.' });
    }
    
    const eurAmount = parseFloat(fiatAmount.toFixed(2));
    
    const orderId = `deps_${userId}_${Date.now()}`;
    
    try {
        const response = await fetch('https://api.nowpayments.io/v1/payment', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.NOWPAYMENTS_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                price_amount: eurAmount,
                price_currency: fiatCurrency,
                pay_currency: currency,
                ipn_callback_url: 'https://' + req.get('host') + '/api/deposit/crypto/webhook',
                order_id: orderId,
                order_description: `ZephR$ Deposit: ${fiatAmount} ${fiatCurrency.toUpperCase()}`
            })
        });
        
        const data = await response.json();
        if (!response.ok) {
            console.error('NOWPayments Error:', data);
            return res.status(500).json({ error: data.message || 'Payment provider error' });
        }
        
        res.json({
            payment_id: data.payment_id,
            pay_address: data.pay_address,
            pay_amount: data.pay_amount,
            pay_currency: data.pay_currency,
            pay_extra_id: data.payin_extra_id || data.pay_extra_id || data.extra_id || null,
            order_id: data.order_id
        });
    } catch (e) {
        console.error('NOWPayments Request Error:', e);
        res.status(500).json({ error: 'Internal server error while contacting payment provider' });
    }
});

app.post('/api/deposit/crypto/webhook', express.json(), async (req, res) => {
    const { payment_id } = req.body;
    if (!payment_id) return res.status(400).send('No payment ID');

    // To completely avoid JSON-parsing formatting bugs with the HMAC signature, we directly query the NowPayments API
    // using our server's internal API Key. This securely guarantees the payment data is real.
    try {
        const verifyRes = await fetch(`https://api.nowpayments.io/v1/payment/${payment_id}`, {
            headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
        });
        
        if (!verifyRes.ok) return res.status(403).send('Invalid payment_id lookup');
        
        const paymentData = await verifyRes.json();
        const { payment_status, order_id, price_amount } = paymentData;
        
        // We only credit when payment is completely finished
        if (payment_status === 'finished') {
        const parts = String(order_id).split('_');
        if (parts.length >= 2 && parts[0] === 'deps') {
            const userId = parseInt(parts[1], 10);
            
            // SECURITY: Check Supabase for duplicate order_id before crediting.
            // The in-memory Set is only a fast pre-check; Supabase is the authoritative guard
            // against replays across restarts and the 50k clear window.
            const dupCheckRes = await supabaseFetch(
                `transactions?type=eq.crypto_deposit_webhook&reference_id=eq.${encodeURIComponent(String(order_id).slice(0, 200))}&limit=1`
            ).catch(() => null);
            const dupRows = dupCheckRes && dupCheckRes.ok ? await dupCheckRes.json().catch(() => []) : [];
            const alreadyProcessed = Array.isArray(dupRows) && dupRows.length > 0;
            if (!processedCryptoPayments.has(order_id) && !alreadyProcessed) {
                processedCryptoPayments.add(order_id);
                
                // Reverse calculation: RoBet = EUR / 0.007
                const depositAmount = Math.round(parseFloat(price_amount) / 0.007);
                
                if (userId && depositAmount > 0 && supabaseEnabled()) {
                    try {
                        const uid = parseRobloxNumericId(userId);
                        const bal = await getUserBalance(uid);
                        if (bal) {
                            const newBal = bal.balance_zr + depositAmount; // legacy balance_zh is merged on next login via loadAccountFromSupabase
                            // Persist a webhook receipt row so replays after restart are blocked
                            await supabaseFetch('transactions', {
                                method: 'POST',
                                headers: { Prefer: 'return=minimal' },
                                body: JSON.stringify({
                                    user_id: String(uid),
                                    amount: depositAmount,
                                    currency: 'zr',
                                    type: 'crypto_deposit_webhook',
                                    status: 'completed',
                                    game_name: `NOWPayments order: ${order_id}`,
                                    reference_id: String(order_id).slice(0, 200)
                                })
                            }).catch(() => {});
                            const result = await updateUserBalance(uid, newBal, 0); // we pass 0 here because it's merged naturally or zeroed
                            if (result.ok) {
                                emitBalanceRemoteSync(io, uid, { balance: newBal, stats: {} });
                                console.log(`Credited ${depositAmount} RoBet (crypto) to user ${uid}`);
                                const who = getOnlineUsernameByUserId(uid) || `User ${uid}`;
                                const paidCoin = String(paymentData.pay_currency || '').toUpperCase();
                                const paidAmount = Number(paymentData.pay_amount || 0);
                                const paidText = Number.isFinite(paidAmount) && paidAmount > 0
                                    ? `${paidAmount} ${paidCoin || 'CRYPTO'}`
                                    : `${depositAmount} RoBet equivalent`;
                                postDiscordAudit(`💰 ${who} deposited ${paidText}. Credited ${depositAmount.toLocaleString('en-US')} RoBet.`);
                            }
                        }
                    } catch (e) {
                        console.error('Crypto Webhook DB Error:', e);
                    }
                }
            }
        }
        } // close if payment_status === 'finished'
    } catch (e) {
        console.error('Crypto Webhook verify error:', e);
        return res.status(500).send('Verify error');
    }
    
    res.status(200).send('OK');
});

// =====================================================================
// DYNAMIC ROBUX DEPOSIT (API-KEY BASED)
// =====================================================================
/**
 * In-memory store of pending deposits created by the server.
 * Key: gamePassId (number)
 * Value: { userId (number), amount (number), createdAt (number) }
 *
 * SECURITY: The credit amount is stored here server-side only.
 * The client NEVER sends the amount during verify — we look it up here.
 * Entries expire after 30 minutes to prevent stale claims.
 */
const _pendingDeposits = new Map();
const DEPOSIT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// Cleanup expired pending deposits every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [gpId, entry] of _pendingDeposits) {
        if (now - entry.createdAt > DEPOSIT_EXPIRY_MS) {
            _pendingDeposits.delete(gpId);
        }
    }
}, 5 * 60 * 1000).unref();

/**
 * POST /api/deposit/robux/create
 * Body: { userId, amount, sessionToken }
 * Creates a unique gamepass on the house experience at the requested price.
 * Returns: { gamepassId, gamepassUrl }
 */
app.options('/api/deposit/robux/create', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/api/deposit/robux/create', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, amount, sessionToken } = req.body || {};
    const depositAmount = Number(amount);

    if (!userId || isNaN(depositAmount) || depositAmount < 1 || depositAmount > 100000) {
        return res.status(400).json({ error: 'Invalid deposit amount. Must be between 1 and 100,000 R$.' });
    }
    if (!Number.isInteger(depositAmount)) {
        return res.status(400).json({ error: 'Deposit amount must be a whole number.' });
    }
    if (!validateSessionToken(userId, sessionToken)) {
        return res.status(401).json({ error: 'Unauthorized. Please refresh the page and make sure you are logged in.' });
    }
    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Server database is not configured. Contact admin.' });
    }

    const houseApiKey = process.env.HOUSE_API_KEY;
    const houseUniverseId = process.env.HOUSE_UNIVERSE_ID;
    if (!houseApiKey || !houseUniverseId) {
        console.error('[Deposit/Create] HOUSE_API_KEY or HOUSE_UNIVERSE_ID not set in environment.');
        return res.status(503).json({ error: 'Deposit system is not configured. Contact admin.' });
    }

    // Check per-user deposit rate limit (max 1 pending deposit creation per 10s)
    const diskSave = await readAccountJson(userId);
    const save = diskSave ? { ...diskSave } : { stats: {} };
    if (!save.stats) save.stats = {};
    const lastCreate = save.stats.lastDepositCreateAt || 0;
    if (Date.now() - lastCreate < 10000) {
        return res.status(429).json({ error: 'Please wait a few seconds before creating another deposit.' });
    }

    try {
        // Create the gamepass on the house experience via Roblox Open Cloud API
        const formData = new FormData();
        formData.append('name', 'delete me');
        formData.append('price', String(depositAmount));
        formData.append('isForSale', 'true');

        let actualUniverseId = houseUniverseId;
        let gpCreateRes = await fetch(`https://apis.roblox.com/game-passes/v1/universes/${actualUniverseId}/game-passes`, {
            method: 'POST',
            headers: { 'x-api-key': houseApiKey },
            body: formData
        });

        // Autocorrect if user accidentally put a Place ID in HOUSE_UNIVERSE_ID (.env)
        if (gpCreateRes.status === 404 || gpCreateRes.status === 400) {
            const uniRes = await fetch(`https://apis.roblox.com/universes/v1/places/${actualUniverseId}/universe`);
            if (uniRes.ok) {
                const uniData = await uniRes.json();
                if (uniData && uniData.universeId) {
                    actualUniverseId = uniData.universeId;
                    
                    // Remake the form data because it got consumed
                    const retryData = new FormData();
                    retryData.append('name', 'delete me');
                    retryData.append('price', String(depositAmount));
                    retryData.append('isForSale', 'true');

                    gpCreateRes = await fetch(`https://apis.roblox.com/game-passes/v1/universes/${actualUniverseId}/game-passes`, {
                        method: 'POST',
                        headers: { 'x-api-key': houseApiKey },
                        body: retryData
                    });
                }
            }
        }

        let gpJson;
        try {
            gpJson = await gpCreateRes.json();
        } catch (_) {
            throw new Error(`Roblox API returned invalid response (${gpCreateRes.status}).`);
        }

        if (!gpCreateRes.ok) {
            throw new Error(`Roblox API Error: ${gpJson.message || gpJson.code || gpCreateRes.statusText || 'Check HOUSE_API_KEY permissions.'}`);
        }

        const gpId = gpJson.gamePassId;
        if (!gpId) throw new Error('Roblox did not return a valid Game Pass ID.');

        // Store pending deposit server-side (amount is authoritative here, never from client)
        _pendingDeposits.set(Number(gpId), {
            userId: Number(userId),
            amount: depositAmount,
            createdAt: Date.now()
        });

        // Rate-limit stamp
        save.stats.lastDepositCreateAt = Date.now();
        await persistAccountSave(userId, save);

        console.log(`[Deposit/Create] user=${userId} gpId=${gpId} amount=${depositAmount} R$`);

        return res.json({
            ok: true,
            gamepassId: gpId,
            gamepassUrl: `https://www.roblox.com/game-pass/${gpId}/delete-me`
        });

    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[Deposit/Create] Failed:', msg);
        return res.status(400).json({ error: msg });
    }
});

/**
 * POST /api/deposit/robux/verify
 * Body: { userId, gamepassId, sessionToken }
 * Verifies the user owns the gamepass, then credits their balance.
 * Amount is looked up from server-side _pendingDeposits — never trusted from client.
 */
app.options('/api/deposit/robux/verify', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/api/deposit/robux/verify', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, gamepassId, sessionToken } = req.body || {};
    const gpId = Number(gamepassId);

    if (!userId || !gpId || gpId < 1) {
        return res.status(400).json({ error: 'Missing userId or gamepassId.' });
    }
    if (!validateSessionToken(userId, sessionToken)) {
        return res.status(401).json({ error: 'Unauthorized. Please refresh and log in again.' });
    }
    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Server database is not configured.' });
    }

    // --- SECURITY: Look up amount from server-side store, NOT from client ---
    const pending = _pendingDeposits.get(gpId);
    if (!pending) {
        return res.status(400).json({ error: 'No pending deposit found for this gamepass. It may have expired (30 min limit) or already been claimed.' });
    }
    if (Number(pending.userId) !== Number(userId)) {
        return res.status(403).json({ error: 'This deposit was created for a different account.' });
    }
    if (Date.now() - pending.createdAt > DEPOSIT_EXPIRY_MS) {
        _pendingDeposits.delete(gpId);
        return res.status(400).json({ error: 'This deposit link has expired. Please create a new one.' });
    }

    const creditAmount = pending.amount; // Server-authoritative, not from client

    await withUserLock(userId, async () => {
        // --- SECURITY: Check gamepass has not already been claimed by anyone ---
        const diskSave = await readAccountJson(userId);
        const save = diskSave ? { ...diskSave } : { robloxUserId: userId, balance: 0, stats: {} };
        if (!save.stats) save.stats = {};
        if (!Array.isArray(save.stats.claimedDepositPassIds)) save.stats.claimedDepositPassIds = [];

        if (save.stats.claimedDepositPassIds.includes(gpId)) {
            return res.status(400).json({ error: 'This gamepass has already been claimed. Each gamepass can only be used once.' });
        }

        // --- Verify ownership with Roblox ---
        const own = await fetchUserOwnsGamePass(Number(userId), gpId);
        if (!own.ok) {
            return res.status(502).json({ error: 'Could not verify ownership with Roblox. Try again in a moment.' });
        }
        if (!own.owned) {
            return res.status(400).json({ error: 'You do not own this gamepass yet. Buy it on Roblox first, then click Verify.' });
        }

        // --- Credit the balance atomically ---
        const creditResult = await creditUserWin(userId, creditAmount);
        if (!creditResult || !creditResult.ok) {
            return res.status(500).json({ error: 'Could not credit your balance. Please contact support.' });
        }

        // --- Mark as permanently claimed so it can never be reused ---
        _pendingDeposits.delete(gpId);
        save.stats.claimedDepositPassIds.push(gpId);
        save.stats.deposited = (save.stats.deposited || 0) + creditAmount;
        save.stats.lastDepositAt = Date.now();

        if (!Array.isArray(save.transactions)) save.transactions = [];
        save.transactions.unshift({
            id: Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
            desc: `Deposit (${creditAmount} R$ → ${creditAmount} RoBet)`,
            date: formatTxDateServer(),
            amount: creditAmount,
            type: 'deposit'
        });
        if (save.transactions.length > 100) save.transactions = save.transactions.slice(0, 100);

        await persistAccountSave(userId, save);

        const who = save.username || getOnlineUsernameByUserId(userId) || `User ${userId}`;
        postDiscordAudit(`💰 **Deposit:** ${who} deposited ${creditAmount.toLocaleString('en-US')} R$ → credited ${creditAmount.toLocaleString('en-US')} RoBet.`);
        console.log(`[Deposit/Verify] user=${userId} gpId=${gpId} credited=${creditAmount}`);

        return res.json({ ok: true, credited: creditAmount });
    });
});

/** Game pass deposit: Robux paid = RoBet credited. Keys must match client GAME_PASS_DEPOSIT_TIERS. */

const GAME_PASS_CREDIT_BY_ID = {
    1784194501: 7,
    1783449405: 8,
    1784128758: 9,
    1784222735: 10,
    1784188882: 15,
    1784300749: 20,
    1784700043: 25,
    1784130820: 30,
    1784396767: 35,
    1784082914: 40,
    1783926960: 45,
    1784340755: 50,
    1784248824: 60,
    1783479386: 70,
    1790780840: 75,
    1784464672: 80,
    1784464674: 90,
    1783918985: 100
};

/**
 * Per-user, per-gamepass cooldown.
 * After a successful deposit, the specific gamepass is locked for DEPOSIT_LOCK_MS
 * to prevent spam-clicking.  After the timer expires the lock is cleared,
 * so the user can delete the pass from their Roblox inventory, buy it fresh,
 * and deposit again.
 *
 * Structure:  Map<userId, Set<gamePassId>>
 */
const DEPOSIT_LOCK_MS = 5000;
const depositLocks = new Map();

function isDepositLocked(userId, gamePassId) {
    const s = depositLocks.get(userId);
    return s ? s.has(gamePassId) : false;
}

function lockDeposit(userId, gamePassId) {
    if (!depositLocks.has(userId)) depositLocks.set(userId, new Set());
    depositLocks.get(userId).add(gamePassId);
    setTimeout(() => {
        const s = depositLocks.get(userId);
        if (s) {
            s.delete(gamePassId);
            if (s.size === 0) depositLocks.delete(userId);
        }
    }, DEPOSIT_LOCK_MS);
}

function fetchUserOwnsGamePass(userId, gamePassId) {
    return new Promise((resolve) => {
        const p = `/v1/users/${encodeURIComponent(userId)}/items/GamePass/${encodeURIComponent(gamePassId)}/is-owned`;
        https
            .get({ hostname: 'inventory.roblox.com', port: 443, path: p }, (robRes) => {
                const chunks = [];
                robRes.on('data', (c) => chunks.push(c));
                robRes.on('end', () => {
                    const raw = Buffer.concat(chunks).toString();
                    if (robRes.statusCode !== 200) {
                        console.error(`[Deposit] Roblox is-owned ${robRes.statusCode} for user=${userId} gp=${gamePassId}: ${raw}`);
                        resolve({ ok: false, status: robRes.statusCode, raw });
                        return;
                    }
                    try {
                        const owned = JSON.parse(raw);
                        resolve({ ok: true, owned: owned === true });
                    } catch (e) {
                        resolve({ ok: false, status: 502, raw });
                    }
                });
            })
            .on('error', (err) => {
                console.error(`[Deposit] Roblox is-owned network error for user=${userId} gp=${gamePassId}:`, err.message);
                resolve({ ok: false, status: 502, raw: null });
            });
    });
}

app.options('/api/gamepass-deposit-claim', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/api/gamepass-deposit-claim', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = req.body || {};
    const userId = parseInt(String(body.userId != null ? body.userId : ''), 10);

    if (!userId || userId < 1) {
        return res.status(400).json({ error: 'Missing userId.' });
    }

    // â”€â”€ Validate gamepass ID â”€â”€
    const gamePassId = parseInt(String(body.gamePassId != null ? body.gamePassId : ''), 10);
    if (!gamePassId || gamePassId < 1) {
        return res.status(400).json({ error: 'Missing or invalid gamePassId.' });
    }
    const credit = GAME_PASS_CREDIT_BY_ID[gamePassId];
    if (typeof credit !== 'number' || credit < 1) {
        return res.status(400).json({ error: 'That game pass is not enabled for deposits.' });
    }

    // â”€â”€ Per-gamepass cooldown (prevents spam-clicking the same tier) â”€â”€
    if (isDepositLocked(userId, gamePassId)) {
        return res.status(429).json({
            error: 'You just deposited this tier. Wait a few seconds before trying again.'
        });
    }

    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Account storage is not configured or unavailable.' });
    }

    // â”€â”€ Ask Roblox: does this user actually own this game pass right now? â”€â”€
    const own = await fetchUserOwnsGamePass(userId, gamePassId);
    if (!own.ok) {
        return res.status(502).json({
            error: 'Could not verify ownership with Roblox. Try again in a moment.'
        });
    }
    if (!own.owned) {
        return res.status(400).json({
            error: 'You do not own this game pass. Buy it on Roblox first, then come back and click Verify.'
        });
    }

    // â”€â”€ Ownership verified â€” load balance from Supabase, credit, save â”€â”€
    const diskSave = await readAccountJson(userId);
    const save = diskSave ? { ...diskSave } : { robloxUserId: userId, balance: 0, stats: {} };
    save.robloxUserId = userId;
    mergeFlipIntoBalance(save);
    if (!save.stats || typeof save.stats !== 'object') save.stats = {};
    if (!Array.isArray(save.stats.depositedPassIds)) save.stats.depositedPassIds = [];

    // Check if this specific gamepass ID has already been credited to this user account
    if (save.stats.depositedPassIds.includes(gamePassId)) {
        return res.status(400).json({ error: 'This game pass has already been used for a deposit. Buy a different tier or wait for new ones.' });
    }

    const bal = typeof save.balance === 'number' && save.balance >= 0 ? save.balance : 0;
    save.balance = bal + credit;
    save.stats.deposited = (typeof save.stats.deposited === 'number' ? save.stats.deposited : 0) + credit;
    save.stats.depositedPassIds.push(gamePassId);
    save.savedAt = Date.now();

    if (!Array.isArray(save.transactions)) save.transactions = [];
    save.transactions.unshift({
        id: Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
        desc: `Deposit (Game Pass ${credit} R$)`,
        date: formatTxDateServer(),
        amount: credit,
        type: 'deposit'
    });
    if (save.transactions.length > 100) save.transactions = save.transactions.slice(0, 100);

    try {
        const result = await persistAccountSave(userId, save);
        if (!result.ok) {
            return res.status(503).json({ error: 'Could not save account.', step: result.step, detail: result.detail });
        }
    } catch (e) {
        console.error('[Deposit] persist error:', e);
        return res.status(503).json({ error: 'Could not save account.', detail: String(e && e.message) });
    }

    // â”€â”€ Lock this tier for 5 seconds so they can't spam-click â”€â”€
    lockDeposit(userId, gamePassId);

    console.log(`[Deposit] user=${userId} gp=${gamePassId} credited=${credit} newBal=${save.balance}`);
    {
        const who = getOnlineUsernameByUserId(userId) || `User ${userId}`;
        postDiscordAudit(`💰 ${who} deposited ${credit.toLocaleString('en-US')} RoBet (Game Pass).`);
    }
    res.json({ ok: true, save, credited: credit });
});

app.get('/api/deposit/robux/status', async (req, res) => {
    // legacy mock for gamepass deposit flow
    const uid = req.query.userId || req.query.robloxUserId;
    res.json({ deposited: true, processed: false, remaining: 0, pendingTiers: [] });
});

// ===================================
// CRYPTO WITHDRAWAL API
// ===================================

app.post('/api/withdraw/crypto/request', express.json(), async (req, res) => {
    let { userId, coin, address, extraId, zhAmount } = req.body;
    userId = parseRobloxUserIdStrict(userId);
    zhAmount = parseInt(zhAmount, 10);
    
    if (!userId || !coin || !address || isNaN(zhAmount) || zhAmount < 1800) {
        return res.status(400).json({ error: 'Invalid request. Minimum is 1800 RoBet.' });
    }
    
    await withUserLock(userId, async () => {
        // Use the dedicated fast balance read so we always get the live number from Supabase
        const bal = await getUserBalance(userId);
        const currentBalance = bal ? (bal.balance_zr + (bal.balance_zh || 0)) : 0;
        if (!bal || currentBalance < zhAmount) {
            return res.status(400).json({ error: `Insufficient balance. You have ${Math.floor(currentBalance)} RoBet.` });
        }

        // Deduct directly via updateUserBalance (the single source of truth)
        const newBalance = Math.round((currentBalance - zhAmount) * 100) / 100;
        const updateResult = await updateUserBalance(userId, newBalance, 0);
        if (!updateResult.ok) {
            return res.status(500).json({ error: 'Could not process withdrawal. Try again.' });
        }
        // Push balance update to any open tabs for this user
        emitBalanceRemoteSync(io, userId, { balance: newBalance, stats: {} });

        // Fiat value estimation: 1 RoBet = 0.007 EUR
        const fiatValue = parseFloat((zhAmount * 0.007).toFixed(2));

        // Look up username from in-memory connected players (best-effort)
        let wdUsername = 'Unknown';
        for (const p of onlinePlayers.values()) {
            if (String(p.userId) === String(userId)) { wdUsername = p.username || 'Unknown'; break; }
        }

        const wdReq = {
            id: `cwd_${Date.now()}_${userId}`,
            userId: userId,
            username: wdUsername,
            coin: coin,
            address: address,
            extraId: extraId || '',
            zhAmount: zhAmount,
            fiatAmount: fiatValue,
            fiatCurrency: 'eur',
            status: 'pending',
            createdAt: Date.now()
        };
        
        cryptoWdState.push(wdReq);
        saveCryptoWd();
        const fiatLabel = `${fiatValue.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })} ${String(wdReq.fiatCurrency || 'eur').toUpperCase()}`;
        postDiscordAudit(
            `📤 ${wdUsername || `User ${userId}`} requested withdraw ${zhAmount.toLocaleString(
                'en-US'
            )} RoBet (~${fiatLabel}) to ${String(coin || '').toUpperCase()}.`
        );
        
        res.json({ ok: true, request: wdReq });
        
        // Notify admins if connected
        io.emit('admin:crypto_wd_update', cryptoWdState.filter(w => w.status === 'pending'));
    });
});

app.get('/api/withdraw/crypto/list', (req, res) => {
    let userId = parseRobloxUserIdStrict(req.query.userId || req.query.robloxUserId);
    if (!userId) return res.json({ list: [] });
    
    // Send all withdrawals (including paid/rejected/cancelled) for their history
    const userWds = cryptoWdState.filter(w => w.userId === userId).sort((a,b) => b.createdAt - a.createdAt);
    res.json({ list: userWds });
});

app.post('/api/withdraw/crypto/cancel', express.json(), async (req, res) => {
    let { userId, wdId } = req.body;
    userId = parseRobloxUserIdStrict(userId);
    if (!userId || !wdId) return res.status(400).json({ error: 'Invalid request' });
    
    const wdIndex = cryptoWdState.findIndex(w => w.id === wdId && w.userId === userId && w.status === 'pending');
    if (wdIndex === -1) return res.status(404).json({ error: 'Pending withdrawal not found or already processed.' });
    
    const reqWd = cryptoWdState[wdIndex];
    cryptoWdState[wdIndex].status = 'cancelled';
    saveCryptoWd();
    
    // SECURITY: Use creditUserWin for atomic Supabase refund â€” not the stale read-modify-write pattern.
    const refundResult = await creditUserWin(userId, reqWd.zhAmount);
    if (!refundResult.ok) {
        console.error('[CryptoWd Cancel] Refund failed for', userId, refundResult);
    }
    
    res.json({ ok: true });
    
    // Notify admins
    io.emit('admin:crypto_wd_update', cryptoWdState.filter(w => w.status === 'pending'));
});

/**
 * Active Scanner: Checks Roblox for ownership of any deposit gamepasses.
 * This is used to force the user to delete any gamepasses they own.
 */
app.post('/api/scan-owned-passes', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = req.body || {};
    const userId = parseInt(String(body.userId != null ? body.userId : ''), 10);

    if (!userId || userId < 1) {
        return res.status(400).json({ error: 'Missing userId.' });
    }

    const gamePassIds = Object.keys(GAME_PASS_CREDIT_BY_ID).map(id => parseInt(id, 10));
    const ownedPasses = [];

    // Scan all passes concurrently (17 passes is small enough for Roblox API)
    const checks = gamePassIds.map(async (gpId) => {
        const own = await fetchUserOwnsGamePass(userId, gpId);
        if (own.ok && own.owned) {
            ownedPasses.push(gpId);
        }
    });

    await Promise.all(checks);

    res.json({ ok: true, ownedPasses });
});


// =====================================================================
// ROBLOX BOT â€” Automated Gamepass Withdrawal
// =====================================================================
/** The bot's .ROBLOSECURITY cookie from .env */
const ROBLOX_COOKIE = (process.env.ROBLOX_COOKIE || '').trim();

/** Set to true once noblox has authenticated successfully. */
let botReady = false;
let botUsername = 'NOT LOGGED IN';

async function initRobloxBot() {
    if (!ROBLOX_COOKIE) {
        console.warn('[Withdrawal Bot] ROBLOX_COOKIE not set in .env â€” withdrawal endpoint will be disabled.');
        return;
    }
    try {
        const user = await noblox.setCookie(ROBLOX_COOKIE);
        // noblox.js v4+ returns { name, id } â€” older versions used UserName/UserID
        botUsername = user.name || user.UserName || JSON.stringify(user);
        const botId   = user.id   || user.UserID;
        botReady = true;
        console.log(`[Withdrawal Bot] Logged in as ${botUsername} (ID: ${botId})`);
    } catch (e) {
        console.error('[Withdrawal Bot] Login failed:', e && e.message);
    }
}
initRobloxBot();

/**
 * POST /api/withdraw
 * Body: { userId: number, gamepassId: string, zrCoins: number, expectedRobux: number }
 *
 * Flow:
 *   1. Validate inputs & bot readiness.
 *   2. Fetch product info for the gamepass (verifies it exists & gets price).
 *   3. Verify the gamepass is owned by the requesting Roblox user.
 *   4. Purchase the gamepass with the bot account.
 *   5. Deduct RoBet from the user's Supabase balance.
 */
app.post('/api/withdraw', express.json(), async (req, res) => {
    if (!botReady) {
        return res.status(503).json({ error: 'Withdrawal bot is offline. Make sure ROBLOX_COOKIE is set in .env and restart the server.' });
    }

    const { userId, apiKey, zrCoins, expectedRobux, sessionToken } = req.body || {};

    const amountCoins = Number(zrCoins);
    if (!userId || !apiKey || isNaN(amountCoins) || amountCoins <= 0) {
        return res.status(400).json({ error: 'Missing or invalid fields: userId, apiKey, and withdrawal amount are required.' });
    }
    
    const cleanApiKey = String(apiKey).replace(/[\r\n\t]/g, '').trim();
    if (cleanApiKey.length < 10) {
        return res.status(400).json({ error: 'API Key format is invalid.' });
    }

    if (!validateSessionToken(userId, sessionToken)) {
        return res.status(401).json({ error: 'Unauthorized request. Please refresh the page and make sure you are logged in.' });
    }
    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Server database is not configured. Contact admin.' });
    }

    // --- SECURITY: Strict Server-Side Gamepass Price Calculation ---
    const calculatedPrice = Math.floor(amountCoins / 1.5);
    if (Math.abs(calculatedPrice - expectedRobux) > 5) {
        return res.status(400).json({ error: 'Price calculation mismatch. Please refresh the page and try again.' });
    }
    const gamepassPrice = calculatedPrice;
    if (gamepassPrice > 150 || gamepassPrice <= 0) {
        return res.status(400).json({ error: `Withdrawals must be between 1 and 150 R$ per transaction. Your request is ${gamepassPrice} R$.` });
    }

    await withUserLock(userId, async () => {
        // --- SECURE: Rate limit and cooldown checks must happen INSIDE the lock ---
        const diskSave = await readAccountJson(userId);
        let save = diskSave ? { ...diskSave } : { balance: 0, balanceZh: 0, stats: {} };
        if (!save.stats) save.stats = {};

        if (save.stats.withdrawAccessRevoked === true) {
            return res.status(403).json({ error: 'Withdrawal access has been revoked for this account.' });
        }

        const lastWd = save.stats.lastWithdrawAt || 0;
        const cooldownMs = getWithdrawCooldownMsFromStats(save.stats);
        if (Date.now() - lastWd < cooldownMs) {
            const leftMin = Math.ceil((cooldownMs - (Date.now() - lastWd)) / 60000);
            return res.status(429).json({ error: `Withdraw on cooldown. Please wait ${leftMin} more minute(s).` });
        }

        // --- Step 1: Check balance first ---
        const currentBal = await getUserBalance(userId);
        if (!currentBal) {
            return res.status(503).json({ error: 'Could not read your account balance. Try again.' });
        }
        if (currentBal.balance_zr < amountCoins) {
            return res.status(400).json({ error: 'Insufficient RoBet balance on server.' });
        }

        // --- Step 2: Atomic Deduction ---
        const newZr = Math.max(0, currentBal.balance_zr - amountCoins);
        const updateResult = await updateUserBalance(userId, newZr, currentBal.balance_zh);
        
        if (!updateResult.ok) {
            return res.status(500).json({ error: 'Internal error: Could not secure funds for withdrawal. Deduction aborted.' });
        }

        let isRefunded = false;
        const refundUserTokens = async () => {
            if (isRefunded) return;
            isRefunded = true;
            await creditUserWin(userId, amountCoins); // This atomically adds back the tokens and emits remote sync
            console.log(`[Withdraw] Refunded ${amountCoins} RoBet back to ${userId} due to API failure.`);
        };

        try {
            // --- Step 3: Fetch User's First Experience ---
            const gamesRes = await fetch(`https://games.roblox.com/v2/users/${userId}/games?limit=10`);
            const gamesJson = await gamesRes.json();
            
            if (!gamesRes.ok || !gamesJson.data || gamesJson.data.length === 0) {
                throw new Error("You must have at least one public experience on Roblox to generate a game pass.");
            }
            
            const universeId = gamesJson.data[0].id;
            if (!universeId) throw new Error("Could not extract universeId from your experiences.");

            // --- Step 4: Create Game Pass via Roblox API ---
            const formData = new FormData();
            formData.append('name', 'delete me');
            formData.append('price', gamepassPrice.toString());
            formData.append('isForSale', 'true');

            const gpCreateRes = await fetch(`https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes`, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey
                },
                body: formData
            });

            let gpJson;
            try {
                gpJson = await gpCreateRes.json();
            } catch (je) {
                throw new Error(`Roblox API returned invalid response (${gpCreateRes.status}). Check API Key.`);
            }

            if (!gpCreateRes.ok) {
                // If the user's API Key is messed up, or permissions are wrong:
                throw new Error(`Roblox API Error: ${gpJson.message || gpJson.code || gpCreateRes.statusText || 'Check your API Key permissions.'}`);
            }

            const gpId = gpJson.gamePassId;
            if (!gpId) throw new Error("Roblox did not return a valid Game Pass ID.");

            // Get product ID for purchasing
            const productInfo = await noblox.getGamePassProductInfo(gpId).catch(() => {
                throw new Error("Could not index the generated gamepass on Roblox catalog.");
            });

            // --- Step 5: Bot Purchases Game Pass ---
            const csrfToken = await noblox.getGeneralToken();
            const cookie = `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE.trim().replace(/^"|"$/g, '')}`;

            const purchaseRes = await fetch(`https://economy.roblox.com/v1/purchases/products/${productInfo.ProductId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': csrfToken,
                    'Cookie': cookie
                },
                body: JSON.stringify({
                    expectedCurrency: 1,
                    expectedPrice: gamepassPrice,
                    expectedSellerId: userId
                })
            });

            const purchaseJson = await purchaseRes.json();
            
            if (!purchaseRes.ok || !purchaseJson.purchased) {
                throw new Error(`Bot could not purchase gamepass: ${purchaseJson.errorMsg || purchaseJson.message || 'Roblox rejected the transaction call.'}`);
            }

            console.log(`[Withdraw] Bot generated and purchased Gamepass ${gpId} (Price: ${gamepassPrice} R$) for user ${userId}`);

        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            console.error('[Withdraw] API Flow failed:', msg);
            await refundUserTokens();
            const who = save.username || getOnlineUsernameByUserId(userId) || `User ${userId}`;
            postDiscordAudit(`❌ **Failed Automated Withdrawal:** ${who} tried to withdraw ${Number(amountCoins).toLocaleString('en-US')} RoBet but it failed: ${msg} (Tokens refunded).`);
            // Log failed transaction internally to their local profile history
            if (!Array.isArray(save.transactions)) save.transactions = [];
            save.transactions.unshift({
                id: Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
                desc: `Failed (${amountCoins} RoBet rejected): ${msg}`,
                date: formatTxDateServer(),
                amount: 0,
                type: 'withdraw_failed'
            });
            if (save.transactions.length > 100) save.transactions = save.transactions.slice(0, 100);
            await persistAccountSave(userId, save);

            return res.status(400).json({ error: `${msg} (Your balance has been refunded)` });
        }

        // --- Step 6: Persist Withdrawal Analytics / History ---
        save.balance = currentBal.balance_zr - amountCoins; // update local context
        save.stats.withdrawn = (save.stats.withdrawn || 0) + amountCoins;
        save.stats.lastWithdrawAt = Date.now();
        if (!Array.isArray(save.transactions)) save.transactions = [];
        save.transactions.unshift({
            id: Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
            desc: `Withdrawal (${Math.floor(gamepassPrice * 0.7)} R$ received)`,
            date: formatTxDateServer(),
            amount: -amountCoins,
            type: 'withdraw'
        });
        if (save.transactions.length > 100) save.transactions = save.transactions.slice(0, 100);
        
        await persistAccountSave(userId, save);

        {
            const who = save.username || getOnlineUsernameByUserId(userId) || `User ${userId}`;
            postDiscordAudit(`✅ **Successful Automated Withdrawal:** ${who} automatically generated and withdrew ${Number(amountCoins).toLocaleString('en-US')} RoBet for a ${gamepassPrice} R$ Gamepass.`);
        }

        return res.json({
            ok: true,
            message: `Gamepass generated and purchased automatically. You will receive ${Math.floor(gamepassPrice * 0.7)} R$ in your pending balance after Roblox tax.`,
            robuxPaid: gamepassPrice,
            robuxAfterTax: Math.floor(gamepassPrice * 0.7)
        });
    });
});
// =====================================================================
// GLOBAL CRASH GAME ENGINE
// =====================================================================
const crashGame = {
    state: 'starting', // 'starting', 'running', 'crashed'
    target: 1.00,
    startTime: 0,
    flightTimeMs: 0,
    players: new Map(), // userId -> { userId, username, bet, auto, cashedOut, winAmt }
    timeoutTick: null
};

async function processCrashCashout(userId, cashoutMultiplier) {
    return withUserLock(userId, async () => {
        const p = crashGame.players.get(String(userId));
        if (!p || p.cashedOut || crashGame.state !== 'running') return false;

        p.cashedOut = true;
        p.winAmt = p.bet * cashoutMultiplier;

        // SECURITY: Use creditUserWin (atomic Supabase read-modify-write) instead of
        // the old read-modify-persist pattern which was vulnerable to race conditions.
        await creditUserWin(userId, p.winAmt);

        io.emit('crash:playerCashedOut', { userId: String(userId), multi: cashoutMultiplier, winAmt: p.winAmt });
        return true;
    });
}

function tickCrash() {
    if (crashGame.state !== 'running') return;
    const elapsed = Date.now() - crashGame.startTime;
    const currentMulti = 1.00 * Math.pow(Math.E, Math.max(0, elapsed) * 0.00006);
    
    for (const [uid, p] of crashGame.players.entries()) {
        if (!p.cashedOut && p.auto > 1.0 && currentMulti >= p.auto) {
            processCrashCashout(uid, p.auto);
        }
    }
    
    if (elapsed >= crashGame.flightTimeMs) {
        runCrashCrashed();
    } else {
        crashGame.timeoutTick = setTimeout(tickCrash, 50);
    }
}

function runCrashStarting() {
    crashGame.state = 'starting';
    crashGame.players.clear();
    io.emit('crash:starting', { countdown: 5.0 });
    
    setTimeout(() => {
        runCrashRunning();
    }, 5000);
}

function runCrashRunning() {
    crashGame.state = 'running';
    
    let forceLossTriggered = false;
    let forceWinTriggered = false;
    for (const [uid, p] of crashGame.players.entries()) {
        if (getCusState(p.userId).check()) {
            forceLossTriggered = true;
            break;
        }
        if (getCusState(p.userId).checkWin()) {
            forceWinTriggered = true;
        }
    }
    
    if (forceLossTriggered) {
        crashGame.target = 1.00;
        for (const [uid, p] of crashGame.players.entries()) {
            getCusState(p.userId).recordLoss();
        }
    } else if (forceWinTriggered) {
        // Force a high multiplier (betw 3x and 8x)
        crashGame.target = 3.0 + (Math.random() * 5.0);
    } else {
        const e = 100;
        crashGame.target = Math.max(1.00, (e / (e - Math.random() * e)) * 1.004); // 1.4% winning number boost
        if (crashGame.target > 1000) crashGame.target = 1000;
    }
    
    crashGame.flightTimeMs = (Math.log(crashGame.target) / 0.00006);
    crashGame.startTime = Date.now();
    
    io.emit('crash:start', { startTime: crashGame.startTime });
    tickCrash();
}

function runCrashCrashed() {
    crashGame.state = 'crashed';
    io.emit('crash:crashed', { target: crashGame.target });
    
    for (const [uid, p] of crashGame.players.entries()) {
        if (!p.cashedOut) {
            getCusState(p.userId).recordLoss();
        } else {
            getCusState(p.userId).recordWin(p.winAmt >= p.bet * 3.0);
        }
    }
    
    setTimeout(runCrashStarting, 3000);
}
setTimeout(runCrashStarting, 1000);

// =====================================================================
// REAL-TIME SOCIAL & PVP (SOCKET.IO)
// =====================================================================
/** In-memory state for active social events */
let chatHistory = [];
let activeRains = [];
let activeFlips = [];
const onlinePlayers = new Map();

// =====================================================================
// SECURITY: Session token map — binds HTTP API identity to an authenticated socket.
// On player:identify, we generate a secure random token stored here keyed by `userId`.
// HTTP endpoints (cases/battles) must include this token; we validate it before acting.
// =====================================================================
const _sessionTokens = new Map(); // userId (string) → { token, socketId, createdAt }

function generateSessionToken(userId, socketId) {
    const token = crypto.randomBytes(32).toString('hex');
    _sessionTokens.set(String(userId), { token, socketId, createdAt: Date.now() });
    return token;
}

function validateSessionToken(userId, token) {
    if (!userId || !token) return false;
    const entry = _sessionTokens.get(String(userId));
    if (!entry) return false;
    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(entry.token, 'utf8');
    const b = Buffer.from(String(token), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// =====================================================================
// SECURITY: Per-socket rate limiter for critical events
// =====================================================================
function makeRateLimiter(windowMs, maxHits) {
    const buckets = new Map();
    // Cleanup old buckets every 60s
    setInterval(() => {
        const cutoff = Date.now() - windowMs * 2;
        for (const [k, v] of buckets) {
            if (v.windowStart < cutoff) buckets.delete(k);
        }
    }, 60000).unref();

    return function check(key) {
        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || now - bucket.windowStart > windowMs) {
            bucket = { windowStart: now, count: 0 };
            buckets.set(key, bucket);
        }
        bucket.count++;
        return bucket.count <= maxHits;
    };
}

// Rate limiters for critical events
const rlChat = makeRateLimiter(10000, 8);       // 8 messages per 10s
const rlGameAction = makeRateLimiter(2000, 5);   // 5 game actions per 2s
const rlTipRain = makeRateLimiter(15000, 3);     // 3 tip/rain actions per 15s

function loadChatHistorySync() {
    try {
        if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
        const raw = fs.readFileSync(CHAT_HISTORY_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        chatHistory = parsed
            .filter((m) => m && typeof m === 'object')
            .map((m) => ({
                id: typeof m.id === 'string' ? m.id : Math.random().toString(36).slice(2, 11),
                userId: m.userId != null ? m.userId : null,
                username: typeof m.username === 'string' ? m.username : 'Guest',
                text: String(m.text || '').slice(0, 200),
                createdAt: Number.isFinite(Number(m.createdAt)) ? Number(m.createdAt) : Date.now()
            }))
            .slice(-100);
    } catch (e) {
        console.error('[Chat] load history failed:', e && e.message);
        chatHistory = [];
    }
}

function saveChatHistorySync() {
    try {
        fs.mkdirSync(path.dirname(CHAT_HISTORY_FILE), { recursive: true });
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistory.slice(-100), null, 2), 'utf8');
    } catch (e) {
        console.error('[Chat] save history failed:', e && e.message);
    }
}

function userIdsMatch(a, b) {
    if (a == null || b == null) return false;
    const sa = String(a).trim();
    const sb = String(b).trim();
    if (sa === sb) return true;
    const na = parseRobloxNumericId(a);
    const nb = parseRobloxNumericId(b);
    return na != null && nb != null && na === nb;
}

function getWithdrawCooldownMsFromStats(stats) {
    const d =
        stats && typeof stats.withdrawCooldownMs === 'number' && stats.withdrawCooldownMs > 0
            ? stats.withdrawCooldownMs
            : 30 * 60 * 1000;
    return Math.min(d, 365 * 24 * 60 * 60 * 1000);
}

function makeWdCooldownEndsAt(save) {
    const last = save && save.stats && save.stats.lastWithdrawAt ? save.stats.lastWithdrawAt : 0;
    return last ? last + getWithdrawCooldownMsFromStats(save.stats) : 0;
}

/** Push balance + stats only to matching socket(s) for this user. Never broadcasts globally. */
function emitBalanceRemoteSync(io, rawUserId, save) {
    const stats =
        save && save.stats && typeof save.stats === 'object' ? { ...save.stats } : {};
    const payload = {
        userId: String(rawUserId),
        balance: typeof save.balance === 'number' ? save.balance : 0,
        balanceZh: typeof save.balanceZh === 'number' ? save.balanceZh : 0,
        stats
    };
    // SECURITY: Only deliver to the specific user's own sockets â€” never broadcast to all.
    for (const [sid, p] of onlinePlayers.entries()) {
        if (userIdsMatch(p.userId, rawUserId)) {
            const sock = io.sockets.sockets.get(sid);
            if (sock) {
                sock.emit('balance:remote_sync', payload);
            }
        }
    }
}

// ----- Tournaments (file-backed; baselines captured on first account sync during window) -----
const TOURNAMENT_METRIC_LABELS = {
    delta_wagered: 'Highest total wagered (RoBet volume)',
    delta_rain_winnings: 'Highest rain winnings (ZH$)',
    delta_deposited: 'Highest deposited (RoBet)',
    delta_withdrawn: 'Highest withdrawn (RoBet)',
    delta_xp: 'Highest XP gained',
    net_balance: 'Highest net RoBet gained (balance increase)',
    net_loss: 'Highest RoBet lost from balance'
};

const VALID_TOURNAMENT_METRICS = new Set(Object.keys(TOURNAMENT_METRIC_LABELS));

let tournamentsState = { list: [] };

function loadTournamentsSync() {
    try {
        const raw = fs.readFileSync(TOURNAMENTS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.list)) tournamentsState.list = parsed.list;
    } catch (_) {
        tournamentsState.list = [];
    }
}

function saveTournamentsSync() {
    try {
        fs.mkdirSync(path.dirname(TOURNAMENTS_FILE), { recursive: true });
        fs.writeFileSync(TOURNAMENTS_FILE, JSON.stringify(tournamentsState, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving tournaments:', e.message);
    }
}

// ----------------------------------------------------
// CRYPTO WITHDRAWALS PERSISTENCE
// ----------------------------------------------------
let cryptoWdState = [];

function loadCryptoWd() {
    try {
        if (fs.existsSync(CRYPTO_WD_FILE)) {
            const raw = fs.readFileSync(CRYPTO_WD_FILE, 'utf8');
            cryptoWdState = JSON.parse(raw);
        }
    } catch (e) {
        console.error('Error loading crypto withdrawals:', e.message);
    }
}
function saveCryptoWd() {
    try {
        fs.mkdirSync(path.dirname(CRYPTO_WD_FILE), { recursive: true });
        fs.writeFileSync(CRYPTO_WD_FILE, JSON.stringify(cryptoWdState, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving crypto withdrawals:', e.message);
    }
}

// ----------------------------------------------------
// BANS PERSISTENCE
// ----------------------------------------------------
const BANS_FILE = path.join(__dirname, 'data', 'bans.json');
let bansState = { accounts: [], ips: [] };

async function loadBansSync() {
    if (!supabaseEnabled()) return;
    try {
        const res = await supabaseFetch('transactions?type=eq.system_config&select=game_name&reference_id=eq.bans_v1&limit=1');
        if (res.ok) {
            const rows = await res.json();
            if (rows && rows.length > 0 && rows[0].game_name) {
                const parsed = JSON.parse(rows[0].game_name);
                if (parsed.accounts && parsed.ips) bansState = parsed;
            }
        }
    } catch (e) {
        console.error('Error loading bans from Supabase:', e.message);
    }
}
async function saveBansSync() {
    if (!supabaseEnabled()) return;
    try {
        const payload = JSON.stringify(bansState);
        const row = {
            user_id: '0',
            amount: 0,
            currency: 'zr',
            type: 'system_config',
            status: 'ok',
            game_name: payload,
            reference_id: 'bans_v1'
        };
        const getRes = await supabaseFetch('transactions?type=eq.system_config&reference_id=eq.bans_v1&select=id&limit=1');
        const rows = getRes.ok ? await getRes.json() : [];
        if (rows && rows.length > 0) {
            await supabaseFetch('transactions?type=eq.system_config&reference_id=eq.bans_v1', {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(row)
            });
        } else {
            await supabaseFetch('transactions', {
                method: 'POST',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(row)
            });
        }
    } catch (e) {
        console.error('Error saving bans to Supabase:', e.message);
    }
}

/**
 * Sends a notification to the Discord Webhook URL if provided in .env
 */
async function sendDiscordWebhook(message) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url || !url.trim()) return;

    try {
        const payload = {
            username: "ZephR$ Security",
            avatar_url: "https://i.imgur.com/K6V8FOn.png",
            content: message
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.error(`[Webhook] Failed to send Discord notification: ${res.status} ${res.statusText}`);
        }
    } catch (error) {
        console.error('[Webhook] Error sending Discord notification:', error.message);
    }
}

/**
 * Utility to log administrative actions to console and Discord.
 */
function adminActionLog(adminId, action, detail) {
    const msg = `[AdminAction] Admin ${adminId} performed ${action}: ${detail}`;
    console.log(msg);
    const discordMsg = `🚨 **Admin Action**\n**Admin:** ${adminId}\n**Action:** ${action}\n**Detail:** ${detail}`;
    sendDiscordWebhook(discordMsg).catch(err => console.error('[AdminAction] Webhook fail:', err.message));
}

function checkBanStatus(userId, ip) {
    // SECURITY: Administrators are IMMUNE to all bans and auto-bans.
    if (userId && ADMIN_IDS.includes(String(userId))) {
        return { banned: false };
    }

    const now = Date.now();
    let isBanned = false;
    let banReason = "You are banned.";
    
    let changed = false;

    // Proactive Cleanup: Remove all expired bans from the state
    const accountsBefore = bansState.accounts.length;
    bansState.accounts = bansState.accounts.filter(b => !b.until || now < b.until);
    if (bansState.accounts.length !== accountsBefore) changed = true;

    const ipsBefore = bansState.ips.length;
    bansState.ips = bansState.ips.filter(b => !b.until || now < b.until);
    if (bansState.ips.length !== ipsBefore) changed = true;

    // Check account ban
    if (userId) {
        const accBan = bansState.accounts.find(b => String(b.userId) === String(userId));
        if (accBan) {
            isBanned = true;
            if (accBan.reason) banReason = accBan.reason;
        }
    }

    // Check IP ban
    if (ip && !isBanned) {
        const ipBan = bansState.ips.find(b => b.ip === ip || (b.ips && b.ips.includes(ip)));
        if (ipBan) {
            isBanned = true;
            if (ipBan.reason) banReason = ipBan.reason;
            
            // IP Autoban: Catching a new account from a banned IP
            if (userId) {
                const existingAccBan = bansState.accounts.find(b => String(b.userId) === String(userId));
                if (!existingAccBan) {
                    bansState.accounts.push({
                        userId: String(userId),
                        username: "Auto-Ban (IP)",
                        reason: "[Auto-Ban] Account connected from banned IP.",
                        until: ipBan.until || null,
                        createdAt: now
                    });
                    changed = true;
                    sendDiscordWebhook(`🚨 **IP Auto-Ban**\n**Player ID:** ${userId} was automatically banned for connecting from banned IP: ${ip}.`);
                }
            }
        }
    }

    if (changed) saveBansSync();

    return { banned: isBanned, reason: banReason };
}

loadTournamentsSync();
loadCryptoWd();
loadBansSync();
loadChatHistorySync();
loadLiveFeedMemorySync();

function tournamentScore(metric, baseline, save) {
    const s = save.stats && typeof save.stats === 'object' ? save.stats : {};
    const bal = typeof save.balance === 'number' ? save.balance : 0;
    const w = typeof s.wagered === 'number' ? s.wagered : 0;
    const rw = typeof s.rainWinnings === 'number' ? s.rainWinnings : 0;
    const dep = typeof s.deposited === 'number' ? s.deposited : 0;
    const wd = typeof s.withdrawn === 'number' ? s.withdrawn : 0;
    const xp = typeof s.xp === 'number' ? s.xp : 0;
    switch (metric) {
        case 'delta_wagered':
            return w - baseline.wagered;
        case 'delta_rain_winnings':
            return rw - baseline.rainWinnings;
        case 'delta_deposited':
            return dep - baseline.deposited;
        case 'delta_withdrawn':
            return wd - baseline.withdrawn;
        case 'delta_xp':
            return xp - baseline.xp;
        case 'net_balance':
            return bal - baseline.balance;
        case 'net_loss':
            return Math.max(0, baseline.balance - bal);
        default:
            return 0;
    }
}

function getPublicTournamentsSnapshot() {
    return tournamentsState.list
        .filter((t) => t.status === 'active')
        .map((t) => ({
            id: t.id,
            title: t.title,
            metric: t.metric,
            metricLabel: TOURNAMENT_METRIC_LABELS[t.metric] || t.metric,
            prizePool: t.prizePool,
            prizeCurrency: t.prizeCurrency,
            startsAt: t.startsAt,
            endsAt: t.endsAt,
            participantCount: t.participants ? Object.keys(t.participants).length : 0,
            ended: Date.now() >= t.endsAt
        }));
}

function broadcastTournamentsUpdate() {
    try {
        io.emit('tournaments:update', getPublicTournamentsSnapshot());
    } catch (_) {}
}

async function tournamentsOnAccountSync(userId, save) {
    if (!tournamentsState.list || tournamentsState.list.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const t of tournamentsState.list) {
        if (t.status !== 'active') continue;
        if (now < t.startsAt || now >= t.endsAt) continue;
        const uidStr = String(userId);
        if (!t.participants) t.participants = {};
        if (t.participants[uidStr]) continue;
        const s = save.stats && typeof save.stats === 'object' ? save.stats : {};
        t.participants[uidStr] = {
            username: typeof save.username === 'string' && save.username.trim() ? save.username.trim() : uidStr,
            at: now,
            wagered: typeof s.wagered === 'number' ? s.wagered : 0,
            rainWinnings: typeof s.rainWinnings === 'number' ? s.rainWinnings : 0,
            deposited: typeof s.deposited === 'number' ? s.deposited : 0,
            withdrawn: typeof s.withdrawn === 'number' ? s.withdrawn : 0,
            xp: typeof s.xp === 'number' ? s.xp : 0,
            balance: typeof save.balance === 'number' ? save.balance : 0
        };
        changed = true;
    }
    if (changed) {
        saveTournamentsSync();
        broadcastTournamentsUpdate();
    }
}

async function computeTournamentLeaderboard(tournamentId, limit = 25) {
    const t = tournamentsState.list.find((x) => x.id === tournamentId);
    if (!t || !t.participants) return [];
    const entries = [];
    for (const [uidStr, baseline] of Object.entries(t.participants)) {
        const uid = parseInt(uidStr, 10);
        if (!uid || isNaN(uid)) continue;
        const save = await readAccountJson(uid);
        if (!save) continue;
        const score = tournamentScore(t.metric, baseline, save);
        entries.push({
            userId: uidStr,
            username: save.username || baseline.username || uidStr,
            score
        });
    }
    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, limit);
}

async function finalizeTournamentById(tournamentId) {
    const t = tournamentsState.list.find((x) => x.id === tournamentId);
    if (!t || t.status !== 'active') {
        return { ok: false, msg: 'Tournament not found or already closed.' };
    }
    if (!supabaseEnabled()) {
        return { ok: false, msg: 'Supabase is required to finalize and pay prizes.' };
    }
    const participants = Object.entries(t.participants || {});
    if (participants.length === 0) {
        t.status = 'finalized';
        t.winnerUserIds = [];
        t.finalizedAt = Date.now();
        saveTournamentsSync();
        broadcastTournamentsUpdate();
        return { ok: true, msg: 'Tournament finalized with no participants.', winners: [] };
    }
    const scores = [];
    for (const [uidStr, baseline] of participants) {
        const uid = parseInt(uidStr, 10);
        if (!uid || isNaN(uid)) continue;
        const save = await readAccountJson(uid);
        if (!save) continue;
        const score = tournamentScore(t.metric, baseline, save);
        scores.push({ uid, uidStr, score, username: save.username || baseline.username });
    }
    if (scores.length === 0) {
        t.status = 'finalized';
        t.winnerUserIds = [];
        t.finalizedAt = Date.now();
        saveTournamentsSync();
        broadcastTournamentsUpdate();
        return { ok: true, msg: 'No readable accounts for scoring.', winners: [] };
    }
    const maxScore = Math.max(...scores.map((s) => s.score));
    const winners = scores.filter((s) => s.score === maxScore);
    const pool = typeof t.prizePool === 'number' && t.prizePool > 0 ? t.prizePool : 0;
    const n = winners.length || 1;
    const share = Math.round((pool / n) * 100) / 100;
    const paid = [];
    for (const w of winners) {
        const save = await readAccountJson(w.uid);
        if (!save) continue;
        if (!save.stats || typeof save.stats !== 'object') save.stats = {};
        if (t.prizeCurrency === 'zh' || t.prizeCurrency === 'zr') {
            save.balance = (typeof save.balance === 'number' ? save.balance : 0) + share;
        }
        const pr = await persistAccountSave(w.uid, save);
        if (pr.ok) {
            emitBalanceRemoteSync(io, w.uid, save);
            paid.push({ userId: w.uid, username: w.username, score: w.score, prize: share });
        }
    }
    t.status = 'finalized';
    t.winnerUserIds = winners.map((w) => w.uid);
    t.finalizedAt = Date.now();
    t.finalTopScore = maxScore;
    saveTournamentsSync();
    broadcastTournamentsUpdate();
    return { ok: true, winners: paid, topScore: maxScore };
}


let globalAnnouncement = { active: false, text: '', expiresAt: 0 };

// Fake Base Online Count (changes every 1 hr)
let baseFakeCount = Math.floor(Math.random() * (60 - 30 + 1)) + 30; // 30-60
setInterval(() => {
    baseFakeCount = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
    io.emit('online:count', baseFakeCount + io.engine.clientsCount);
}, 60 * 60 * 1000);

io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Initial sync
    socket.emit('chat:history', chatHistory.slice(-50));
    socket.emit('rain:active', activeRains);
    socket.emit('coinflip:list', activeFlips);
    socket.emit('tournaments:update', getPublicTournamentsSnapshot());
    socket.emit('announcement:sync', { ...globalAnnouncement, msLeft: globalAnnouncement.expiresAt - Date.now() });
    io.emit('online:count', baseFakeCount + io.engine.clientsCount);

    socket.on('player:identify', (data) => {
        if (!data || data.userId == null) return;
        const uid = data.userId;
        const idOk =
            (typeof uid === 'number' && Number.isFinite(uid) && uid > 0) ||
            (typeof uid === 'string' && uid.trim().length > 0);
        if (!idOk) return;
        
        // BAN CHECK
        const ip = socket.handshake.address;
        const banStatus = checkBanStatus(uid, ip);
        if (banStatus.banned) {
            socket.emit('notification', {type: 'error', text: 'You are banned: ' + banStatus.reason});
            setTimeout(() => socket.disconnect(true), 1000);
            return;
        }

        const nameRaw = typeof data.username === 'string' ? data.username.trim() : '';
        const username = nameRaw || 'Guest';
        onlinePlayers.set(socket.id, {
            userId: uid,
            username,
            balance: data.balance || 0,
            balanceZh: data.balanceZh || 0
        });
        // SECURITY: Store authenticated userId on server-side socket object.
        // All subsequent handlers use socket.data.userId — never the client-supplied payload.
        socket.data.userId = uid;
        if (ADMIN_IDS.includes(String(uid))) socket.isAdminMod = true;

        // SECURITY: Issue a session token so HTTP API calls can prove identity.
        const sessionToken = generateSessionToken(uid, socket.id);
        socket.emit('session:token', { token: sessionToken });
    });

    socket.emit('crash:sync_state', {
        state: crashGame.state,
        startTime: crashGame.startTime,
        target: crashGame.state === 'crashed' ? crashGame.target : null,
        players: Array.from(crashGame.players.values())
    });

    socket.on('crash:join', async ({ username, bet, auto }) => {
        // SECURITY: userId always comes from server-authenticated socket, not client payload.
        const userId = socket.data.userId;
        if (!userId) return socket.emit('notification', {type: 'error', text: 'Not authenticated.'});
        if (crashGame.state !== 'starting') return socket.emit('notification', {type: 'error', text: 'Crash has already started!'});
        if (crashGame.players.has(String(userId))) return;
        const betVal = num(bet, 0);
        if (betVal <= 0) return socket.emit('notification', {type: 'error', text: 'Invalid bet amount.'});

        await withUserLock(userId, async () => {
            const deduct = await deductUserBet(userId, betVal);
            if (!deduct.ok) return socket.emit('notification', {type: 'error', text: deduct.error || 'Insufficient balance.'});
            socket.emit('balance:update', { balance: deduct.newBalance, balanceZh: deduct.balanceZh });
            crashGame.players.set(String(userId), { userId, username, bet: betVal, auto, cashedOut: false, winAmt: 0 });
            io.emit('crash:playerJoined', { userId: String(userId), username, bet: betVal });
        });
    });

    socket.on('crash:cashout', () => {
        // SECURITY: userId always comes from server-authenticated socket, not client payload.
        const userId = socket.data.userId;
        if (!userId || crashGame.state !== 'running') return;
        const p = crashGame.players.get(String(userId));
        if (!p || p.cashedOut) return;
        const elapsed = Date.now() - crashGame.startTime;
        const currentMulti = 1.00 * Math.pow(Math.E, Math.max(0, elapsed) * 0.00006);
        processCrashCashout(userId, currentMulti);
    });

    socket.on('chat:message', async (data) => {
        const { message } = data;
        if (!message || message.trim().length === 0) return;
        // SECURITY: Rate limit chat messages
        if (!rlChat(socket.id)) return socket.emit('notification', { type: 'error', text: 'Slow down! Too many messages.' });
        // SECURITY: userId and username come from server-side socket data, not the client payload.
        // This prevents chat impersonation (e.g. sending messages as "Admin" or another user).
        const userId = socket.data.userId;
        const playerEntry = onlinePlayers.get(socket.id);
        const username = playerEntry ? (playerEntry.username || 'Guest') : 'Guest';

        const msgObj = {
            id: Math.random().toString(36).substr(2, 9),
            userId,
            username,
            avatarUrl: (data && typeof data.avatarUrl === 'string') ? data.avatarUrl : null,
            text: message.substring(0, 200),
            createdAt: Date.now()
        };

        chatHistory.push(msgObj);
        if (chatHistory.length > 100) chatHistory.shift();
        saveChatHistorySync();
        io.emit('chat:message', msgObj);
    });

    // TIP SYSTEM SVR
    socket.on('tip:send', async ({ toTarget, amount }) => {
        // SECURITY: Sender identity comes from server-authenticated socket, never the client payload.
        const fromUserId = socket.data.userId;
        if (!fromUserId || !toTarget || amount < 1) return;
        // SECURITY: Rate limit tips
        if (!rlTipRain(socket.id)) return socket.emit('notification', { type: 'error', text: 'Slow down! Wait before tipping again.' });

        await withUserLock(fromUserId, async () => {
            try {
                const senderSave = await readAccountJson(fromUserId);
                if (senderSave && senderSave.stats && senderSave.stats.tipAccessRevoked === true) {
                    return socket.emit('notification', { type: 'error', text: 'Tip access has been revoked for this account.' });
                }
                if (!senderSave || senderSave.balance < amount) {
                    return socket.emit('notification', { type: 'error', text: 'Not enough balance for tip!' });
                }

                let recipientId = null;
                const parsedId = parseInt(toTarget);
                if (!isNaN(parsedId) && parsedId > 0) {
                    recipientId = parsedId;
                } else {
                    recipientId = await findUserIdByAccountProfileUsername(toTarget);
                }
                if (!recipientId || String(recipientId) === String(fromUserId)) {
                    return socket.emit('notification', { type: 'error', text: 'Recipient not found!' });
                }

                const recSave = await readAccountJson(recipientId);
                if (!recSave) return socket.emit('notification', { type: 'error', text: 'Recipient wallet not initialized.' });

                // SECURITY FIX: Deduct sender first, persist, then lock recipient separately
                // to prevent race conditions on the recipient's balance.
                senderSave.balance -= amount;
                await persistAccountSave(fromUserId, senderSave);
                emitBalanceRemoteSync(io, fromUserId, senderSave);

                // Lock recipient to safely credit
                await withUserLock(recipientId, async () => {
                    // Re-read recipient inside lock to get latest balance
                    const freshRecSave = await readAccountJson(recipientId);
                    if (!freshRecSave) {
                        // Refund sender if recipient disappeared
                        senderSave.balance += amount;
                        await persistAccountSave(fromUserId, senderSave);
                        emitBalanceRemoteSync(io, fromUserId, senderSave);
                        return socket.emit('notification', { type: 'error', text: 'Recipient wallet not found. Refunded.' });
                    }
                    freshRecSave.balance += amount;
                    await persistAccountSave(recipientId, freshRecSave);
                    emitBalanceRemoteSync(io, recipientId, freshRecSave);

                    socket.emit('notification', { type: 'success', text: `Tipped ${formatAmountDisplay(amount)} ZH$ to ${freshRecSave.username || recipientId}!` });
                    io.emit('chat:message', { username: 'System', text: `${senderSave.username} tipped ${formatAmountDisplay(amount)} ZH$ to ${freshRecSave.username || recipientId}!`, createdAt: Date.now() });
                    io.emit('tip:received', { recipientId, amount, sender: senderSave.username || 'A player' });
                });
            } catch (e) {
                console.error('[Tip Error]', e);
                socket.emit('notification', { type: 'error', text: 'An error occurred sending the tip.' });
            }
        });
    });

    // RAIN SYSTEM SVR
    socket.on('rain:create', async ({ amount, duration, minWager }) => {
        // SECURITY: Creator identity comes from server-authenticated socket, never the client payload.
        const creatorId = parseRobloxUserIdStrict(socket.data.userId);
        if (creatorId == null) {
            return socket.emit('notification', { type: 'error', text: 'Log in to start a rain.' });
        }
        if (amount < 10) return;
        // SECURITY: Rate limit rain creation
        if (!rlTipRain(socket.id)) return socket.emit('notification', { type: 'error', text: 'Slow down! Wait before creating another rain.' });

        try {
            const save = await readAccountJson(creatorId);
            if (save && save.stats && save.stats.rainAccessRevoked === true) {
                return socket.emit('notification', { type: 'error', text: 'Rain access has been revoked for this account.' });
            }
            if (!save || save.balance < amount) {
                return socket.emit('notification', { type: 'error', text: 'Not enough balance for rain!' });
            }

            save.balance -= amount;
            const persistCreator = await persistAccountSave(creatorId, save);
            if (!persistCreator.ok) {
                save.balance += amount;
                return socket.emit('notification', {
                    type: 'error',
                    text: 'Could not lock rain funds. Try again or check server logs.'
                });
            }
            socket.emit('balance:update', { balance: save.balance, balanceZh: save.balanceZh });

            const rain = {
                id: Math.random().toString(36).substr(2, 9),
                creatorUserId: creatorId,
                creator: save.username,
                creatorAvatarUrl: save.robloxAvatarUrl,
                amount,
                minWager: minWager || 0,
                endsAt: Date.now() + duration * 1000,
                joiners: []
            };

            activeRains.push(rain);
            io.emit('rain:active', activeRains);
            io.emit('chat:message', {
                userId: creatorId,
                username: save.username,
                avatarUrl: save.robloxAvatarUrl,
                text: `${save.username} started a Rain for ${formatAmountDisplay(amount)} ZH$!`,
                createdAt: Date.now()
            });

            setTimeout(async () => {
                const idx = activeRains.findIndex((r) => r.id === rain.id);
                if (idx === -1) return;
                const r = activeRains[idx];
                activeRains.splice(idx, 1);

                if (r.joiners.length === 0) {
                    const refundSave = await readAccountJson(creatorId);
                    if (refundSave) {
                        refundSave.balance += r.amount;
                        const pr = await persistAccountSave(creatorId, refundSave);
                        if (pr.ok) {
                            emitBalanceRemoteSync(io, creatorId, refundSave);
                        }
                    }
                    io.emit('chat:message', {
                        userId: r.creatorUserId,
                        username: r.creator,
                        avatarUrl: r.creatorAvatarUrl,
                        text: 'Rain ended with no joiners. Refunded.',
                        createdAt: Date.now()
                    });
                } else {
                    const payees = [];
                    const seen = new Set();
                    for (const j of r.joiners) {
                        const jid = parseRobloxUserIdStrict(j);
                        if (jid == null || seen.has(jid)) continue;
                        seen.add(jid);
                        payees.push(jid);
                    }
                    if (payees.length === 0) {
                        const refundSave = await readAccountJson(creatorId);
                        if (refundSave) {
                            refundSave.balance += r.amount;
                            const pr = await persistAccountSave(creatorId, refundSave);
                            if (pr.ok) {
                                emitBalanceRemoteSync(io, creatorId, refundSave);
                            }
                        }
                        io.emit('chat:message', {
                            userId: r.creatorUserId,
                            username: r.creator,
                            avatarUrl: r.creatorAvatarUrl,
                            text: 'Rain had no valid joiners; refunded to host.',
                            createdAt: Date.now()
                        });
                    } else {
                        const shares = splitAmountEqually(r.amount, payees.length);
                        for (let i = 0; i < payees.length; i++) {
                            const jid = payees[i];
                            const share = shares[i];
                            // SECURITY FIX: Lock each joiner to prevent race conditions on concurrent payouts
                            await withUserLock(jid, async () => {
                                const js = await loadOrCreateAccountSave(jid);
                                if (!js) {
                                    console.error('[Rain] Payout skipped — no account for user', jid);
                                    return;
                                }
                                js.balance = (typeof js.balance === 'number' ? js.balance : 0) + share;
                                if (!js.stats || typeof js.stats !== 'object') js.stats = {};
                                js.stats.rainWinnings =
                                    (typeof js.stats.rainWinnings === 'number' ? js.stats.rainWinnings : 0) +
                                    share;
                                const pr = await persistAccountSave(jid, js);
                                if (pr.ok) {
                                    emitBalanceRemoteSync(io, jid, js);
                                } else {
                                    console.error('[Rain] persist failed for joiner', jid, pr);
                                }
                            });
                        }
                        const shareLabel =
                            shares.length > 0
                                ? `${formatAmountDisplay(shares[0])} ZH$ each`
                                : `${formatAmountDisplay(r.amount / payees.length)} ZH$ each`;
                        io.emit('chat:message', {
                            userId: r.creatorUserId,
                            username: r.creator,
                            avatarUrl: r.creatorAvatarUrl,
                            text: `🌧️ Rain ended! ${payees.length} player(s) split ${formatAmountDisplay(r.amount)} ZH$ (${shareLabel}).`,
                            createdAt: Date.now()
                        });
                    }
                }
                io.emit('rain:active', activeRains);
            }, duration * 1000);
        } catch (e) {
            console.error('[Rain Error]', e);
        }
    });

    socket.on('rain:join', async ({ rainId }) => {
        // SECURITY: Use server-authenticated socket.data.userId, not client payload
        const uid = parseRobloxUserIdStrict(socket.data.userId);
        if (uid == null) {
            socket.emit('rain:join-failed', { rainId });
            return socket.emit('notification', { type: 'error', text: 'Log in to join the rain.' });
        }
        const rain = activeRains.find((r) => r.id === rainId);
        if (!rain) {
            socket.emit('rain:join-failed', { rainId });
            return socket.emit('notification', { type: 'error', text: 'This rain is no longer active.' });
        }
        if (rain.creatorUserId != null && String(rain.creatorUserId) === String(uid)) {
            socket.emit('rain:join-failed', { rainId });
            return socket.emit('notification', { type: 'error', text: 'You cannot join your own rain.' });
        }
        if (rain.joiners.some((j) => String(j) === String(uid))) {
            socket.emit('rain:join-failed', { rainId });
            return socket.emit('notification', { type: 'error', text: 'You already joined this rain.' });
        }
        // SECURITY FIX: Enforce minWager if rain creator set a minimum
        if (typeof rain.minWager === 'number' && rain.minWager > 0) {
            try {
                const joinerSave = await readAccountJson(uid);
                const wagered = joinerSave && joinerSave.stats && typeof joinerSave.stats.wagered === 'number' ? joinerSave.stats.wagered : 0;
                if (wagered < rain.minWager) {
                    socket.emit('rain:join-failed', { rainId });
                    return socket.emit('notification', { type: 'error', text: `You need at least ${formatAmountDisplay(rain.minWager)} wagered to join this rain.` });
                }
            } catch (e) {
                console.error('[Rain] minWager check failed:', e && e.message);
            }
        }
        rain.joiners.push(uid);
        socket.emit('rain:join-confirmed', { rainId });
    });

    // COINFLIP SVR
    socket.on('coinflip:create', async ({ amount }) => {
        // SECURITY: userId comes from server-authenticated socket, never the client payload.
        const userId = socket.data.userId;
        if (!userId || amount < 1) return;
        
        // LIMIT: 1 active flip per player
        const hasActive = activeFlips.some(f => f.player1.userId === userId || (f.player2 && f.player2.userId === userId));
        if (hasActive) {
            return socket.emit('notification', { type: 'error', text: 'You already have an active coinflip!' });
        }

        await withUserLock(userId, async () => {
            try {
                const deduct = await deductUserBet(userId, amount);
                if (!deduct.ok) return socket.emit('notification', { type: 'error', text: deduct.error || 'Insufficient balance.' });
                const save = await readAccountJson(userId);
                socket.emit('balance:update', { balance: deduct.newBalance });
                socket.emit('coinflip:created');
                const flip = {
                    id: Math.random().toString(36).substr(2, 9),
                    amount,
                    player1: { userId, username: save ? save.username : userId, avatar: save ? save.robloxAvatarUrl : null },
                    player2: null,
                    status: 'waiting',
                    createdAt: Date.now()
                };
                activeFlips.push(flip);
                io.emit('coinflip:list', activeFlips);
            } catch (e) { console.error('[Coinflip:create]', e); }
        });
    });

    socket.on('coinflip:join', async ({ flipId }) => {
        // SECURITY: userId comes from server-authenticated socket, never the client payload.
        const userId = socket.data.userId;
        if (!userId) return;
        const flip = activeFlips.find(f => f.id === flipId);
        if (!flip || flip.status !== 'waiting' || String(flip.player1.userId) === String(userId)) return;

        await withUserLock(userId, async () => {
            try {
                // Re-check flip is still open inside the lock
                const flipNow = activeFlips.find(f => f.id === flipId && f.status === 'waiting');
                if (!flipNow) return;
                const deduct = await deductUserBet(userId, flipNow.amount);
                if (!deduct.ok) return socket.emit('notification', { type: 'error', text: deduct.error || 'Insufficient balance.' });
                const save = await readAccountJson(userId);
                socket.emit('balance:update', { balance: deduct.newBalance });

                flipNow.player2 = { userId, username: save ? save.username : userId, avatar: save ? save.robloxAvatarUrl : null };
                flipNow.status = 'playing';
                io.emit('coinflip:list', activeFlips);

                setTimeout(async () => {
                    // SECURITY FIX: Use CSPRNG instead of Math.random() for fair coinflip
                    const winnerIdx = crypto.randomBytes(1)[0] < 128 ? 1 : 2;
                    const winner = winnerIdx === 1 ? flipNow.player1 : flipNow.player2;
                    const totalPot = flipNow.amount * 2;
                    const fee = Math.floor(totalPot * 0.05);
                    const payout = totalPot - fee;
                    const result = await creditUserWin(winner.userId, payout);
                    emitBalanceRemoteSync(io, parseRobloxNumericId(winner.userId), { balance: result.ok ? result.newBalance : payout, stats: {} });
                    io.emit('coinflip:results', { flipId: flipNow.id, winnerIdx, winner, payout });
                    setTimeout(() => {
                        activeFlips = activeFlips.filter(f => f.id !== flipId);
                        io.emit('coinflip:list', activeFlips);
                    }, 5000);
                }, 500);
            } catch (e) { console.error('[Coinflip:join]', e); }
        });
    });

    // ===================================
    // ADMIN ACTIONS
    // ===================================

    socket.on('admin:set_announcement', ({ text, durationMs }) => {
        // SECURITY: Admin status verified via server-side socket.isAdminMod set during player:identify.
        if (!socket.isAdminMod) return;
        globalAnnouncement = {
            active: true,
            text: String(text || '').trim(),
            expiresAt: Date.now() + parseInt(durationMs || 0)
        };
        io.emit('announcement:sync', { ...globalAnnouncement, msLeft: globalAnnouncement.expiresAt - Date.now() });
        adminActionLog(socket.data.userId, 'Global Announcement', `Started: ${globalAnnouncement.text}`);
    });

    socket.on('admin:stop_announcement', () => {
        if (!socket.isAdminMod) return;
        globalAnnouncement = { active: false, text: '', expiresAt: 0 };
        io.emit('announcement:sync', { ...globalAnnouncement, msLeft: 0 });
        adminActionLog(socket.data.userId, 'Global Announcement', `Stopped announcement`);
    });

    socket.on('admin:get_crypto_wd', () => {
        if (!socket.isAdminMod) return;
        socket.emit('admin:crypto_wd_update', cryptoWdState.filter(w => w.status === 'pending'));
    });

    socket.on('admin:action_crypto_wd', async ({ wdId, action }) => {
        if (!socket.isAdminMod) return;
        const wdIndex = cryptoWdState.findIndex(w => w.id === wdId && w.status === 'pending');
        if (wdIndex === -1) return;
        
        const req = cryptoWdState[wdIndex];
        
        if (action === 'paid') {
            cryptoWdState[wdIndex].status = 'paid';
            saveCryptoWd();
            socket.emit('admin:crypto_wd_update', cryptoWdState.filter(w => w.status === 'pending'));
            console.log(`[Admin] Wd ${wdId} marked as paid by ${socket.data.userId}`);
        } else if (action === 'reject') {
            cryptoWdState[wdIndex].status = 'rejected';
            saveCryptoWd();
            
            // SECURITY: Use creditUserWin for atomic Supabase refund â€” not stale read-modify-write.
            await creditUserWin(req.userId, req.zhAmount);
            
            socket.emit('admin:crypto_wd_update', cryptoWdState.filter(w => w.status === 'pending'));
            console.log(`[Admin] Wd ${wdId} rejected and refunded by ${socket.data.userId}`);
        }
    });

    // ============================================================
    // ADMIN PANEL SOCKET HANDLERS
    // ============================================================

    // Notify admin clients on connect if they are admin
    socket.on('admin:identify', () => {
        // isAdminMod was set during player:identify via the server-stored userId.
        if (!socket.isAdminMod) return;
        socket.emit('admin:auth_success');
        console.log(`[Admin] Admin connected: userId=${socket.data.userId}`);
    });
    
    // Provide a list of live online players to admins
    socket.on('admin:get_online_users', () => {
        if (!socket.isAdminMod) {
            socket.emit('admin:online_users_list', []);
            return;
        }
        const users = Array.from(onlinePlayers.values()).map((p) => ({
            userId: p.userId,
            username: p.username
        }));
        socket.emit('admin:online_users_list', users);
    });

    socket.on('admin:lookup_user', async ({ query }) => {
        if (!socket.isAdminMod) {
            socket.emit('admin:lookup_result', { error: 'Unauthorized.' });
            return;
        }

        let save = null;
        let foundUserId = null;
        const qRaw = String(query || '').trim();
        if (!qRaw) {
            return socket.emit('admin:lookup_result', { error: 'Enter a username or Roblox user ID.' });
        }

        const parsedId = parseInt(qRaw.replace(/\D/g, ''), 10);
        if (!Number.isNaN(parsedId) && parsedId > 0) {
            save = await readAccountJson(parsedId);
            if (save) foundUserId = parsedId;
        }

        if (!save) {
            const qLower = qRaw.toLowerCase();
            const digitsOnly = qRaw.replace(/\D/g, '');
            for (const p of onlinePlayers.values()) {
                const idStr = String(p.userId);
                const nameMatch =
                    p.username && String(p.username).trim().toLowerCase() === qLower;
                const idMatch =
                    idStr === qRaw ||
                    (digitsOnly.length > 0 && idStr.replace(/\D/g, '') === digitsOnly);
                if (!nameMatch && !idMatch) continue;

                const uidNum = parseRobloxNumericId(p.userId);
                if (uidNum != null) {
                    foundUserId = uidNum;
                    save = await readAccountJson(foundUserId);
                }
                if (!save) {
                    save = {
                        robloxUserId: p.userId,
                        username: p.username || qRaw,
                        balance: typeof p.balance === 'number' ? p.balance : 0,
                        balanceZh: typeof p.balanceZh === 'number' ? p.balanceZh : 0,
                        stats: {},
                        isLocalOnly: true
                    };
                    foundUserId = uidNum != null ? uidNum : p.userId;
                }
                break;
            }
        }

        if (!save && supabaseEnabled()) {
            const byName = await findUserIdByAccountProfileUsername(qRaw);
            if (byName != null) {
                foundUserId = byName;
                save = await readAccountJson(foundUserId);
            }
        }

        if (!save) {
            return socket.emit('admin:lookup_result', {
                error:
                    'User not found. On Render: set environment variable SUPABASE_SERVICE_ROLE_KEY (from Supabase Project Settings â†’ API) on this web service so admin search can read profile rows. Never put that key in the frontend.'
            });
        }

        const numericForDb = parseRobloxNumericId(foundUserId);
        if (!save.isLocalOnly && (numericForDb == null || numericForDb <= 0)) {
            return socket.emit('admin:lookup_result', { error: 'User not found.' });
        }

        const rigKey = save.isLocalOnly ? String(save.robloxUserId) : String(numericForDb);
        const rigState = adminRigOverrides.get(rigKey) || 'default';
        const wdCooldownEndsAt = makeWdCooldownEndsAt(save);
        const hasWdCooldown = wdCooldownEndsAt > Date.now();
        const withdrawCooldownMinutes = Math.max(1, Math.round(getWithdrawCooldownMsFromStats(save.stats) / 60000));

        const emitUserId = save.isLocalOnly ? save.robloxUserId : numericForDb;

        socket.emit('admin:lookup_result', {
            userId: emitUserId,
            username: save.username || save.robloxUsername || qRaw,
            balance: save.balance || 0,
            balanceZh: save.balanceZh || 0,
            rigState,
            wdCooldownEndsAt: hasWdCooldown ? wdCooldownEndsAt : 0,
            withdrawCooldownMinutes,
            withdrawAccessRevoked: Boolean(save.stats && save.stats.withdrawAccessRevoked),
            rainAccessRevoked: Boolean(save.stats && save.stats.rainAccessRevoked),
            tipAccessRevoked: Boolean(save.stats && save.stats.tipAccessRevoked),
            isLocalOnly: Boolean(save.isLocalOnly)
        });
    });

    socket.on('admin:set_withdraw_access', async ({ targetUserId, revoked }) => {
        if (!socket.isAdminMod) return;
        const wantRevoke = Boolean(revoked);

        try {
            const save = await readAccountJson(targetUserId);
            if (!save) return socket.emit('admin:action_result', { ok: false, msg: 'User not found.' });
            if (!save.stats) save.stats = {};
            save.stats.withdrawAccessRevoked = wantRevoke;
            await persistAccountSave(targetUserId, save);
            emitBalanceRemoteSync(io, targetUserId, save);
            socket.emit('admin:action_result', {
                ok: true,
                msg: wantRevoke
                    ? `Withdrawal access revoked for user ${targetUserId}.`
                    : `Withdrawal access restored for user ${targetUserId}.`,
                withdrawAccessRevoked: wantRevoke,
                targetUserId: String(targetUserId),
                skipAdminLookup: true
            });
            console.log(`[Admin] ${socket.data.userId || 'Unknown'} set withdrawAccessRevoked=${wantRevoke} for ${targetUserId}`);
        } catch (e) {
            socket.emit('admin:action_result', { ok: false, msg: 'Error updating withdrawal access.' });
        }
    });

    socket.on('admin:set_rain_access', async ({ targetUserId, revoked }) => {
        if (!socket.isAdminMod) return;
        const wantRevoke = Boolean(revoked);

        try {
            const save = await readAccountJson(targetUserId);
            if (!save) return socket.emit('admin:action_result', { ok: false, msg: 'User not found.' });
            if (!save.stats) save.stats = {};
            save.stats.rainAccessRevoked = wantRevoke;
            await persistAccountSave(targetUserId, save);
            emitBalanceRemoteSync(io, targetUserId, save);
            socket.emit('admin:action_result', {
                ok: true,
                msg: wantRevoke
                    ? `Rain access revoked for user ${targetUserId}.`
                    : `Rain access restored for user ${targetUserId}.`,
                rainAccessRevoked: wantRevoke,
                targetUserId: String(targetUserId),
                skipAdminLookup: true
            });
            console.log(`[Admin] ${socket.data.userId || 'Unknown'} set rainAccessRevoked=${wantRevoke} for ${targetUserId}`);
        } catch (e) {
            socket.emit('admin:action_result', { ok: false, msg: 'Error updating rain access.' });
        }
    });

    socket.on('admin:set_tip_access', async ({ targetUserId, revoked }) => {
        if (!socket.isAdminMod) return;
        const wantRevoke = Boolean(revoked);

        try {
            const save = await readAccountJson(targetUserId);
            if (!save) return socket.emit('admin:action_result', { ok: false, msg: 'User not found.' });
            if (!save.stats) save.stats = {};
            save.stats.tipAccessRevoked = wantRevoke;
            await persistAccountSave(targetUserId, save);
            emitBalanceRemoteSync(io, targetUserId, save);
            socket.emit('admin:action_result', {
                ok: true,
                msg: wantRevoke
                    ? `Tip access revoked for user ${targetUserId}.`
                    : `Tip access restored for user ${targetUserId}.`,
                tipAccessRevoked: wantRevoke,
                targetUserId: String(targetUserId),
                skipAdminLookup: true
            });
            console.log(`[Admin] ${socket.data.userId || 'Unknown'} set tipAccessRevoked=${wantRevoke} for ${targetUserId}`);
        } catch (e) {
            socket.emit('admin:action_result', { ok: false, msg: 'Error updating tip access.' });
        }
    });

    socket.on('admin:update_balance', async ({ targetUserId, newBalance, newBalanceZh }) => {
        if (!socket.isAdminMod) return;

        try {
            const tid = parseRobloxNumericId(targetUserId);
            if (tid == null || tid <= 0) {
                return socket.emit('admin:action_result', { ok: false, msg: 'Invalid user id.' });
            }

            let save = await readAccountJson(tid);
            if (!save) {
                let inMem = null;
                for (const p of onlinePlayers.values()) {
                    const pid = parseRobloxNumericId(p.userId);
                    if (pid === tid || String(p.userId) === String(targetUserId)) {
                        inMem = p;
                        break;
                    }
                }
                if (inMem) {
                    save = {
                        ...inMem,
                        robloxUserId: tid,
                        balance: typeof inMem.balance === 'number' ? inMem.balance : 0,
                        balanceZh: typeof inMem.balanceZh === 'number' ? inMem.balanceZh : 0,
                        isLocalOnly: true
                    };
                } else {
                    return socket.emit('admin:action_result', { ok: false, msg: 'User not found in DB or online.' });
                }
            }

            if (typeof newBalance === 'number' && newBalance >= 0) save.balance = newBalance;
            if (typeof newBalanceZh === 'number' && newBalanceZh >= 0) save.balanceZh = newBalanceZh;

            if (supabaseEnabled()) {
                if (!save.isLocalOnly) {
                    const persistRes = await persistAccountSave(tid, save);
                    if (!persistRes.ok) {
                        return socket.emit('admin:action_result', {
                            ok: false,
                            msg: `Database save failed (${persistRes.step || 'unknown'}): ${persistRes.detail || 'check Render logs & Supabase RLS'}.`,
                            targetUserId: String(tid),
                            skipAdminLookup: true
                        });
                    }
                } else {
                    // Was skipping persist for "local only" users — balance never hit Supabase, so games saw no row / errors.
                    const balRes = await updateUserBalance(tid, num(save.balance, 0), num(save.balanceZh, 0));
                    if (!balRes.ok) {
                        return socket.emit('admin:action_result', {
                            ok: false,
                            msg: `Could not write balance (${balRes.step || 'unknown'}): ${balRes.detail || 'check SUPABASE_SERVICE_ROLE_KEY and user_balances policies'}.`,
                            targetUserId: String(tid),
                            skipAdminLookup: true
                        });
                    }
                }
            }

            emitBalanceRemoteSync(io, tid, save);

            socket.emit('admin:action_result', {
                ok: true,
                msg: `Balance updated: RoBet ${Number(save.balance).toFixed(2)}`,
                targetUserId: String(tid),
                skipAdminLookup: true
            });
            console.log(`[Admin] ${socket.data.userId || 'Unknown'} set balance of ${tid} to RoBet ${save.balance}`);
        } catch (e) {
            socket.emit('admin:action_result', { ok: false, msg: 'Error updating balance.' });
        }
    });

    socket.on('admin:set_rig', ({ targetUserId, rigMode }) => {
        if (!socket.isAdminMod) return;
        const validModes = ['win', 'lose', 'default'];
        if (!validModes.includes(rigMode)) return;

        const tid = String(targetUserId);
        if (rigMode === 'default') {
            adminRigOverrides.delete(tid);
        } else {
            adminRigOverrides.set(tid, rigMode);
        }

        socket.emit('admin:action_result', {
            ok: true,
            msg: `Rig set to "${rigMode}" for user ${tid}.`,
            rigState: rigMode,
            targetUserId: tid,
            skipAdminLookup: true
        });
        console.log(`[Admin] ${socket.data.userId || 'Unknown'} set rig of ${tid} to ${rigMode}`);
    });

    socket.on('admin:set_wd_cooldown', async ({ targetUserId, action, durationMinutes }) => {
        // action: 'set' = apply cooldown now for durationMinutes (default 30), 'clear' = remove active cooldown
        if (!socket.isAdminMod) return;

        try {
            const save = await readAccountJson(targetUserId);
            if (!save) return socket.emit('admin:action_result', { ok: false, msg: 'User not found.' });
            if (!save.stats) save.stats = {};

            if (action === 'set') {
                let mins =
                    typeof durationMinutes === 'number' && Number.isFinite(durationMinutes)
                        ? durationMinutes
                        : 30;
                mins = Math.min(Math.max(1, mins), 60 * 24 * 7);
                save.stats.withdrawCooldownMs = Math.round(mins * 60 * 1000);
                save.stats.lastWithdrawAt = Date.now();
                await persistAccountSave(targetUserId, save);
                emitBalanceRemoteSync(io, targetUserId, save);
                const endsAt = makeWdCooldownEndsAt(save);
                socket.emit('admin:action_result', {
                    ok: true,
                    msg: `Withdrawal cooldown (${mins} min) applied to user ${targetUserId}.`,
                    wdCooldownEndsAt: endsAt > Date.now() ? endsAt : 0,
                    withdrawCooldownMinutes: mins,
                    targetUserId: String(targetUserId),
                    skipAdminLookup: true
                });
            } else if (action === 'clear') {
                save.stats.lastWithdrawAt = 0;
                await persistAccountSave(targetUserId, save);
                emitBalanceRemoteSync(io, targetUserId, save);
                socket.emit('admin:action_result', {
                    ok: true,
                    msg: `Withdrawal cooldown cleared for user ${targetUserId}.`,
                    wdCooldownEndsAt: 0,
                    targetUserId: String(targetUserId),
                    skipAdminLookup: true
                });
            }
        } catch (e) {
            socket.emit('admin:action_result', { ok: false, msg: 'Error updating withdrawal cooldown.' });
        }
    });

    socket.on('admin:tournaments_list', () => {
        if (!socket.isAdminMod) return;
        socket.emit('admin:tournaments_data', { tournaments: tournamentsState.list });
    });

    socket.on('admin:tournament_create', ({ title, metric, prizePool, prizeCurrency, durationDays }) => {
        if (!socket.isAdminMod) return;
        if (!VALID_TOURNAMENT_METRICS.has(String(metric))) {
            return socket.emit('admin:action_result', { ok: false, msg: 'Invalid metric.' });
        }
        const pool = Number(prizePool);
        if (!Number.isFinite(pool) || pool <= 0) {
            return socket.emit('admin:action_result', { ok: false, msg: 'Prize pool must be a positive number.' });
        }
        const days = Number(durationDays);
        if (!Number.isFinite(days) || days < 1 || days > 60) {
            return socket.emit('admin:action_result', { ok: false, msg: 'Duration must be between 1 and 60 days.' });
        }
        const pc = prizeCurrency === 'zh' ? 'zh' : 'zr';
        const startsAt = Date.now();
        const endsAt = startsAt + Math.round(days * 86400000);
        const id = `t_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const tour = {
            id,
            title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Tournament',
            metric: String(metric),
            prizePool: pool,
            prizeCurrency: pc,
            startsAt,
            endsAt,
            status: 'active',
            participants: {},
            createdAt: startsAt
        };
        tournamentsState.list.push(tour);
        saveTournamentsSync();
        broadcastTournamentsUpdate();
        socket.emit('admin:action_result', {
            ok: true,
            msg: `Tournament "${tour.title}" created â€” ends ${new Date(endsAt).toLocaleString()}.`,
            skipAdminLookup: true
        });
        socket.emit('admin:tournaments_data', { tournaments: tournamentsState.list });
    });

    socket.on('admin:tournament_finalize', async ({ tournamentId }) => {
        if (!socket.isAdminMod) return;
        const r = await finalizeTournamentById(String(tournamentId || ''));
        let msg = r.msg || '';
        if (r.ok && r.winners && r.winners.length) {
            const cur = tournamentsState.list.find((x) => x.id === String(tournamentId));
            const curLabel = cur && cur.prizeCurrency === 'zh' ? 'ZH$' : 'RoBet';
            msg = `Finalized: ${r.winners.length} winner(s), top score ${r.topScore}. Each received ${r.winners[0].prize} ${curLabel}.`;
        } else if (r.ok && !msg) {
            msg = 'Tournament finalized.';
        } else if (!r.ok) {
            msg = r.msg || 'Finalize failed.';
        }
        socket.emit('admin:action_result', {
            ok: r.ok,
            msg,
            skipAdminLookup: true
        });
        socket.emit('admin:tournaments_data', { tournaments: tournamentsState.list });
    });

    socket.on('admin:tournament_cancel', ({ tournamentId }) => {
        if (!socket.isAdminMod) return;
        const tid = String(tournamentId || '');
        const t = tournamentsState.list.find((x) => x.id === tid);
        if (!t || t.status !== 'active') {
            return socket.emit('admin:action_result', { ok: false, msg: 'Tournament not found or already closed.' });
        }
        t.status = 'cancelled';
        t.cancelledAt = Date.now();
        saveTournamentsSync();
        broadcastTournamentsUpdate();
        socket.emit('admin:action_result', { ok: true, msg: 'Tournament cancelled (no prizes sent).', skipAdminLookup: true });
        socket.emit('admin:tournaments_data', { tournaments: tournamentsState.list });
    });

    socket.on('disconnect', () => {
        onlinePlayers.delete(socket.id);
        io.emit('online:count', baseFakeCount + io.engine.clientsCount);
        console.log(`[Socket] Client disconnected: ${socket.id}`);
    });

    socket.on('admin:ban_user', async ({ targetUserId, reason, durationHours, ipBan }) => {
        if (!socket.isAdminMod) return;

        // PREVENTION: Cannot ban an administrator
        if (ADMIN_IDS.includes(String(targetUserId))) {
            return socket.emit('admin:action_result', { ok: false, msg: "Cannot ban an administrator." });
        }
        
        const now = Date.now();
        const until = (typeof durationHours === 'number' && durationHours > 0) ? now + (durationHours * 60 * 60 * 1000) : null;
        const banReason = (reason && String(reason).trim().length > 0) ? String(reason).trim() : 'Rule violation.';
        const durationText = until ? `${durationHours} hour(s)` : 'Permanent';

        let targetIp = null;
        let targetName = `ID ${targetUserId}`;

        // Attempt to find user in onlinePlayers for IP and Username
        for (const [sid, p] of onlinePlayers.entries()) {
            if (String(p.userId) === String(targetUserId)) {
                targetName = p.username || targetName;
                const sock = io.sockets.sockets.get(sid);
                if (sock) targetIp = sock.handshake.address;
                break;
            }
        }

        // If not online, try to find in Supabase/Disk for Username
        if (targetName.startsWith('ID ') && supabaseEnabled()) {
            try {
                const save = await readAccountJson(targetUserId);
                if (save && save.username) targetName = save.username;
            } catch (e) {}
        }
        
        // Remove existing to replace
        bansState.accounts = bansState.accounts.filter(b => String(b.userId) !== String(targetUserId));
        bansState.accounts.push({
            userId: String(targetUserId),
            username: targetName, // Store for easy reference in UI
            reason: banReason,
            until: until,
            createdAt: now
        });
        
        if (ipBan && targetIp) {
            bansState.ips = bansState.ips.filter(b => b.ip !== targetIp);
            bansState.ips.push({
                ip: targetIp,
                reason: banReason,
                until: until,
                createdAt: now
            });
        }
        
        saveBansSync();
        
        // Discord Notification
        const webhookMsg = `🔨 **Ban Issued**\n**Player:** ${targetName} (${targetUserId})\n**Reason:** ${banReason}\n**Duration:** ${durationText}${ipBan && targetIp ? `\n**IP:** ${targetIp} (BANNED)` : ''}\n**By admin:** ${socket.data.userId || 'Unknown'}`;
        sendDiscordWebhook(webhookMsg);
        
        // Actively boot the user
        for (const [sid, p] of onlinePlayers.entries()) {
            if (String(p.userId) === String(targetUserId) || (ipBan && targetIp && io.sockets.sockets.get(sid) && io.sockets.sockets.get(sid).handshake.address === targetIp)) {
                const sock = io.sockets.sockets.get(sid);
                if (sock) {
                    sock.emit('notification', {type: 'error', text: 'You have been banned.\nReason: ' + banReason});
                    setTimeout(() => sock.disconnect(true), 500);
                }
            }
        }
        
        socket.emit('admin:action_result', {
            ok: true,
            msg: `User ${targetName} has been banned.` + (ipBan && targetIp ? ` (IP ${targetIp} banned)` : '')
        });
        socket.emit('admin:bans_list', bansState);
    });

    socket.on('admin:unban_user', ({ targetUserId, targetIp }) => {
        if (!socket.isAdminMod) return;
        
        let changed = false;
        let details = [];

        if (targetUserId) {
            const before = bansState.accounts.length;
            const target = bansState.accounts.find(b => String(b.userId) === String(targetUserId));
            const name = target ? (target.username || targetUserId) : targetUserId;
            
            bansState.accounts = bansState.accounts.filter(b => String(b.userId) !== String(targetUserId));
            if (before !== bansState.accounts.length) {
                changed = true;
                details.push(`Account ID: ${targetUserId} (${name})`);
            }
        }
        if (targetIp) {
             const before = bansState.ips.length;
             bansState.ips = bansState.ips.filter(b => String(b.ip) !== String(targetIp));
             if (before !== bansState.ips.length) {
                 changed = true;
                 details.push(`IP: ${targetIp}`);
             }
        }
        
        if (changed) {
            saveBansSync();
            sendDiscordWebhook(`🔨 **Unban Issued**\n**Targets:** ${details.join(', ')}\n**By admin:** ${socket.data.userId || 'Unknown'}`);
        }
        
        socket.emit('admin:action_result', {
            ok: true,
            msg: `Unbanned successfully.`
        });
        socket.emit('admin:bans_list', bansState);
    });

    socket.on('admin:get_bans', () => {
        if (!socket.isAdminMod) return;
        socket.emit('admin:bans_list', bansState);
    });

    // REMOVED: Duplicate disconnect handler (the primary one is at line ~4344)
    // The duplicate was emitting a different online count formula, causing inconsistencies.

    // Client may emit identify before handlers attach or before login state loads; ask again once connection is fully wired.
    setImmediate(() => {
        try {
            socket.emit('presence:please_identify');
        } catch (_) {}
    });
});


// ======================================================================
// CASE BATTLES SYSTEM
// ======================================================================

/** Inline SVG data URLs — no photo backgrounds; icons sit cleanly on UI surfaces. */
function caseSvgDataUrl(svg) {
    const min = svg.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><').trim();
    return 'data:image/svg+xml,' + encodeURIComponent(min);
}

function caseNormalizeHex(c) {
    const s = String(c || '#64748b').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
        return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    }
    return '#64748b';
}

/** Dark theme hexes need a lighter stroke or the art disappears on navy cards. */
function caseStrokeForUi(hex) {
    const h = caseNormalizeHex(hex).slice(1);
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum < 0.22) return '#94a3b8';
    return caseNormalizeHex(hex);
}

function caseHashStr(s) {
    let h = 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function buildCaseCoverDataUrl(hex, caseId) {
    const c = caseStrokeForUi(hex);
    const v = caseHashStr(caseId) % 4;
    let inner = '';
    if (v === 0) {
        inner = `<path d="M50 8 L88 36 L72 88 L28 88 L12 36 Z" stroke="${c}" stroke-width="2.6" fill="none" stroke-linejoin="round"/><path d="M50 8 L50 52 M12 36 L88 36 M28 88 L72 12 M72 88 L28 12" stroke="${c}" stroke-width="1.1" opacity="0.45"/>`;
    } else if (v === 1) {
        inner = `<rect x="18" y="22" width="64" height="56" rx="7" stroke="${c}" stroke-width="2.6" fill="none"/><path d="M18 42h64M50 22v18" stroke="${c}" stroke-width="2"/><rect x="36" y="48" width="28" height="18" rx="3" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="1.2"/>`;
    } else if (v === 2) {
        inner = `<circle cx="50" cy="50" r="28" stroke="${c}" stroke-width="2.6" fill="none"/><circle cx="50" cy="50" r="15" stroke="${c}" stroke-width="1.4" fill="none" opacity="0.7"/><ellipse cx="50" cy="50" rx="36" ry="11" stroke="${c}" stroke-width="1.1" fill="none" opacity="0.38" transform="rotate(-22 50 50)"/>`;
    } else {
        inner = `<path d="M50 6 L63 38 L94 42 L68 58 L74 92 L50 72 L26 92 L32 58 L6 42 L37 38 Z" stroke="${c}" stroke-width="2.2" fill="none" stroke-linejoin="round"/><path d="M50 6 V72 M37 38 L63 58 M6 42 L94 42" stroke="${c}" stroke-width="1" opacity="0.35"/>`;
    }
    return caseSvgDataUrl(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">${inner}</svg>`
    );
}

/**
 * All case prize rows (every item in every case), sorted by in-game value ascending
 * (then case id, then item id), are mapped 1:1 onto this ladder. Names match Roblox
 * catalog titles; images are filled from the thumbnails API at startup.
 * Low RoBet rewards use cheaper/free catalog items; high RoBet rewards use famous limiteds.
 */
const CASE_ROBLOX_CATALOG_LADDER_ASC = [
    { assetId: 48474313, name: 'Red Roblox Cap' },
    { assetId: 63690008, name: 'Pal Hair' },
    { assetId: 417457461, name: "ROBLOX 'R' Baseball Cap" },
    { assetId: 376548738, name: 'Brown Charmer Hair' },
    { assetId: 451221329, name: 'True Blue Hair' },
    { assetId: 62234425, name: 'Brown Hair' },
    { assetId: 451220849, name: 'Lavender Updo' },
    { assetId: 376524487, name: 'Blonde Spiked Hair' },
    { assetId: 376526673, name: 'Stylish Aviators' },
    { assetId: 376527500, name: 'Orange Shades' },
    { assetId: 6340227, name: 'Trim' },
    { assetId: 1374269, name: 'Kitty Ears' },
    { assetId: 1744068302, name: 'Distressed Jeans' },
    { assetId: 7074764, name: 'Chill' },
    { assetId: 583722751, name: '[+] Control' },
    { assetId: 121946387, name: "Bombo's Survival Knife" },
    { assetId: 11999247, name: 'Subspace Tripmine' },
    { assetId: 122278207, name: 'Punk Wrist Cuff' },
    { assetId: 30649735, name: 'Magnificent Magenta Paintball Gun' },
    { assetId: 193769809, name: 'Boombox Gear 3.0' },
    { assetId: 86498048, name: 'Man Head' },
    { assetId: 1028606, name: 'Red Baseball Cap' },
    { assetId: 1048037, name: 'Bighead' },
    { assetId: 17450053, name: 'Sinister P.' },
    { assetId: 86494893, name: 'Darksteel Katana of Ancient Illuminators' },
    { assetId: 125013849, name: 'Taxi' },
    { assetId: 67798397, name: 'Annoying Elf: Finsurf' },
    { assetId: 9254254, name: 'Rubber Duckie' },
    { assetId: 1081300, name: 'Golden Crown' },
    { assetId: 151784320, name: 'Doge' },
    { assetId: 139573061, name: 'Frost Guard General Helm' },
    { assetId: 82665932, name: "Overseer's Eye" },
    { assetId: 1365767, name: 'Valkyrie Helm' },
    { assetId: 1029025, name: 'The Classic ROBLOX Fedora' },
    { assetId: 4390891467, name: 'Ice Valkyrie' },
    { assetId: 11748356, name: "Clockwork's Shades" },
    { assetId: 74891470, name: 'Frozen Horns of the Frigid Planes' },
    { assetId: 1285307, name: 'Sparkle Time Fedora' },
    { assetId: 134082579, name: 'Headless Head' },
    { assetId: 31101391, name: 'Dominus Infernus' },
    { assetId: 48545806, name: 'Dominus Frigidus' },
    { assetId: 21070012, name: 'Dominus Empyreus' },
    { assetId: 1285307, name: 'Sparkle Time Fedora' },
    { assetId: 134082579, name: 'Headless Head' },
    { assetId: 31101391, name: 'Dominus Infernus' },
    { assetId: 48545806, name: 'Dominus Frigidus' },
    { assetId: 21070012, name: 'Dominus Empyreus' },
    { assetId: 11748356, name: "Clockwork's Shades" },
    { assetId: 74891470, name: 'Frozen Horns of the Frigid Planes' },
    { assetId: 4390891467, name: 'Ice Valkyrie' },
    { assetId: 1365767, name: 'Valkyrie Helm' },
    { assetId: 1285307, name: 'Sparkle Time Fedora' },
    { assetId: 134082579, name: 'Headless Head' },
    { assetId: 31101391, name: 'Dominus Infernus' },
    { assetId: 48545806, name: 'Dominus Frigidus' },
    { assetId: 21070012, name: 'Dominus Empyreus' },
    { assetId: 21070012, name: 'Dominus Empyreus' }
];

const CASES_DATA_BASE = [
    {
        id: 'starter',
        name: 'Starter Case',
        price: 100,
        image: '',
        color: '#00d2ff',
        items: [
            { id: 'blue_gem', value: 30, chance: 55, rarity: 'common' },
            { id: 'gold_coin', value: 80, chance: 30, rarity: 'uncommon' },
            { id: 'crown', value: 200, chance: 12, rarity: 'rare' },
            { id: 'diamond', value: 500, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'standard',
        name: 'ZephR$ Standard',
        price: 500,
        image: '',
        color: '#a855f7',
        items: [
            { id: 'bronze_shield', value: 100, chance: 40, rarity: 'common' },
            { id: 'silver_sword', value: 250, chance: 30, rarity: 'uncommon' },
            { id: 'hoverboard', value: 700, chance: 20, rarity: 'rare' },
            { id: 'dominus', value: 1500, chance: 8, rarity: 'epic' },
            { id: 'headless', value: 3000, chance: 2, rarity: 'legendary' }
        ]
    },
    {
        id: 'elite',
        name: 'Elite Case',
        price: 2000,
        image: '',
        color: '#ef4444',
        items: [
            { id: 'rare_aura', value: 500, chance: 35, rarity: 'uncommon' },
            { id: 'dragon_scale', value: 1200, chance: 30, rarity: 'rare' },
            { id: 'void_sword', value: 2500, chance: 20, rarity: 'epic' },
            { id: 'elite_crown', value: 5000, chance: 12, rarity: 'legendary' },
            { id: 'eternal_diamond', value: 10000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'lucky',
        name: 'Lucky Flip',
        price: 250,
        image: '',
        color: '#22c55e',
        items: [
            { id: 'nothing', value: 0, chance: 45, rarity: 'common' },
            { id: 'lucky_charm', value: 200, chance: 35, rarity: 'rare' },
            { id: 'golden_ticket', value: 750, chance: 20, rarity: 'legendary' }
        ]
    },
    {
        id: 'amethyst',
        name: 'Amethyst Case',
        price: 45,
        image: '',
        color: '#a855f7',
        items: [
            { id: 'amethyst_shard', value: 15, chance: 50, rarity: 'common' },
            { id: 'purple_band', value: 30, chance: 35, rarity: 'uncommon' },
            { id: 'amethyst_ring', value: 90, chance: 12, rarity: 'rare' },
            { id: 'amethyst_crown', value: 300, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'ruby',
        name: 'Ruby Case',
        price: 150,
        image: '',
        color: '#ef4444',
        items: [
            { id: 'ruby_shard', value: 40, chance: 55, rarity: 'common' },
            { id: 'red_hood', value: 120, chance: 30, rarity: 'uncommon' },
            { id: 'ruby_sword', value: 350, chance: 12, rarity: 'rare' },
            { id: 'ruby_dragon', value: 1200, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'emerald',
        name: 'Emerald Case',
        price: 400,
        image: '',
        color: '#22c55e',
        items: [
            { id: 'emerald_shard', value: 110, chance: 55, rarity: 'common' },
            { id: 'green_band', value: 320, chance: 30, rarity: 'uncommon' },
            { id: 'emerald_blade', value: 1000, chance: 12, rarity: 'rare' },
            { id: 'emerald_dominus', value: 3000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'sapphire',
        name: 'Sapphire Case',
        price: 850,
        image: '',
        color: '#3b82f6',
        items: [
            { id: 'sapphire_shard', value: 250, chance: 50, rarity: 'common' },
            { id: 'blue_hood', value: 600, chance: 35, rarity: 'uncommon' },
            { id: 'sapphire_sword', value: 2000, chance: 12, rarity: 'rare' },
            { id: 'sapphire_dragon', value: 6000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'diamond',
        name: 'Diamond Case',
        price: 1500,
        image: '',
        color: '#e0f2fe',
        items: [
            { id: 'diamond_shard', value: 450, chance: 55, rarity: 'common' },
            { id: 'white_band', value: 1100, chance: 30, rarity: 'uncommon' },
            { id: 'diamond_blade', value: 3500, chance: 12, rarity: 'rare' },
            { id: 'diamond_dominus', value: 12000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'void',
        name: 'Void Case',
        price: 3000,
        image: '',
        color: '#111827',
        items: [
            { id: 'void_dust', value: 800, chance: 55, rarity: 'common' },
            { id: 'dark_hood', value: 2200, chance: 30, rarity: 'uncommon' },
            { id: 'void_scepter', value: 7000, chance: 12, rarity: 'rare' },
            { id: 'void_dragon', value: 20000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'galactic',
        name: 'Galactic Case',
        price: 6500,
        image: '',
        color: '#4c1d95',
        items: [
            { id: 'star_dust', value: 1800, chance: 55, rarity: 'common' },
            { id: 'cosmic_band', value: 4800, chance: 30, rarity: 'uncommon' },
            { id: 'galactic_blade', value: 15000, chance: 12, rarity: 'rare' },
            { id: 'galactic_dominus', value: 45000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'inferno',
        name: 'Inferno Case',
        price: 12000,
        image: '',
        color: '#991b1b',
        items: [
            { id: 'ember', value: 3500, chance: 55, rarity: 'common' },
            { id: 'flame_hood', value: 8500, chance: 30, rarity: 'uncommon' },
            { id: 'inferno_sword', value: 28000, chance: 12, rarity: 'rare' },
            { id: 'inferno_dragon', value: 80000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'divine',
        name: 'Divine Case',
        price: 25000,
        image: '',
        color: '#fef08a',
        items: [
            { id: 'holy_light', value: 7500, chance: 55, rarity: 'common' },
            { id: 'divine_band', value: 19000, chance: 30, rarity: 'uncommon' },
            { id: 'divine_blade', value: 60000, chance: 12, rarity: 'rare' },
            { id: 'divine_dominus', value: 180000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'supreme',
        name: 'ZephR$ Supreme',
        price: 50000,
        image: '',
        color: '#facc15',
        items: [
            { id: 'pure_gold', value: 15000, chance: 55, rarity: 'common' },
            { id: 'supreme_crown', value: 38000, chance: 30, rarity: 'uncommon' },
            { id: 'zephrs_scepter', value: 115000, chance: 12, rarity: 'rare' },
            { id: 'creator_dominus', value: 300000, chance: 3, rarity: 'legendary' }
        ]
    }
];

function buildCasesDataSync() {
    const base = JSON.parse(JSON.stringify(CASES_DATA_BASE));
    const flat = [];
    for (const c of base) {
        for (const it of c.items) {
            flat.push({ c, it, v: it.value, cid: c.id, sid: it.id });
        }
    }
    flat.sort((a, b) => {
        if (a.v !== b.v) return a.v - b.v;
        if (a.cid !== b.cid) return a.cid.localeCompare(b.cid);
        return a.sid.localeCompare(b.sid);
    });
    if (flat.length !== CASE_ROBLOX_CATALOG_LADDER_ASC.length) {
        throw new Error(
            `[Cases] Roblox ladder length ${CASE_ROBLOX_CATALOG_LADDER_ASC.length} !== sorted prizes ${flat.length}`
        );
    }
    flat.forEach((row, i) => {
        const L = CASE_ROBLOX_CATALOG_LADDER_ASC[i];
        row.it.assetId = L.assetId;
        row.it.name = L.name;
        row.it.icon = '';
    });
    for (const c of base) {
        c.image = buildCaseCoverDataUrl(c.color, c.id);
    }
    return base;
}

let CASES_DATA = buildCasesDataSync();

async function fetchRobloxAssetThumbUrlMap(assetIds) {
    const map = new Map();
    const uniq = [...new Set(assetIds.filter((n) => Number.isFinite(n) && n > 0))];
    const CHUNK = 100;
    for (let i = 0; i < uniq.length; i += CHUNK) {
        const chunk = uniq.slice(i, i + CHUNK);
        const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${chunk.join(
            ','
        )}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`;
        try {
            const res = await fetch(url);
            const j = await res.json();
            for (const row of j.data || []) {
                if (row.imageUrl && row.targetId != null) map.set(row.targetId, row.imageUrl);
            }
        } catch (e) {
            console.error('[Cases] Thumbnail batch failed:', e && e.message);
        }
    }
    return map;
}

async function hydrateCaseItemThumbnails() {
    const ids = [];
    for (const c of CASES_DATA) {
        for (const it of c.items) {
            if (it.assetId) ids.push(it.assetId);
        }
    }
    const thumbMap = await fetchRobloxAssetThumbUrlMap(ids);
    for (const c of CASES_DATA) {
        for (const it of c.items) {
            const u = thumbMap.get(it.assetId);
            if (u) it.icon = u;
        }
    }
}


function rollCaseItem(caseData, userId, isBot = false) {
    const items = caseData.items;
    const total = items.reduce((s, i) => s + i.chance, 0);
    const avgValue = Number(caseData && caseData.price) || 0;
    
    let cusForced = false;
    let cusWin = false;
    if (!isBot && userId) {
        const cus = getCusState(userId);
        cusForced = cus.check();
        cusWin = cus.checkWin();
    }

    // Sort items by value so we can bias properly
    const sorted = [...items].sort((a, b) => a.value - b.value);

    let roll;
    if (cusForced) {
        // Force low-value result: pick from bottom 40% by value
        const lowItems = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.4)));
        const lt = lowItems.reduce((s, i) => s + i.chance, 0);
        let r = Math.random() * lt;
        roll = lowItems[lowItems.length - 1];
        for (const item of lowItems) { r -= item.chance; if (r <= 0) { roll = item; break; } }
    } else if (cusWin) {
        // Force high-value result: pick from top 30% by value
        const highItems = sorted.slice(Math.max(0, Math.floor(sorted.length * 0.7)));
        const ht = highItems.reduce((s, i) => s + i.chance, 0);
        let r = Math.random() * ht;
        roll = highItems[highItems.length - 1];
        for (const item of highItems) { r -= item.chance; if (r <= 0) { roll = item; break; } }
    } else {
        // Normal weighted random with a small player-side lift:
        // +4.5 percentage points to "winning-tier" outcomes (value > 0.8x case price).
        const winTier = items.filter((i) => Number(i.value) > avgValue * 0.8);
        const loseTier = items.filter((i) => !(Number(i.value) > avgValue * 0.8));
        const winTierWeight = winTier.reduce((s, i) => s + i.chance, 0);
        const baseWinTierChance = total > 0 ? winTierWeight / total : 0;
        const boostedWinTierChance = Math.max(
            0,
            Math.min(1, baseWinTierChance + (!isBot && userId ? 0.045 : 0))
        );
        const pickWinTier = winTier.length > 0 && Math.random() < boostedWinTierChance;
        const pool = pickWinTier ? winTier : (loseTier.length > 0 ? loseTier : items);
        const poolTotal = pool.reduce((s, i) => s + i.chance, 0) || 1;
        let r = Math.random() * poolTotal;
        roll = pool[pool.length - 1];
        for (const item of pool) { r -= item.chance; if (r <= 0) { roll = item; break; } }
    }

    // Update CUS state
    if (!isBot && userId) {
        const cus = getCusState(userId);
        if (roll.value > avgValue * 1.5) cus.recordWin(true);
        else if (roll.value > avgValue * 0.8) cus.recordWin(false);
        else cus.recordLoss();
    }

    return { ...roll };
}

function battleToClient(b) {
    const c = b.caseData;
    return {
        id: b.id,
        caseId: b.caseId,
        caseName: c.name,
        caseImage: c.image,
        casePrice: c.price,
        rounds: b.rounds,
        mode: b.mode,
        maxPlayers: b.maxPlayers,
        status: b.status,
        players: b.players.map((p) => ({
            userId: p.userId,
            username: p.username,
            isBot: p.isBot,
            total: p.total,
            rolls: p.rolls.map((x) => ({ item: x.item }))
        })),
        winner: b.winner || null,
        isTie: Boolean(b.isTie),
        payoutAmount: typeof b.payoutAmount === 'number' ? b.payoutAmount : 0
    };
}

function serializeCaseBattlesList() {
    return Array.from(caseBattles.values()).map(battleToClient);
}

function caseBattleEntryFee(b) {
    return Math.round(b.caseData.price * b.rounds * 100) / 100;
}

async function startCaseBattleFlow(battleId) {
    if (caseBattleStarting.has(battleId)) return;
    const b = caseBattles.get(battleId);
    if (!b || b.status !== 'waiting' || b.players.length < b.maxPlayers) return;
    caseBattleStarting.add(battleId);
    try {
        b.status = 'active';
        io.emit(`battle:${battleId}:started`, battleToClient(b));
        io.emit('battles:list_update', serializeCaseBattlesList());

        for (let round = 1; round <= b.rounds; round++) {
            const results = [];
            for (const p of b.players) {
                const uidForRoll = p.isBot ? null : parseRobloxNumericId(p.userId);
                const item = rollCaseItem(b.caseData, uidForRoll, p.isBot);
                p.rolls.push({ item, round });
                p.total = Math.round((p.total + (Number(item.value) || 0)) * 100) / 100;
                results.push({ userId: p.userId, item, total: p.total });
            }
            io.emit(`battle:${battleId}:round`, { round, results });
            await new Promise((r) => setTimeout(r, 5600));
        }

        const entry = caseBattleEntryFee(b);
        const humans = b.players.filter((p) => !p.isBot);
        const pot = Math.round(entry * humans.length * 100) / 100;

        const best =
            b.mode === 'crazy'
                ? Math.min(...b.players.map((p) => p.total))
                : Math.max(...b.players.map((p) => p.total));
        const top = b.players.filter((p) => p.total === best);
        const isTie = top.length > 1;
        const winPlayer = isTie ? null : top[0];
        b.status = 'done';
        b.isTie = isTie;
        b.payoutAmount = isTie ? 0 : pot;
        b.winner =
            winPlayer && !winPlayer.isBot
                ? { userId: winPlayer.userId, username: winPlayer.username }
                : winPlayer && winPlayer.isBot
                  ? { userId: winPlayer.userId, username: winPlayer.username }
                  : null;

        if (isTie) {
            for (const p of humans) {
                const u = parseRobloxNumericId(p.userId);
                if (u) await creditUserWin(u, entry);
            }
        } else if (winPlayer && !winPlayer.isBot) {
            const wu = parseRobloxNumericId(winPlayer.userId);
            if (wu) await creditUserWin(wu, pot);
        }

        b.endedAt = Date.now();
        io.emit(`battle:${battleId}:done`, battleToClient(b));
        io.emit('battles:list_update', serializeCaseBattlesList());
    } catch (e) {
        console.error('[CaseBattles] startCaseBattleFlow:', e && e.message);
    } finally {
        caseBattleStarting.delete(battleId);
    }
}

// GET /api/cases â€” all case definitions
app.get('/api/cases', (req, res) => {
    res.json({ cases: CASES_DATA });
});

// POST /api/cases/open â€” solo case opening
app.post('/api/cases/open', express.json(), async (req, res) => {
    const { userId, caseId, sessionToken } = req.body || {};
    const uid = parseRobloxUserIdStrict(userId);
    if (!uid || !caseId) return res.status(400).json({ error: 'Invalid request.' });
    // SECURITY FIX: Validate session token to prevent userId spoofing
    if (!validateSessionToken(uid, sessionToken)) {
        return res.status(403).json({ error: 'Invalid session. Please refresh the page.' });
    }

    const caseData = CASES_DATA.find(c => c.id === caseId);
    if (!caseData) return res.status(404).json({ error: 'Case not found.' });

    await withUserLock(uid, async () => {
        // Check and deduct balance from Supabase
        const bal = await getUserBalance(uid);
        if (!bal) {
            return res.status(503).json({
                error: 'Could not read balance from the database. Check Supabase URL/keys on the server.'
            });
        }
        const currentBalance = bal.balance_zr + (bal.balance_zh || 0);
        if (currentBalance < caseData.price) {
            return res.status(400).json({ error: `Insufficient balance. Need ${caseData.price} RoBet.` });
        }

        const newBalance = Math.round((currentBalance - caseData.price) * 100) / 100;
        const updateResult = await updateUserBalance(uid, newBalance, 0);
        if (!updateResult.ok) return res.status(500).json({ error: 'Could not deduct balance.' });

        // Roll item BEFORE we respond (all server-side, no client can manipulate)
        const item = rollCaseItem(caseData, uid, false);

        // Credit the item value back if it's worth something
        if (item.value > 0) {
            const finalBalance = Math.round((newBalance + item.value) * 100) / 100;
            await updateUserBalance(uid, finalBalance, 0);
            emitBalanceRemoteSync(io, uid, { balance: finalBalance, stats: {} });
            return res.json({ ok: true, item, newBalance: finalBalance });
        }

        emitBalanceRemoteSync(io, uid, { balance: newBalance, stats: {} });
        res.json({ ok: true, item, newBalance });
    });
});

// ----- Case battles (server-authoritative entry, rolls, payouts) -----
app.get('/api/battles', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ battles: serializeCaseBattlesList() });
});

app.post('/api/battles/create', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, caseId, rounds, mode, maxPlayers, sessionToken } = req.body || {};
    const uid = parseRobloxUserIdStrict(userId);
    // SECURITY FIX: Validate session token to prevent userId spoofing
    if (!validateSessionToken(uid, sessionToken)) {
        return res.status(403).json({ error: 'Invalid session. Please refresh the page.' });
    }
    const caseData = CASES_DATA.find((c) => c.id === caseId);
    const r = Math.min(10, Math.max(1, parseInt(String(rounds || 1), 10) || 1));
    const mp = Math.min(8, Math.max(2, parseInt(String(maxPlayers || 2), 10) || 2));
    const m = ['normal', 'crazy', 'team', 'group'].includes(String(mode)) ? String(mode) : 'normal';

    if (!uid || !caseId || !caseData) {
        return res.status(400).json({ error: 'Invalid request.' });
    }
    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Database not configured.' });
    }

    const entryFee = Math.round(caseData.price * r * 100) / 100;

    await withUserLock(uid, async () => {
        const deduct = await deductUserBet(uid, entryFee);
        if (!deduct.ok) {
            return res.status(400).json({ error: deduct.error || 'Could not deduct entry fee.' });
        }
        const id = `b_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const uname = getOnlineUsernameByUserId(uid) || `User${uid}`;
        const battle = {
            id,
            caseId,
            caseData,
            rounds: r,
            mode: m,
            maxPlayers: mp,
            status: 'waiting',
            players: [{ userId: uid, username: uname, isBot: false, total: 0, rolls: [] }],
            creatorUserId: uid,
            winner: null,
            isTie: false,
            payoutAmount: 0,
            endedAt: 0
        };
        caseBattles.set(id, battle);
        emitBalanceRemoteSync(io, uid, { balance: deduct.newBalance, balanceZh: deduct.balanceZh, stats: {} });
        io.emit('battles:list_update', serializeCaseBattlesList());
        res.json({ battle: battleToClient(battle) });
    });
});

app.post('/api/battles/:battleId/join', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const battleId = String(req.params.battleId || '');
    const uid = parseRobloxUserIdStrict(req.body && req.body.userId);
    // SECURITY FIX: Validate session token to prevent userId spoofing
    if (!validateSessionToken(uid, req.body && req.body.sessionToken)) {
        return res.status(403).json({ error: 'Invalid session. Please refresh the page.' });
    }
    const b = caseBattles.get(battleId);

    if (!uid) return res.status(400).json({ error: 'Invalid user.' });
    if (!b || b.status !== 'waiting') return res.status(400).json({ error: 'Battle is not open.' });
    if (b.players.some((p) => String(p.userId) === String(uid))) {
        return res.status(400).json({ error: 'Already in this battle.' });
    }
    if (b.players.length >= b.maxPlayers) return res.status(400).json({ error: 'Battle is full.' });
    if (!supabaseEnabled()) return res.status(503).json({ error: 'Database not configured.' });

    const entryFee = caseBattleEntryFee(b);

    await withUserLock(uid, async () => {
        const deduct = await deductUserBet(uid, entryFee);
        if (!deduct.ok) {
            return res.status(400).json({ error: deduct.error || 'Could not deduct entry fee.' });
        }
        const uname = getOnlineUsernameByUserId(uid) || `User${uid}`;
        b.players.push({ userId: uid, username: uname, isBot: false, total: 0, rolls: [] });
        emitBalanceRemoteSync(io, uid, { balance: deduct.newBalance, balanceZh: deduct.balanceZh, stats: {} });
        io.emit(`battle:${battleId}:update`, battleToClient(b));
        io.emit('battles:list_update', serializeCaseBattlesList());
        if (b.players.length >= b.maxPlayers) {
            void startCaseBattleFlow(battleId);
        }
        res.json({ ok: true, battle: battleToClient(b) });
    });
});

app.post('/api/battles/:battleId/callbot', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const battleId = String(req.params.battleId || '');
    const uid = parseRobloxUserIdStrict(req.body && req.body.userId);
    // SECURITY FIX: Validate session token to prevent userId spoofing
    if (!validateSessionToken(uid, req.body && req.body.sessionToken)) {
        return res.status(403).json({ error: 'Invalid session. Please refresh the page.' });
    }
    const b = caseBattles.get(battleId);

    if (!uid) return res.status(400).json({ error: 'Invalid user.' });
    if (!b || b.status !== 'waiting') return res.status(400).json({ error: 'Battle is not open.' });
    if (String(b.creatorUserId) !== String(uid)) {
        return res.status(403).json({ error: 'Only the host can add bots.' });
    }
    if (b.players.length >= b.maxPlayers) return res.status(400).json({ error: 'Lobby is full.' });

    const botNum = b.players.filter((p) => p.isBot).length + 1;
    const botId = `bot_${battleId.slice(-12)}_${botNum}`;
    b.players.push({
        userId: botId,
        username: `Bot ${botNum}`,
        isBot: true,
        total: 0,
        rolls: []
    });
    io.emit(`battle:${battleId}:update`, battleToClient(b));
    io.emit('battles:list_update', serializeCaseBattlesList());
    if (b.players.length >= b.maxPlayers) {
        void startCaseBattleFlow(battleId);
    }
    res.json({ ok: true, battle: battleToClient(b) });
});

const obfCache = {};
function getObfuscated(filename) {
    if (!obfCache[filename]) {
        try {
            const raw = fs.readFileSync(path.join(ROOT, filename), 'utf8');
            // High-performance obfuscation to completely scramble logic and strings
            const obf = JavaScriptObfuscator.obfuscate(raw, {
                compact: true,
                controlFlowFlattening: false,
                deadCodeInjection: false,
                debugProtection: true,
                debugProtectionInterval: 4000,
                disableConsoleOutput: true,
                stringArray: true,
                stringArrayEncoding: ['base64'],
                stringArrayThreshold: 0.75
            });
            obfCache[filename] = obf.getObfuscatedCode();
        } catch (e) {
            console.error('Error obfuscating ' + filename, e);
            return '';
        }
    }
    return obfCache[filename];
}

app.get(['/', '/index.html'], (req, res) => {
    try {
        if (!obfCache['index.html']) {
            let htmlCtx = fs.readFileSync(path.join(ROOT, 'index.raw.html'), 'utf8');
            htmlCtx = htmlCtx.replace(/<!--[\s\S]*?-->/g, '');
            
            const b64 = Buffer.from(htmlCtx, 'utf8').toString('base64');
            const chunkSz = 200;
            const chunks = [];
            for (let ci = 0; ci < b64.length; ci += chunkSz) {
                chunks.push(b64.substring(ci, ci + chunkSz));
            }
            
            const rawLoaderScript = `
                (function(){
                    const c = ${JSON.stringify(chunks)};
                    setTimeout(function(){
                        try {
                            const r = atob(c.join(''));
                            const u = new Uint8Array(r.length);
                            for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i);
                            const d = new TextDecoder('utf-8').decode(u);
                            document.open();
                            document.write(d);
                            document.close();
                        } catch (e) {
                            document.body.innerHTML = '<div style="color:#ef4444;padding:40px;">[FATAL] SECURE_LOAD_FAILED</div>';
                        }
                    }, 1200);
                })();
            `;
            
            const obfLoader = JavaScriptObfuscator.obfuscate(rawLoaderScript, {
                compact: true,
                controlFlowFlattening: false,
                deadCodeInjection: false,
                debugProtection: true,
                debugProtectionInterval: 4000,
                disableConsoleOutput: true,
                stringArray: true,
                stringArrayEncoding: ['base64'],
                stringArrayThreshold: 0.75
            }).getObfuscatedCode();
            
            obfCache['index.html'] = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>RoBet</title><style>body{margin:0;background:#0f212e;overflow:hidden;font-family:'Inter',sans-serif}@keyframes _0x_spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style></head><body><div id="_0x4d12" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0f212e;z-index:9999999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#00c896;"><svg width="80" height="80" viewBox="0 0 100 100" style="margin-bottom:20px;"><defs><linearGradient id="_0x_grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00c896"/><stop offset="100%" stop-color="#008f6b"/></linearGradient></defs><path d="M20 80 L20 20 L40 20 L70 55 L70 20 L80 20 L80 80 L60 80 L30 45 L30 80 Z" fill="url(#_0x_grad)"/></svg><div style="border:3px solid rgba(0,200,150,0.1);border-top:3px solid #00c896;border-radius:50%;width:40px;height:40px;animation:_0x_spin 1s linear infinite;margin-bottom:20px;"></div><h2 style="margin:0;font-size:24px;letter-spacing:1px;">RoBet</h2><p style="color:#64748b;font-size:14px;margin-top:8px;">Protected Document</p></div><script>${obfLoader}</script></body></html>`;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(obfCache['index.html']);
    } catch (e) {
        console.error('Error serving index.html:', e);
        res.status(500).send('');
    }
});

app.get('/script.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(getObfuscated('script.js'));
});

app.get('/voice.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(getObfuscated('voice.js'));
});

app.get('/style.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    if (!obfCache['style.css']) {
        try {
            let raw = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
            obfCache['style.css'] = raw.replace(/\/\*[\s\S]*?\*\//g, '');
        } catch (e) {
            console.error('Error minifying CSS', e);
            return res.send('');
        }
    }
    res.send(obfCache['style.css']);
});

// SECURITY FIX: Block access to sensitive files before serving static assets.
// express.static(ROOT) would expose server.js, .env, data/, keys.json, etc.
const BLOCKED_STATIC_PATTERNS = [
    /^\/server\.js$/i,
    /^\/\.env$/i,
    /^\/\.git/i,
    /^\/\.gitignore$/i,
    /^\/package\.json$/i,
    /^\/package-lock\.json$/i,
    /^\/keys\.json$/i,
    /^\/keys\.txt$/i,
    /^\/data\//i,
    /^\/methods\//i,
    /^\/api\//i,
    /^\/scripts\//i,
    /^\/scratch\//i,
    /^\/node_modules\//i,
    /^\/diff\.txt$/i,
    /^\/debug\.txt$/i,
    /^\/views\.txt$/i,
    /^\/wq$/i,
    /^\/noblox_index\.txt$/i,
    /^\/nx_api\.txt$/i,
    /^\/test_gp\./i,
    /^\/index\.raw\.html$/i,
    /^\/chat\.js$/i
];
app.use((req, res, next) => {
    const urlPath = decodeURIComponent(req.path);
    for (const pattern of BLOCKED_STATIC_PATTERNS) {
        if (pattern.test(urlPath)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
    }
    next();
});
app.use(express.static(ROOT, { dotfiles: 'deny' }));


hydrateCaseItemThumbnails()
    .then(() => {
        console.log('[Cases] Roblox catalog thumbnails loaded for case items.');
    })
    .catch((e) => {
        console.error('[Cases] Thumbnail hydrate failed (items may lack icons until restart):', e && e.message);
    })
    .finally(() => {
        server.listen(PORT, () => {
            console.log(`Open http://localhost:${PORT}`);
            if (supabaseEnabled()) {
                const sr = Boolean(SUPABASE_SERVICE_ROLE_KEY);
                console.log(
                    `Account data: Supabase (${sr ? 'service_role key present' : 'WARNING: only anon key — set SUPABASE_SERVICE_ROLE_KEY on Render for RLS bypass'})`
                );
                void (async () => {
                    const shape = validateSupabaseUrlShape();
                    if (shape) console.warn('[Supabase] SUPABASE_URL check:', shape);
                    try {
                        const probe = await supabaseFetch('user_balances?select=user_id&limit=1');
                        const snippet = probe.ok ? 'OK' : await readSupabaseErrorBody(probe);
                        console.log(`[Supabase] REST probe GET user_balances → HTTP ${probe.status} ${probe.ok ? snippet : snippet}`);
                    } catch (e) {
                        console.error('[Supabase] REST probe failed:', formatNodeFetchError(e));
                    }
                })();
            } else {
                console.log('Account data: Local JSON only (save/load endpoints available)');
            }
            
            // Webhook Diagnostic
            if (process.env.DISCORD_WEBHOOK_URL) {
                const wh = process.env.DISCORD_WEBHOOK_URL.trim();
                console.log(`[Webhook] Active via .env: ${wh.slice(0, 35)}...${wh.slice(-8)}`);
            } else {
                console.log('[Webhook] Active via fallback logic.');
            }
        });
    });


