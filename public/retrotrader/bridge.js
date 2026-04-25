/**
 * RETRO TRADER BRIDGE v8 — "CUS-Integrated (Sync-Safe)"
 *
 * CUS: Single spin-sync per round with both bet+win. Server applies CUS
 * and returns adjustedWin. Balance is always injected from server's
 * authoritative value — self-corrects on every message.
 * Messages are delivered SYNCHRONOUSLY to avoid breaking game state.
 */
(function() {
    console.log('[Bridge] Retro Trader Bridge v8 Active');

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
            if (r.status === 409 || d.error === 'game_active_other_tab') {
                console.warn('[Bridge] Session blocked: game is active in another tab');
                document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a1a;color:#fff;font-family:sans-serif;text-align:center;padding:20px;"><div><div style="font-size:48px;margin-bottom:16px;">&#9888;&#65039;</div><div style="font-size:20px;font-weight:700;margin-bottom:8px;">Game Active in Another Tab</div><div style="font-size:14px;color:rgba(255,255,255,0.6);">Please close the game in your other tab first.</div></div></div>';
                try { window.parent.postMessage({ type: 'bridge_session_blocked' }, '*'); } catch(e) {}
                return;
            }
            if (typeof d.gameBalance === 'number') {
                robetBalance = d.gameBalance;
                exposeBalance();
            }
            console.log('[Bridge] Session started, robetBalance:', robetBalance);
        } catch(e) { console.error('[Bridge] Init error:', e); }
    })();

    // CUS: track pending bet for combined sync
    let _pendingBetRBT = 0;

    /**
     * Sync a complete round (bet + win) to the server (fire-and-forget).
     * Server applies CUS and returns adjustedWin + gameBalance.
     * Balance self-corrects via injection on next message.
     */
    function syncRound(bet, win) {
        if (!creds.id) return;
        _fetch('/api/avia/v1/spin-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: creds.id, sessionToken: creds.token, bet, win })
        }).then(function(r) { return r.json(); }).then(function(d) {
            if (typeof d.gameBalance === 'number') {
                robetBalance = d.gameBalance;
                exposeBalance();
                console.log('[Bridge] Server sync → balance: ' + robetBalance.toFixed(2) +
                    (d.cusApplied ? ' (CUS: adjustedWin=' + d.adjustedWin + ')' : ''));
            }
        }).catch(function(e) {
            console.warn('[Bridge] spin-sync failed:', e);
        });
    }

    function replaceFunInString(str) {
        return str.replace(/"FUN"/g, '"RBT"').replace(/"fun"/g, '"RBT"').replace(/\bFUN\b/g, 'RBT');
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

    // BGaming's ACTUAL demo max bet for Retro Trader (1,000 RBT = 100,000 cents)
    const BGAMING_MAX_BET_CENTS = 100000;
    const CUSTOM_LINE_BETS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000, 25000000, 50000000];
    let _activeScaleFactor = 1;

    let _lastTrackedMsg = '';
    let _lastTrackedTime = 0;

    function processMessage(dataStr) {
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

            if (parsed.message && parsed.message.data && Array.isArray(parsed.message.data)) {
                const msgData = parsed.message.data;

                for (let i = 0; i < msgData.length; i++) {
                    const item = msgData[i];
                    if (!item || !item.changes) continue;
                    const changes = item.changes;

                    if (typeof changes === 'object' && !Array.isArray(changes)) {
                        // Balance injection
                        const keys = Object.keys(changes);
                        if (keys.includes('value') && typeof changes.value === 'number' && robetBalance !== null) {
                            const balCents = Math.round(robetBalance * 100);
                            console.log('[Bridge] \u{1F4B0} Balance: ' + changes.value + ' \u2192 ' + balCents + ' (' + robetBalance.toFixed(2) + ' RBT)');
                            changes.value = balCents;
                        }

                        // Bet limit overrides
                        if (changes.line_bets || changes.max_bet) {
                            changes.line_bets = CUSTOM_LINE_BETS;
                            changes.max_bet = 50000000;
                            changes.min_bet = 1000;
                            changes.default_bet = 10000;
                            if (changes.casino_freespin_total_bets) {
                                changes.casino_freespin_total_bets = CUSTOM_LINE_BETS;
                            }
                            console.log('[Bridge] \u{1F3B0} Bet limits overridden');
                        }

                        // Bet confirmation — track locally, DON'T sync yet
                        if (shouldTrack && typeof changes.bet_cents === 'number' && changes.bet_cents > 0) {
                            const realBetCents = Math.round(changes.bet_cents * _activeScaleFactor);
                            changes.bet_cents = realBetCents;
                            const betRBT = realBetCents / 100;
                            _pendingBetRBT = betRBT;
                            robetBalance = Math.max(0, robetBalance - betRBT);
                            robetBalance = Math.round(robetBalance * 100) / 100;
                            exposeBalance();
                            console.log('[Bridge] \u{1F4C9} Bet: -' + betRBT + ' \u2192 balance: ' + robetBalance.toFixed(2));
                        }

                        // Win — sync BOTH bet+win together (fire-and-forget)
                        if (shouldTrack && typeof changes.win_cents === 'number' && changes.win_cents > 0) {
                            const realWinCents = Math.round(changes.win_cents * _activeScaleFactor);
                            changes.win_cents = realWinCents;
                            const winRBT = realWinCents / 100;
                            // Optimistic local update (server will correct via balance injection)
                            robetBalance += winRBT;
                            robetBalance = Math.round(robetBalance * 100) / 100;
                            exposeBalance();
                            console.log('[Bridge] \u{1F4C8} Win: +' + winRBT + ' \u2192 balance: ' + robetBalance.toFixed(2));
                            // Combined sync: bet + win in one call
                            syncRound(_pendingBetRBT, winRBT);
                            _pendingBetRBT = 0;
                        }
                    }

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
                                    console.log('[Bridge] \u{1F4C8} Win: +' + winRBT + ' \u2192 balance: ' + robetBalance.toFixed(2));
                                    syncRound(_pendingBetRBT, winRBT);
                                    _pendingBetRBT = 0;
                                }
                                if (shouldTrack && typeof sub.bet_cents === 'number' && sub.bet_cents > 0) {
                                    const betRBT = sub.bet_cents / 100;
                                    _pendingBetRBT = betRBT;
                                    robetBalance = Math.max(0, robetBalance - betRBT);
                                    robetBalance = Math.round(robetBalance * 100) / 100;
                                    exposeBalance();
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

        let _userOnMessage = null;

        const _addListener = ws.addEventListener.bind(ws);
        ws.addEventListener = function(type, fn, opts) {
            if (type === 'message') {
                const wrappedFn = function(event) {
                    let data = event.data;
                    if (typeof data === 'string') {
                        const modified = processMessage(data);
                        const newEvent = new MessageEvent('message', {
                            data: modified, origin: event.origin,
                            lastEventId: event.lastEventId,
                            source: event.source, ports: event.ports
                        });
                        return fn.call(this, newEvent);
                    }
                    return fn.call(this, event);
                };
                return _addListener(type, wrappedFn, opts);
            }
            return _addListener(type, fn, opts);
        };

        Object.defineProperty(ws, 'onmessage', {
            get: function() { return _userOnMessage; },
            set: function(fn) {
                _userOnMessage = fn;
                Object.getOwnPropertyDescriptor(_WS.prototype, 'onmessage').set.call(ws, function(event) {
                    let data = event.data;
                    if (typeof data === 'string') {
                        const modified = processMessage(data);
                        const newEvent = new MessageEvent('message', {
                            data: modified, origin: event.origin,
                            lastEventId: event.lastEventId,
                            source: event.source, ports: event.ports
                        });
                        return fn.call(this, newEvent);
                    }
                    return fn.call(this, event);
                });
            }
        });

        // Outgoing — block overbets + scale down
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
                                console.warn('[Bridge] \u274C BLOCKED bet: ' + betRBT + ' > balance ' + robetBalance);
                                return;
                            }
                            if (inner.bet_cents > BGAMING_MAX_BET_CENTS) {
                                _activeScaleFactor = inner.bet_cents / BGAMING_MAX_BET_CENTS;
                                inner.bet_cents = BGAMING_MAX_BET_CENTS;
                                parsed.data = JSON.stringify(inner);
                                data = JSON.stringify(parsed);
                                console.log('[Bridge] \u{1F504} Scaled bet: ' + betRBT + ' RBT \u2192 ' + (BGAMING_MAX_BET_CENTS/100) + ' to server (x' + _activeScaleFactor.toFixed(2) + ')');
                            } else {
                                _activeScaleFactor = 1;
                            }
                            console.log('[Bridge] \u2705 Bet ' + betRBT + ' RBT (balance: ' + robetBalance.toFixed(2) + ')');
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
