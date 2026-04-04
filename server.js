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
const https = require('https');
const express = require('express');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

/** Profile JSON is stored in one synthetic transactions row (type account_profile) so stats/username sync cross-device. */
const PROFILE_REF_ID = 'zephrs_profile';

function supabaseEnabled() {
    return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function supabaseFetch(pathAndQuery, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
    const method = options.method || 'GET';
    const headers = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    const init = { method, headers };
    if (options.body !== undefined) init.body = options.body;
    return fetch(url, init);
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
 * @param {number} userId
 * @param {number} balanceZr
 * @param {number} balanceZh
 * @returns {Promise<boolean>}
 */
async function updateUserBalance(userId, balanceZr, balanceZh) {
    if (!supabaseEnabled()) return false;
    const row = {
        user_id: String(userId),
        balance_zr: balanceZr,
        balance_zh: balanceZh,
        updated_at: new Date().toISOString()
    };
    let res;
    try {
        res = await supabaseFetch(`user_balances?on_conflict=user_id`, {
            method: 'POST',
            headers: {
                Prefer: 'resolution=merge-duplicates'
            },
            body: JSON.stringify(row)
        });
    } catch (e) {
        console.error('updateUserBalance network error:', e && e.message);
        return false;
    }
    if (!res.ok) {
        try {
            console.error('updateUserBalance failed:', res.status, await res.text());
        } catch (_) {}
        return false;
    }
    return true;
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
        type: type || 'deposit',
        status: 'completed',
        game_name: gameName != null ? String(gameName) : '',
        reference_id: null
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
    const id =
        ref.length > 0
            ? ref
            : typeof row.id === 'string' && row.id.length
              ? row.id.slice(0, 8)
              : Math.floor(Math.random() * 0xffffffff)
                    .toString(16)
                    .padStart(8, '0');
    return {
        id,
        desc: typeof row.game_name === 'string' ? row.game_name : '',
        date: formatTxDateFromIso(row.created_at),
        amount: num(row.amount, 0),
        type: typeof row.type === 'string' ? row.type : 'deposit'
    };
}

function clientTxToRow(userId, tx) {
    return {
        user_id: String(userId),
        amount: num(tx.amount, 0),
        currency: 'zr',
        type: typeof tx.type === 'string' ? tx.type : 'deposit',
        status: 'completed',
        game_name: typeof tx.desc === 'string' ? tx.desc : '',
        reference_id: tx.id != null ? String(tx.id) : null
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
 * @returns {Promise<boolean>}
 */
async function persistAccountSave(userId, save) {
    if (!supabaseEnabled()) return false;
    const uid = encodeURIComponent(String(userId));
    const balanceZr = typeof save.balance === 'number' && save.balance >= 0 ? save.balance : 0;
    const balanceZh =
        typeof save.balanceZh === 'number' && save.balanceZh >= 0 ? save.balanceZh : 0;

    const okBal = await updateUserBalance(userId, balanceZr, balanceZh);
    if (!okBal) return false;

    let delRes;
    try {
        delRes = await supabaseFetch(`transactions?user_id=eq.${uid}`, { method: 'DELETE' });
    } catch (e) {
        console.error('persistAccountSave delete txs network error:', e && e.message);
        return false;
    }
    if (!delRes.ok) {
        try {
            console.error('persistAccountSave delete failed:', delRes.status, await delRes.text());
        } catch (_) {}
        return false;
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
            return false;
        }
        if (!insRes.ok) {
            try {
                console.error('persistAccountSave insert txs failed:', insRes.status, await insRes.text());
            } catch (_) {}
            return false;
        }
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
        reference_id: PROFILE_REF_ID
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
        return false;
    }
    if (!profRes.ok) {
        try {
            console.error('persistAccountSave profile failed:', profRes.status, await profRes.text());
        } catch (_) {}
        return false;
    }

    return true;
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
        if (row.type === 'account_profile' && String(row.reference_id) === PROFILE_REF_ID) {
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

const app = express();
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
        const ok = await persistAccountSave(userId, save);
        if (!ok) {
            return res.status(503).json({ error: 'Could not save account. Storage may be unavailable.' });
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('POST /api/account-sync:', e);
        res.status(503).json({ error: 'write failed' });
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
    1783449405: 8,
    1784194501: 7,
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
/** Prevents double-submit; not a daily cap. */
const GAMEPASS_DEPOSIT_MIN_INTERVAL_MS = 2500;
const lastGamepassDepositAt = new Map();

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
            .on('error', () => resolve({ ok: false, status: 502, raw: null }));
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
    const clientSave = body.save;
    if (!userId || userId < 1) {
        return res.status(400).json({ error: 'missing userId' });
    }
    if (!clientSave || typeof clientSave !== 'object' || clientSave.robloxUserId !== userId) {
        return res.status(400).json({ error: 'expected save with matching robloxUserId' });
    }

    const prevAt = lastGamepassDepositAt.get(userId) || 0;
    if (Date.now() - prevAt < GAMEPASS_DEPOSIT_MIN_INTERVAL_MS) {
        return res.status(429).json({
            error: 'Please wait a couple of seconds between deposit verifications.'
        });
    }

    if (!supabaseEnabled()) {
        return res.status(503).json({ error: 'Account storage is not configured or unavailable.' });
    }

    const diskSave = await readAccountJson(userId);

    let save;
    if (!diskSave) {
        save = { ...clientSave };
    } else {
        const diskAt = typeof diskSave.savedAt === 'number' ? diskSave.savedAt : 0;
        const clientAt = typeof clientSave.savedAt === 'number' ? clientSave.savedAt : 0;
        save = diskAt >= clientAt ? { ...diskSave } : { ...clientSave };
        save.robloxUserId = userId;
    }

    mergeFlipIntoBalance(save);

    if (save.gamePassDepositClaimed !== undefined) {
        delete save.gamePassDepositClaimed;
    }

    const gamePassId = parseInt(String(body.gamePassId != null ? body.gamePassId : ''), 10);
    if (!gamePassId || gamePassId < 1) {
        return res.status(400).json({ error: 'missing or invalid gamePassId' });
    }
    const credit = GAME_PASS_CREDIT_BY_ID[gamePassId];
    if (typeof credit !== 'number' || credit < 1) {
        return res.status(400).json({ error: 'That game pass is not enabled for deposits.' });
    }

    const own = await fetchUserOwnsGamePass(userId, gamePassId);
    if (!own.ok) {
        return res.status(502).json({
            error: 'Could not verify with Roblox. Try again in a moment.'
        });
    }
    if (!own.owned) {
        return res.status(400).json({
            error:
                'That game pass was not found on this Roblox account. Buy the selected pass on Roblox, then verify again (it can take a few seconds after purchase).'
        });
    }

    const bal = typeof save.balance === 'number' && save.balance >= 0 ? save.balance : 0;
    save.balance = bal + credit;
    if (typeof save.balanceZh !== 'number' || save.balanceZh < 0) {
        save.balanceZh = 0;
    }
    if (!save.stats || typeof save.stats !== 'object') save.stats = {};
    save.stats.deposited =
        (typeof save.stats.deposited === 'number' ? save.stats.deposited : 0) + credit;
    save.savedAt = Date.now();
    lastGamepassDepositAt.set(userId, save.savedAt);

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
        const ok = await persistAccountSave(userId, save);
        if (!ok) {
            return res.status(503).json({ error: 'Could not save account' });
        }
    } catch (e) {
        console.error('gamepass persist:', e);
        return res.status(503).json({ error: 'Could not save account' });
    }

    res.json({ ok: true, save, credited: credit });
});

app.use(express.static(ROOT));

app.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT}`);
    if (supabaseEnabled()) {
        console.log('Account data: Supabase (user_balances + transactions)');
    } else {
        console.warn('SUPABASE_URL / SUPABASE_ANON_KEY missing — account sync and deposits will return 503.');
    }
});
