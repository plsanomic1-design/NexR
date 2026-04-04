/**
 * Vercel: POST /api/gamepass-deposit-claim
 * body: { userId, save, gamePassId } — credits ZR$ when Roblox reports ownership of that pass (whitelist).
 */
const https = require('https');
const fs = require('fs').promises;
const path = require('path');

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

function formatTxDateServer() {
    const d = new Date();
    const str = d.toDateString();
    return str.substring(0, 10) + ' ' + d.getFullYear() + ' ' + d.toTimeString().substring(0, 5);
}

async function readAccountFile(DATA_DIR, userId) {
    try {
        const raw = await fs.readFile(path.join(DATA_DIR, `${userId}.json`), 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};
    const userId = parseInt(String(body.userId != null ? body.userId : ''), 10);
    const clientSave = body.save;
    if (!userId || userId < 1) {
        return res.status(400).json({ error: 'missing userId' });
    }
    if (!clientSave || typeof clientSave !== 'object' || clientSave.robloxUserId !== userId) {
        return res.status(400).json({ error: 'expected save with matching robloxUserId' });
    }

    const gamePassId = parseInt(String(body.gamePassId != null ? body.gamePassId : ''), 10);
    if (!gamePassId || gamePassId < 1) {
        return res.status(400).json({ error: 'missing or invalid gamePassId' });
    }
    const credit = GAME_PASS_CREDIT_BY_ID[gamePassId];
    if (typeof credit !== 'number' || credit < 1) {
        return res.status(400).json({ error: 'That game pass is not enabled for deposits.' });
    }

    const prevAt = lastGamepassDepositAt.get(userId) || 0;
    if (Date.now() - prevAt < GAMEPASS_DEPOSIT_MIN_INTERVAL_MS) {
        return res.status(429).json({
            error: 'Please wait a couple of seconds between deposit verifications.'
        });
    }

    const DATA_DIR = path.join(process.cwd(), 'data');
    const diskSave = await readAccountFile(DATA_DIR, userId);

    let save;
    if (!diskSave) {
        save = { ...clientSave };
    } else {
        const diskAt = typeof diskSave.savedAt === 'number' ? diskSave.savedAt : 0;
        const clientAt = typeof clientSave.savedAt === 'number' ? clientSave.savedAt : 0;
        save = diskAt >= clientAt ? { ...diskSave } : { ...clientSave };
        save.robloxUserId = userId;
    }

    if (save.gamePassDepositClaimed !== undefined) {
        delete save.gamePassDepositClaimed;
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
    if (!save.stats || typeof save.stats !== 'object') save.stats = {};
    save.stats.deposited = (typeof save.stats.deposited === 'number' ? save.stats.deposited : 0) + credit;
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
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(path.join(DATA_DIR, `${userId}.json`), JSON.stringify(save), 'utf8');
    } catch (e) {
        return res.status(500).json({ error: 'Could not save account' });
    }

    res.status(200).json({ ok: true, save, credited: credit });
};
