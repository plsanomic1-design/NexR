/**
 * Global chat: MQTT (HiveMQ public broker) when available, plus BroadcastChannel for extra tab sync.
 * No seeded demo messages — history starts empty for each session.
 */
(function () {
    const CHAT_TOPIC = 'games/zephrs_sim_v1/chat';
    const PRESENCE_PREFIX = 'games/zephrs_sim_v1/presence/';
    const MQTT_URL = 'wss://broker.hivemq.com:8884/mqtt';
    const MAX_MSG = 120;
    const PRESENCE_MS = 45000;

    const messagesEl = document.getElementById('chat-messages');
    const inputEl = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const statusEl = document.getElementById('chat-status');
    const onlineNumEl = document.getElementById('chat-online-num');
    const rail = document.getElementById('chat-rail');
    const collapseBtn = document.getElementById('chat-collapse-btn');

    if (!messagesEl || !inputEl || !sendBtn) return;

    const seenIds = new Set();
    const list = [];
    let mqttClient = null;
    let lastSend = 0;
    const clientId = 'bf_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    const presenceMap = new Map();

    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('zephrs_chat_bc') : null;

    function getUser() {
        try {
            if (typeof getZephrsChatUser === 'function') return getZephrsChatUser();
        } catch (e) {}
        return { name: 'Guest', level: 1 };
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function formatTime(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return hh + ':' + mm;
    }

    function avatarUrl(name) {
        return 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + encodeURIComponent(name) + '&backgroundColor=2c2f4a';
    }

    function trimList() {
        while (list.length > MAX_MSG) {
            const old = list.shift();
            if (old && old.id) seenIds.delete(old.id);
            const first = messagesEl.firstElementChild;
            if (first) first.remove();
        }
    }

    function appendMessage(msg, scrollBottom) {
        if (!msg || !msg.id || seenIds.has(msg.id)) return;
        seenIds.add(msg.id);
        list.push(msg);

        const row = document.createElement('div');
        row.className = 'chat-msg';
        row.dataset.id = msg.id;

        const u = getUser();
        const isSelf = msg.u === u.name;

        row.innerHTML =
            '<img class="chat-msg-avatar" src="' +
            avatarUrl(msg.u) +
            '" alt="">' +
            '<div class="chat-msg-body">' +
            '<div class="chat-msg-meta">' +
            '<span class="chat-msg-level">' +
            escapeHtml(String(msg.lv || 1)) +
            '</span>' +
            '<span class="chat-msg-name' +
            (isSelf ? ' chat-msg-name--self' : '') +
            '">' +
            escapeHtml(msg.u) +
            '</span>' +
            '<span class="chat-msg-time">' +
            formatTime(msg.ts) +
            '</span>' +
            '</div>' +
            '<div class="chat-msg-text">' +
            escapeHtml(msg.t) +
            '</div>' +
            '</div>';

        messagesEl.appendChild(row);
        trimList();
        if (scrollBottom !== false) {
            messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
        }
    }

    function ingestPayload(str) {
        let data;
        try {
            data = JSON.parse(str);
        } catch (e) {
            return;
        }
        if (!data || !data.id || !data.u || typeof data.t !== 'string') return;
        data.t = data.t.slice(0, 280);
        appendMessage(data);
    }

    function broadcastLocal(msg) {
        if (bc) {
            try {
                bc.postMessage(msg);
            } catch (e) {}
        }
    }

    function publishMqtt(obj) {
        if (mqttClient && mqttClient.connected) {
            try {
                mqttClient.publish(CHAT_TOPIC, JSON.stringify(obj), { qos: 0 });
            } catch (e) {}
        }
    }

    function sendCurrentMessage() {
        const text = (inputEl.value || '').trim();
        if (!text) return;
        const now = Date.now();
        if (now - lastSend < 1500) return;
        lastSend = now;

        const u = getUser();
        const msg = {
            id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'm_' + now + '_' + Math.random().toString(16).slice(2),
            u: u.name,
            lv: u.level,
            t: text,
            ts: now
        };

        inputEl.value = '';
        appendMessage(msg);
        publishMqtt(msg);
        broadcastLocal(msg);
        if (!mqttClient || !mqttClient.connected) {
            try {
                localStorage.setItem('zephrs_chat_ping', String(now));
            } catch (e) {}
        }
    }

    function updateOnlineDisplay() {
        const now = Date.now();
        let n = 0;
        presenceMap.forEach((ts) => {
            if (now - ts < PRESENCE_MS) n++;
        });
        if (onlineNumEl) onlineNumEl.textContent = String(Math.max(1, n));
    }

    function publishPresence() {
        const payload = JSON.stringify({ ts: Date.now(), cid: clientId });
        if (mqttClient && mqttClient.connected) {
            try {
                mqttClient.publish(PRESENCE_PREFIX + clientId, payload, { qos: 0, retain: false });
            } catch (e) {}
        }
    }

    function startPresenceLoop() {
        publishPresence();
        setInterval(publishPresence, 15000);
        setInterval(updateOnlineDisplay, 4000);
        setInterval(() => {
            const now = Date.now();
            presenceMap.forEach((ts, id) => {
                if (now - ts > PRESENCE_MS * 2) presenceMap.delete(id);
            });
        }, 20000);
    }

    function onPresencePayload(str) {
        let data;
        try {
            data = JSON.parse(str);
        } catch (e) {
            return;
        }
        if (data && data.cid) presenceMap.set(data.cid, data.ts || Date.now());
        updateOnlineDisplay();
    }

    function initMqtt() {
        if (typeof mqtt === 'undefined') {
            if (statusEl) statusEl.textContent = 'Tab sync only - open via http(s) for global chat';
            updateOnlineDisplay();
            return;
        }

        try {
            mqttClient = mqtt.connect(MQTT_URL, {
                clientId: clientId,
                clean: true,
                reconnectPeriod: 4000,
                connectTimeout: 10000
            });
        } catch (e) {
            mqttClient = null;
            if (statusEl) statusEl.textContent = 'Could not start chat connection';
            return;
        }

        mqttClient.on('connect', () => {
            if (statusEl) statusEl.textContent = 'Connected';
            mqttClient.subscribe(CHAT_TOPIC, { qos: 0 });
            mqttClient.subscribe(PRESENCE_PREFIX + '+', { qos: 0 });
            startPresenceLoop();
        });

        mqttClient.on('message', (topic, payload) => {
            const s = payload.toString();
            if (topic.indexOf(PRESENCE_PREFIX) === 0) {
                onPresencePayload(s);
                return;
            }
            if (topic === CHAT_TOPIC) ingestPayload(s);
        });

        mqttClient.on('error', () => {
            if (statusEl) statusEl.textContent = 'Chat connection error - retrying...';
        });

        mqttClient.on('reconnect', () => {
            if (statusEl) statusEl.textContent = 'Reconnecting...';
        });

        mqttClient.on('offline', () => {
            if (statusEl) statusEl.textContent = 'Offline - tab sync still works';
        });
    }

    if (bc) {
        bc.onmessage = (ev) => {
            if (ev.data && ev.data.id) appendMessage(ev.data);
        };
    }

    window.addEventListener('storage', (e) => {
        if (e.key === 'zephrs_chat_ping' && e.newValue) {
            presenceMap.set('ls_' + e.newValue, Date.now());
            updateOnlineDisplay();
        }
    });

    sendBtn.addEventListener('click', sendCurrentMessage);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCurrentMessage();
        }
    });

    if (collapseBtn && rail) {
        collapseBtn.addEventListener('click', () => {
            rail.classList.toggle('collapsed');
            const collapsed = rail.classList.contains('collapsed');
            collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            collapseBtn.innerHTML = collapsed ? '<i class="fa-solid fa-chevron-left"></i>' : '<i class="fa-solid fa-chevron-right"></i>';
        });
    }

    function boot() {
        initMqtt();
        presenceMap.set(clientId, Date.now());
        updateOnlineDisplay();
        if (statusEl && typeof mqtt === 'undefined') statusEl.textContent = 'Tab sync only - MQTT library missing';
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();

