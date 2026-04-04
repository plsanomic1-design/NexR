/**
 * Vercel serverless: POST /api/roblox-lookup  body: { "username": "..." }
 * Same behavior as server.js — use when the site is deployed on Vercel (no Express).
 */
const https = require('https');

function fetchRobloxAvatarHeadshotUrl(userId) {
    const path = `/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=420x420&format=Png&isCircular=true`;
    return new Promise((resolve) => {
        https
            .get({ hostname: 'thumbnails.roblox.com', port: 443, path }, (robRes) => {
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
            })
            .on('error', () => resolve(null));
    });
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
                    try {
                        const json = JSON.parse(Buffer.concat(chunks).toString());
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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
};
