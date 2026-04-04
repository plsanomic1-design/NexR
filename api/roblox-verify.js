/**
 * Vercel serverless: POST /api/roblox-verify  body: { "userId": 123, "code": "ABCDEF..." }
 * Checks the user's public profile description contains the code (same as server.js).
 */
const https = require('https');

const VERIFY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VERIFY_CODE_LEN = 12;

function fetchRobloxUserDescription(userId) {
    const id = parseInt(String(userId), 10);
    if (!id || id < 1) return Promise.resolve(null);
    return new Promise((resolve) => {
        https
            .get(
                { hostname: 'users.roblox.com', port: 443, path: `/v1/users/${encodeURIComponent(id)}` },
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
    const upper = code.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
        if (VERIFY_CODE_CHARS.indexOf(upper[i]) === -1) return false;
    }
    return true;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    res.status(200).json({ ok: true });
};
