/**
 * AVIA MASTERS BRIDGE v26 — "Fixed Exit Flow"
 * 
 * Fixes:
 * - Always calls session/start (even on restore) so server has active session
 * - Properly exposes balance to parent for tab switch
 * - Uses outcome.bet/outcome.win for tracking (confirmed working)
 */
(function() {
    console.log('[Bridge] Avia Masters Bridge v26 Active');

    function findCredentials() {
        try {
            return { id: window.parent.robloxUserId, token: window.parent._sessionToken };
        } catch(e) { return { id: null, token: null }; }
    }

    let creds = findCredentials();
    console.log('[Bridge] User:', creds.id || 'DEMO');

    let robetBalance = null;

    const _fetch = window.fetch.bind(window);

    // Don't set _aviaInPlay here — switchView manages this flag

    function exposeBalance() {
        try {
            window.parent._aviaGameBalance = robetBalance;
            console.log('[Bridge] Exposed balance to parent:', robetBalance);
        } catch(e) { console.warn('[Bridge] Cannot expose to parent:', e); }
    }

    // Sequential queue
    let queue = Promise.resolve();
    function enqueue(fn) { queue = queue.then(fn, fn); return queue; }

    // ALWAYS call session/start — server will resume if session exists
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
            console.log('[Bridge] Session started/resumed, game balance:', robetBalance);
        } catch(e) { console.error('[Bridge] Init error:', e); }
    })();

    window.fetch = function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url?.url || '');
        if (!urlStr.includes('bgaming-network.com/api')) {
            return _fetch.apply(window, arguments);
        }

        const args = [url, options];

        return enqueue(async () => {
            const realRes = await _fetch.apply(window, args);
            const data = await realRes.clone().json();

            // Use outcome.bet and outcome.win (confirmed working)
            if (robetBalance !== null && data.outcome) {
                const bet = (data.outcome.bet || 0) / 100;
                const win = (data.outcome.win || 0) / 100;
                if (bet > 0 || win > 0) {
                    robetBalance = robetBalance - bet + win;
                    exposeBalance();
                    console.log(`[Bridge] BET:${bet.toFixed(2)} WIN:${win.toFixed(2)} → ${robetBalance.toFixed(2)}`);
                }
            }

            // Override balance display
            if (robetBalance !== null && data.balance) {
                data.balance.wallet = Math.round(robetBalance * 100);
            }

            if (data.options?.currency) {
                data.options.currency.code = 'RBT';
                data.options.currency.symbol = 'R$';
            }

            return new Response(JSON.stringify(data), {
                status: realRes.status,
                headers: { 'Content-Type': 'application/json' }
            });
        });
    };

    // Save on unload (refresh/close)
    window.addEventListener('beforeunload', () => {
        if (creds.id && robetBalance !== null) {
            navigator.sendBeacon('/api/avia/v1/session/save', new Blob([
                JSON.stringify({ userId: creds.id, gameBalance: robetBalance })
            ], { type: 'application/json' }));
        }
    });
})();
