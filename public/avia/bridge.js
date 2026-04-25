/**
 * AVIA MASTERS BRIDGE v30 — "CUS-Integrated"
 *
 * Features:
 * - Reports every spin outcome to the server via /api/avia/v1/spin-sync
 * - Server is the source of truth for gameBalance
 * - Blocks bets > server-tracked balance
 * - Scales down bets that exceed BGaming's demo max to avoid CORS rejections
 * - Scales win payouts back up proportionally
 * - Overrides BGaming's bet limits UI to show up to 500k
 * - Currency renaming (RBT / R$)
 * - CUS integration: server returns adjustedWin + cusApplied flag;
 *   bridge patches outcome.win in the response before the game sees it
 * - beforeunload beacon as fallback safety net
 */
(function() {
    console.log('[Bridge] Avia Masters Bridge v30 Active');

    function findCredentials() {
        try {
            return { id: window.parent.robloxUserId, token: window.parent._sessionToken };
        } catch(e) { return { id: null, token: null }; }
    }

    let creds = findCredentials();
    console.log('[Bridge] User:', creds.id || 'DEMO');

    let robetBalance = null;

    const _fetch = window.fetch.bind(window);

    function exposeBalance() {
        try {
            window.parent._aviaGameBalance = robetBalance;
        } catch(e) {}
    }

    // Sequential queue for BGaming API calls
    let queue = Promise.resolve();
    function enqueue(fn) { queue = queue.then(fn, fn); return queue; }

    // ALWAYS call session/start on load
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
                // Show error overlay in iframe
                document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a1a;color:#fff;font-family:sans-serif;text-align:center;padding:20px;"><div><div style="font-size:48px;margin-bottom:16px;">&#9888;&#65039;</div><div style="font-size:20px;font-weight:700;margin-bottom:8px;">Game Active in Another Tab</div><div style="font-size:14px;color:rgba(255,255,255,0.6);">Please close the game in your other tab first.</div></div></div>';
                // Notify parent frame to revert
                try { window.parent.postMessage({ type: 'bridge_session_blocked' }, '*'); } catch(e) {}
                return;
            }
            if (typeof d.gameBalance === 'number') {
                robetBalance = d.gameBalance;
                exposeBalance();
            }
            console.log('[Bridge] Session started, balance:', robetBalance);
        } catch(e) { console.error('[Bridge] Init error:', e); }
    })();

    /**
     * Report a spin outcome to the server (BLOCKING — awaits CUS result).
     * Returns { gameBalance, adjustedWin, cusApplied } from the server.
     */
    async function syncSpin(bet, win) {
        if (!creds.id) return null;
        try {
            const r = await _fetch('/api/avia/v1/spin-sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: creds.id,
                    sessionToken: creds.token,
                    bet: bet,
                    win: win
                })
            });
            const d = await r.json();
            if (typeof d.gameBalance === 'number') {
                robetBalance = d.gameBalance;
                exposeBalance();
                console.log('[Bridge] Server sync → balance: ' + robetBalance.toFixed(2) +
                    (d.cusApplied ? ' (CUS applied, adjustedWin=' + d.adjustedWin + ')' : ''));
            }
            return d;
        } catch(e) {
            console.warn('[Bridge] spin-sync failed, using local fallback:', e);
            const newBalance = robetBalance - bet + win;
            robetBalance = Math.max(0, Math.round(newBalance * 100) / 100);
            exposeBalance();
            return null;
        }
    }

    // BGaming's demo server rejects bets above this threshold (CORS error)
    const BGAMING_MAX_BET_CENTS = 100000; // 1000 RBT in cents

    window.fetch = function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url?.url || '');
        if (!urlStr.includes('bgaming-network.com/api')) {
            return _fetch.apply(window, arguments);
        }

        // Parse the request body to detect bet amount and possibly scale it down
        let requestBetCents = 0;
        let scaleFactor = 1;
        let modifiedOptions = options;

        try {
            if (options && options.body) {
                const bodyStr = typeof options.body === 'string' ? options.body : '';
                if (bodyStr) {
                    const bodyData = JSON.parse(bodyStr);
                    console.log('[Bridge] Request body:', JSON.stringify(bodyData));

                    // Detect bet amount (BGaming uses cents internally)
                    if (bodyData.options && typeof bodyData.options.bet === 'number') {
                        requestBetCents = bodyData.options.bet;
                    } else {
                        const rawBet = bodyData.bet || bodyData.total_bet || bodyData.stake || bodyData.wager || bodyData.amount;
                        if (typeof rawBet === 'number') requestBetCents = rawBet;
                    }

                    // If bet exceeds BGaming's demo max, scale down the request
                    if (requestBetCents > BGAMING_MAX_BET_CENTS) {
                        scaleFactor = requestBetCents / BGAMING_MAX_BET_CENTS;
                        const clampedBody = JSON.parse(bodyStr);
                        if (clampedBody.options && typeof clampedBody.options.bet === 'number') {
                            clampedBody.options.bet = BGAMING_MAX_BET_CENTS;
                        }
                        if (typeof clampedBody.bet === 'number') clampedBody.bet = BGAMING_MAX_BET_CENTS;
                        if (typeof clampedBody.total_bet === 'number') clampedBody.total_bet = BGAMING_MAX_BET_CENTS;
                        modifiedOptions = Object.assign({}, options, { body: JSON.stringify(clampedBody) });
                        console.log('[Bridge] Scaled bet: ' + requestBetCents + ' → ' + BGAMING_MAX_BET_CENTS + ' (x' + scaleFactor.toFixed(2) + ')');
                    }
                }
            }
        } catch(e) {}

        const requestBet = requestBetCents / 100; // in RBT for balance checks

        // BLOCK spin if bet exceeds balance — return a fake "push" so BGaming
        // doesn't deduct anything internally (bet === win → net zero change)
        if (requestBet > 0 && robetBalance !== null && requestBet > robetBalance + 0.01) {
            console.warn('[Bridge] BLOCKED: bet ' + requestBet + ' > balance ' + robetBalance);
            const walletCents = Math.round(robetBalance * 100);
            return Promise.resolve(new Response(JSON.stringify({
                balance: { wallet: walletCents },
                outcome: { bet: requestBetCents, win: requestBetCents },
                error: 'insufficient_funds'
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }));
        }

        const currentScale = scaleFactor; // capture for async closure

        return enqueue(async () => {
            const realRes = await _fetch.call(window, url, modifiedOptions);
            const data = await realRes.clone().json();

            // Scale outcome back up if we clamped the bet
            if (currentScale > 1 && data.outcome) {
                if (typeof data.outcome.bet === 'number') data.outcome.bet = Math.round(data.outcome.bet * currentScale);
                if (typeof data.outcome.win === 'number') data.outcome.win = Math.round(data.outcome.win * currentScale);
            }

            // Use outcome.bet and outcome.win (now at real scale)
            if (robetBalance !== null && data.outcome) {
                const bet = (data.outcome.bet || 0) / 100;
                const win = (data.outcome.win || 0) / 100;

                if (bet > 0 || win > 0) {
                    // === CUS: Await server sync to get CUS-adjusted outcome ===
                    const syncResult = await syncSpin(bet, win);

                    if (syncResult && syncResult.cusApplied) {
                        // Server modified the outcome — patch the response
                        const adjustedWin = typeof syncResult.adjustedWin === 'number' ? syncResult.adjustedWin : win;
                        const adjustedWinCents = Math.round(adjustedWin * 100);
                        console.log('[Bridge] CUS applied! Original win: ' + win.toFixed(2) + ' → Adjusted: ' + adjustedWin.toFixed(2));
                        data.outcome.win = adjustedWinCents;
                    }

                    console.log('[Bridge] BET:' + bet.toFixed(2) + ' WIN:' + ((syncResult && syncResult.cusApplied) ? syncResult.adjustedWin : win).toFixed(2) + ' → ' + robetBalance.toFixed(2));
                }
            }

            // Override balance display with our tracked balance
            if (robetBalance !== null && data.balance) {
                data.balance.wallet = Math.round(robetBalance * 100);
            }

            if (data.options && data.options.currency) {
                data.options.currency.code = 'RBT';
                data.options.currency.symbol = 'R$';
            }

            // Override BGaming's bet limits with our own (up to 500k)
            const customBets = [10, 20, 50, 100, 200, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
            const customBetsCents = customBets.map(function(b) { return b * 100; });
            if (data.options) {
                if (data.options.bets) data.options.bets = customBetsCents;
                if (data.options.available_bets) data.options.available_bets = customBetsCents;
                if (data.options.denominations) data.options.denominations = customBetsCents;
                if (typeof data.options.max_bet !== 'undefined') data.options.max_bet = 500000 * 100;
                if (typeof data.options.min_bet !== 'undefined') data.options.min_bet = 10 * 100;
                if (typeof data.options.default_bet !== 'undefined') data.options.default_bet = 100 * 100;
            }
            if (Array.isArray(data.bets)) data.bets = customBetsCents;

            return new Response(JSON.stringify(data), {
                status: realRes.status,
                headers: { 'Content-Type': 'application/json' }
            });
        });
    };

    // Save on unload (fallback safety net — server already tracks via spin-sync)
    window.addEventListener('beforeunload', function() {
        if (creds.id && robetBalance !== null) {
            navigator.sendBeacon('/api/avia/v1/session/save', new Blob([
                JSON.stringify({ userId: creds.id, gameBalance: robetBalance, sessionToken: creds.token })
            ], { type: 'application/json' }));
        }
    });
})();
