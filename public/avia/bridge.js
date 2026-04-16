/**
 * AVIA MASTERS BRIDGE v27 — "Bet Validation"
 * 
 * Fixes: Prevents betting more than the RoBet balance.
 * - Checks outcome.bet against current balance
 * - If bet > balance, blocks the spin and returns an error
 * - Balance can never go below 0
 */
(function() {
    console.log('[Bridge] Avia Masters Bridge v27 Active');

    function findCredentials() {
        try {
            return { id: window.parent.robloxUserId, token: window.parent._sessionToken };
        } catch(e) { return { id: null, token: null }; }
    }

    let creds = findCredentials();
    console.log('[Bridge] User:', creds.id || 'DEMO');

    let robetBalance = null;
    let lastSelectedBet = 0; // Track what bet amount the user selected

    const _fetch = window.fetch.bind(window);

    // Don't set _aviaInPlay here — switchView manages this flag

    function exposeBalance() {
        try {
            window.parent._aviaGameBalance = robetBalance;
        } catch(e) {}
    }

    // Sequential queue
    let queue = Promise.resolve();
    function enqueue(fn) { queue = queue.then(fn, fn); return queue; }

    // ALWAYS call session/start
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
            console.log('[Bridge] Session started, balance:', robetBalance);
        } catch(e) { console.error('[Bridge] Init error:', e); }
    })();

    window.fetch = function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url?.url || '');
        if (!urlStr.includes('bgaming-network.com/api')) {
            return _fetch.apply(window, arguments);
        }

        const args = [url, options];

        // Check request body for bet amount (to block before sending)
        let requestBet = 0;
        try {
            if (options && options.body) {
                const bodyStr = typeof options.body === 'string' ? options.body : '';
                if (bodyStr) {
                    const bodyData = JSON.parse(bodyStr);
                    console.log(`[Bridge] Request body:`, JSON.stringify(bodyData)); // Stringify to see the contents!
                    
                    // Try to catch the bet amount from common field names
                    let rawBet = bodyData.bet || bodyData.total_bet || bodyData.stake || bodyData.wager || bodyData.amount;
                    if (typeof rawBet === 'number') {
                        requestBet = rawBet / 100;
                    } else if (bodyData.options && typeof bodyData.options.bet === 'number') {
                        requestBet = bodyData.options.bet / 100;
                    }
                }
            }
        } catch(e) {}

        // BLOCK spin if bet exceeds balance
        if (requestBet > 0 && robetBalance !== null && requestBet > robetBalance + 0.01) {
            console.warn(`[Bridge] BLOCKED: bet ${requestBet} > balance ${robetBalance}`);
            // Return a fake "insufficient funds" response
            return Promise.resolve(new Response(JSON.stringify({
                balance: { wallet: Math.round(robetBalance * 100) },
                error: 'insufficient_funds'
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }));
        }

        return enqueue(async () => {
            const realRes = await _fetch.apply(window, args);
            const data = await realRes.clone().json();

            // Use outcome.bet and outcome.win
            if (robetBalance !== null && data.outcome) {
                const bet = (data.outcome.bet || 0) / 100;
                const win = (data.outcome.win || 0) / 100;

                if (bet > 0 || win > 0) {
                    // Extra safety: don't let balance go below 0
                    const newBalance = robetBalance - bet + win;
                    robetBalance = Math.max(0, Math.round(newBalance * 100) / 100);
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

    // Save on unload
    window.addEventListener('beforeunload', () => {
        if (creds.id && robetBalance !== null) {
            navigator.sendBeacon('/api/avia/v1/session/save', new Blob([
                JSON.stringify({ userId: creds.id, gameBalance: robetBalance })
            ], { type: 'application/json' }));
        }
    });
})();
