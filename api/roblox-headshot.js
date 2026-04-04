/**
 * Vercel: GET /api/roblox-headshot?userId=123  → { avatarUrl } (CDN image URL)
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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    const id = parseInt(String(req.query.userId || ''), 10);
    if (!id) return res.status(400).json({ error: 'missing userId' });
    const avatarUrl = await fetchRobloxAvatarHeadshotUrl(id);
    if (!avatarUrl) return res.status(404).json({ error: 'no avatar' });
    res.json({ avatarUrl });
};
