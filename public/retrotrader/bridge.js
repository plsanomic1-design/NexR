/**
 * RETRO TRADER BRIDGE v6 — "Production-Ready"
 *
 * ActionCable message structure (discovered via debug):
 *   data[0] = Round status {alive, status, waiting_started_at, ...}
 *   data[1] = Player bets []
 *   data[2] = Other players []
 *   data[3] = History [{crashpoint, finished_at, round}, ...]
 *   data[4] = Config {currencies, currency, default_bet, line_bets, max_bet, min_bet}
 *   data[5] = BALANCE {value: <cents>}  ← THIS IS THE BALANCE
 *   data[6] = Chart {current_step, points}
 *
 * Bet confirmation: data[0].changes.bet_cents
 * Win result: data[0].changes[0].win_cents (or data[0].changes.win_cents)
 */
(function() {
    console.log('[Bridge] Retro Trader Bridge v6 Active');

    function findCredentials() {
        try {
            return { id: window.parent.robloxUserId, token: window.parent._sessionToken };
        } catch(e) { return { id: null, token: null }; }
    }

    let creds = findCredentials();
    let robetBalance = null;
    const _fetch = window.fetch.bind(window);

    function exposeBalance() {
        try { window.parent._aviaGameBalance = robetBalance; } catch(e) {}
    }

    // Start session
    (async function() {
        creds = findCredentials();
        if (!creds.id) return;
        try {
            const r = await _fetch('/api/avia/v1/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: creds.id, sessionToken: creds.token })
            });
            const d = await r.json();
            if (typeof d.gameBalance === 'number') {
                robetBalance = d.gameBalance;
                exposeBalance();
            }
            console.log('[Bridge] Session started, robetBalance:', robetBalance);
        } catch(e) { console.error('[Bridge] Init error:', e); }
    })();

    async function syncSpin(bet, win) {
        if (!creds.id) return;
        try {
            const r = await _fetch('/api/avia/v1/spin-sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: creds.id, sessionToken: creds.token, bet, win })
            });
            const d = await r.json();
            if (typeof d.gameBalance === 'number') {
                robetBalance = d.gameBalance;
                exposeBalance();
            }
        } catch(e) {
            const nb = robetBalance - bet + win;
            robetBalance = Math.max(0, Math.round(nb * 100) / 100);
            exposeBalance();
        }
    }

    function replaceFunInString(str) {
        return str
            .replace(/"FUN"/g, '"RBT"')
            .replace(/"fun"/g, '"RBT"')
            .replace(/\bFUN\b/g, 'RBT');
    }

    function deepReplaceFun(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                if (typeof obj[i] === 'string' && (obj[i] === 'FUN' || obj[i] === 'fun')) obj[i] = 'RBT';
                else if (typeof obj[i] === 'object') deepReplaceFun(obj[i]);
            }
            return;
        }
        for (const k of Object.keys(obj)) {
            if (typeof obj[k] === 'string' && (obj[k] === 'FUN' || obj[k] === 'fun')) obj[k] = 'RBT';
            else if (typeof obj[k] === 'object' && obj[k] !== null) deepReplaceFun(obj[k]);
        }
    }

    // BGaming's demo max bet in cents (10,000 RBT = 1,000,000 cents)
    const BGAMING_MAX_BET_CENTS = 1000000;
    // Custom bet limits (in cents) — up to 500k RBT
    const CUSTOM_LINE_BETS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000, 25000000, 50000000];
    let _activeScaleFactor = 1; // tracks current bet's scale factor for win scaling

    /**
     * Process an incoming ActionCable message:
     * - Replace FUN → RBT
     * - Inject our balance into data[n].changes.value
     * - Track bet/win for spin-sync
     * Uses content-based dedup: first handler to process a message tracks
     * financials, second handler seeing the same content skips.
     */
    let _lastTrackedMsg = '';
    let _lastTrackedTime = 0;

    function processMessage(dataStr) {
        // Dedup: if this exact message was already tracked within 50ms, skip financials
        const now = Date.now();
        const shouldTrack = (dataStr !== _lastTrackedMsg || now - _lastTrackedTime > 50);
        if (shouldTrack) {
            _lastTrackedMsg = dataStr;
            _lastTrackedTime = now;
        }

        let modified = replaceFunInString(dataStr);

        try {
            const parsed = JSON.parse(modified);
            deepReplaceFun(parsed);

            // Process ActionCable game channel messages
            if (parsed.message && parsed.message.data && Array.isArray(parsed.message.data)) {
                const msgData = parsed.message.data;

                for (let i = 0; i < msgData.length; i++) {
                    const item = msgData[i];
                    if (!item || !item.changes) continue;

                    const changes = item.changes;

                    // === HANDLE OBJECT changes (balance, bet_cents, config, etc.) ===
                    if (typeof changes === 'object' && !Array.isArray(changes)) {
                        // Balance slot: {value: <cents>}
                        const keys = Object.keys(changes);
                        if (keys.includes('value') && typeof changes.value === 'number' && robetBalance !== null) {
                            const balCents = Math.round(robetBalance * 100);
                            console.log(`[Bridge] 💰 Balance: ${changes.value} → ${balCents} (${robetBalance.toFixed(2)} RBT)`);
                            changes.value = balCents;
                        }

                        // Override bet limits (config slot — has line_bets, max_bet, etc.)
                        if (changes.line_bets || changes.max_bet) {
                            changes.line_bets = CUSTOM_LINE_BETS;
                            changes.max_bet = 50000000; // 500k RBT in cents
                            changes.min_bet = 1000;     // 10 RBT in cents
                            changes.default_bet = 10000; // 100 RBT in cents
                            if (changes.casino_freespin_total_bets) {
                                changes.casino_freespin_total_bets = CUSTOM_LINE_BETS;
                            }
                            console.log('[Bridge] 🎰 Bet limits overridden: 10 - 500,000 RBT');
                        }

                        // Track bet confirmations — scale up if bet was scaled down
                        if (shouldTrack && typeof changes.bet_cents === 'number' && changes.bet_cents > 0) {
                            // Scale the confirmation back up to the real bet
                            const realBetCents = Math.round(changes.bet_cents * _activeScaleFactor);
                            changes.bet_cents = realBetCents; // show real amount in game
                            const betRBT = realBetCents / 100;
                            robetBalance = Math.max(0, robetBalance - betRBT);
                            robetBalance = Math.round(robetBalance * 100) / 100;
                            exposeBalance();
                            console.log(`[Bridge] 📉 Bet: -${betRBT} → balance: ${robetBalance.toFixed(2)}`);
                            syncSpin(betRBT, 0);
                        }

                        // Track win results — scale up if bet was scaled
                        if (shouldTrack && typeof changes.win_cents === 'number' && changes.win_cents > 0) {
                            const realWinCents = Math.round(changes.win_cents * _activeScaleFactor);
                            changes.win_cents = realWinCents;
                            const winRBT = realWinCents / 100;
                            robetBalance += winRBT;
                            robetBalance = Math.round(robetBalance * 100) / 100;
                            exposeBalance();
                            console.log(`[Bridge] 📈 Win: +${winRBT} → balance: ${robetBalance.toFixed(2)}`);
                            syncSpin(0, winRBT);
                        }
                    }

                    // === HANDLE ARRAY changes (win results: [{win_cents: ...}]) ===
                    if (Array.isArray(changes)) {
                        for (const sub of changes) {
                            if (sub && typeof sub === 'object') {
                                if (shouldTrack && typeof sub.win_cents === 'number' && sub.win_cents > 0) {
                                    const realWinCents = Math.round(sub.win_cents * _activeScaleFactor);
                                    sub.win_cents = realWinCents;
                                    const winRBT = realWinCents / 100;
                                    robetBalance += winRBT;
                                    robetBalance = Math.round(robetBalance * 100) / 100;
                                    exposeBalance();
                                    console.log(`[Bridge] 📈 Win: +${winRBT} → balance: ${robetBalance.toFixed(2)}`);
                                    syncSpin(0, winRBT);
                                }
                                // Also check for bet_cents in array items
                                if (shouldTrack && typeof sub.bet_cents === 'number' && sub.bet_cents > 0) {
                                    const betRBT = sub.bet_cents / 100;
                                    robetBalance = Math.max(0, robetBalance - betRBT);
                                    robetBalance = Math.round(robetBalance * 100) / 100;
                                    exposeBalance();
                                    console.log(`[Bridge] 📉 Bet: -${betRBT} → balance: ${robetBalance.toFixed(2)}`);
                                    syncSpin(betRBT, 0);
                                }
                            }
                        }
                    }
                }
            }

            return JSON.stringify(parsed);
        } catch(e) {
            return modified;
        }
    }

    // ============================================================
    // WEBSOCKET INTERCEPT
    // ============================================================
    const _WS = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        console.log('[Bridge WS] Connecting:', url);
        const ws = protocols ? new _WS(url, protocols) : new _WS(url);

        // Track if onmessage has been set to avoid double-firing
        let _userOnMessage = null;
        let _listenerWrapped = false;

        const _addListener = ws.addEventListener.bind(ws);
        ws.addEventListener = function(type, fn, opts) {
            if (type === 'message') {
                const wrappedFn = function(event) {
                    let data = event.data;
                    if (typeof data === 'string') {
                        const modified = processMessage(data);
                        const newEvent = new MessageEvent('message', {
                            data: modified,
                            origin: event.origin,
                            lastEventId: event.lastEventId,
                            source: event.source,
                            ports: event.ports
                        });
                        return fn.call(this, newEvent);
                    }
                    return fn.call(this, event);
                };
                return _addListener(type, wrappedFn, opts);
            }
            return _addListener(type, fn, opts);
        };

        // Intercept onmessage — DON'T re-route through addEventListener to avoid double-fire
        Object.defineProperty(ws, 'onmessage', {
            get: function() { return _userOnMessage; },
            set: function(fn) {
                if (_userOnMessage) {
                    // Remove previous raw listener if any
                }
                _userOnMessage = fn;
                // Set the real onmessage with our wrapper
                Object.getOwnPropertyDescriptor(_WS.prototype, 'onmessage').set.call(ws, function(event) {
                    let data = event.data;
                    if (typeof data === 'string') {
                        const modified = processMessage(data);
                        const newEvent = new MessageEvent('message', {
                            data: modified,
                            origin: event.origin,
                            lastEventId: event.lastEventId,
                            source: event.source,
                            ports: event.ports
                        });
                        return fn.call(this, newEvent);
                    }
                    return fn.call(this, event);
                });
            }
        });

        // Outgoing — block overbets + scale down if exceeding BGaming demo max
        const _wsSend = ws.send.bind(ws);
        ws.send = function(data) {
            if (typeof data === 'string') {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.data && typeof parsed.data === 'string') {
                        const inner = JSON.parse(parsed.data);
                        if (inner.action === 'make_bet' && inner.bet_cents && robetBalance !== null) {
                            const betRBT = inner.bet_cents / 100;
                            if (betRBT > robetBalance + 0.01) {
                                console.warn(`[Bridge] ❌ BLOCKED bet: ${betRBT} > balance ${robetBalance}`);
                                return;
                            }

                            // Scale down if bet exceeds BGaming's demo max
                            if (inner.bet_cents > BGAMING_MAX_BET_CENTS) {
                                _activeScaleFactor = inner.bet_cents / BGAMING_MAX_BET_CENTS;
                                inner.bet_cents = BGAMING_MAX_BET_CENTS;
                                parsed.data = JSON.stringify(inner);
                                data = JSON.stringify(parsed);
                                console.log(`[Bridge] 🔄 Scaled bet: ${betRBT} RBT → ${BGAMING_MAX_BET_CENTS/100} to server (x${_activeScaleFactor.toFixed(2)})`);
                            } else {
                                _activeScaleFactor = 1;
                            }

                            console.log(`[Bridge] ✅ Bet ${betRBT} RBT (balance: ${robetBalance.toFixed(2)})`);
                        }
                    }
                } catch(e) {}
            }
            return _wsSend(data);
        };

        return ws;
    };
    window.WebSocket.CONNECTING = _WS.CONNECTING;
    window.WebSocket.OPEN = _WS.OPEN;
    window.WebSocket.CLOSING = _WS.CLOSING;
    window.WebSocket.CLOSED = _WS.CLOSED;
    window.WebSocket.prototype = _WS.prototype;

    // ============================================================
    // XHR INTERCEPT — translations/rules FUN→RBT
    // ============================================================
    const _XHROpen = XMLHttpRequest.prototype.open;
    const _XHRGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');

    XMLHttpRequest.prototype.open = function(method, url) {
        this._bridgeUrl = url;
        return _XHROpen.apply(this, arguments);
    };

    Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
        get: function() {
            const text = _XHRGetter.get.call(this);
            if (text && typeof text === 'string' && this._bridgeUrl &&
                (this._bridgeUrl.includes('bgaming') || this._bridgeUrl.includes('BInvest'))) {
                if (text.includes('FUN') || text.includes('fun')) return replaceFunInString(text);
            }
            return text;
        }
    });

    const _XHRRespGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    if (_XHRRespGetter && _XHRRespGetter.get) {
        Object.defineProperty(XMLHttpRequest.prototype, 'response', {
            get: function() {
                const resp = _XHRRespGetter.get.call(this);
                if ((this.responseType === '' || this.responseType === 'text') &&
                    resp && typeof resp === 'string' && this._bridgeUrl &&
                    (this._bridgeUrl.includes('bgaming') || this._bridgeUrl.includes('BInvest'))) {
                    if (resp.includes('FUN') || resp.includes('fun')) return replaceFunInString(resp);
                }
                return resp;
            }
        });
    }

    // ============================================================
    // FETCH INTERCEPT — rules JSON FUN→RBT
    // ============================================================
    window.fetch = function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url?.url || '');
        if (urlStr.startsWith('/api/avia/')) return _fetch.apply(window, arguments);
        if (urlStr.includes('bgaming') || urlStr.includes('BInvest')) {
            return _fetch.apply(window, arguments).then(async (response) => {
                const ct = response.headers.get('content-type') || '';
                if (ct.includes('json') || urlStr.endsWith('.json')) {
                    const text = await response.text();
                    return new Response(replaceFunInString(text), {
                        status: response.status, statusText: response.statusText, headers: response.headers
                    });
                }
                return response;
            });
        }
        return _fetch.apply(window, arguments);
    };

    // ============================================================
    // SAVE ON UNLOAD
    // ============================================================
    window.addEventListener('beforeunload', function() {
        if (creds.id && robetBalance !== null) {
            navigator.sendBeacon('/api/avia/v1/session/save', new Blob([
                JSON.stringify({ userId: creds.id, gameBalance: robetBalance, sessionToken: creds.token })
            ], { type: 'application/json' }));
        }
    });
})();
