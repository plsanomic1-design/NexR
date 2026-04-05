/**
 * Serves this folder and proxies Roblox username lookup.
 * Browsers cannot call Roblox APIs directly from your site (CORS). This route runs on the server instead.
 *
 * Usage: npm install && npm start
 * Then open http://localhost:8080 (not file://, not a static host without this server).
 *
 * Account data: Supabase (user_balances + transactions). Set SUPABASE_URL and SUPABASE_ANON_KEY.
 * On Render/production, set SUPABASE_SERVICE_ROLE_KEY so the server can read any row (admin search, tips by name).
 * Never expose the service role to the browser — server env only.
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
const { Server } = require('socket.io');

const app = express();
/** Render, Fly, Heroku, etc. sit behind a reverse proxy — required for correct req.ip and WebSocket upgrades */
app.set('trust proxy', 1);

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

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
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
 * Split `total` ZR$ across `count` recipients in whole cents so the sum matches exactly (e.g. 100k / 2 => 50k each).
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
            if (state.winStreak > 2) {
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
            if (isBigWin && Math.random() < 0.142) { 
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
// SERVER-SIDE BET DEDUCTION & WIN CREDIT — prevents multi-tab exploit
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
    const { userId, target, isOver, multi, bet } = req.body;
    // Atomically deduct bet before computing outcome
    const betVal = num(bet, 0);
    if (betVal > 0 && supabaseEnabled()) {
        const deduct = await deductUserBet(userId, betVal);
        if (!deduct.ok) return res.status(400).json({ error: deduct.error });
    }
    let forceLoss = getCusState(userId).check();
    let forceWin = getCusState(userId).checkWin();
    let roll;
    if (forceWin) {
        if (isOver) roll = target + Math.max(0.01, (Math.random() * (99.99 - target)));
        else roll = (Math.random() * target);
        if (roll >= 100) roll = 99.99;
    } else if (forceLoss) {
        if (isOver) roll = (Math.random() * target);
        else {
            roll = target + (Math.random() * (100 - target));
            if (roll >= 100) roll = 99.99;
        }
    } else {
        roll = (Math.random() * 100);
    }
    roll = parseFloat(roll.toFixed(2));
    const win = isOver ? (roll > target) : (roll < target);
    // Credit win (or just sync balance on loss) — all tabs get updated via socket
    if (betVal > 0 && supabaseEnabled()) {
        const winAmount = win ? betVal * num(multi, 1) : 0;
        await creditUserWin(userId, winAmount);
    }
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
    const forceWin = getCusState(userId).checkWin();
    if (forceWin) {
        const edges = [0, rows];
        idx = edges[Math.floor(Math.random() * edges.length)];
        getCusState(userId).recordWin(true);
    } else if (forceLoss) {
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

app.post('/api/game/towers/start', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, rows, width, bombs, bet, diff } = req.body;
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
    activeTowersGames.set(String(userId), { logic, bet: betVal, diff: String(diff || 'easy') });
    res.json({ ok: true });
});

app.post('/api/game/towers/click', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, row, col } = req.body;
    const g = activeTowersGames.get(String(userId));
    if (!g) return res.status(400).json({ error: 'No active game' });
    
    setTimeout(async () => {
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
            // Bet was deducted at start — sync the true balance to all tabs
            if (supabaseEnabled()) await creditUserWin(userId, 0);
        }
        res.json({ isBomb, rowData: logicRow });
    }, Math.floor(Math.random() * 2500));
});

app.post('/api/game/towers/cashout', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, curRow } = req.body;
    const g = activeTowersGames.get(String(userId));
    if (!g) return res.status(400).json({ error: 'No active game' });
    activeTowersGames.delete(String(userId));
    if (g.bet > 0 && curRow > 0 && supabaseEnabled()) {
        const multi = computeTowersMultiplier(g.diff || 'easy', curRow);
        const winAmount = g.bet * multi;
        const result = await creditUserWin(userId, winAmount);
        getCusState(userId).recordWin(multi >= 3.0);
        return res.json({ ok: true, winAmount, multiplier: multi, newBalance: result.newBalance });
    }
    res.json({ ok: true });
});

app.post('/api/game/mines/start', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, bombs, bet } = req.body;
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
    activeMinesGames.set(String(userId), { logic: mGrid, bet: betVal, bombs: nb });
    res.json({ ok: true });
});

app.post('/api/game/mines/click', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, tileIdx } = req.body;
    const g = activeMinesGames.get(String(userId));
    if (!g) return res.status(400).json({ error: 'No active game' });
    
    setTimeout(async () => {
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
            // Bet was deducted at start — sync true balance to all tabs
            if (supabaseEnabled()) await creditUserWin(userId, 0);
        }
        res.json({ isBomb, mGridFull: isBomb ? g.logic : null });
    }, Math.floor(Math.random() * 2500));
});

app.post('/api/game/mines/cashout', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, revealed } = req.body;
    const g = activeMinesGames.get(String(userId));
    if (!g) return res.json({ error: 'No active game' });
    activeMinesGames.delete(String(userId));
    const revealedCount = parseInt(revealed) || 0;
    if (g.bet > 0 && revealedCount > 0 && supabaseEnabled()) {
        const multi = computeMinesMultiplier(g.bombs || 3, revealedCount);
        const winAmount = g.bet * multi;
        const result = await creditUserWin(userId, winAmount);
        getCusState(userId).recordWin(multi >= 3.0);
        return res.json({ logic: g.logic, winAmount, multiplier: multi, newBalance: result.newBalance });
    }
    // No tiles revealed or no bet — just sync balance (loss already deducted at start)
    if (supabaseEnabled()) await creditUserWin(userId, 0);
    res.json({ logic: g.logic });
});

/** Session-restore: check if server still has an active mines game for this user */
app.get('/api/game/mines/status', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const g = activeMinesGames.get(userId);
    res.json({ active: !!g, bombs: g ? g.logic.filter(Boolean).length : 0 });
});

/** Session-restore: re-create server mines game after cold-start, ensuring bombs avoid already-revealed tiles */
app.post('/api/game/mines/restore', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, bombs, revealedTiles } = req.body;
    const uid = String(userId || '').trim();
    if (!uid) return res.status(400).json({ error: 'Missing userId' });
    if (activeMinesGames.has(uid)) return res.json({ ok: true, restored: false });
    const safe = new Set(Array.isArray(revealedTiles) ? revealedTiles.map(Number) : []);
    const nb = Math.min(Math.max(parseInt(bombs) || 3, 1), 24);
    let mGrid = Array(25).fill(false);
    let placed = 0, attempts = 0;
    while (placed < nb && attempts < 20000) {
        attempts++;
        const idx = Math.floor(Math.random() * 25);
        if (!mGrid[idx] && !safe.has(idx)) { mGrid[idx] = true; placed++; }
    }
    activeMinesGames.set(uid, { logic: mGrid });
    res.json({ ok: true, restored: true });
});

/** Session-restore: check if server still has an active towers game for this user */
app.get('/api/game/towers/status', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const g = activeTowersGames.get(userId);
    res.json({ active: !!g });
});

/** Session-restore: re-create server towers game after cold-start */
app.post('/api/game/towers/restore', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, rows, width, bombs } = req.body;
    const uid = String(userId || '').trim();
    if (!uid) return res.status(400).json({ error: 'Missing userId' });
    if (activeTowersGames.has(uid)) return res.json({ ok: true, restored: false });
    const r = parseInt(rows) || 8;
    const w = parseInt(width) || 4;
    const nb = parseInt(bombs) || 1;
    let logic = [];
    for (let row = 0; row < r; row++) {
        let rArr = Array(w).fill(false);
        let placed = 0;
        while (placed < nb) {
            let i = Math.floor(Math.random() * w);
            if (!rArr[i]) { rArr[i] = true; placed++; }
        }
        logic.push(rArr);
    }
    activeTowersGames.set(uid, { logic });
    res.json({ ok: true, restored: true });
});

app.post('/api/game/blackjack/start', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, deck, bet } = req.body;
    const betVal = num(bet, 0);
    if (betVal > 0 && supabaseEnabled()) {
        const deduct = await deductUserBet(userId, betVal);
        if (!deduct.ok) return res.status(400).json({ error: deduct.error });
        emitBalanceRemoteSync(io, parseRobloxNumericId(userId), { balance: deduct.newBalance, balanceZh: deduct.balanceZh, stats: {} });
    }
    let forceLoss = getCusState(userId).check();
    let forceWin = getCusState(userId).checkWin();
    
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
    // Store bet for result endpoint to credit
    activeBlackjackGames.set(String(userId), { bet: betVal });
    res.json({ deck, pHand, dHand });
});

/** Called by client after determining BJ outcome; server credits the win authoritatively. */
app.post('/api/game/blackjack/result', express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { userId, outcome } = req.body;
    // outcome: 'blackjack' | 'win' | 'push' | 'lose' | 'bust'
    const g = activeBlackjackGames.get(String(userId));
    activeBlackjackGames.delete(String(userId));
    if (!g || g.bet <= 0 || !supabaseEnabled()) return res.json({ ok: true });
    let winAmount = 0;
    if (outcome === 'blackjack') {
        winAmount = g.bet * 2.5;
        getCusState(userId).recordWin(true);
    } else if (outcome === 'win') {
        winAmount = g.bet * 2;
        getCusState(userId).recordWin(false);
    } else if (outcome === 'push') {
        winAmount = g.bet; // return stake only
    } else {
        getCusState(userId).recordLoss(); // lose / bust
    }
    const result = await creditUserWin(userId, winAmount);
    res.json({ ok: true, winAmount, newBalance: result.newBalance });
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
        return res.status(200).json({ ok: true, _isDisabled: true });
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
        return res.status(200).json({ ok: true, _isDisabled: true });
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
const crypto = require('crypto');
const processedCryptoPayments = new Set();

app.options('/api/deposit/crypto/create', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/api/deposit/crypto/create', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = req.body || {};
    const userId = parseInt(String(body.userId || ''), 10);
    const currency = String(body.currency || '').toLowerCase();
    const amountZh = parseInt(body.amountZh || 0, 10);
    
    if (!userId || !currency || amountZh < 100) {
        return res.status(400).json({ error: 'Invalid request. Minimum deposit is 100 ZH$.' });
    }
    
    // Exchange rate: 500 ZH$ = 3.50 EUR -> 1 ZH$ = 0.007 EUR
    const eurAmount = parseFloat((amountZh * 0.007).toFixed(2));
    if (eurAmount < 0.5) return res.status(400).json({ error: 'Deposit amount too small for crypto networks.' });
    
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
                price_currency: 'eur',
                pay_currency: currency,
                ipn_callback_url: 'https://' + req.get('host') + '/api/deposit/crypto/webhook',
                order_id: orderId,
                order_description: `ZephR$ Deposit: ${amountZh} ZH$`
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
            order_id: data.order_id
        });
    } catch (e) {
        console.error('NOWPayments Request Error:', e);
        res.status(500).json({ error: 'Internal server error while contacting payment provider' });
    }
});

app.post('/api/deposit/crypto/webhook', express.json(), async (req, res) => {
    const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!ipnSecret) return res.status(500).send('IPN secret not configured');
    
    const sig = req.headers['x-nowpayments-sig'];
    if (!sig) return res.status(400).send('No signature');
    
    // Sort keys before hashing according to NowPayments docs
    const hmac = crypto.createHmac('sha512', ipnSecret);
    hmac.update(JSON.stringify(req.body, Object.keys(req.body).sort()));
    if (sig !== hmac.digest('hex')) {
        return res.status(403).send('Invalid signature');
    }
    
    const { payment_status, order_id, price_amount } = req.body;
    
    // We only credit when payment is completely finished
    if (payment_status === 'finished') {
        const parts = String(order_id).split('_');
        if (parts.length >= 2 && parts[0] === 'deps') {
            const userId = parseInt(parts[1], 10);
            
            if (!processedCryptoPayments.has(order_id)) {
                processedCryptoPayments.add(order_id);
                if (processedCryptoPayments.size > 50000) processedCryptoPayments.clear();
                
                // Reverse calculation: ZH$ = EUR / 0.007
                const zhAmount = Math.round(parseFloat(price_amount) / 0.007);
                
                if (userId && zhAmount > 0 && supabaseEnabled()) {
                    try {
                        const uid = parseRobloxNumericId(userId);
                        const bal = await getUserBalance(uid);
                        if (bal) {
                            const newZh = bal.balance_zh + zhAmount;
                            const result = await updateUserBalance(uid, bal.balance_zr, newZh);
                            if (result.ok) {
                                emitBalanceRemoteSync(io, uid, { balance: bal.balance_zr, balanceZh: newZh, stats: {} });
                                console.log(`Credited ${zhAmount} ZH$ (crypto) to user ${uid}`);
                            }
                        }
                    } catch (e) {
                        console.error('Crypto Webhook DB Error:', e);
                    }
                }
            }
        }
    }
    res.status(200).send('OK');
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

    if (save.stats.withdrawAccessRevoked === true) {
        return res.status(403).json({ error: 'Withdrawal access has been revoked for this account.' });
    }

    const lastWd = save.stats.lastWithdrawAt || 0;
    const cooldownMs = getWithdrawCooldownMsFromStats(save.stats);
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

function processCrashCashout(userId, cashoutMultiplier) {
    const p = crashGame.players.get(String(userId));
    if (!p || p.cashedOut || crashGame.state !== 'running') return false;
    
    p.cashedOut = true;
    p.winAmt = p.bet * cashoutMultiplier;
    
    readAccountJson(userId).then(save => {
        if (save) {
            save.balance += p.winAmt;
            persistAccountSave(userId, save);
            emitBalanceRemoteSync(io, userId, save);
        }
    });

    io.emit('crash:playerCashedOut', { userId: String(userId), multi: cashoutMultiplier, winAmt: p.winAmt });
    return true;
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

/** Push balance + stats to matching socket(s); broadcast only if nobody matched (e.g. not yet identified). */
function emitBalanceRemoteSync(io, rawUserId, save) {
    const stats =
        save && save.stats && typeof save.stats === 'object' ? { ...save.stats } : {};
    const payload = {
        userId: String(rawUserId),
        balance: typeof save.balance === 'number' ? save.balance : 0,
        balanceZh: typeof save.balanceZh === 'number' ? save.balanceZh : 0,
        stats
    };
    let targeted = 0;
    for (const [sid, p] of onlinePlayers.entries()) {
        if (userIdsMatch(p.userId, rawUserId)) {
            const sock = io.sockets.sockets.get(sid);
            if (sock) {
                sock.emit('balance:remote_sync', payload);
                targeted++;
            }
        }
    }
    if (targeted === 0) {
        io.emit('balance:remote_sync', payload);
    }
}

// ----- Tournaments (file-backed; baselines captured on first account sync during window) -----
const TOURNAMENT_METRIC_LABELS = {
    delta_wagered: 'Highest total wagered (ZR$ volume)',
    delta_rain_winnings: 'Highest rain winnings (ZH$)',
    delta_deposited: 'Highest deposited (ZR$)',
    delta_withdrawn: 'Highest withdrawn (ZR$)',
    delta_xp: 'Highest XP gained',
    net_balance: 'Highest net ZR$ gained (balance increase)',
    net_loss: 'Highest ZR$ lost from balance'
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
        console.error('[Tournaments] save failed:', e && e.message);
    }
}

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
        if (t.prizeCurrency === 'zh') {
            save.balanceZh = (typeof save.balanceZh === 'number' ? save.balanceZh : 0) + share;
        } else {
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

loadTournamentsSync();

io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Initial sync
    socket.emit('chat:history', chatHistory.slice(-50));
    socket.emit('rain:active', activeRains);
    socket.emit('coinflip:list', activeFlips);
    socket.emit('tournaments:update', getPublicTournamentsSnapshot());
    io.emit('online:count', io.engine.clientsCount);

    socket.on('player:identify', (data) => {
        if (!data || data.userId == null) return;
        const uid = data.userId;
        const idOk =
            (typeof uid === 'number' && Number.isFinite(uid) && uid > 0) ||
            (typeof uid === 'string' && uid.trim().length > 0);
        if (!idOk) return;
        const nameRaw = typeof data.username === 'string' ? data.username.trim() : '';
        const username = nameRaw || 'Guest';
        onlinePlayers.set(socket.id, {
            userId: uid,
            username,
            balance: data.balance || 0,
            balanceZh: data.balanceZh || 0
        });
    });

    socket.emit('crash:sync_state', {
        state: crashGame.state,
        startTime: crashGame.startTime,
        target: crashGame.state === 'crashed' ? crashGame.target : null,
        players: Array.from(crashGame.players.values())
    });

    socket.on('crash:join', async ({ userId, username, bet, auto }) => {
        if (crashGame.state !== 'starting') return socket.emit('notification', {type: 'error', text: 'Crash has already started!'});
        if (crashGame.players.has(String(userId))) return;
        
        const save = await readAccountJson(userId);
        if (!save || save.balance < bet) return socket.emit('notification', {type: 'error', text: 'Not enough balance!'});
        
        save.balance -= bet;
        await persistAccountSave(userId, save);
        socket.emit('balance:update', { balance: save.balance, balanceZh: save.balanceZh });
        
        crashGame.players.set(String(userId), { userId, username, bet, auto, cashedOut: false, winAmt: 0 });
        io.emit('crash:playerJoined', { userId: String(userId), username, bet });
    });

    socket.on('crash:cashout', ({ userId }) => {
        if (crashGame.state !== 'running') return;
        const p = crashGame.players.get(String(userId));
        if (!p || p.cashedOut) return;
        const elapsed = Date.now() - crashGame.startTime;
        const currentMulti = 1.00 * Math.pow(Math.E, Math.max(0, elapsed) * 0.00006);
        processCrashCashout(userId, currentMulti);
    });

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

            // Find recipient — by numeric ID or username lookup in Supabase
            let recipientId = null;
            const parsedId = parseInt(toTarget);
            if (!isNaN(parsedId) && parsedId > 0) {
                recipientId = parsedId;
            } else {
                recipientId = await findUserIdByAccountProfileUsername(toTarget);
            }

            if (!recipientId || recipientId === fromUserId) {
                return socket.emit('notification', { type: 'error', text: 'Recipient not found!' });
            }

            const recSave = await readAccountJson(recipientId);
            if (!recSave) return socket.emit('notification', { type: 'error', text: 'Recipient wallet not initialized.' });

            // Transfer from main balance
            senderSave.balance -= amount;
            recSave.balance += amount;

            await persistAccountSave(fromUserId, senderSave);
            await persistAccountSave(recipientId, recSave);

            socket.emit('notification', {
                type: 'success',
                text: `Tipped ${formatAmountDisplay(amount)} ZH$ to ${recSave.username || recipientId}!`
            });
            socket.emit('balance:update', { balance: senderSave.balance, balanceZh: senderSave.balanceZh });
            
            io.emit('chat:message', {
                username: 'System',
                text: `${senderSave.username} tipped ${formatAmountDisplay(amount)} ZH$ to ${recSave.username || recipientId}!`,
                createdAt: Date.now()
            });
            
            // Notify the specific recipient so their wallet instantly updates in real-time
            io.emit('tip:received', {
                recipientId: recipientId,
                amount: amount,
                sender: senderSave.username || 'A player'
            });

        } catch (e) {
            console.error('[Tip Error]', e);
            socket.emit('notification', { type: 'error', text: 'An error occurred sending the tip.' });
        }
    });

    // RAIN SYSTEM SVR
    socket.on('rain:create', async ({ userId, amount, duration, minWager }) => {
        if (amount < 10) return;

        const creatorId = parseRobloxUserIdStrict(userId);
        if (creatorId == null) {
            return socket.emit('notification', { type: 'error', text: 'Log in to start a rain.' });
        }

        try {
            const save = await readAccountJson(creatorId);
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
                amount,
                minWager: minWager || 0,
                endsAt: Date.now() + duration * 1000,
                joiners: []
            };

            activeRains.push(rain);
            io.emit('rain:active', activeRains);
            io.emit('chat:message', {
                username: 'System',
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
                        username: 'System',
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
                            username: 'System',
                            text: 'Rain had no valid joiners; refunded to host.',
                            createdAt: Date.now()
                        });
                    } else {
                        const shares = splitAmountEqually(r.amount, payees.length);
                        for (let i = 0; i < payees.length; i++) {
                            const jid = payees[i];
                            const share = shares[i];
                            const js = await loadOrCreateAccountSave(jid);
                            if (!js) {
                                console.error('[Rain] Payout skipped — no account for user', jid);
                                continue;
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
                        }
                        const shareLabel =
                            shares.length > 0
                                ? `${formatAmountDisplay(shares[0])} ZH$ each`
                                : `${formatAmountDisplay(r.amount / payees.length)} ZH$ each`;
                        io.emit('chat:message', {
                            username: 'System',
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

    socket.on('rain:join', ({ rainId, userId }) => {
        const uid = parseRobloxUserIdStrict(userId);
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
        rain.joiners.push(uid);
        socket.emit('rain:join-confirmed', { rainId });
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

    // ============================================================
    // ADMIN PANEL SOCKET HANDLERS
    // ============================================================

    // Notify admin clients on connect if they are admin
    socket.on('admin:identify', ({ userId }) => {
        if (!ADMIN_IDS.includes(String(userId))) return;
        socket.emit('admin:auth_success');
        console.log(`[Admin] Admin connected: userId=${userId}`);
    });
    
    // Provide a list of live online players to admins
    socket.on('admin:get_online_users', ({ adminUserId }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) {
            socket.emit('admin:online_users_list', []);
            return;
        }
        const users = Array.from(onlinePlayers.values()).map((p) => ({
            userId: p.userId,
            username: p.username
        }));
        socket.emit('admin:online_users_list', users);
    });

    socket.on('admin:lookup_user', async ({ adminUserId, query }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) {
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
                    'User not found. On Render: set environment variable SUPABASE_SERVICE_ROLE_KEY (from Supabase Project Settings → API) on this web service so admin search can read profile rows. Never put that key in the frontend.'
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
            isLocalOnly: Boolean(save.isLocalOnly)
        });
    });

    socket.on('admin:set_withdraw_access', async ({ adminUserId, targetUserId, revoked }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) return;
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
            console.log(`[Admin] ${adminUserId} set withdrawAccessRevoked=${wantRevoke} for ${targetUserId}`);
        } catch (e) {
            socket.emit('admin:action_result', { ok: false, msg: 'Error updating withdrawal access.' });
        }
    });

    socket.on('admin:update_balance', async ({ adminUserId, targetUserId, newBalance, newBalanceZh }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) return;

        try {
            let save = await readAccountJson(targetUserId);
            if (!save) {
                // If they are local-only and online, we can still push a remote sync
                let inMem = null;
                for (const p of onlinePlayers.values()) {
                    if (String(p.userId) === String(targetUserId)) inMem = p;
                }
                if (inMem) {
                    save = { ...inMem, balance: inMem.balance || 0, balanceZh: inMem.balanceZh || 0, isLocalOnly: true };
                } else {
                    return socket.emit('admin:action_result', { ok: false, msg: 'User not found in DB or online.' });
                }
            }

            if (typeof newBalance === 'number' && newBalance >= 0) save.balance = newBalance;
            if (typeof newBalanceZh === 'number' && newBalanceZh >= 0) save.balanceZh = newBalanceZh;
            
            // Only try to physically save if they actually have DB records / configured DB
            if (!save.isLocalOnly) {
                await persistAccountSave(targetUserId, save);
            }

            emitBalanceRemoteSync(io, targetUserId, save);

            socket.emit('admin:action_result', {
                ok: true,
                msg: `Balance updated: ZR$ ${save.balance.toFixed(2)}`,
                targetUserId: String(targetUserId),
                skipAdminLookup: true
            });
            console.log(`[Admin] ${adminUserId} set balance of ${targetUserId} to ZR$${save.balance}`);
        } catch (e) {
            socket.emit('admin:action_result', { ok: false, msg: 'Error updating balance.' });
        }
    });

    socket.on('admin:set_rig', ({ adminUserId, targetUserId, rigMode }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) return;
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
        console.log(`[Admin] ${adminUserId} set rig of ${tid} to ${rigMode}`);
    });

    socket.on('admin:set_wd_cooldown', async ({ adminUserId, targetUserId, action, durationMinutes }) => {
        // action: 'set' = apply cooldown now for durationMinutes (default 30), 'clear' = remove active cooldown
        if (!ADMIN_IDS.includes(String(adminUserId))) return;

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

    socket.on('admin:tournaments_list', ({ adminUserId }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) return;
        socket.emit('admin:tournaments_data', { tournaments: tournamentsState.list });
    });

    socket.on('admin:tournament_create', ({ adminUserId, title, metric, prizePool, prizeCurrency, durationDays }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) return;
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
            msg: `Tournament "${tour.title}" created — ends ${new Date(endsAt).toLocaleString()}.`,
            skipAdminLookup: true
        });
        socket.emit('admin:tournaments_data', { tournaments: tournamentsState.list });
    });

    socket.on('admin:tournament_finalize', async ({ adminUserId, tournamentId }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) return;
        const r = await finalizeTournamentById(String(tournamentId || ''));
        let msg = r.msg || '';
        if (r.ok && r.winners && r.winners.length) {
            const cur = tournamentsState.list.find((x) => x.id === String(tournamentId));
            const curLabel = cur && cur.prizeCurrency === 'zh' ? 'ZH$' : 'ZR$';
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

    socket.on('admin:tournament_cancel', ({ adminUserId, tournamentId }) => {
        if (!ADMIN_IDS.includes(String(adminUserId))) return;
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
        io.emit('online:count', io.engine.clientsCount);
        console.log(`[Socket] Client disconnected: ${socket.id}`);
    });

    // Client may emit identify before handlers attach or before login state loads; ask again once connection is fully wired.
    setImmediate(() => {
        try {
            socket.emit('presence:please_identify');
        } catch (_) {}
    });
});

app.use(express.static(ROOT));

server.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT}`);
    if (supabaseEnabled()) {
        console.log(
            `Account data: Supabase (${SUPABASE_SERVICE_ROLE_KEY ? 'service_role (recommended on Render)' : 'anon key'} — user_balances + transactions)`
        );
    } else {
        console.log('Account data: Local JSON only (save/load endpoints available)');
    }
});
