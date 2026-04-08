document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const views = document.querySelectorAll('.view');
    const topNavLinks = document.querySelectorAll('.top-nav-links a[data-view]');

    // Extract default view from hash or use home
    let defaultView = window.location.hash.replace('#', '') || 'home';
    if(![...views].some(v => v.id === 'view-' + defaultView)) defaultView = 'home';
    switchView(defaultView);

    function switchView(viewName) {
        // Update hash
        window.location.hash = viewName;

        // Update sidebar
        navItems.forEach(item => {
            if(item.dataset.view === viewName) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // Update top nav
        topNavLinks.forEach(item => {
            if(item.dataset.view === viewName) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // Switch container
        views.forEach(view => {
            if(view.id === 'view-' + viewName) {
                view.classList.add('active');
            } else {
                view.classList.remove('active');
            }
        });

        // Trigger active scanner when switching tabs if logged in
        if (typeof performActiveGamepassScan === 'function') {
            performActiveGamepassScan();
        }
        // Init case battles when navigating to it
        if (viewName === 'casebattles' && typeof cbInit === 'function') {
            setTimeout(cbInit, 100);
        }
    }

    // Attach click events to nav links
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(item.dataset.view);
        });
    });

    topNavLinks.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(item.dataset.view);
        });
    });

    if (typeof initLiveFeed === 'function') initLiveFeed();

    // Set footer year
    const footerYear = document.getElementById('zr-footer-year');
    if (footerYear) {
        footerYear.textContent = new Date().getFullYear();
    }

    // Blackjack Logic
    const bjPlayBtn = document.getElementById('bj-play-btn');
    if (bjPlayBtn) {
        const bjHitBtn = document.getElementById('bj-hit-btn');
        const bjStandBtn = document.getElementById('bj-stand-btn');
        const dCardsEl = document.getElementById('bj-dealer-cards');
        const pCardsEl = document.getElementById('bj-player-cards');
        const dScoreEl = document.getElementById('bj-dealer-score');
        const pScoreEl = document.getElementById('bj-player-score');
        const bjMsg = document.getElementById('bj-message');

        let dHand = [];
        let pHand = [];
        let isPlaying = false;
        let cDeck = [];

        function getScore(hand) {
            let score = 0;
            let aces = 0;
            for(let card of hand) {
                score += card.score;
                if(card.value === 'A') aces++;
            }
            while(score > 21 && aces > 0) { score -= 10; aces--; }
            return score;
        }

        function renderCard(card, hidden = false) {
            if(hidden) return `<div class="bj-card hidden"></div>`;
            const color = card.isRed ? 'red' : 'black';
            const suitMid = `<span class="bj-suit-letter">${card.suitLetter}</span>`;
            return `<div class="bj-card ${color}">
                <div style="align-self:flex-start;">${card.value}</div>
                <div style="align-self:center; font-size:26px; font-weight:900; line-height:1;">${suitMid}</div>
                <div style="align-self:flex-end; transform:rotate(180deg);">${card.value}</div>
            </div>`;
        }

        function renderHands(hideDealer = true) {
            pCardsEl.innerHTML = pHand.map(c => renderCard(c)).join('');
            pScoreEl.style.display = 'block';
            pScoreEl.textContent = getScore(pHand);

            if(hideDealer) {
                dCardsEl.innerHTML = renderCard(dHand[0]) + renderCard(dHand[1], true);
                dScoreEl.style.display = 'block';
                dScoreEl.textContent = getScore([dHand[0]]);
            } else {
                dCardsEl.innerHTML = dHand.map(c => renderCard(c)).join('');
                dScoreEl.style.display = 'block';
                dScoreEl.textContent = getScore(dHand);
            }
        }

        function endGame(msg, color) {
            GSM.clear('blackjack');
            isPlaying = false;
            renderHands(false);
            bjHitBtn.disabled = true;
            bjStandBtn.disabled = true;
            bjPlayBtn.disabled = false;
            bjPlayBtn.textContent = 'Place bet';
            bjPlayBtn.classList.remove('custom-cashout-btn');
            bjPlayBtn.style.background = 'var(--accent)';
            
            bjMsg.textContent = msg;
            bjMsg.style.color = color;
            bjMsg.style.display = 'block';
        }

        // Expose Blackjack restore hook (called by resumeGameSessions on page load)
        window._bjRestore = function(session) {
            if (!session || !session.pHand || !session.dHand) {
                if (session && session.bet > 0) { awardWin(session.bet); }
                GSM.clear('blackjack');
                showGameToast('\uD83C\uDCCF Your Blackjack bet was refunded', 'var(--accent)');
                return;
            }
            document.getElementById('bj-bet-input').value = session.bet;
            pHand = session.pHand;
            dHand = session.dHand;
            cDeck = session.deck || [];
            isPlaying = true;
            bjHitBtn.disabled = false;
            bjStandBtn.disabled = false;
            bjPlayBtn.disabled = false;
            bjPlayBtn.textContent = 'Playing...';
            bjPlayBtn.classList.add('custom-cashout-btn');
            bjPlayBtn.style.background = '';
            bjMsg.style.display = 'none';
            renderHands(true);
        };

        bjPlayBtn.addEventListener('click', async () => {
            if(isPlaying) return;
            isPlaying = true;
            bjMsg.style.display = 'none';
            
            bjHitBtn.disabled = true;
            bjStandBtn.disabled = true;
            bjPlayBtn.disabled = true;
            bjPlayBtn.textContent = 'Connecting...';
            
            // Build temporary deck for server
            const suits = [{ letter: 'S', isRed: false }, { letter: 'H', isRed: true }, { letter: 'D', isRed: true }, { letter: 'C', isRed: false }];
            const values = [{v:'2',s:2},{v:'3',s:3},{v:'4',s:4},{v:'5',s:5},{v:'6',s:6},{v:'7',s:7},{v:'8',s:8},{v:'9',s:9},{v:'10',s:10},{v:'J',s:10},{v:'Q',s:10},{v:'K',s:10},{v:'A',s:11}];
            let newDeck = [];
            for(const suit of suits) {
                for(let val of values) newDeck.push({suitLetter: suit.letter, value: val.v, score: val.s, isRed: suit.isRed});
            }
            newDeck.sort(() => Math.random() - 0.5);

            try {
                const bjBetAmt = parseFloat(document.getElementById('bj-bet-input').value) || 0;
                const res = await fetch('/api/game/blackjack/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId, deck: newDeck, bet: bjBetAmt })
                });
                const data = await res.json();
                if (!res.ok) { endGame(data.error || 'Error starting', 'var(--red)'); return; }
                cDeck = data.deck;
                pHand = data.pHand;
                dHand = data.dHand;
                
                bjHitBtn.disabled = false;
                bjStandBtn.disabled = false;
                bjPlayBtn.textContent = 'Playing...';
                bjPlayBtn.classList.add('custom-cashout-btn');
                
                renderHands();
                GSM.update('blackjack', { pHand: pHand, dHand: dHand, deck: cDeck });
                if(getScore(pHand) === 21) {
                    endGame('Blackjack! You Win', 'var(--gold)');
                    fetch('/api/game/blackjack/result', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId: robloxUserId, outcome: 'blackjack' }) }).catch(()=>{});
                }
            } catch(e) {
                endGame('Error starting', 'var(--red)');
            }
        });

        bjHitBtn.addEventListener('click', async () => {
            if(!isPlaying) return;
            bjHitBtn.disabled = true; // prevent double click
            try {
                const res = await fetch('/api/game/blackjack/hit', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId })
                });
                const data = await res.json();
                if(data.error) throw new Error(data.error);
                
                pHand.push(data.card);
                renderHands();
                GSM.update('blackjack', { pHand: pHand, dHand: dHand, deck: cDeck });
                
                if(data.bust) {
                    endGame('Bust! You Lose', 'var(--red)');
                } else {
                    bjHitBtn.disabled = false;
                }
            } catch(e) {
                console.error(e);
                bjHitBtn.disabled = false;
            }
        });

        bjStandBtn.addEventListener('click', async () => {
            if(!isPlaying) return;
            bjHitBtn.disabled = true;
            bjStandBtn.disabled = true;
            
            try {
                const res = await fetch('/api/game/blackjack/stand', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId })
                });
                const data = await res.json();
                if(data.error) throw new Error(data.error);
                
                // Server reveals dealer hand and final outcome
                dHand = data.dHand || dHand;
                
                let msg = 'Push'; let color = 'var(--text-secondary)';
                if(data.outcome === 'blackjack') { msg = 'Blackjack! You Win'; color = 'var(--gold)'; }
                else if(data.outcome === 'win') { msg = 'You Win!'; color = 'var(--green)'; }
                else if(data.outcome === 'lose') { msg = 'Dealer Wins'; color = 'var(--red)'; }
                
                // Render true final hands before ending
                pCardsEl.innerHTML = pHand.map(c => renderCard(c)).join('');
                pScoreEl.style.display = 'block';
                pScoreEl.textContent = data.pScore;
                dCardsEl.innerHTML = dHand.map(c => renderCard(c)).join('');
                dScoreEl.style.display = 'block';
                dScoreEl.textContent = data.dScore;
                
                endGame(msg, color);
            } catch(e) {
                console.error(e);
                endGame('Error connecting to server', 'var(--red)');
            }
        });
    }

    // Mines Logic
    const minesPlayBtn = document.getElementById('mines-play-btn');
    if(minesPlayBtn) {
        const minesGrid = document.getElementById('mines-grid');
        const minesMsg = document.getElementById('mines-message');
        const earningsInp = document.getElementById('mines-earnings');
        const betInp = document.getElementById('mines-bet-input');
        const countInp = document.getElementById('mines-count-input');
        
        let mIsPlaying = false;
        let mGrid = []; // true if bomb
        let mRevealed = 0;
        let mRevealedTiles = []; // indices of safely-revealed tiles (for session restore)
        let mMultiplier = 1.0;
        let currentBet = 0;
        let mGameId = 0;

        // Init grid ui
        function initGridUI() {
            minesGrid.innerHTML = '';
            for(let i=0; i<25; i++) {
                const tile = document.createElement('div');
                tile.className = 'mines-tile';
                tile.dataset.i = i;
                tile.innerHTML = '<span class="tile-mark">G</span>';
                tile.addEventListener('click', () => handleTileClick(i, tile));
                minesGrid.appendChild(tile);
            }
        }
        initGridUI();

        // Expose Mines restore hook (called by resumeGameSessions on page load)
        window._minesRestore = function(session) {
            if (!session) return;
            currentBet       = session.bet || 0;
            mRevealed        = session.revealed || 0;
            mRevealedTiles   = session.revealedTiles ? [...session.revealedTiles] : [];
            mMultiplier      = session.multiplier || 1.0;
            mGrid            = Array(25).fill(false);
            mIsPlaying       = true;
            betInp.value     = session.bet;
            countInp.value   = session.bombs;
            earningsInp.value = (currentBet * parseFloat(mMultiplier)).toFixed(2);
            const revSet = new Set(mRevealedTiles);
            const tiles  = minesGrid.querySelectorAll('.mines-tile');
            tiles.forEach((t, i) => {
                t.className = 'mines-tile';
                if (revSet.has(i)) {
                    t.classList.add('revealed', 'gem');
                    t.innerHTML = '<span class="tile-mark">G</span>';
                } else {
                    t.innerHTML = '<span class="tile-mark">G</span>';
                }
            });
            minesMsg.style.display = 'none';
            minesPlayBtn.disabled  = mRevealed === 0;
            syncMinesCashoutButton();
        };

        function getMulti(mines, clicks) {
            // Simplified multiplier math
            let prob = 1.0;
            for(let i=0; i<clicks; i++) {
                prob *= (25 - mines - i) / (25 - i);
            }
            return (0.95 / prob).toFixed(2);
        }

        function syncMinesCashoutButton() {
            if(!mIsPlaying) return;
            const mult = Number(mMultiplier);
            minesPlayBtn.textContent = `Cashout (${mult.toFixed(2)} x)`;
            minesPlayBtn.classList.add('custom-cashout-btn');
            minesPlayBtn.disabled = (mRevealed === 0) || (minesGrid.querySelectorAll('.mines-tile.loading').length > 0);
        }

        minesPlayBtn.addEventListener('click', async () => {
            if(mIsPlaying) {
                // Cash out
                minesPlayBtn.disabled = true;
                minesPlayBtn.textContent = 'Cashing out...';
                try {
                    const res = await fetch('/api/game/mines/cashout', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId: robloxUserId, revealed: mRevealed })
                    });
                    const data = await res.json();
                    if(data.logic) mGrid = data.logic;
                    // Balance credited server-side; balance:remote_sync will update all tabs
                } catch(e) { console.error(e); }
                endMines(true);
            } else {
                // Start
                currentBet = parseFloat(betInp.value) || 0;
                let bombs = parseInt(countInp.value) || 3;
                if(bombs < 1) bombs = 1; if(bombs > 24) bombs = 24;
                
                minesMsg.style.display = 'none';
                minesPlayBtn.disabled = true;
                minesPlayBtn.textContent = 'Connecting...';
                
                try {
                    const res = await fetch('/api/game/mines/start', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId: robloxUserId, bombs, bet: currentBet })
                    });
                    const startData = await res.json();
                    if (!res.ok) {
                        minesMsg.textContent = startData.error || 'Insufficient balance';
                        minesMsg.style.color = 'var(--red)';
                        minesMsg.style.display = 'block';
                        minesPlayBtn.disabled = false;
                        minesPlayBtn.textContent = 'Start new game';
                        return;
                    }
                    
                    mGameId++;
                    mIsPlaying = true;
                    mGrid = Array(25).fill(false);
                    mRevealed = 0;
                    mRevealedTiles = [];
                    mMultiplier = 1.0;
                    earningsInp.value = currentBet.toFixed(2);
                    minesPlayBtn.disabled = true;
                    syncMinesCashoutButton();
                    
                    const tiles = minesGrid.querySelectorAll('.mines-tile');
                    tiles.forEach((t) => {
                        t.className = 'mines-tile';
                        t.innerHTML = '<span class="tile-mark">G</span>';
                    });
                } catch(e) {
                    minesMsg.textContent = 'Error starting game';
                    minesMsg.style.color = 'var(--red)';
                    minesMsg.style.display = 'block';
                    minesPlayBtn.disabled = false;
                    minesPlayBtn.textContent = 'Start new game';
                }
            }
        });

        async function handleTileClick(i, tileEl) {
            if(!mIsPlaying || tileEl.classList.contains('revealed') || tileEl.classList.contains('loading')) return;
            
            tileEl.classList.add('loading');
            tileEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
            syncMinesCashoutButton();
            
            const currentGameId = mGameId;
            
            try {
                const res = await fetch('/api/game/mines/click', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId, tileIdx: i })
                });
                const data = await res.json();
                
                if (mGameId !== currentGameId) return; // ignore if user already restared game
                
                tileEl.classList.remove('loading');
                tileEl.classList.add('revealed');
                
                if(data.isBomb) {
                    mGrid = data.mGridFull || mGrid;
                    tileEl.classList.add('bomb');
                    tileEl.innerHTML = '<span class="tile-mark">B</span>';
                    soundBomb();
                    endMines(false);
                } else {
                    tileEl.classList.add('gem');
                    tileEl.innerHTML = '<span class="tile-mark">G</span>';
                    soundGem();
                    mRevealed++;
                    mRevealedTiles.push(i);
                    let bombs = parseInt(countInp.value) || 3;
                    mMultiplier = getMulti(bombs, mRevealed);
                    earningsInp.value = (currentBet * parseFloat(mMultiplier)).toFixed(2);
                    syncMinesCashoutButton();
                    // Save progress so game can be resumed after a refresh
                    GSM.update('mines', { revealed: mRevealed, revealedTiles: mRevealedTiles, multiplier: mMultiplier });
                    
                    if(mRevealed + bombs === 25) {
                        endMines(true); // auto cashout if all found
                    }
                }
            } catch(e) {
                if (mGameId !== currentGameId) return;
                minesMsg.textContent = 'Network Error';
                minesMsg.style.color = 'var(--red)';
                minesMsg.style.display = 'block';
                tileEl.classList.remove('loading');
                tileEl.innerHTML = '<span class="tile-mark">G</span>';
                syncMinesCashoutButton();
            }
        }

        function endMines(win) {
            GSM.clear('mines');
            mIsPlaying = false;
            minesPlayBtn.textContent = 'Start new game';
            minesPlayBtn.classList.remove('custom-cashout-btn');
            minesPlayBtn.style.background = 'var(--accent)';
            minesPlayBtn.disabled = false;
            
            const tiles = minesGrid.querySelectorAll('.mines-tile');
            for(let i=0; i<25; i++) {
                if(!tiles[i].classList.contains('revealed')) {
                    tiles[i].classList.add('revealed');
                    if(mGrid[i]) {
                        tiles[i].classList.add('bomb');
                        tiles[i].innerHTML = '<span class="tile-mark" style="opacity:0.4">B</span>';
                    } else {
                        tiles[i].classList.add('gem');
                        tiles[i].innerHTML = '<span class="tile-mark" style="opacity:0.4">G</span>';
                    }
                }
            }
            
            if(win && mRevealed > 0) {
                minesMsg.textContent = `Won ${(currentBet * parseFloat(mMultiplier)).toFixed(2)}`;
                minesMsg.style.color = 'var(--green)';
                minesMsg.style.display = 'block';
                
                fetch('/api/game/record-result', {
                    method:'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId, win: true, bigWin: mMultiplier >= 3.0 })
                }).catch(()=>{});
            } else if (!win) {
                minesMsg.textContent = 'Busted!';
                minesMsg.style.color = 'var(--red)';
                minesMsg.style.display = 'block';
            }
        }
    }

    // Towers Logic
    const tPlayBtn = document.getElementById('towers-play-btn');
    if(tPlayBtn) {
        const tGrid = document.getElementById('towers-grid-container');
        const tMsg = document.getElementById('towers-message');
        const tBetInp = document.getElementById('towers-bet-input');
        const diffBtns = document.querySelectorAll('.towers-diff-tabs .diff-btn');

        let diff = 'easy';
        let rows = 8;
        let tIsPlaying = false;
        let curRow = 0;
        let curBet = 0;
        let tMulti = 1.0;
        let tLogic = [];
        let tRevealedRows = []; // rows climbed for session restore

        diffBtns.forEach(b => {
            b.addEventListener('click', (e) => {
                if(tIsPlaying) return;
                diffBtns.forEach(x=>x.classList.remove('active'));
                b.classList.add('active');
                diff = b.dataset.diff;
                initTowersUI();
            });
        });

        function getDiffConfig() {
            if(diff === 'easy') return {w: 4, b: 1, base: 1.28};
            if(diff === 'normal') return {w: 3, b: 1, base: 1.42};
            if(diff === 'hard') return {w: 3, b: 2, base: 2.85};
        }

        function initTowersUI() {
            tGrid.innerHTML = '';
            const cfg = getDiffConfig();
            
            for(let r=0; r<rows; r++) {
                const rowDiv = document.createElement('div');
                rowDiv.className = 'tower-row';
                rowDiv.dataset.r = r;
                let multi = Math.pow(cfg.base, r+1).toFixed(2);
                
                for(let c=0; c<cfg.w; c++) {
                    const tile = document.createElement('div');
                    tile.className = 'tower-tile';
                    tile.dataset.c = c;
                    tile.innerHTML = `${multi}x <span class="tower-zr-suffix">ZH$</span>`;
                    tile.addEventListener('click', () => handleTowerClick(r, c, tile));
                    rowDiv.appendChild(tile);
                }
                tGrid.appendChild(rowDiv);
            }
        }
        initTowersUI();

        // Expose Towers restore hook (called by resumeGameSessions on page load)
        window._towersRestore = function(session) {
            if (!session) return;
            curRow   = session.curRow || 0;
            curBet   = session.bet || 0;
            tMulti   = session.multiplier || 1.0;
            diff     = session.diff || 'easy';
            tRevealedRows = session.revealedRows ? [...session.revealedRows] : [];
            tIsPlaying = true;
            tBetInp.value = session.bet;
            diffBtns.forEach(b => b.classList.toggle('active', b.dataset.diff === diff));
            initTowersUI();
            const cfg = getDiffConfig();
            const rElements = Array.from(tGrid.children);
            for (let r = 0; r < curRow; r++) {
                rElements[r].classList.add('passed');
                rElements[r].classList.remove('active-row');
                Array.from(rElements[r].children).forEach(t => {
                    const origVal = Math.pow(cfg.base, r + 1).toFixed(2);
                    t.className = 'tower-tile gem';
                    t.innerHTML = `${origVal}x <span class="tower-zr-suffix">ZH$</span>`;
                    t.style.pointerEvents = 'none';
                });
            }
            if (curRow < rElements.length) {
                rElements[curRow].classList.add('active-row');
                Array.from(rElements[curRow].children).forEach(t => t.style.pointerEvents = 'auto');
            }
            tMsg.style.display = 'none';
            tPlayBtn.disabled = curRow === 0;
            if (curRow > 0) {
                tPlayBtn.textContent = `Cashout (${tMulti.toFixed(2)} x)`;
                tPlayBtn.classList.add('custom-cashout-btn');
            }
        };

        tPlayBtn.addEventListener('click', async () => {
            if(tIsPlaying) {
                // Cashout — server computes payout and credits via balance:remote_sync
                tPlayBtn.disabled = true;
                tPlayBtn.textContent = 'Cashing out...';
                try {
                    await fetch('/api/game/towers/cashout', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId: robloxUserId, curRow })
                    });
                } catch(e) { console.error('[Towers cashout]', e); }
                endTowers(true);
            } else {
                curRow = 0;
                curBet = parseFloat(tBetInp.value) || 0;
                tRevealedRows = [];
                const cfg = getDiffConfig();
                
                tMsg.style.display = 'none';
                tPlayBtn.disabled = true;
                tPlayBtn.textContent = 'Connecting...';
                
                try {
                    const res = await fetch('/api/game/towers/start', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId: robloxUserId, rows: rows, width: cfg.w, bombs: cfg.b, bet: curBet, diff })
                    });
                    const startData = await res.json();
                    if(!res.ok) {
                        tMsg.textContent = startData.error || 'Insufficient balance';
                        tMsg.style.color = 'var(--red)';
                        tMsg.style.display = 'block';
                        tPlayBtn.disabled = false;
                        tPlayBtn.textContent = 'Start new game';
                        return;
                    }
                    
                    tIsPlaying = true;
                    tMulti = 1.0;
                    tLogic = [];
                    
                    syncTowersCashoutButton();
                    tPlayBtn.disabled = true;
                    
                    Array.from(tGrid.children).forEach((row, i) => {
                        row.className = 'tower-row ' + (i===0 ? 'active-row' : '');
                        Array.from(row.children).forEach(t => {
                            let origVal = Math.pow(cfg.base, i+1).toFixed(2);
                            t.className = 'tower-tile';
                            t.innerHTML = `${origVal}x <span class="tower-zr-suffix">ZH$</span>`;
                            t.style.pointerEvents = (i===0) ? 'auto' : 'none';
                        });
                    });
                } catch(e) {
                    tMsg.textContent = 'Error starting game';
                    tMsg.style.color = 'var(--red)';
                    tMsg.style.display = 'block';
                    tPlayBtn.disabled = false;
                    tPlayBtn.textContent = 'Start new game';
                }
            }
        });

        async function handleTowerClick(r, c, tileEl) {
            if(!tIsPlaying || r !== curRow || tileEl.classList.contains('loading')) return;
            const cfg = getDiffConfig();
            
            tileEl.classList.add('loading');
            tileEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
            tPlayBtn.disabled = true; // disable cashout while loading
            
            try {
                const res = await fetch('/api/game/towers/click', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId, row: r, col: c })
                });
                const data = await res.json();
                tileEl.classList.remove('loading');
                
                tLogic[curRow] = data.rowData; // Sync from server
                
                if(data.isBomb) {
                    tileEl.classList.add('bomb');
                    tileEl.innerHTML = '<span class="tile-mark">B</span>';
                    endTowers(false);
                } else {
                    tileEl.classList.add('gem');
                    tileEl.innerHTML = '<span class="tile-mark">S</span>';
                    tMulti = Math.pow(cfg.base, curRow+1);
                    curRow++;
                    tRevealedRows.push(curRow - 1);
                    tPlayBtn.disabled = false; // can now cashout
                    syncTowersCashoutButton();
                    // Persist progress for session restore on refresh
                    GSM.update('towers', { curRow, multiplier: tMulti, revealedRows: tRevealedRows });
                    
                    const rElements = Array.from(tGrid.children);
                    rElements[curRow-1].classList.remove('active-row');
                    rElements[curRow-1].classList.add('passed');
                    
                    if(curRow >= rows) {
                        endTowers(true);
                    } else {
                        rElements[curRow].classList.add('active-row');
                        Array.from(rElements[curRow].children).forEach(t => t.style.pointerEvents='auto');
                    }
                }
            } catch(e) {
                tMsg.textContent = 'Network error fetching step.';
                tMsg.style.color = 'var(--red)';
                tMsg.style.display = 'block';
                tileEl.classList.remove('loading');
                tileEl.innerHTML = 'Retry';
                tPlayBtn.disabled = false;
            }
        }

        function syncTowersCashoutButton() {
            if(!tIsPlaying) return;
            tPlayBtn.textContent = `Cashout (${tMulti.toFixed(2)} x)`;
            tPlayBtn.classList.add('custom-cashout-btn');
        }

        function endTowers(win) {
            GSM.clear('towers');
            tIsPlaying = false;
            tPlayBtn.textContent = 'Start new game';
            tPlayBtn.classList.remove('custom-cashout-btn');
            tPlayBtn.style.background = 'var(--accent)';
            tPlayBtn.disabled = false;
            
            document.querySelectorAll('.tower-tile').forEach(t => t.style.pointerEvents='none');
            
            if(!win) {
                const rElements = Array.from(tGrid.children);
                const crow = rElements[curRow];
                if (tLogic[curRow]) {
                    Array.from(crow.children).forEach((el, idx) => {
                        if(!el.classList.contains('bomb') && !el.classList.contains('gem')) {
                            if(tLogic[curRow][idx]) {
                                el.classList.add('bomb');
                                el.innerHTML = '<span class="tile-mark" style="opacity:0.5">B</span>';
                            }
                        }
                    });
                }
            }

            if(win && curRow > 0) {
                tMsg.textContent = `Won ${(curBet * tMulti).toFixed(2)}`;
                tMsg.style.color = 'var(--green)';
                tMsg.style.display = 'block';
                
                 fetch('/api/game/record-result', {
                    method:'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId, win: true, bigWin: tMulti >= 3.0 })
                }).catch(()=>{});
            } else if (!win) {
                tMsg.textContent = 'Busted!';
                tMsg.style.color = 'var(--red)';
                tMsg.style.display = 'block';
            }
        }
    }

    // Dice Logic
    const dPlayBtn = document.getElementById('dice-play-btn');
    if(dPlayBtn) {
        const slider = document.getElementById('dice-slider');
        const trackFill = document.getElementById('dice-track-fill');
        const multiInp = document.getElementById('dice-multi-input');
        const targetInp = document.getElementById('dice-target-input');
        const chanceInp = document.getElementById('dice-chance-input');
        const toggleDir = document.getElementById('dice-toggle-dir');
        
        const betInp = document.getElementById('dice-bet-input');
        const profMulti = document.getElementById('dice-profit-multi');
        const profInp = document.getElementById('dice-profit-input');
        const resultMarker = document.getElementById('dice-result-marker');
        const historyCon = document.getElementById('dice-history');

        let isOver = true; // true = roll over, false = roll under
        const HOUSE_EDGE = 0.99; // 1% edge

        function updateFromSlider() {
            let val = parseFloat(slider.value);
            targetInp.value = val.toFixed(2);
            
            let chance = isOver ? (100 - val) : val;
            chanceInp.value = chance.toFixed(2);
            
            let multi = (100 / chance) * HOUSE_EDGE;
            multiInp.value = multi.toFixed(4);
            
            updateVisuals();
            updateProfit();
        }

        function updateFromMulti() {
            let multi = parseFloat(multiInp.value);
            if(multi < 1.01) multi = 1.01;
            let chance = (100 / multi) * HOUSE_EDGE;
            if(chance > 98) chance = 98;
            chanceInp.value = chance.toFixed(2);
            
            let val = isOver ? (100 - chance) : chance;
            slider.value = val;
            targetInp.value = val.toFixed(2);
            
            updateVisuals();
            updateProfit();
        }

        function updateProfit() {
            let bet = parseFloat(betInp.value) || 0;
            let multi = parseFloat(multiInp.value) || 0;
            profMulti.textContent = multi.toFixed(2);
            profInp.value = (bet * multi).toFixed(2);
        }

        function updateVisuals() {
            let val = parseFloat(slider.value);
            if(isOver) {
                trackFill.classList.remove('roll-under');
                trackFill.style.left = val + '%';
                trackFill.style.right = '0%';
                trackFill.style.width = 'auto';
            } else {
                trackFill.classList.add('roll-under');
                trackFill.style.left = '0%';
                trackFill.style.width = val + '%';
                trackFill.style.right = 'auto';
            }
        }

        slider.addEventListener('input', updateFromSlider);
        multiInp.addEventListener('change', updateFromMulti);
        betInp.addEventListener('input', updateProfit);
        
        toggleDir.addEventListener('click', () => {
            isOver = !isOver;
            updateFromSlider();
        });

        dPlayBtn.addEventListener('click', async () => {
            dPlayBtn.disabled = true;
            resultMarker.classList.remove('show');
            
            let target = parseFloat(targetInp.value);
            let multi = parseFloat(multiInp.value) || 1;
            
            try {
                const res = await fetch('/api/game/dice', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId, target, isOver, multi, bet: parseFloat(betInp.value) || 0 })
                });
                const data = await res.json();
                
                // simulate roll animation delay
                setTimeout(() => {
                    let roll = data.roll.toFixed(2);
                    let win = data.win;
                    
                    resultMarker.style.left = roll + '%';
                    resultMarker.textContent = roll;
                    resultMarker.className = 'dice-result-marker show ' + (win ? 'win' : '');
                    
                    // Add to history
                    const pill = document.createElement('div');
                    pill.className = 'history-pill ' + (win ? 'win' : 'lose');
                    pill.textContent = parseFloat(multiInp.value).toFixed(2) + 'x';
                    historyCon.prepend(pill);
                    if(historyCon.children.length > 8) historyCon.lastChild.remove(); // keep 8 history
                    
                    // Balance update styling
                    if(win) {
                        profInp.style.color = 'var(--green)';
                    } else {
                        profInp.style.color = 'var(--red)';
                    }
                    setTimeout(() => profInp.style.color = 'var(--text-secondary)', 1500);
                    
                    dPlayBtn.disabled = false;
                }, 300);
                
            } catch(e) {
                console.error(e);
                dPlayBtn.disabled = false;
            }
        });
        
        updateFromSlider();
    }

    // Plinko Logic
    const pPlayBtn = document.getElementById('plinko-play-btn');
    if(pPlayBtn) {
        const canvas = document.getElementById('plinko-canvas');
        const ctx = canvas.getContext('2d');
        const bucketsContainer = document.getElementById('plinko-buckets');
        const rowsInp = document.getElementById('plinko-rows-input');
        const diffBtns = document.querySelectorAll('#plinko-diff-tabs .diff-btn');
        const rowBtns = document.querySelectorAll('.plinko-row-btns .row-btn');
        
        let pRows = 10;
        let pDiff = 'easy';
        let balls = [];
        let pegs = [];
        let pIsAnimating = false;

        const getBucketColor = (idx, rows) => {
            const dist = Math.abs(idx - rows/2);
            const rDist = Math.round(dist); // will be exactly 0,1,2,3... because 8,10,12,14,16 rows produce odd num of buckets
            const colors = [
                '#ffc000', // 0: center (Yellow)
                '#ff9315', // 1: Orange-Yellow
                '#f96538', // 2: Orange-Red
                '#e34850', // 3: Pink-Red
                '#b63695', // 4: Magenta
                '#8c2eff', // 5: Purple
                '#6821d3', // 6: Deep Purple
                '#4b16b9', // 7: Violet
                '#310b99'  // 8: Indigo
            ];
            return colors[rDist] || '#310b99';
        };

        const getMultipliers = (rows, diff) => {
            // Plinko payout tables — designed so:
            //   Hard 16: center buckets (0.2x) land ~40-50% of the time (most common)
            //             medium buckets (2x) land ~10% of the time
            //             1000x edge bucket has a ~0.5% real hit probability
            const payouts = {
                8: {
                    easy: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
                    normal: [14, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 14],
                    hard: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
                },
                10: {
                    easy: [8.9, 3, 1.4, 1.1, 1.0, 0.5, 1.0, 1.1, 1.4, 3, 8.9],
                    normal: [22, 5, 2, 1.4, 0.6, 0.4, 0.6, 1.4, 2, 5, 22],
                    hard: [76, 10, 3, 0.9, 0.3, 0.2, 0.3, 0.9, 3, 10, 76]
                },
                12: {
                    easy: [11, 4, 1.6, 1.4, 1.1, 1.0, 0.5, 1.0, 1.1, 1.4, 1.6, 4, 11],
                    normal: [33, 8.9, 3, 1.7, 1.1, 0.6, 0.3, 0.6, 1.1, 1.7, 3, 8.9, 33],
                    hard: [170, 24, 8.1, 1.9, 0.7, 0.2, 0.2, 0.2, 0.7, 1.9, 8.1, 24, 170]
                },
                14: {
                    easy: [15, 7.1, 2.1, 1.6, 1.3, 1.1, 1.0, 0.5, 1.0, 1.1, 1.3, 1.6, 2.1, 7.1, 15],
                    normal: [58, 15, 6, 2, 1.3, 1.1, 0.3, 0.2, 0.3, 1.1, 1.3, 2, 6, 15, 58],
                    hard: [420, 56, 18, 5, 1.9, 0.3, 0.2, 0.2, 0.2, 0.3, 1.9, 5, 18, 56, 420]
                },
                16: {
                    easy: [16, 9, 2.4, 1.7, 1.4, 1.3, 1.1, 1.0, 0.5, 1.0, 1.1, 1.3, 1.4, 1.7, 2.4, 9, 16],
                    normal: [110, 41, 10, 5, 3, 1.5, 1.0, 0.5, 0.3, 0.5, 1.0, 1.5, 3, 5, 10, 41, 110],
                    // Hard 16 — centre 0.2x appear ~45% of time, 2x slots ~10%, 1000x edge ~0.5%
                    hard: [1000, 130, 26, 9, 2, 0.5, 0.2, 0.2, 0.2, 0.2, 0.2, 0.5, 2, 9, 26, 130, 1000]
                }
            };
            return payouts[rows] ? (payouts[rows][diff] || payouts[rows]['easy']) : payouts[8]['easy'];
        };

        const initPlinkoBoard = () => {
            pegs = [];
            const startY = 40;
            const rowHeight = 320 / pRows; // max height ~350, canvas is 400
            
            for(let r=2; r<pRows+2; r++) { // Add pegs starting from a bit down
                let y = startY + (r-2) * rowHeight;
                let pegsInRow = r + 1;
                let spacing = 600 / (pRows + 3); 
                let startX = 300 - ((pegsInRow - 1) * spacing) / 2;
                
                for(let c=0; c<pegsInRow; c++) {
                    pegs.push({ x: startX + c * spacing, y: y, r: 4 });
                }
            }
            
            // Build HTML buckets
            bucketsContainer.innerHTML = '';
            const multis = getMultipliers(pRows, pDiff);
            multis.forEach((m, idx) => {
                const b = document.createElement('div');
                b.className = 'plinko-bucket';
                b.textContent = m + 'x';
                b.style.background = getBucketColor(idx, pRows);
                b.style.color = '#fff';
                b.style.textShadow = '0 1px 2px rgba(0,0,0,0.5)';
                b.dataset.idx = idx;
                b.dataset.multi = m;
                bucketsContainer.appendChild(b);
            });
            drawPlinko();
        };

        const drawPlinko = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // Draw pegs
            ctx.fillStyle = '#4a5ce6';
            ctx.shadowBlur = 4;
            ctx.shadowColor = '#5a6cf9';
            pegs.forEach(p => {
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
                ctx.fill();
            });
            ctx.shadowBlur = 0;

            // Draw balls
            balls.forEach(b => {
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
                ctx.fillStyle = '#f4c23f';
                ctx.fill();
                ctx.shadowBlur = 10;
                ctx.shadowColor = '#f5af19';
                ctx.fill();
                ctx.shadowBlur = 0;
            });
        };

        rowBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                rowBtns.forEach(b => { b.classList.remove('active'); b.style.background='transparent'; b.style.color='var(--text-secondary)'; });
                btn.classList.add('active');
                btn.style.background='var(--bg-panel)';
                btn.style.color='white';
                pRows = parseInt(btn.dataset.r);
                rowsInp.value = pRows;
                initPlinkoBoard();
            });
        });

        diffBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                diffBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                pDiff = btn.dataset.diff;
                initPlinkoBoard();
            });
        });

        initPlinkoBoard();

        const updatePhysics = () => {
            let activeBalls = false;
            const gravity = 0.22;
            const bucketY = 370; // bucket level

            for(let i=balls.length-1; i>=0; i--) {
                const b = balls[i];
                if(b.done) continue;
                activeBalls = true;
                
                b.vy += gravity;
                b.y += b.vy;
                b.x += b.vx;
                b.vx *= 0.99; // slight air friction

                // Collision with pegs
                pegs.forEach(p => {
                    let dx = b.x - p.x;
                    let dy = b.y - p.y;
                    let dist = Math.sqrt(dx*dx + dy*dy);
                    if(dist < b.r + p.r) {
                        // True Plinko mechanics (Binomial)
                        let angle = Math.atan2(dy, dx);
                        let speed = Math.sqrt(b.vx*b.vx + b.vy*b.vy) * 0.4; // damp heavily
                        
                        // severely reduce current horizontal momentum so it doesn't fly out, and impart 50/50 kick
                        let kick = (Math.random() < 0.5 ? -1.8 : 1.8) + (Math.random()-0.5)*0.5;
                        if (b.customOutcome && b.targetIdx !== undefined) {
                            // Nudge ball towards the exact target bucket's center X
                            const bucketWidth = 600 / (pRows + 1);
                            const targetX = (b.targetIdx + 0.5) * bucketWidth;
                            const diff = targetX - b.x;
                            kick = Math.sign(diff) * 1.4 + (Math.random() - 0.5) * 0.4;
                        }
                        
                        b.vx = (Math.cos(angle) * speed * 0.2) + kick; 
                        b.vy = Math.sin(angle) * speed;
                        
                        // Prevent sticking inside peg
                        b.x = p.x + Math.cos(angle) * (b.r + p.r + 0.5);
                        b.y = p.y + Math.sin(angle) * (b.r + p.r + 0.5);
                        
                        // play ping
                        if(typeof playTone === 'function') playTone(800 + Math.random()*200, 0.05, 'sine', 0.05);
                    }
                });
                
                // Keep inside canvas bounds horizontally
                if(b.x < b.r) { b.x = b.r; b.vx *= -0.5; }
                if(b.x > canvas.width - b.r) { b.x = canvas.width - b.r; b.vx *= -0.5; }

                // Bottom hit (Bucket)
                if(b.y > bucketY) {
                    b.done = true;
                    // Calculate which bucket
                    let bucketWidth = 600 / (pRows + 1);
                    let idx = Math.floor(b.x / bucketWidth);
                    if(idx < 0) idx = 0;
                    if(idx > pRows) idx = pRows; // pRows + 1 buckets
                    
                    if (b.customOutcome && b.targetIdx !== undefined) idx = b.targetIdx; // Guarantee correct visual target based on server rigging
                    
                    const bucketEl = bucketsContainer.children[idx];
                    if(bucketEl) {
                        bucketEl.classList.add('hit');
                        setTimeout(() => bucketEl.classList.remove('hit'), 150);
                        const multi = parseFloat(bucketEl.dataset.multi);
                        // Balance is updated via balance:remote_sync from server — no client-side awardWin
                        postLiveFeedRound('plinko', b.bet, multi, b.bet * multi);
                        if(multi >= 2) {
                            if(typeof soundWin === 'function') soundWin();
                        } else {
                            if(typeof soundLose === 'function') soundLose();
                        }
                    }
                }
            }
            
            balls = balls.filter(b => !b.done);
            drawPlinko();
            
            if(activeBalls) {
                requestAnimationFrame(updatePhysics);
            } else {
                pIsAnimating = false;
            }
        };

        pPlayBtn.addEventListener('click', async (e) => {
            const bet = parseFloat(document.getElementById('plinko-bet-input').value) || 0;
            if(bet <= 0 || bet > roBalance) {
                e.stopImmediatePropagation();
                const warn = document.createElement('div');
                warn.textContent = bet <= 0 ? 'Enter a valid bet amount!' : 'Not enough ZR$!';
                warn.style.cssText='position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#2a1515;border:1px solid var(--red);color:var(--red);padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;';
                document.body.appendChild(warn);
                setTimeout(()=>warn.remove(), 2000);
                return;
            }
            
            try {
                // Pass bet to server so it can atomically deduct + credit
                const res = await fetch('/api/game/plinko', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ userId: robloxUserId, pRows, pDiff, bet })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    const warn = document.createElement('div');
                    warn.textContent = err.error || 'Server error. Try again.';
                    warn.style.cssText='position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#2a1515;border:1px solid var(--red);color:var(--red);padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;';
                    document.body.appendChild(warn);
                    setTimeout(()=>warn.remove(), 2500);
                    return;
                }
                const data = await res.json();
                // Balance updated via balance:remote_sync socket — no client-side deductBet needed
                
                balls.push({
                    x: 300 + (Math.random()-0.5)*2,
                    y: 15,
                    vx: 0,
                    vy: 0,
                    r: 6,
                    bet: bet,
                    done: false,
                    customOutcome: data.customOutcome,
                    targetIdx: data.idx
                });
                
                if(!pIsAnimating) {
                    pIsAnimating = true;
                    requestAnimationFrame(updatePhysics);
                }
            } catch(err) {
                console.error(err);
            }
        });
    }

    // Crash Logic
    const crashPlayBtn = document.getElementById('crash-play-btn');
    if(crashPlayBtn) {
        const canvas = document.getElementById('crash-canvas');
        const ctx = canvas.getContext('2d');
        const display = document.getElementById('crash-multi-display');
        const statusText = document.getElementById('crash-status-text');
        const betInp = document.getElementById('crash-bet-input');
        const autoInp = document.getElementById('crash-auto-input');
        const playersList = document.querySelector('.crash-players-list');
        
        let cState = 'idle'; 
        let cBet = 0;
        let cAuto = 2.0;
        let cMulti = 1.00;
        let cCrashPoint = 1.00;
        let startTime = 0;
        let animFrame = null;
        let crashCountdownInterval = null;
        let hasCashedOut = false;

        const normalizeCrashStartTime = (serverStartTime) => {
            const now = Date.now();
            const parsed = Number(serverStartTime);
            if (!Number.isFinite(parsed) || parsed <= 0) return now;
            // If clocks are skewed and server time appears in the future,
            // use local now so multiplier doesn't freeze at 1.00x.
            if (parsed > now) return now;
            return parsed;
        };

        const stopCrashAnimLoop = () => {
            if (animFrame != null) {
                cancelAnimationFrame(animFrame);
                animFrame = null;
            }
        };

        const clearCrashCountdown = () => {
            if (crashCountdownInterval != null) {
                clearInterval(crashCountdownInterval);
                crashCountdownInterval = null;
            }
        };

        const setCrashPendingCashoutButton = () => {
            crashPlayBtn.textContent = `Cashout (${cMulti.toFixed(2)} x)`;
            if (!crashPlayBtn.classList.contains('custom-cashout-btn')) {
                crashPlayBtn.classList.add('custom-cashout-btn');
            }
            // Waiting for round start: show cashout label, but keep disabled/greyed.
            crashPlayBtn.style.background = 'var(--bg-panel-light)';
            crashPlayBtn.disabled = true;
        };
        
        const resizeCanvas = () => {
            const area = document.querySelector('.crash-area');
            if(area && area.clientWidth > 0) {
                canvas.width = area.clientWidth;
                canvas.height = area.clientHeight;
            } else {
                canvas.width = 800; 
                canvas.height = 550;
            }
        };
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        const drawGraph = (timeMs, multi) => {
            if(canvas.width === 800 && document.querySelector('.crash-area').clientWidth > 0) resizeCanvas();
            
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.lineWidth = 1;
            
            for(let i=1; i<5; i++) {
                ctx.beginPath();
                ctx.moveTo(0, canvas.height - i*80);
                ctx.lineTo(canvas.width, canvas.height - i*80);
                ctx.stroke();
            }
            
            if(cState === 'running' || cState === 'crashed') {
                const tDraw = Math.max(0, timeMs);
                const padX = 40;
                const padY = 40;
                const maxW = canvas.width - padX*2;
                const maxH = canvas.height - padY*2 - 80;
                
                const maxY = Math.max(2.0, multi * 1.25);
                const maxTime = Math.max(10000, tDraw * 1.25);
                
                ctx.beginPath();
                ctx.moveTo(padX, canvas.height - padY);
                
                let steps = 50;
                let lastX = padX;
                let lastY = canvas.height - padY;

                for (let i = 0; i <= steps; i++) {
                    const frac = i / steps;
                    const t = tDraw * frac;
                    const m = 1.0 * Math.pow(Math.E, t * 0.00006);

                    let px = padX + (t / maxTime) * maxW;
                    let py = (canvas.height - padY) - ((m - 1.0) / (maxY - 1.0)) * maxH;
                    if (isNaN(py)) py = canvas.height - padY;

                    ctx.lineTo(px, py);
                    lastX = px;
                    lastY = py;
                }

                const k = 0.00006;
                const dxdt = maxW / maxTime;
                const dydt = -(k * Math.exp(tDraw * k) / (maxY - 1.0)) * maxH;
                let tangentAngle = Math.atan2(dydt, dxdt);
                if (!Number.isFinite(tangentAngle)) tangentAngle = -Math.PI / 2;
                
                ctx.lineWidth = 4;
                ctx.strokeStyle = cState === 'crashed' ? '#ff6b6b' : '#f5af19';
                ctx.stroke();
                
                const gradient = ctx.createLinearGradient(0, canvas.height-padY-maxH, 0, canvas.height-padY);
                if(cState === 'crashed') {
                    gradient.addColorStop(0, 'rgba(255, 107, 107, 0.4)');
                    gradient.addColorStop(1, 'rgba(255, 107, 107, 0)');
                } else {
                    gradient.addColorStop(0, 'rgba(245, 175, 25, 0.4)');
                    gradient.addColorStop(1, 'rgba(245, 175, 25, 0)');
                }
                ctx.lineTo(lastX, canvas.height - padY);
                ctx.lineTo(padX, canvas.height - padY);
                ctx.fillStyle = gradient;
                ctx.fill();

                /** Rocket Ship Rendering */
                ctx.save();
                ctx.translate(lastX, lastY);
                if(cState === 'running') {
                    ctx.rotate(tangentAngle + Math.PI / 2);
                    
                    // Flame
                    ctx.fillStyle = '#ff4d4d'; // Red flame base
                    ctx.beginPath();
                    ctx.moveTo(-6, 15);
                    ctx.lineTo(0, 28 + Math.random()*8); // Dynamic flame length
                    ctx.lineTo(6, 15);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = '#f5af19'; // Yellow inner flame
                    ctx.beginPath();
                    ctx.moveTo(-3, 15);
                    ctx.lineTo(0, 20 + Math.random()*5);
                    ctx.lineTo(3, 15);
                    ctx.closePath();
                    ctx.fill();

                    // Rocket Body (Capsule)
                    ctx.fillStyle = '#ffffff'; 
                    ctx.strokeStyle = '#94a3b8'; // Light outline
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(0, -22);    // Nose
                    ctx.quadraticCurveTo(12, -8, 10, 16); // Right side
                    ctx.lineTo(-10, 16);   // Bottom
                    ctx.quadraticCurveTo(-12, -8, 0, -22); // Left side
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    
                    // Left Fin
                    ctx.fillStyle = '#ef4444'; 
                    ctx.beginPath(); 
                    ctx.moveTo(-10, 4);
                    ctx.lineTo(-18, 18);
                    ctx.lineTo(-10, 16);
                    ctx.closePath();
                    ctx.fill();
                    
                    // Right Fin
                    ctx.fillStyle = '#ef4444'; 
                    ctx.beginPath(); 
                    ctx.moveTo(10, 4);
                    ctx.lineTo(18, 18);
                    ctx.lineTo(10, 16);
                    ctx.closePath();
                    ctx.fill();

                    // Window
                    ctx.fillStyle = '#bae6fd'; // Light blue glass
                    ctx.strokeStyle = '#0284c7'; // Dark blue outline
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(0, -2, 5, 0, Math.PI*2);
                    ctx.fill();
                    ctx.stroke();
                    
                } else if(cState === 'crashed') {
                    ctx.strokeStyle = '#ff6b6b';
                    ctx.lineWidth = 3;
                    for(let i = 0; i < 12; i++) {
                        const a = (i / 12) * Math.PI * 2;
                        const dist = 10 + Math.random() * 15;
                        ctx.beginPath();
                        ctx.moveTo(Math.cos(a)*5, Math.sin(a)*5);
                        ctx.lineTo(Math.cos(a)*dist, Math.sin(a)*dist);
                        ctx.stroke();
                    }
                    ctx.fillStyle = '#ff6b6b';
                    ctx.beginPath();
                    ctx.arc(0, 0, 8, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        };

        const doCashout = () => {
            if(hasCashedOut || cState !== 'running' || cBet <= 0) return;
            hasCashedOut = true;
            socket?.emit('crash:cashout', { userId: robloxUserId });
            // The server will acknowledge with 'crash:playerCashedOut'
        };

        const updateCrash = () => {
            if (cState === 'crashed') {
                animFrame = null;
                return;
            }
            if (cState === 'running') {
                const elapsed = Math.max(0, Date.now() - startTime);
                cMulti = 1.0 * Math.pow(Math.E, elapsed * 0.00006);

                if (cBet > 0 && !hasCashedOut) {
                    crashPlayBtn.textContent = `Cashout (${cMulti.toFixed(2)} x)`;
                    if (!crashPlayBtn.classList.contains('custom-cashout-btn')) {
                        crashPlayBtn.classList.add('custom-cashout-btn');
                    }
                }

                display.textContent = cMulti.toFixed(2) + 'x';
                drawGraph(elapsed, cMulti);
                animFrame = requestAnimationFrame(updateCrash);
            } else {
                animFrame = null;
            }
        };
        
        // Socket Handlers
        socket?.on('crash:starting', ({ countdown }) => {
            stopCrashAnimLoop();
            clearCrashCountdown();
            cState = 'starting';
            cBet = 0;
            hasCashedOut = false;
            display.style.color = 'white';
            statusText.textContent = 'Next round starting…';
            statusText.style.color = 'var(--text-secondary)';
            crashPlayBtn.textContent = 'Join next game';
            crashPlayBtn.classList.remove('custom-cashout-btn');
            crashPlayBtn.style.background = 'var(--accent)';
            crashPlayBtn.disabled = false;
            playersList.innerHTML = '';

            let left = typeof countdown === 'number' && countdown > 0 ? countdown : 5;
            display.textContent = left.toFixed(1) + 's';

            crashCountdownInterval = setInterval(() => {
                left -= 0.1;
                if (left <= 0 || cState !== 'starting') {
                    clearCrashCountdown();
                    return;
                }
                display.textContent = Math.max(0, left).toFixed(1) + 's';
                drawGraph(0, 1.0);
            }, 100);
        });

        socket?.on('crash:sync_state', (data) => {
            cState = data.state;
            startTime = normalizeCrashStartTime(data.startTime);
            cCrashPoint = data.target || 1.0;

            const myPlayer = data.players.find((p) => String(p.userId) === String(robloxUserId));
            if (myPlayer) {
                cBet = myPlayer.bet;
                hasCashedOut = myPlayer.cashedOut;
            }

            if (cState === 'running') {
                clearCrashCountdown();
                stopCrashAnimLoop();
                display.style.color = 'white';
                statusText.textContent = 'Current payout';
                statusText.style.color = 'var(--text-secondary)';
                if (cBet > 0 && !hasCashedOut) {
                    crashPlayBtn.disabled = false;
                    crashPlayBtn.style.background = 'var(--green)';
                }
                animFrame = requestAnimationFrame(updateCrash);
            } else if (cState === 'crashed') {
                clearCrashCountdown();
                stopCrashAnimLoop();
                display.textContent = cCrashPoint.toFixed(2) + 'x';
                display.style.color = '#ff6b6b';
                statusText.textContent = 'Crashed';
                statusText.style.color = '#ff6b6b';
                drawGraph(Math.max(0, Date.now() - startTime), cCrashPoint);
            } else if (cState === 'starting') {
                clearCrashCountdown();
                stopCrashAnimLoop();
                display.style.color = 'white';
                statusText.textContent = 'Next round starting…';
                statusText.style.color = 'var(--text-secondary)';
                if (cBet > 0 && !hasCashedOut) {
                    cMulti = 1.0;
                    setCrashPendingCashoutButton();
                }
            }

            playersList.innerHTML = '';
            data.players.forEach((p) =>
                appendPlayer(
                    p.userId,
                    p.username,
                    p.bet,
                    p.cashedOut,
                    p.winAmt,
                    p.bet > 0 ? p.winAmt / p.bet : 0
                )
            );
        });
        
        socket?.on('crash:start', (data) => {
            clearCrashCountdown();
            stopCrashAnimLoop();
            cState = 'running';
            startTime = normalizeCrashStartTime(data.startTime);
            display.style.color = 'white';
            statusText.textContent = 'Current payout';
            statusText.style.color = 'var(--text-secondary)';
            if (cBet > 0) {
                crashPlayBtn.textContent = 'Cashout';
                crashPlayBtn.style.background = 'var(--green)';
                crashPlayBtn.disabled = false;
            }
            let elapsed = Date.now() - startTime;
            cMulti = 1.0 * Math.pow(Math.E, Math.max(0, elapsed) * 0.00006);
            display.textContent = cMulti.toFixed(2) + 'x';
            animFrame = requestAnimationFrame(updateCrash);
        });

        socket?.on('crash:crashed', (data) => {
            clearCrashCountdown();
            stopCrashAnimLoop();
            cMulti = data.target;
            cState = 'crashed';
            display.textContent = cMulti.toFixed(2) + 'x';
            display.style.color = '#ff6b6b';
            statusText.textContent = 'Crashed';
            statusText.style.color = '#ff6b6b';
            drawGraph(Math.max(0, Date.now() - startTime), cMulti);
            
            if(typeof soundLose === 'function' && !hasCashedOut && cBet > 0) soundLose();
            if(!hasCashedOut && cBet > 0) postLiveFeedRound('crash', cBet, 0, -cBet);
            
            const hist = document.getElementById('crash-history');
            if(hist) {
                const p = document.createElement('span');
                p.className = 'history-pill ' + (data.target > 2 ? 'win' : 'lose');
                if(data.target >= 10) { p.style.background = '#f5af19'; p.style.color = '#1a1c2d'; }
                p.textContent = data.target.toFixed(2);
                hist.prepend(p);
                if(hist.children.length > 7) hist.lastChild.remove();
            }
        });

        function appendPlayer(uid, username, bet, cashedOut, winAmt, multi) {
            if (cashedOut) {
                playersList.innerHTML = `<div style="color:var(--green)">
                    <span style="display:flex;align-items:center;gap:6px;"><i class="fa-solid fa-check"></i> ${String(uid) === String(robloxUserId) ? 'You' : username}</span>
                    <span>${multi.toFixed(2)}x</span>
                    <span>+${winAmt.toLocaleString('en-US', {minimumFractionDigits:2})}</span>
                </div>` + playersList.innerHTML;
            } else {
                playersList.innerHTML += `<div>
                    <span style="display:flex;align-items:center;gap:6px;"><img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}&backgroundColor=2c2f4a" style="width:16px;border-radius:4px;"> ${String(uid) === String(robloxUserId) ? 'You' : username}</span>
                    <span>-</span>
                    <span>${bet.toLocaleString('en-US', {minimumFractionDigits:2})}</span>
                </div>`;
            }
        }

        socket?.on('crash:playerJoined', (data) => {
            appendPlayer(data.userId, data.username, data.bet, false, 0, 0);
            if (String(data.userId) === String(robloxUserId)) {
                cBet = Number(data.bet) || cBet;
                hasCashedOut = false;
                cMulti = 1.0;
                setCrashPendingCashoutButton();
            }
        });

        socket?.on('crash:playerCashedOut', (data) => {
            if (data.userId === String(robloxUserId)) {
                hasCashedOut = true;
                postLiveFeedRound('crash', cBet, data.multi, data.winAmt);
                if(typeof soundWin === 'function') soundWin();
                
                crashPlayBtn.textContent = 'Cashed out';
                crashPlayBtn.classList.remove('custom-cashout-btn');
                crashPlayBtn.style.background = 'var(--accent)';
                crashPlayBtn.disabled = true;
            }
            
            // Remove their pending row by wiping and syncing is better, but appending works for now.
            // The user requested quick real-time vibes.
            appendPlayer(data.userId, data.userId === String(robloxUserId) ? 'You' : 'Player', 0, true, data.winAmt, data.multi);
        });

        crashPlayBtn.addEventListener('click', (e) => {
            if(cState === 'idle' || cState === 'starting') {
                if(cBet > 0) return; 
                let bet = parseFloat(betInp.value) || 0;
                if(bet <= 0 || bet > roBalance) {
                    e.stopImmediatePropagation();
                    const warn = document.createElement('div');
                    warn.textContent = bet <= 0 ? 'Enter a valid bet amount!' : 'Not enough ZR$!';
                    warn.style.cssText='position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#2a1515;border:1px solid var(--red);color:var(--red);padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;';
                    document.body.appendChild(warn);
                    setTimeout(()=>warn.remove(), 2000);
                    return;
                }
                
                cAuto = parseFloat(autoInp.value) || 0;
                cBet = bet;
                cMulti = 1.0;
                
                // Do NOT manually deduct from UI, wait for the socket to 'balance:update' and confirm the bet!
                socket?.emit('crash:join', { userId: robloxUserId, username: currentUsername, bet, auto: cAuto });
                setCrashPendingCashoutButton();
                
            } else if(cState === 'running') {
                doCashout();
            }
        });
    }

});

// Footer year (safe no-op if footer not present)
document.addEventListener('DOMContentLoaded', () => {
    const y = document.getElementById('zr-footer-year');
    if (y) y.textContent = String(new Date().getFullYear());
});

function adjustBetInput(inputId, mode) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    const raw = parseFloat(inp.value);
    const current = Number.isFinite(raw) ? raw : 0;
    let next = mode === 'double' ? current * 2 : current / 2;
    next = Math.max(0.1, next);
    // Keep bet amounts clean and predictable: 1 decimal place max.
    next = Math.round(next * 10) / 10;
    inp.value = Number.isInteger(next) ? String(next) : next.toFixed(1);
}

window.halfBetInput = function(inputId) {
    adjustBetInput(inputId, 'half');
};

window.doubleBetInput = function(inputId) {
    adjustBetInput(inputId, 'double');
};

// ===== GLOBAL BALANCE SYSTEM =====
let _roBalance = 0.00;    // ZR$ (main currency)
Object.defineProperty(window, 'roBalance', {
    get: () => _roBalance,
    set: () => { /* silently block console manipulation */ },
    configurable: false
});
// roBalanceZh removed completely
let referralEarned = 0;
let referredCount = 0;

// ===== CLIENT-SIDE ACTIVE RAINS (synced from server via socket) =====
let activeRains = [];

// ====== SOCIAL MODALS (GLOBAL) ======
function openRainModal() {
    const modal = document.getElementById('rain-backdrop');
    if (modal) modal.classList.add('show');
}
function closeRainModal() {
    const modal = document.getElementById('rain-backdrop');
    if (modal) modal.classList.remove('show');
}
function openTipModal() {
    const modal = document.getElementById('tip-backdrop');
    if (modal) modal.classList.add('show');
}
function openTipFor(user) {
    const nameInp = document.getElementById('tip-recipient');
    if (nameInp) nameInp.value = user;
    openTipModal();
}
function closeTipModal() {
    const modal = document.getElementById('tip-backdrop');
    if (modal) modal.classList.remove('show');
}

function getZephrsChatUser() {
    return {
        name: currentUsername || 'Guest',
        level: Math.max(1, Math.floor((userStats.xp || 0) / 100) + 1)
    };
}

function updateBalanceDisplay() {
    const tbEl = document.getElementById('tb-balance');
    const homeEl = document.getElementById('home-balance');
    const formatted = roBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if(tbEl) tbEl.textContent = formatted;
    if(homeEl) homeEl.textContent = formatted;

    // Update ZH$ display if element exists
    const zhEl = document.getElementById('tb-balance-zh');
    if(zhEl) zhEl.textContent = formatted;

    // Animate the topbar value briefly
    const chip = document.querySelector('.balance-chip');
    if(chip) {
        chip.style.borderColor = 'var(--accent)';
        setTimeout(() => chip.style.borderColor = '', 600);
    }
}
updateBalanceDisplay();

// ===== SOUND SYSTEM (Web Audio API — no files needed) =====
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let _audioCtx;
function getAudioCtx() {
    if(!_audioCtx) _audioCtx = new AudioCtx();
    return _audioCtx;
}

function playTone(freq, duration, type = 'sine', vol = 0.3, delay = 0) {
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
        gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + duration);
    } catch(e) {}
}

function soundWin() {
    // Rising happy chord
    playTone(523, 0.15, 'sine', 0.35, 0);
    playTone(659, 0.15, 'sine', 0.3, 0.1);
    playTone(784, 0.3, 'sine', 0.35, 0.2);
    playTone(1047, 0.4, 'sine', 0.25, 0.35);
}

function soundLose() {
    // Descending buzz
    playTone(300, 0.12, 'sawtooth', 0.3, 0);
    playTone(220, 0.12, 'sawtooth', 0.3, 0.12);
    playTone(150, 0.25, 'sawtooth', 0.3, 0.24);
}

function soundGem() {
    // Soft pop/ping
    playTone(880, 0.08, 'sine', 0.2, 0);
    playTone(1320, 0.12, 'sine', 0.15, 0.05);
}

function soundBomb() {
    // Original boom character, lower pitch; one shared level for each layer
    const v = 0.25;
    playTone(52, 0.05, 'sawtooth', v, 0);
    playTone(38, 0.3, 'square', v, 0.05);
    playTone(26, 0.4, 'sawtooth', v, 0.1);
}

function soundClick() {
    playTone(600, 0.05, 'sine', 0.15, 0);
}

// ===== BALANCE HELPERS =====
// SECURITY: These are intentional NO-OPS.
// Balance is ONLY changed by the server via 'balance:remote_sync' socket events.
// Calling awardWin() or deductBet() from the browser console does NOTHING.
function deductBet(amount) { /* server-authoritative — no client-side balance change */ }
function awardWin(amount)  { /* server-authoritative — no client-side balance change */ }


// ===== GAME SESSION MANAGER (refresh / disconnect protection) =====
// Saves active game state to localStorage so the player can continue after a page refresh.
const GSM = (() => {
    const KEYS = {
        mines:     'zephrs_sess_mines',
        towers:    'zephrs_sess_towers',
        blackjack: 'zephrs_sess_blackjack'
    };
    return {
        save(game, data)   { try { localStorage.setItem(KEYS[game], JSON.stringify(data)); } catch(e) {} },
        load(game)         { try { return JSON.parse(localStorage.getItem(KEYS[game])); } catch(e) { return null; } },
        update(game, patch){ const cur = this.load(game) || {}; this.save(game, { ...cur, ...patch }); },
        clear(game)        { try { localStorage.removeItem(KEYS[game]); } catch(e) {} }
    };
})();

/** Show a small floating toast – used to inform the player when session was restored or refunded. */
function showGameToast(msg, color) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;bottom:30px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;
        background:#1c2333;border:1px solid ${color};color:${color};padding:14px 26px;
        border-radius:10px;font-size:13px;font-weight:600;z-index:99999;pointer-events:none;
        transition:opacity 0.35s,transform 0.35s;`;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(-50%) translateY(10px)';
        setTimeout(() => el.remove(), 400);
    }, 3800);
}

/**
 * Called on page load (after robloxUserId is available).
 * Checks localStorage for an interrupted game session and tries to restore it.
 * If the server still has the game in memory → UI is fully re-built so the player continues.
 * If the server restarted (cold-start) → we restore the server state from the saved tiles/rows.
 */
async function resumeGameSessions() {
    if (!robloxUserId) return;

    // ---- MINES ----
    const ms = GSM.load('mines');
    if (ms && ms.active && String(ms.userId) === String(robloxUserId)) {
        try {
            const r = await fetch(`/api/game/mines/status?userId=${encodeURIComponent(robloxUserId)}`);
            const d = await r.json();
            if (!d.active) {
                if (ms.revealed > 0) {
                    // Server lost game – rebuild it from the known safe tiles
                    await fetch('/api/game/mines/restore', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: robloxUserId, bombs: ms.bombs, revealedTiles: ms.revealedTiles })
                    });
                    if (typeof window._minesRestore === 'function') window._minesRestore(ms);
                    showGameToast('\uD83C\uDFAE Mines game restored!', 'var(--accent)');
                } else {
                    // No tiles revealed – refund bet and clear
                    if (ms.bet > 0) awardWin(ms.bet);
                    GSM.clear('mines');
                    showGameToast('\uD83D\uDD04 Your Mines bet was refunded (server restarted)', 'var(--accent)');
                }
            } else {
                // Server still has game – just restore the client UI
                if (typeof window._minesRestore === 'function') window._minesRestore(ms);
                showGameToast('\uD83C\uDFAE Mines game restored – continue where you left off!', 'var(--accent)');
            }
        } catch(e) {
            console.warn('[GSM] Mines restore error:', e);
        }
    }

    // ---- TOWERS ----
    const ts = GSM.load('towers');
    if (ts && ts.active && String(ts.userId) === String(robloxUserId)) {
        try {
            const r = await fetch(`/api/game/towers/status?userId=${encodeURIComponent(robloxUserId)}`);
            const d = await r.json();
            if (!d.active) {
                // Server lost game – rebuild towers logic
                const cfg = ts.diff === 'easy' ? { w: 4, b: 1 } : ts.diff === 'normal' ? { w: 3, b: 1 } : { w: 3, b: 2 };
                await fetch('/api/game/towers/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: robloxUserId, rows: 8, width: cfg.w, bombs: cfg.b })
                });
            }
            if (ts.curRow > 0) {
                if (typeof window._towersRestore === 'function') window._towersRestore(ts);
                showGameToast('\uD83C\uDFAE Towers game restored – continue where you left off!', 'var(--accent)');
            } else {
                // No rows climbed – refund
                if (ts.bet > 0) awardWin(ts.bet);
                GSM.clear('towers');
                showGameToast('\uD83D\uDD04 Your Towers bet was refunded (server restarted)', 'var(--accent)');
            }
        } catch(e) {
            console.warn('[GSM] Towers restore error:', e);
        }
    }

    // ---- BLACKJACK ----
    const bjs = GSM.load('blackjack');
    if (bjs && bjs.active && String(bjs.userId) === String(robloxUserId)) {
        if (typeof window._bjRestore === 'function') {
            window._bjRestore(bjs);
            if (bjs.pHand && bjs.dHand) showGameToast('\uD83C\uDCCF Blackjack hand restored – keep playing!', 'var(--accent)');
        }
    }
}

function getLiveFeedDisplayName() {
    try {
        if (typeof currentUsername === 'string' && currentUsername.trim().length > 0) {
            return currentUsername.trim().slice(0, 40);
        }
    } catch (e) {}
    return 'Guest';
}

function postLiveFeedRound(gameKey, bet, multiplier, grossPayout) {
    if (typeof window === 'undefined' || window.location.protocol === 'file:') return;
    const b = typeof bet === 'number' && bet >= 0 ? bet : 0;
    if (b <= 0) return;
    const m = typeof multiplier === 'number' && multiplier >= 0 ? multiplier : 0;
    const p = typeof grossPayout === 'number' ? grossPayout : 0;
    try {
        fetch(new URL('/api/live-feed', window.location.origin).href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: getLiveFeedDisplayName(),
                gameKey,
                bet: b,
                multiplier: m,
                payout: p
            })
        }).catch(() => {});
    } catch (e) {}
}

let _liveFeedFilter = 'all';

const GAME_FEED_META = {
    crash: { name: 'Crash', emoji: '🚀' },
    blackjack: { name: 'Blackjack', emoji: '🃏' },
    dice: { name: 'Dice', emoji: '🎲' },
    mines: { name: 'Mines', emoji: '💎' },
    towers: { name: 'Towers', emoji: '🏰' },
    plinko: { name: 'Plinko', emoji: '📊' },
    rooms: { name: 'Rooms', emoji: '🚪' }
};

function escapeFeedHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function formatFeedTime(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
}

function renderLiveFeedRows(events) {
    const body = document.getElementById('live-feed-body');
    if (!body) return;
    let list = Array.isArray(events) ? [...events] : [];
    if (_liveFeedFilter === 'high') {
        list = list.filter((e) => (e.payout || 0) > 0 && (e.bet || 0) >= 100);
    } else if (_liveFeedFilter === 'lucky') {
        list = list.filter((e) => (e.payout || 0) > 0 && (e.multiplier || 0) >= 3);
    }
    body.textContent = '';
    const slice = list.slice(0, 25);
    if (slice.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML =
            '<td colspan="6" style="padding:28px 12px; text-align:center; color:var(--text-secondary); font-size:13px;">No activity for this filter yet. Play a game or switch to All Games.</td>';
        body.appendChild(tr);
        return;
    }
    slice.forEach((ev) => {
        const meta = GAME_FEED_META[ev.gameKey] || { name: ev.gameKey || 'Game', emoji: '🎰' };
        const bet = Number(ev.bet) || 0;
        const mult = Number(ev.multiplier) || 0;
        const payoutVal = Number(ev.payout) || 0;
        const payoutStr = payoutVal >= 0 ? '+' + payoutVal.toFixed(2) : payoutVal.toFixed(2);
        const payoutClass = payoutVal > 0 ? 'payout-pos' : 'payout-neg';
        const timeStr = ev.createdAt ? formatFeedTime(ev.createdAt) : '--:--';
        const user = typeof ev.username === 'string' ? ev.username : 'Guest';
        const tr = document.createElement('tr');
        tr.innerHTML =
            '<td><span class="feed-game-emoji" aria-hidden="true">' +
            meta.emoji +
            '</span> <span class="feed-game-name">' +
            escapeFeedHtml(meta.name) +
            '</span></td>' +
            '<td><div style="display:flex; align-items:center;"><img src="https://api.dicebear.com/7.x/avataaars/svg?seed=' +
            encodeURIComponent(user) +
            '&backgroundColor=2c2f4a" alt="" style="width:24px;height:24px;border-radius:50%;margin-right:8px;"> ' +
            escapeFeedHtml(user) +
            '</div></td>' +
            '<td><span class="currency-inline">ZR$</span> ' +
            bet.toFixed(2) +
            '</td>' +
            '<td style="color:var(--text-secondary)">x' +
            mult.toFixed(2) +
            '</td>' +
            '<td class="' +
            payoutClass +
            '"><span class="currency-inline">ZR$</span> ' +
            payoutStr +
            '</td>' +
            '<td style="color:var(--text-secondary)">' +
            escapeFeedHtml(timeStr) +
            '</td>';
        body.appendChild(tr);
    });
}

async function refreshLiveFeed() {
    const body = document.getElementById('live-feed-body');
    if (!body || typeof window === 'undefined' || window.location.protocol === 'file:') return;
    try {
        const u = new URL('/api/live-feed', window.location.origin);
        u.searchParams.set('limit', '80');
        const res = await fetch(u.href);
        if (!res.ok) return;
        const data = await res.json();
        const rows = Array.isArray(data.events) ? data.events : [];
        renderLiveFeedRows(rows);
    } catch (e) {}
}

function initLiveFeed() {
    const body = document.getElementById('live-feed-body');
    if (!body || typeof window === 'undefined' || window.location.protocol === 'file:') return;
    const tabs = document.querySelectorAll('.live-feed-section .feed-tab');
    tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            _liveFeedFilter = i === 1 ? 'high' : i === 2 ? 'lucky' : 'all';
            refreshLiveFeed();
        });
    });
    refreshLiveFeed();
    setInterval(refreshLiveFeed, 5000);
}

// Re-wire game balance hooks (called after games init)
document.addEventListener('DOMContentLoaded', () => {
    patchBlackjackBalance();
    patchMinesBalance();
    patchTowersBalance();
    patchDiceBalance();
});

function patchBlackjackBalance() {
    const playBtn = document.getElementById('bj-play-btn');
    const hitBtn  = document.getElementById('bj-hit-btn');
    const standBtn = document.getElementById('bj-stand-btn');
    if(!playBtn) return;

    let bjLiveFeedLast = '';

    // Check balance before BJ start (server does the real deduction)
    playBtn.addEventListener('click', function(e) {
        const bjMsg = document.getElementById('bj-message');
        if(playBtn.textContent.trim() === 'Place bet') {
            const bet = parseFloat(document.getElementById('bj-bet-input').value) || 0;
            if(bet <= 0) { e.stopImmediatePropagation(); return; }
            if(bet > roBalance) {
                e.stopImmediatePropagation();
                if(bjMsg) { bjMsg.textContent = 'Not enough ZR$!'; bjMsg.style.color='var(--red)'; bjMsg.style.display='block'; }
                return;
            }
            // Do NOT deductBet — server handles it atomically
            GSM.save('blackjack', { active: true, userId: robloxUserId, bet, pHand: null, dHand: null, deck: null });
            bjLiveFeedLast = '';
            soundClick();
        }
    }, true);

    // Patch stand outcome via MutationObserver on bj-message
    const bjMsg = document.getElementById('bj-message');
    if(bjMsg) {
        const obs = new MutationObserver(() => {
            if(bjMsg.style.display === 'none') return;
            const txtRaw = bjMsg.textContent || '';
            const txt = txtRaw.toLowerCase().trim();
            if(txtRaw === bjLiveFeedLast) return;
            const bet = parseFloat(document.getElementById('bj-bet-input').value) || 0;
            
            // IMPORTANT: check 'dealer wins' FIRST — it contains the word 'win'
            if(txt === 'dealer wins') {
                bjLiveFeedLast = txtRaw;
                postLiveFeedRound('blackjack', bet, 0, -bet);
                soundLose();
            } else if(txt.includes('blackjack')) {
                bjLiveFeedLast = txtRaw;
                const gross = bet * 2.5;
                // awardWin removed — server credits via balance:remote_sync
                postLiveFeedRound('blackjack', bet, 2.5, gross);
                soundWin();
            } else if(txt.includes('win')) {
                bjLiveFeedLast = txtRaw;
                const gross = bet * 2;
                // awardWin removed — server credits via balance:remote_sync
                postLiveFeedRound('blackjack', bet, 2, gross);
                soundWin();
            } else if(txt.includes('push')) {
                bjLiveFeedLast = txtRaw;
                // awardWin removed — server credits via balance:remote_sync
                postLiveFeedRound('blackjack', bet, 1, bet);
                soundClick();
            } else if(txt.includes('lose') || txt.includes('bust')) {
                bjLiveFeedLast = txtRaw;
                postLiveFeedRound('blackjack', bet, 0, -bet);
                soundLose();
            }
        });
        obs.observe(bjMsg, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    }
}

function patchMinesBalance() {
    const playBtn = document.getElementById('mines-play-btn');
    const minesMsg = document.getElementById('mines-message');
    if(!playBtn) return;

    // Check balance before mines start (server does real atomic deduction)
    playBtn.addEventListener('click', function(e) {
        if(playBtn.textContent.trim() === 'Start new game') {
            const bet = parseFloat(document.getElementById('mines-bet-input').value) || 0;
            if(bet <= 0 || bet > roBalance) {
                e.stopImmediatePropagation();
                if(minesMsg) { minesMsg.textContent= bet <= 0 ? 'Enter a valid bet amount!' : 'Not enough ZR$!'; minesMsg.style.color='var(--red)'; minesMsg.style.display='block'; }
                return;
            }
            // Do NOT deductBet — server handles it atomically
            const _bombs = parseInt(document.getElementById('mines-count-input').value) || 3;
            GSM.save('mines', { active: true, userId: robloxUserId, bet, bombs: _bombs, revealedTiles: [], revealed: 0, multiplier: 1.0 });
            minesFeedLast = '';
        }
    }, true);

    let minesFeedLast = '';

    // Listen on mines-message for outcome
    if(minesMsg) {
        const obs = new MutationObserver(() => {
            if(minesMsg.style.display === 'none') return;
            const txtRaw = minesMsg.textContent || '';
            const txt = txtRaw.toLowerCase();
            const bet = parseFloat(document.getElementById('mines-bet-input').value) || 0;
            if(txt.startsWith('won')) {
                if(txtRaw === minesFeedLast) return;
                minesFeedLast = txtRaw;
                const val = parseFloat(minesMsg.textContent.replace(/Won/gi, '')) || 0;
                const mult = bet > 0 ? val / bet : 0;
                postLiveFeedRound('mines', bet, mult, val);
                // awardWin removed — server credits via balance:remote_sync
                soundWin();
            } else if(txt.includes('busted')) {
                if(txtRaw === minesFeedLast) return;
                minesFeedLast = txtRaw;
                postLiveFeedRound('mines', bet, 0, -bet);
            }
            // bust: bomb SFX only from the clicked tile (not mines-message observer)
        });
        obs.observe(minesMsg, { attributes: true, attributeFilter: ['style'] });
    }

    // Mines gem/bomb SFX: handled in handleTileClick (mGrid) — no grid observer (avoids stacked tones)
}

function patchTowersBalance() {
    const playBtn = document.getElementById('towers-play-btn');
    const tMsg = document.getElementById('towers-message');
    if(!playBtn) return;

    playBtn.addEventListener('click', function(e) {
        if(playBtn.textContent.trim() === 'Start new game') {
            const bet = parseFloat(document.getElementById('towers-bet-input').value) || 0;
            if(bet <= 0 || bet > roBalance) {
                e.stopImmediatePropagation();
                if(tMsg) { tMsg.textContent= bet <= 0 ? 'Enter a valid bet amount!' : 'Not enough ZR$!'; tMsg.style.color='var(--red)'; tMsg.style.display='block'; }
                return;
            }
            // Do NOT deductBet — server handles it atomically
            const _diff = document.querySelector('.towers-diff-tabs .diff-btn.active')?.dataset.diff || 'easy';
            GSM.save('towers', { active: true, userId: robloxUserId, bet, diff: _diff, curRow: 0, multiplier: 1.0, revealedRows: [] });
            towersFeedLast = '';
        }
    }, true);

    let towersFeedLast = '';

    if(tMsg) {
        const obs = new MutationObserver(() => {
            if(tMsg.style.display === 'none') return;
            const txtRaw = tMsg.textContent || '';
            const txt = txtRaw.toLowerCase();
            const bet = parseFloat(document.getElementById('towers-bet-input').value) || 0;
            if(txt.startsWith('won')) {
                if(txtRaw === towersFeedLast) return;
                towersFeedLast = txtRaw;
                const val = parseFloat(tMsg.textContent.replace(/Won/gi, '')) || 0;
                const mult = bet > 0 ? val / bet : 0;
                postLiveFeedRound('towers', bet, mult, val);
                // awardWin removed — server credits via balance:remote_sync
                soundWin();
            } else if(txt === 'busted!') {
                if(txtRaw === towersFeedLast) return;
                towersFeedLast = txtRaw;
                postLiveFeedRound('towers', bet, 0, -bet);
                soundLose();
            }
        });
        obs.observe(tMsg, { attributes: true, attributeFilter: ['style'] });
    }

    // Gem/bomb sounds on tower tiles
    const tGrid = document.getElementById('towers-grid-container');
    if(tGrid) {
        const tileObs = new MutationObserver(muts => {
            muts.forEach(m => {
                if(m.type==='attributes' && m.attributeName==='class') {
                    const el = m.target;
                    if(el.classList.contains('gem') && !el.dataset.sounded) {
                        el.dataset.sounded = '1';
                        soundGem();
                    } else if(el.classList.contains('bomb') && !el.dataset.sounded) {
                        el.dataset.sounded = '1';
                        soundBomb();
                    }
                }
            });
        });
        tileObs.observe(tGrid, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
}

function patchDiceBalance() {
    const playBtn = document.getElementById('dice-play-btn');
    const resultMarker = document.getElementById('dice-result-marker');
    if(!playBtn) return;

    playBtn.addEventListener('click', function(e) {
        const bet = parseFloat(document.getElementById('dice-bet-input').value) || 0;
        if(bet <= 0 || bet > roBalance) {
            e.stopImmediatePropagation();
            const warn = document.createElement('div');
            warn.textContent = bet <= 0 ? 'Enter a valid bet amount!' : 'Not enough ZR$!';
            warn.style.cssText='position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#2a1515;border:1px solid var(--red);color:var(--red);padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;';
            document.body.appendChild(warn);
            setTimeout(()=>warn.remove(), 2000);
            return;
        }
        // Do NOT deductBet — server handles it atomically in /api/game/dice
    }, true);

    let diceFeedAt = 0;

    // Listen for result marker win/lose class
    if(resultMarker) {
        const obs = new MutationObserver(() => {
            if(!resultMarker.classList.contains('show')) return;
            if(Date.now() - diceFeedAt < 450) return;
            diceFeedAt = Date.now();
            const bet = parseFloat(document.getElementById('dice-bet-input').value) || 0;
            const multi = parseFloat(document.getElementById('dice-multi-input').value) || 1;
            if(resultMarker.classList.contains('win')) {
                const gross = bet * multi;
                // awardWin removed — server credits via balance:remote_sync
                postLiveFeedRound('dice', bet, multi, gross);
                soundWin();
            } else {
                // awardWin removed — server is authoritative for balance
                postLiveFeedRound('dice', bet, 0, -bet);
                soundLose();
            }
        });
        obs.observe(resultMarker, { attributes: true, attributeFilter: ['class'] });
    }
}

// ===== DEPOSIT MODAL (game pass tiers: Robux paid = same ZR$ credit; IDs must match server GAME_PASS_CREDIT_BY_ID) =====
const GAME_PASS_DEPOSIT_TIERS = [
    { id: 1784194501, robux: 7 },
    { id: 1783449405, robux: 8 },
    { id: 1784128758, robux: 9 },
    { id: 1784222735, robux: 10 },
    { id: 1784188882, robux: 15 },
    { id: 1784300749, robux: 20 },
    { id: 1784700043, robux: 25 },
    { id: 1784130820, robux: 30 },
    { id: 1784396767, robux: 35 },
    { id: 1784082914, robux: 40 },
    { id: 1783926960, robux: 45 },
    { id: 1784340755, robux: 50 },
    { id: 1784248824, robux: 60 },
    { id: 1783479386, robux: 70 },
    { id: 1790780840, robux: 75 },
    { id: 1784464672, robux: 80 },
    { id: 1784464674, robux: 90 },
    { id: 1783918985, robux: 100 }
];

let selectedDepTierId = null;

function initDepGamePassGrid() {
    const grid = document.getElementById('dep-tiers-grid');
    if (!grid) return;
    
    const sorted = [...GAME_PASS_DEPOSIT_TIERS].sort((a, b) => a.robux - b.robux);
    
    // Filter out already deposited tiers
    const usedIds = Array.isArray(userStats.depositedPassIds) ? userStats.depositedPassIds : [];
    const available = sorted.filter(t => !usedIds.includes(t.id));
    
    if (available.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 20px; color: var(--text-secondary);">
            <i class="fa-solid fa-check-circle" style="font-size: 32px; color: var(--green); margin-bottom: 10px; display: block;"></i>
            No tiers available. You've deposited everything!
        </div>`;
        return;
    }

    grid.innerHTML = available.map(t => `
        <div class="dep-tier-btn ${selectedDepTierId === t.id ? 'active' : ''}" data-id="${t.id}" onclick="selectDepTier(this, ${t.id})">
            <div class="dep-tier-robux">
                <i class="fa-solid fa-gem"></i>
                ${t.robux}
            </div>
            <div class="dep-tier-zr">${t.robux} ZR$</div>
        </div>
    `).join('');
    
    syncDepGamePassLink();
}

function selectDepTier(el, id) {
    selectedDepTierId = id;
    document.querySelectorAll('.dep-tier-btn').forEach(btn => btn.classList.remove('active'));
    el.classList.add('active');
    syncDepGamePassLink();
}

function syncDepGamePassLink() {
    const link = document.getElementById('dep-gamepass-store-link');
    const desc = document.getElementById('dep-gamepass-tier-desc');
    if (!link) return;
    
    const tier = GAME_PASS_DEPOSIT_TIERS.find(t => t.id === selectedDepTierId);
    if (!tier) {
        link.style.display = 'none';
        if (desc) desc.textContent = 'Select a tier above to see details.';
        return;
    }
    
    link.style.display = 'block';
    link.href = `https://www.roblox.com/game-pass/${tier.id}/${tier.robux}`;
    if (desc) {
        desc.textContent = `You pay ${tier.robux} Robux on Roblox; we credit ${tier.robux} ZR$ after verification.`;
    }
}

function getSelectedDepGamePassId() {
    return selectedDepTierId || 0;
}

// ===== DEPOSIT MODAL =====
function openDepositModal() {
    const backdrop = document.getElementById('deposit-backdrop');
    backdrop.classList.add('show');
    goDepPage(1);
}

function closeDepositModal(event) {
    if(event && event.target !== event.currentTarget) return;
    const backdrop = document.getElementById('deposit-backdrop');
    backdrop.classList.remove('show');
    const depErr = document.getElementById('dep-gamepass-error');
    if(depErr) {
        depErr.textContent = '';
        depErr.style.display = 'none';
    }
}

function goDepPage(num) {
    document.querySelectorAll('.dep-page').forEach(p => p.style.display = 'none');
    const page = document.getElementById('dep-page-' + num);
    if(page) page.style.display = 'block';
    if(num === 3) updateDepGamePassUi();
    if(num === 'crypto1') updateCryptoMinAmount();
}

function updateDepGamePassUi() {
    const btn = document.getElementById('dep-gamepass-verify-btn');
    if(btn && !btn.disabled) btn.textContent = 'Verify purchase';
    initDepGamePassGrid();
}

function showComingSoon() {
    const toast = document.createElement('div');
    toast.textContent = 'This payment method is coming soon!';
    toast.style.cssText = `
        position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
        background: #20233b; border: 1px solid #2c2f4a;
        color: white; padding: 12px 24px; border-radius: 10px;
        font-size: 13px; font-weight: 600; z-index: 9999;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

async function confirmGamePassDeposit() {
    const errEl = document.getElementById('dep-gamepass-error');
    if(errEl) {
        errEl.style.display = 'none';
        errEl.textContent = '';
    }
    if(typeof robloxUserId !== 'number' || robloxUserId <= 0) {
        if(errEl) {
            errEl.textContent = 'Sign in with your Roblox account first.';
            errEl.style.display = 'block';
        }
        return;
    }
    if(typeof window !== 'undefined' && window.location.protocol === 'file:') {
        if(errEl) {
            errEl.textContent =
                "Deposits require this app's server. Run npm start and open http://localhost:8080.";
            errEl.style.display = 'block';
        }
        return;
    }
    const gamePassId = getSelectedDepGamePassId();
    if(!gamePassId) {
        if(errEl) {
            errEl.textContent = 'Choose a deposit amount first.';
            errEl.style.display = 'block';
        }
        return;
    }
    const btn = document.getElementById('dep-gamepass-verify-btn');
    const oldLabel = btn ? btn.textContent : '';
    if(btn) {
        btn.disabled = true;
        btn.textContent = 'Verifying...';
    }
    try {
        const res = await fetch(new URL('/api/gamepass-deposit-claim', window.location.origin).href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: robloxUserId,
                gamePassId
            })
        });
        const j = await res.json().catch(() => ({}));
        if(!res.ok) {
            let msg =
                typeof j.error === 'string' && j.error.length > 0
                    ? j.error
                    : res.status === 429
                      ? 'Please wait a couple of seconds and try again.'
                      : 'Verification failed.';
            if (typeof j.detail === 'string' && j.detail.length > 0) {
                msg += ' — ' + j.detail;
            } else if (typeof j.step === 'string' && j.step.length > 0) {
                msg += ' (' + j.step + ')';
            }
            throw new Error(msg);
        }
        if(j.save && typeof j.save === 'object') applySavePayload(j.save);
        updateDepGamePassUi();
        saveToStorage();
        updateBalanceDisplay();
        updateProfViews();
        soundWin();
        const msg = document.getElementById('dep-success-msg');
        const credited = typeof j.credited === 'number' ? j.credited : 7;
        if(msg) msg.textContent = `+${credited.toFixed(2)} ZR$ added to your balance.`;
        goDepPage(4);
        
        // Scan immediately after successful deposit to trigger lock screen if needed
        if (typeof performActiveGamepassScan === 'function') {
            performActiveGamepassScan(true);
        }
    } catch(e) {
        if(errEl) {
            errEl.textContent = e && typeof e.message === 'string' ? e.message : 'Verification failed.';
            errEl.style.display = 'block';
        }
    } finally {
        if(btn) {
            btn.disabled = false;
            btn.textContent = oldLabel || 'Verify purchase';
        }
    }
}

// ===== WITHDRAW MODAL =====
function openWithdrawModal() {
    const backdrop = document.getElementById('withdraw-backdrop');
    if(backdrop) {
        backdrop.classList.add('show');
        goWdPage(1);
    }
}

function closeWithdrawModal(event) {
    if(event && event.target !== event.currentTarget) return;
    const backdrop = document.getElementById('withdraw-backdrop');
    if(backdrop) backdrop.classList.remove('show');
    
    if(wdCooldownInterval) {
        clearInterval(wdCooldownInterval);
        wdCooldownInterval = null;
    }

    const inp = document.getElementById('wd-amount-input');
    if(inp) {
        inp.value = 15;
        inp.dispatchEvent(new Event('input'));
    }
}

let wdCooldownInterval = null;
function refreshWithdrawCooldown() {
    const btn = document.getElementById('wd-continue-btn');
    if(!btn) return;

    if (userStats.withdrawAccessRevoked) {
        btn.disabled = true;
        btn.textContent = 'Access revoked';
        btn.classList.add('wd-btn-access-revoked');
        btn.style.opacity = '1';
        return true;
    }
    btn.classList.remove('wd-btn-access-revoked');

    const lastWd = userStats.lastWithdrawAt || 0;
    const cooldownMs =
        typeof userStats.withdrawCooldownMs === 'number' && userStats.withdrawCooldownMs > 0
            ? userStats.withdrawCooldownMs
            : 30 * 60 * 1000;
    const now = Date.now();
    const diff = now - lastWd;

    if(diff < cooldownMs) {
        const remaining = cooldownMs - diff;
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        
        btn.disabled = true;
        btn.textContent = `On Cooldown (${timeStr})`;
        btn.style.opacity = '0.7';
        return true; // on cooldown
    } else {
        // Only reset text/style if it was on cooldown, don't just enable (amount check might still want it disabled)
        if(btn.textContent.includes('Cooldown')) {
            btn.textContent = 'Withdraw — Bot Buys Instantly';
            btn.style.opacity = '';
            // Trigger an input event to let the amount validator decide the final disabled state
            const inp = document.getElementById('wd-amount-input');
            if(inp) inp.dispatchEvent(new Event('input'));
        }
        return false; // not on cooldown
    }
}

function goWdPage(num) {
    document.querySelectorAll('#withdraw-backdrop .wd-page').forEach(p => p.style.display = 'none');
    const page = document.getElementById('wd-page-' + num);
    if(page) page.style.display = 'block';
    
    if(num === 2) {
        const avail = document.getElementById('wd-avail-bal');
        if(avail) avail.textContent = roBalance.toFixed(2);
        
        // Start cooldown check timer
        if(!wdCooldownInterval) {
            refreshWithdrawCooldown();
            wdCooldownInterval = setInterval(refreshWithdrawCooldown, 1000);
        }
    } else {
        if(wdCooldownInterval) {
            clearInterval(wdCooldownInterval);
            wdCooldownInterval = null;
        }
    }
}

function showWdComingSoon() {
    showComingSoon();
}

function addWdAmt(val) {
    const inp = document.getElementById('wd-amount-input');
    if(inp) {
        inp.value = parseInt(inp.value || 0) + val;
        inp.dispatchEvent(new Event('input'));
    }
}

const wdAmtInput = document.getElementById('wd-amount-input');
if(wdAmtInput) {
    wdAmtInput.addEventListener('input', () => {
        const coins = parseInt(wdAmtInput.value) || 0;
        const beforeTax = Math.floor(coins / 1.5);
        const afterTax = Math.floor(beforeTax * 0.7);
        
        const bEl = document.getElementById('wd-before-tax');
        const aEl = document.getElementById('wd-after-tax');
        const wdWrap = wdAmtInput.closest('.wd-input-wrap');
        const errEl = document.getElementById('wd-error-msg');
        
        if (beforeTax > 150) {
            if (wdWrap) wdWrap.style.borderColor = 'var(--red)';
            if (errEl) { errEl.textContent = 'Maximum withdrawal per transaction is 150 R$.'; errEl.style.display = 'block'; }
            const btn = document.getElementById('wd-continue-btn');
            if (btn) btn.disabled = true;
        } else {
            if (wdWrap) wdWrap.style.borderColor = '';
            if (errEl) errEl.style.display = 'none';
            const btn = document.getElementById('wd-continue-btn');
            if (btn && !btn.textContent.includes('Cooldown') && !userStats.withdrawAccessRevoked) {
                btn.disabled = false;
            }
        }

        if(bEl) bEl.value = beforeTax;
        if(aEl) aEl.textContent = afterTax;

        // Update the required gamepass price label
        const priceLabel = document.getElementById('wd-req-gamepass-price');
        if(priceLabel) priceLabel.textContent = beforeTax + ' R$';

        refreshWithdrawCooldown();
    });
}

function extractGamepassId(link) {
    // Matches: roblox.com/game-pass/12345678/... or roblox.com/catalog/12345678/...
    const m = String(link).match(/\/(?:game-pass|catalog)\/(\d+)/i);
    return m ? m[1] : null;
}

async function confirmWithdraw() {
    const inp = document.getElementById('wd-amount-input');
    const coins = parseFloat(inp ? inp.value : 0) || 0;
    const beforeTax = Math.floor(coins / 1.5);
    const afterTax = Math.floor(beforeTax * 0.7);
    const errEl = document.getElementById('wd-error-msg');

    const btn = document.getElementById('wd-continue-btn');
    const oldTxt = btn ? btn.textContent : '';

    function showErr(msg) {
        if(errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    }
    if(errEl) errEl.style.display = 'none';

    if (userStats.withdrawAccessRevoked) {
        showErr('Withdrawal access has been revoked for this account.');
        return;
    }

    const wdWrap = inp && inp.closest('.wd-input-wrap');
    if(afterTax < 7) {
        if(wdWrap) wdWrap.style.borderColor = 'var(--red)';
        setTimeout(() => { if(wdWrap) wdWrap.style.borderColor = ''; }, 2000);
        showErr('Minimum withdrawal is 7 R$ after tax.');
        return;
    }
    
    if(beforeTax > 150) {
        if(wdWrap) wdWrap.style.borderColor = 'var(--red)';
        setTimeout(() => { if(wdWrap) wdWrap.style.borderColor = ''; }, 2000);
        showErr('Maximum withdrawal is 150 R$ per transaction.');
        return;
    }

    if(coins > roBalance) {
        showErr('Not enough ZR$ balance to withdraw this amount.');
        return;
    }

    // Validate gamepass link
    const linkInput = document.getElementById('wd-gamepass-link');
    const gpLink = linkInput ? linkInput.value.trim() : '';
    const gpId = extractGamepassId(gpLink);
    if(!gpId) {
        showErr('Please paste a valid Roblox Gamepass link (e.g. https://www.roblox.com/game-pass/12345678/...).');
        return;
    }

    if(typeof robloxUserId !== 'number' || robloxUserId <= 0) {
        showErr('You must be signed in with your Roblox account before withdrawing.');
        return;
    }

    if(window.location.protocol === 'file:') {
        showErr('Withdrawals require the local server. Run npm start and open http://localhost:8080.');
        return;
    }

    // Show processing spinner
    goWdPage(3);
    if(btn) { btn.disabled = true; btn.textContent = 'Processing...'; }

    try {
        const res = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: robloxUserId,
                gamepassId: gpId,
                zrCoins: coins,
                expectedRobux: beforeTax
            })
        });

        const j = await res.json().catch(() => ({}));

        if(!res.ok) {
            // Go back to page 2 and show error
            goWdPage(2);
            showErr(j.error || 'Withdrawal failed. Please try again.');
            return;
        }

        // SUCCESS - now deduct balance locally and persist
        _roBalance -= coins;
        userStats.withdrawn += coins;
        userStats.lastWithdrawAt = Date.now();
        addTransaction('Withdrawal (' + afterTax + ' R$ received)', -coins, 'withdraw');
        updateBalanceDisplay();
        updateProfViews();
        saveToStorage();


        const msg = document.getElementById('wd-success-msg');
        if(msg) msg.textContent = `Success! The bot purchased your ${beforeTax} R$ gamepass. You will receive ${afterTax} R$ (after Roblox 30% tax) in your pending balance shortly.`;
        goWdPage(4);

    } catch(e) {
        goWdPage(2);
        showErr('Network error: ' + (e && e.message ? e.message : 'Could not reach server.'));
    } finally {
        if(btn) { btn.disabled = false; btn.textContent = oldTxt || 'Withdraw Robux'; }
    }
}

// ===== CRYPTO WITHDRAWAL SYSTEM =====
function updateCryptoWdPreview() {
    const amtStr = document.getElementById('wd-crypto-amount')?.value;
    const prevEl = document.getElementById('wd-crypto-fiat-preview');
    if (!amtStr || !prevEl) return;
    
    let zhAmt = parseInt(amtStr, 10);
    if (isNaN(zhAmt) || zhAmt < 0) zhAmt = 0;
    
    // Convert ZH$ to EUR
    const eurVal = (zhAmt * 0.007).toFixed(2);
    prevEl.textContent = `${eurVal} EUR`;
}

async function requestCryptoWithdraw() {
    if (!robloxUserId) return alert("You must be signed in.");
    
    const coin = document.getElementById('wd-crypto-coin').value;
    const address = document.getElementById('wd-crypto-address').value.trim();
    const extraId = document.getElementById('wd-crypto-extra').value.trim();
    const zhAmount = parseInt(document.getElementById('wd-crypto-amount').value, 10);
    const errEl = document.getElementById('wd-crypto-error-msg');
    const btn = document.getElementById('wd-crypto-submit-btn');
    
    const showErr = (msg) => {
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    };
    if (errEl) errEl.style.display = 'none';
    
    if (isNaN(zhAmount) || zhAmount < 1800) {
        return showErr("Minimum withdrawal is 1800 ZH$.");
    }
    if (!address) {
        return showErr("Please provide your destination wallet address.");
    }
    
    // Determine if coin REQUIRES tag (like XRP, XLM)
    const requiresTag = ['xrp', 'xlm'].includes(coin.toLowerCase());
    if (requiresTag && !extraId) {
        return showErr(`A Destination Tag / Memo is REQUIRED for ${coin.toUpperCase()} withdrawals or your funds will be lost!`);
    } else if (requiresTag && extraId.length < 2) {
        return showErr("Please enter a valid Destination Tag.");
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Processing...';
    }

    try {
        const res = await fetch('/api/withdraw/crypto/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: robloxUserId, coin, address, extraId, zhAmount })
        });
        const data = await res.json();
        
        if (!data.ok) {
            throw new Error(data.error || 'Failed to submit withdrawal request.');
        }
        
        // Success
        saveToStorage(); // Force local flush
        goWdPage(1); // Return to index page
        setTimeout(() => alert('Crypto Withdrawal Requested successfully! It is now pending admin review.'), 300);
        
    } catch(e) {
        showErr(e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Request Withdrawal';
        }
    }
}


// ===== PROFILE SYSTEM =====
let userStats = {
    rainWinnings: 0,
    deposited: 0,
    withdrawn: 0,
    wagered: 0,
    xp: 0,
    lastWithdrawAt: 0,
    depositedPassIds: [],
    withdrawAccessRevoked: false
};
let transactions = [];
let currentUsername = 'artirzu';
/** Set after Roblox username API confirms account; used with avatar URL. */
let robloxUserId = null;
/** CDN headshot URL from server (thumbnails.roblox.com) — survives reloads; www.roblox.com image URLs often break in <img>. */
let robloxAvatarUrl = null;

function accountsMatchServerLocal(a, b) {
    if (a == null || b == null) return false;
    const sa = String(a).trim();
    const sb = String(b).trim();
    if (sa === sb) return true;
    if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
        return parseInt(sa, 10) === parseInt(sb, 10);
    }
    return false;
}

/** Must match server.js / api/roblox-verify.js — letters + digits only (no symbols Roblox may strip). */
const ROVERIFY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROVERIFY_LEN = 12;

function generateRobloxVerificationCode() {
    const arr = new Uint8Array(ROVERIFY_LEN);
    crypto.getRandomValues(arr);
    let s = '';
    for(let i = 0; i < ROVERIFY_LEN; i++) {
        s += ROVERIFY_CHARS[arr[i] % ROVERIFY_CHARS.length];
    }
    return s;
}

function generateTxId() {
    return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

function formatTxDate() {
    const d = new Date();
    const str = d.toDateString(); // "Sat Mar 21 2026"
    return str.substring(0,10) + ' ' + d.getFullYear() + ' ' + d.toTimeString().substring(0, 5);
}

function addTransaction(desc, amount, type) {
    transactions.unshift({
        id: generateTxId(),
        desc: desc,
        date: formatTxDate(),
        amount: amount,
        type: type
    });
}

function updateProfViews() {
    const usernameEl = document.getElementById('prof-username-disp');
    if(usernameEl) usernameEl.textContent = currentUsername;
    
    const rEl=document.getElementById('prof-rain'); if(rEl) rEl.textContent = userStats.rainWinnings;
    const dEl=document.getElementById('prof-deposited'); if(dEl) dEl.textContent = userStats.deposited.toFixed(2);
    const wEl=document.getElementById('prof-withdrawn'); if(wEl) wEl.textContent = userStats.withdrawn.toFixed(2);
    const wgEl=document.getElementById('prof-wagered'); if(wgEl) wgEl.textContent = userStats.wagered.toFixed(2);
    const xpEl=document.getElementById('prof-xp'); if(xpEl) xpEl.textContent = userStats.xp;
    
    renderTxList('prof-tx-list', transactions);
    renderTxList('prof-dep-list', transactions.filter(t => t.type === 'deposit'));
    renderTxList('prof-wd-list', transactions.filter(t => t.type === 'withdraw'));
}

function renderTxList(containerId, list) {
    const container = document.getElementById(containerId);
    if(!container) return;
    if(list.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding: 40px; color:var(--text-secondary); font-size:13px;">No records yet.</div>`;
        return;
    }
    
    let html = '';
    list.forEach(tx => {
        const isPos = tx.amount > 0;
        const color = isPos ? 'var(--green)' : 'white';
        const sign = isPos ? '+' : '';
        html += `
        <div class="prof-tx-row">
            <div style="color:white; font-family:monospace;">${tx.id}</div>
            <div style="color:white; font-weight:600;">${tx.desc}</div>
            <div>${tx.date}</div>
            <div style="text-align:right; color:${color}; font-weight:700;">${sign}${tx.amount.toFixed(2)} <span class="currency-inline" style="color:white;">ZR$</span></div>
        </div>`;
    });
    container.innerHTML = html;
}

document.addEventListener('DOMContentLoaded', () => {
    initWelcomeModal();
    const logoutBtn = document.getElementById('tb-logout-btn');
    if(logoutBtn) logoutBtn.addEventListener('click', performLogout);
    // Profile Tabs Setup
    document.querySelectorAll('.prof-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.prof-tab').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            const tab = e.target.getAttribute('data-ptab');
            document.querySelectorAll('.ptab-content').forEach(c => c.style.display = 'none');
            const target = document.getElementById('ptab-' + tab);
            if(target) target.style.display = 'block';
            
            if (tab === 'withdrawals') {
                loadProfileCryptoWd();
            }
        });
    });
});

async function loadProfileCryptoWd() {
    const listDiv = document.getElementById('prof-crypto-wd-list');
    if (!listDiv || !robloxUserId) return;
    try {
        const res = await fetch('/api/withdraw/crypto/list?userId=' + robloxUserId);
        const data = await res.json();
        
        if (!data.list || data.list.length === 0) {
            listDiv.innerHTML = '<div style="text-align:center; padding: 20px; color:var(--text-secondary); font-size:13px;">No crypto withdrawals yet.</div>';
            return;
        }
        
        listDiv.innerHTML = data.list.map(wd => {
            let statusColor = "var(--text-secondary)";
            let statusText = wd.status.toUpperCase();
            if (wd.status === 'pending') statusColor = "orange";
            if (wd.status === 'paid') statusColor = "var(--green)";
            if (wd.status === 'cancelled' || wd.status === 'rejected') statusColor = "var(--red)";
            
            const dateStr = new Date(wd.createdAt).toLocaleString();
            
            return `
            <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-color); border-radius:6px; padding:12px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-size:14px; font-weight:bold; color:white; margin-bottom:4px;">${wd.zhAmount} ZH$ &nbsp;<i class="fa-solid fa-arrow-right-long" style="opacity:0.5; font-size:10px;"></i>&nbsp; <span style="text-transform:uppercase; color:var(--accent);">${wd.coin}</span></div>
                    <div style="font-size:11px; color:var(--text-secondary); margin-bottom:2px;">Wallet: ${wd.address}</div>
                    <div style="font-size:10px; color:var(--text-secondary);">${dateStr}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:12px; font-weight:bold; color:${statusColor}; margin-bottom:6px;">${statusText}</div>
                    ${wd.status === 'pending' ? `<button class="btn-secondary" style="padding:4px 10px; font-size:11px; color:var(--red); border-color:var(--red);" onclick="cancelCryptoWd('${wd.id}')">Cancel</button>` : ''}
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error(e);
    }
}

async function cancelCryptoWd(wdId) {
    if (!confirm('Are you sure you want to cancel this withdrawal and refund your ZH$?')) return;
    try {
        const res = await fetch('/api/withdraw/crypto/cancel', {
            method: 'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ userId: robloxUserId, wdId })
        });
        const data = await res.json();
        if(!data.ok) throw new Error(data.error || 'Failed to cancel');
        alert('Withdrawal cancelled. Your ZH$ has been refunded.');
        loadProfileCryptoWd();
        saveToStorage(); // triggers global refresh of balances
    } catch (e) {
        alert(e.message);
    }
}

function saveProfUsername() {
    const inp = document.getElementById('prof-new-username');
    if(inp && inp.value.trim().length > 0) {
        currentUsername = inp.value.trim();
        robloxUserId = null;
        robloxAvatarUrl = null;
        applyUsername(currentUsername);
        saveToStorage();
        updateProfViews();
        // btn feedback
        const btn = inp.parentElement.nextElementSibling;
        const old = btn.textContent;
        btn.textContent = 'Saved!';
        btn.style.background = 'var(--green)';
        setTimeout(() => { btn.textContent = old; btn.style.background = ''; }, 2000);
    }
}

// XP Setup
const xpBuyInp = document.getElementById('xp-buy-amount');
if(xpBuyInp) {
    xpBuyInp.addEventListener('input', () => {
        const amt = parseInt(xpBuyInp.value) || 0;
        const received = Math.floor(amt / 200);
        const recvEl = document.getElementById('xp-buy-receive');
        if(recvEl) recvEl.textContent = received;
    });
}
function confirmBuyXp() {
    const amt = parseInt(xpBuyInp.value) || 0;
    const received = Math.floor(amt / 200);
    const btn = document.getElementById('btn-buyxp');
    if(!btn) return;
    const old = btn.textContent;
    
    if(amt < 200) {
        btn.textContent = 'Min is 200';
        btn.style.background = 'var(--red)';
        setTimeout(() => { btn.textContent = old; btn.style.background = ''; }, 2000);
        return;
    }
    if(amt > roBalance) {
        btn.textContent = 'Not enough ZR$';
        btn.style.background = 'var(--red)';
        setTimeout(() => { btn.textContent = old; btn.style.background = ''; }, 2000);
        return;
    }

    _roBalance -= amt;
    userStats.xp += received;
    updateBalanceDisplay();
    updateProfViews();
    saveToStorage();
    soundWin();
    
    btn.textContent = 'Successfully swapped!';
    btn.style.background = 'var(--green)';
    setTimeout(() => { btn.textContent = old; btn.style.background = ''; }, 2000);
}

// ===== PERSISTENCE (localStorage + optional server sync) =====
const SAVE_KEY = 'zephrs_save_v1';
/** Real-time Socket connection — same host by default; on split static/API deploy set window.SOCKET_IO_SERVER = 'https://your-api.onrender.com' */
const _socketIoUrl =
    typeof window !== 'undefined' &&
    typeof window.SOCKET_IO_SERVER === 'string' &&
    window.SOCKET_IO_SERVER.trim()
        ? window.SOCKET_IO_SERVER.trim().replace(/\/$/, '')
        : undefined;
const _socketIoOpts = { transports: ['websocket', 'polling'], path: '/socket.io/' };
const socket =
    typeof io !== 'undefined'
        ? _socketIoUrl
            ? io(_socketIoUrl, _socketIoOpts)
            : io(_socketIoOpts)
        : null;

if(socket) {
    socket.on('chat-msg', (data) => {
        if(data.text.startsWith('!rain')) {
            const modal = document.getElementById('rain-modal');
            if(modal) modal.style.display = 'flex';
        } else if(data.text.startsWith('!tip')) {
            const modal = document.getElementById('tip-modal');
            if(modal) modal.style.display = 'flex';
        }
    });
}

function buildSaveObject() {
    return {
        username: currentUsername,
        robloxUserId: robloxUserId,
        robloxAvatarUrl: robloxAvatarUrl,
        balance: roBalance,
        referralEarned: referralEarned,
        referredCount: referredCount,
        stats: { ...userStats },
        transactions: transactions.slice(0, 100),
        savedAt: Date.now()
    };
}

function applySavePayload(data) {
    if(!data || typeof data !== 'object') return;
    if(typeof data.username === 'string' && data.username.length > 0) currentUsername = data.username;
    if(typeof data.robloxUserId === 'number' && data.robloxUserId > 0) robloxUserId = data.robloxUserId;
    else if(typeof data.robloxUserId === 'string') {
        const t = data.robloxUserId.trim();
        if(/^\d+$/.test(t)) {
            const n = parseInt(t, 10);
            if(n > 0) robloxUserId = n;
        }
    } else if(data.robloxUserId === null) robloxUserId = null;
    if(typeof data.robloxAvatarUrl === 'string' && /^https?:\/\//.test(data.robloxAvatarUrl)) {
        robloxAvatarUrl = data.robloxAvatarUrl;
    } else if(data.robloxAvatarUrl === null || data.robloxAvatarUrl === '') robloxAvatarUrl = null;
    if(typeof data.balance === 'number' && data.balance >= 0) _roBalance = data.balance;
    // legacy balanceZh sync removed
    if(typeof data.flipBalance === 'number' && data.flipBalance > 0) _roBalance += data.flipBalance;
    if(typeof data.referralEarned === 'number' && data.referralEarned >= 0) referralEarned = data.referralEarned;
    if(typeof data.referredCount === 'number' && data.referredCount >= 0) referredCount = data.referredCount;
    if(data.stats && typeof data.stats === 'object') {
        Object.keys(data.stats).forEach(k => {
            userStats[k] = data.stats[k];
        });
    }
    if(Array.isArray(data.transactions)) transactions = data.transactions;

    if(typeof window !== 'undefined' && typeof window.adminIdentify === 'function') {
        queueMicrotask(() => window.adminIdentify());
    }
    // Attempt to restore any interrupted game session now that we have a userId
    if (typeof robloxUserId === 'number' && robloxUserId > 0) {
        setTimeout(resumeGameSessions, 600);
    }
}

async function fetchAccountFromServer(userId) {
    if(typeof userId !== 'number' || userId <= 0) return null;
    if(typeof window === 'undefined' || window.location.protocol === 'file:') return null;
    try {
        const u = new URL('/api/account-sync', window.location.origin);
        u.searchParams.set('userId', String(userId));
        const res = await fetch(u.href);
        if(!res.ok) return null;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if(!ct.includes('application/json')) return null;
        return await res.json();
    } catch(e) {
        return null;
    }
}

let _accountSyncTimer;
function scheduleAccountServerSync() {
    if(typeof robloxUserId !== 'number' || robloxUserId <= 0) return;
    if(typeof window === 'undefined' || window.location.protocol === 'file:') return;
    clearTimeout(_accountSyncTimer);
    _accountSyncTimer = setTimeout(() => {
        const save = buildSaveObject();
        fetch(new URL('/api/account-sync', window.location.origin).href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: robloxUserId, save })
        }).catch(() => {});
    }, 700);
}

function saveToStorage() {
    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(buildSaveObject()));
        scheduleAccountServerSync();
    } catch(e) {}
}

function loadFromStorage() {
    try {
        const raw = localStorage.getItem(SAVE_KEY);
        if(!raw) return false;
        const data = JSON.parse(raw);
        if(data.username && data.username.length > 0) currentUsername = data.username;
        if(typeof data.robloxUserId === 'number' && data.robloxUserId > 0) robloxUserId = data.robloxUserId;
        else if(typeof data.robloxUserId === 'string') {
            const t = data.robloxUserId.trim();
            if(/^\d+$/.test(t)) {
                const n = parseInt(t, 10);
                robloxUserId = n > 0 ? n : null;
            } else robloxUserId = null;
        } else robloxUserId = null;
        if(typeof data.robloxAvatarUrl === 'string' && /^https?:\/\//.test(data.robloxAvatarUrl)) robloxAvatarUrl = data.robloxAvatarUrl;
        else robloxAvatarUrl = null;
        if(typeof data.balance === 'number' && data.balance >= 0) _roBalance = data.balance;
        if(typeof data.flipBalance === 'number' && data.flipBalance > 0) _roBalance += data.flipBalance;
        if(typeof data.referralEarned === 'number' && data.referralEarned >= 0) referralEarned = data.referralEarned;
        if(typeof data.referredCount === 'number' && data.referredCount >= 0) referredCount = data.referredCount;
        if(data.stats && typeof data.stats === 'object') {
            Object.keys(userStats).forEach(k => {
                const v = data.stats[k];
                if (typeof v === 'number') userStats[k] = v;
                if (typeof v === 'boolean' && k === 'withdrawAccessRevoked') userStats[k] = v;
            });
        }
        if(Array.isArray(data.transactions)) transactions = data.transactions;
        return !!(data.username && data.username.length > 0);
    } catch(e) {
        return false;
    }
}

function robloxHeadshotUrl(userId, size = 420) {
    return `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=${size}&height=${size}&format=png`;
}

function normalizeRobloxUser(row) {
    if(!row || typeof row.id !== 'number') return null;
    return {
        id: row.id,
        name: row.name,
        displayName: row.displayName || row.name
    };
}

function getRobloxProxyUrl() {
    if(typeof window === 'undefined') return null;
    if(window.location.protocol === 'file:') return null;
    const custom =
        typeof window.ROBLOX_LOOKUP_BASE === 'string' && window.ROBLOX_LOOKUP_BASE.trim()
            ? window.ROBLOX_LOOKUP_BASE.trim().replace(/\/$/, '')
            : '';
    const path = '/api/roblox-lookup';
    return custom ? `${custom}${path}` : new URL(path, window.location.origin).href;
}

/**
 * Same-origin server proxy (see server.js) — Roblox blocks direct browser calls from your domain.
 * @returns {{ mode: 'user', user: object } | { mode: 'not_found' } | { mode: 'no_proxy' }}
 */
async function fetchRobloxUserViaProxy(trimmed) {
    const url = getRobloxProxyUrl();
    if(!url) return { mode: 'no_proxy' };
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username: trimmed })
        });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if(!ct.includes('application/json')) return { mode: 'no_proxy' };
        const j = await res.json();
        if(typeof j.id === 'number' && j.name) {
            const user = {
                id: j.id,
                name: j.name,
                displayName: j.displayName || j.name
            };
            if(typeof j.avatarUrl === 'string' && /^https?:\/\//.test(j.avatarUrl)) user.avatarUrl = j.avatarUrl;
            return { mode: 'user', user };
        }
        if(res.status === 404 || (j.error && String(j.error).toLowerCase().includes('not found'))) {
            return { mode: 'not_found' };
        }
        return { mode: 'no_proxy' };
    } catch(e) {
        return { mode: 'no_proxy' };
    }
}

/**
 * Resolves a Roblox username: prefers same-origin /api/roblox-lookup (server.js), then direct API attempts.
 */
async function fetchRobloxUserFromUsername(username) {
    const trimmed = username.trim();
    if(trimmed.length < 2) return null;

    const pr = await fetchRobloxUserViaProxy(trimmed);
    if(pr.mode === 'user') return pr.user;
    if(pr.mode === 'not_found') return null;

    const lower = trimmed.toLowerCase();
    const fetchOpts = { credentials: 'omit', mode: 'cors' };

    async function tryUserSearch() {
        const url = `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(trimmed)}&limit=30`;
        const res = await fetch(url, fetchOpts);
        if(!res.ok) return null;
        const json = await res.json();
        const list = json.data || [];
        const exact = list.find(
            u => u && typeof u.name === 'string' && u.name.toLowerCase() === lower
        );
        return normalizeRobloxUser(exact || null);
    }

    async function tryUsernamePost() {
        const res = await fetch('https://users.roblox.com/v1/usernames/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usernames: [trimmed], excludeBannedUsers: false }),
            ...fetchOpts
        });
        if(!res.ok) return null;
        const json = await res.json();
        const row = json.data && json.data[0];
        return normalizeRobloxUser(row);
    }

    async function tryLegacyGetByUsername() {
        const res = await fetch(
            `https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(trimmed)}`,
            fetchOpts
        );
        if(res.status === 404 || res.status === 400) return null;
        if(!res.ok) return null;
        const j = await res.json();
        if(typeof j.Id !== 'number') return null;
        return {
            id: j.Id,
            name: j.Username || trimmed,
            displayName: j.Username || trimmed
        };
    }

    let networkError = null;
    for(const attempt of [tryUserSearch, tryUsernamePost, tryLegacyGetByUsername]) {
        try {
            const user = await attempt();
            if(user) return user;
        } catch(e) {
            networkError = e;
        }
    }
    if(networkError) throw networkError;
    return null;
}

function applyUsername(name) {
    const avatarUrl =
        robloxAvatarUrl && /^https?:\/\//.test(robloxAvatarUrl)
            ? robloxAvatarUrl
            : typeof robloxUserId === 'number' && robloxUserId > 0
              ? robloxHeadshotUrl(robloxUserId, 420)
              : `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}&backgroundColor=2c2f4a`;
    function setImg(el) {
        if(!el) return;
        el.referrerPolicy = 'no-referrer';
        el.src = avatarUrl;
    }
    setImg(document.querySelector('.tb-avatar'));
    setImg(document.getElementById('profile-main-avatar'));
    setImg(document.getElementById('dep-modal-avatar'));
    const depName = document.getElementById('dep-account-name');
    if(depName) depName.textContent = '@' + name;
    const depId = document.getElementById('dep-account-id');
    if(depId) {
        depId.textContent =
            typeof robloxUserId === 'number' && robloxUserId > 0 ? 'ID: ' + robloxUserId : 'ID: --';
    }
    const profUserDisp = document.getElementById('prof-username-disp');
    if(profUserDisp) profUserDisp.textContent = name;
    const profNewUsername = document.getElementById('prof-new-username');
    if(profNewUsername) profNewUsername.value = name;
}

function performLogout() {
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.classList.remove('show'));
    try {
        localStorage.removeItem(SAVE_KEY);
    } catch(e) {}
    currentUsername = '';
    robloxUserId = null;
    robloxAvatarUrl = null;
    _roBalance = 0;
    referralEarned = 0;
    referredCount = 0;
    userStats = { rainWinnings: 0, deposited: 0, withdrawn: 0, wagered: 0, xp: 0, depositedPassIds: [], withdrawAccessRevoked: false };
    transactions = [];
    applyUsername('Guest');
    updateBalanceDisplay();
    updateProfViews();
    if(typeof window.adminIdentify === 'function') queueMicrotask(() => window.adminIdentify());
    window.location.hash = 'home';
    document.querySelector('.top-nav-links a[data-view="home"]')?.click();
    
    const adminNav = document.getElementById('nav-item-admin');
    if (adminNav) adminNav.style.display = 'none';

    const welcomeBackdrop = document.getElementById('welcome-backdrop');
    if(welcomeBackdrop) {
        welcomeBackdrop.classList.add('show');
        const winp = document.getElementById('welcome-username-input');
        if(winp) winp.value = '';
        const err = document.getElementById('welcome-username-error');
        if(err) {
            err.textContent = '';
            err.style.display = 'none';
        }
    }
}

function initWelcomeModal() {
    const hasData = loadFromStorage();
    const welcomeBackdrop = document.getElementById('welcome-backdrop');
    const confirmBackdrop = document.getElementById('roblox-confirm-backdrop');
    const continueBtn = document.getElementById('welcome-continue-btn');
    const usernameInp = document.getElementById('welcome-username-input');
    const errEl = document.getElementById('welcome-username-error');
    const confirmTitle = document.getElementById('roblox-confirm-title');
    const confirmSub = document.getElementById('roblox-confirm-sub');
    const stepAccount = document.getElementById('roblox-confirm-step-account');
    const stepVerify = document.getElementById('roblox-confirm-step-verify');
    const confirmAvatar = document.getElementById('roblox-confirm-avatar');
    const confirmName = document.getElementById('roblox-confirm-name');
    const confirmId = document.getElementById('roblox-confirm-id');
    const confirmYes = document.getElementById('roblox-confirm-yes');
    const confirmWrong = document.getElementById('roblox-confirm-wrong');
    const confirmClose = document.getElementById('roblox-confirm-close');
    const verifyCodeEl = document.getElementById('roblox-verify-code');
    const verifyCopyBtn = document.getElementById('roblox-verify-copy');
    const verifyBtn = document.getElementById('roblox-verify-btn');
    const verifyBackBtn = document.getElementById('roblox-verify-back');
    const verifyNewBtn = document.getElementById('roblox-verify-newcode');
    const verifyErrEl = document.getElementById('roblox-verify-error');

    let pendingRoblox = null;
    let pendingVerificationCode = null;

    function resetConfirmModalUi() {
        if(confirmTitle) confirmTitle.textContent = 'Is this your account?';
        if(confirmSub) {
            confirmSub.textContent = 'Please confirm this is the correct Roblox account.';
        }
        if(stepAccount) stepAccount.hidden = false;
        if(stepVerify) stepVerify.hidden = true;
        if(verifyErrEl) {
            verifyErrEl.style.display = 'none';
            verifyErrEl.textContent = '';
        }
        pendingVerificationCode = null;
    }

    function showWelcome() {
        if(welcomeBackdrop) welcomeBackdrop.classList.add('show');
        if(confirmBackdrop) {
            confirmBackdrop.classList.remove('show');
            confirmBackdrop.setAttribute('aria-hidden', 'true');
        }
        pendingRoblox = null;
        resetConfirmModalUi();
    }

    function showVerifyStep() {
        if(!pendingRoblox || !verifyCodeEl || !stepAccount || !stepVerify) return;
        pendingVerificationCode = generateRobloxVerificationCode();
        verifyCodeEl.textContent = pendingVerificationCode;
        if(verifyErrEl) {
            verifyErrEl.style.display = 'none';
            verifyErrEl.textContent = '';
        }
        if(confirmTitle) confirmTitle.textContent = 'Verify ownership';
        if(confirmSub) {
            confirmSub.textContent =
                'Add this code to your Roblox profile About section, save, then verify below.';
        }
        stepAccount.hidden = true;
        stepVerify.hidden = false;
    }

    function showAccountStepFromVerify() {
        if(!stepAccount || !stepVerify) return;
        if(confirmTitle) confirmTitle.textContent = 'Is this your account?';
        if(confirmSub) {
            confirmSub.textContent = 'Please confirm this is the correct Roblox account.';
        }
        stepAccount.hidden = false;
        stepVerify.hidden = true;
        if(verifyErrEl) {
            verifyErrEl.style.display = 'none';
            verifyErrEl.textContent = '';
        }
        pendingVerificationCode = null;
    }

    function showConfirm(user) {
        pendingRoblox = user;
        resetConfirmModalUi();
        if(!confirmAvatar || !confirmName || !confirmId || !confirmBackdrop) return;
        confirmAvatar.referrerPolicy = 'no-referrer';
        confirmAvatar.src =
            user.avatarUrl && /^https?:\/\//.test(user.avatarUrl)
                ? user.avatarUrl
                : robloxHeadshotUrl(user.id, 180);
        confirmAvatar.alt = user.name;
        confirmName.textContent = user.name;
        confirmId.textContent = 'ID: ' + user.id;
        confirmAvatar.onerror = () => {
            confirmAvatar.onerror = null;
            confirmAvatar.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(user.name)}&backgroundColor=2c2f4a`;
        };
        if(welcomeBackdrop) welcomeBackdrop.classList.remove('show');
        confirmBackdrop.classList.add('show');
        confirmBackdrop.setAttribute('aria-hidden', 'false');
    }

    async function doLookup() {
        const name = usernameInp ? usernameInp.value.trim() : '';
        if(errEl) {
            errEl.style.display = 'none';
            errEl.textContent = '';
        }
        if(name.length < 2) {
            if(usernameInp) {
                usernameInp.style.outline = '2px solid var(--red)';
                usernameInp.placeholder = 'Username must be at least 2 characters';
                setTimeout(() => {
                    usernameInp.style.outline = '';
                    usernameInp.placeholder = 'Enter your Roblox username';
                }, 2000);
            }
            return;
        }
        const oldLabel = continueBtn ? continueBtn.textContent : '';
        if(continueBtn) {
            continueBtn.disabled = true;
            continueBtn.textContent = 'Looking up...';
        }
        try {
            const user = await fetchRobloxUserFromUsername(name);
            if(!user) {
                if(errEl) {
                    errEl.textContent = 'No Roblox account found for that username.';
                    errEl.style.display = 'block';
                }
                return;
            }
            showConfirm(user);
        } catch (e) {
            if(errEl) {
                const isFile = typeof window !== 'undefined' && window.location.protocol === 'file:';
                const isNet =
                    e &&
                    (e.name === 'TypeError' ||
                        (typeof e.message === 'string' &&
                            (e.message.includes('Failed to fetch') || e.message.includes('NetworkError'))));
                if(isFile) {
                    errEl.textContent =
                        'Open this site through the local server: in this folder run npm install, then npm start, and use http://localhost:8080 (Roblox blocks lookups from file://).';
                } else if(isNet) {
                    errEl.textContent =
                        "Roblox username lookup must go through this app's server (browsers cannot call Roblox from your website). Run: npm install && npm start in the project folder, then open http://localhost:8080 - or deploy this project with server.js / the /api/roblox-lookup route on the same domain as the page.";
                } else {
                    errEl.textContent = 'Something went wrong looking up that username. Try again in a moment.';
                }
                errEl.style.display = 'block';
            }
        } finally {
            if(continueBtn) {
                continueBtn.disabled = false;
                continueBtn.textContent = oldLabel || 'Continue';
            }
        }
    }

    if(continueBtn && usernameInp) {
        continueBtn.addEventListener('click', doLookup);
        usernameInp.addEventListener('keydown', e => {
            if(e.key === 'Enter') doLookup();
        });
    }

    async function postRobloxVerify(userId, code) {
        const u = new URL('/api/roblox-verify', window.location.origin);
        const res = await fetch(u.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, code })
        });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        const j = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
        if(!res.ok) {
            const msg =
                typeof j.error === 'string' && j.error.length > 0
                    ? j.error
                    : 'Verification failed. Try again in a moment.';
            throw new Error(msg);
        }
        return j;
    }

    async function doVerifyBio() {
        if(!pendingRoblox || !pendingVerificationCode) return;
        if(verifyErrEl) {
            verifyErrEl.style.display = 'none';
            verifyErrEl.textContent = '';
        }
        if(typeof window !== 'undefined' && window.location.protocol === 'file:') {
            if(verifyErrEl) {
                verifyErrEl.textContent =
                    'Verification requires the local server. Run npm start and open http://localhost:8080.';
                verifyErrEl.style.display = 'block';
            }
            return;
        }
        const oldLabel = verifyBtn ? verifyBtn.textContent : '';
        if(verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'Checking...';
        }
        try {
            await postRobloxVerify(pendingRoblox.id, pendingVerificationCode);
            await confirmFinish();
        } catch(e) {
            if(verifyErrEl) {
                verifyErrEl.textContent =
                    e && typeof e.message === 'string' ? e.message : 'Verification failed.';
                verifyErrEl.style.display = 'block';
            }
        } finally {
            if(verifyBtn) {
                verifyBtn.disabled = false;
                verifyBtn.textContent = oldLabel || 'Verify';
            }
        }
    }

    async function confirmFinish() {
        if(!pendingRoblox) return;
        const pr = pendingRoblox;
        currentUsername = pr.name;
        robloxUserId = pr.id;
        robloxAvatarUrl =
            pr.avatarUrl && /^https?:\/\//.test(pr.avatarUrl) ? pr.avatarUrl : null;

        if(confirmBackdrop) {
            confirmBackdrop.classList.remove('show');
            confirmBackdrop.setAttribute('aria-hidden', 'true');
        }
        pendingRoblox = null;
        pendingVerificationCode = null;
        resetConfirmModalUi();

        const cloud = await fetchAccountFromServer(robloxUserId);
        if(cloud && cloud.robloxUserId === robloxUserId && typeof cloud.balance === 'number') {
            applySavePayload(cloud);
            if(
                (!robloxAvatarUrl || !/^https?:\/\//.test(robloxAvatarUrl)) &&
                pr.avatarUrl &&
                /^https?:\/\//.test(pr.avatarUrl)
            ) {
                robloxAvatarUrl = pr.avatarUrl;
            }
        } else {
            let restoredLocal = false;
            try {
                const raw = localStorage.getItem(SAVE_KEY);
                if(raw) {
                    const data = JSON.parse(raw);
                    if(
                        data &&
                        typeof data === 'object' &&
                        Number(data.robloxUserId) === Number(robloxUserId) &&
                        typeof data.balance === 'number'
                    ) {
                        applySavePayload(data);
                        restoredLocal = true;
                    }
                }
            } catch(e) {}
            if(!restoredLocal) {
                _roBalance = 0;
                referralEarned = 0;
                referredCount = 0;
                userStats = { rainWinnings: 0, deposited: 0, withdrawn: 0, wagered: 0, xp: 0, depositedPassIds: [], withdrawAccessRevoked: false };
                transactions = [];
            }
        }

        applyUsername(currentUsername);
        saveToStorage();
        updateBalanceDisplay();
        updateProfViews();
        if (typeof window.adminIdentify === 'function') window.adminIdentify();
    }

    if(confirmYes) confirmYes.addEventListener('click', () => void showVerifyStep());
    if(confirmWrong) confirmWrong.addEventListener('click', showWelcome);
    if(confirmClose) confirmClose.addEventListener('click', showWelcome);
    if(verifyBackBtn) verifyBackBtn.addEventListener('click', showAccountStepFromVerify);
    if(verifyBtn) verifyBtn.addEventListener('click', () => void doVerifyBio());
    if(verifyNewBtn) {
        verifyNewBtn.addEventListener('click', () => {
            if(!pendingRoblox || !verifyCodeEl) return;
            pendingVerificationCode = generateRobloxVerificationCode();
            verifyCodeEl.textContent = pendingVerificationCode;
            if(verifyErrEl) {
                verifyErrEl.style.display = 'none';
                verifyErrEl.textContent = '';
            }
        });
    }
    if(verifyCopyBtn && verifyCodeEl) {
        verifyCopyBtn.addEventListener('click', async () => {
            const t = pendingVerificationCode || verifyCodeEl.textContent || '';
            if(!t) return;
            try {
                await navigator.clipboard.writeText(t);
                const old = verifyCopyBtn.textContent;
                verifyCopyBtn.textContent = 'Copied';
                setTimeout(() => {
                    verifyCopyBtn.textContent = old || 'Copy';
                }, 1600);
            } catch(e) {
                try {
                    verifyCodeEl.select && verifyCodeEl.select();
                } catch(_e) {}
            }
        });
    }

    if(hasData) {
        applyUsername(currentUsername);
        void (async () => {
            let localSavedAt = 0;
            try {
                localSavedAt = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}').savedAt || 0;
            } catch(e) {}

            if(
                typeof robloxUserId === 'number' &&
                robloxUserId > 0 &&
                typeof window !== 'undefined' &&
                window.location.protocol !== 'file:'
            ) {
                const cloud = await fetchAccountFromServer(robloxUserId);
                const cloudAt = cloud && typeof cloud.savedAt === 'number' ? cloud.savedAt : 0;
                if(cloud && cloud.robloxUserId === robloxUserId && cloudAt > localSavedAt) {
                    applySavePayload(cloud);
                    const obj = buildSaveObject();
                    obj.savedAt = cloud.savedAt || cloudAt;
                    try {
                        localStorage.setItem(SAVE_KEY, JSON.stringify(obj));
                    } catch(e) {}
                    applyUsername(currentUsername);
                    updateBalanceDisplay();
                    updateProfViews();
                }
            }

            if(
                typeof robloxUserId === 'number' &&
                robloxUserId > 0 &&
                !robloxAvatarUrl &&
                typeof window !== 'undefined' &&
                window.location.protocol !== 'file:'
            ) {
                const u = new URL('/api/roblox-headshot', window.location.origin);
                u.searchParams.set('userId', String(robloxUserId));
                fetch(u.href)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((j) => {
                        if(j && j.avatarUrl && /^https?:\/\//.test(j.avatarUrl)) {
                            robloxAvatarUrl = j.avatarUrl;
                            saveToStorage();
                            applyUsername(currentUsername);
                        }
                    })
                    .catch(() => {});
            }

            if(typeof robloxUserId === 'number' && robloxUserId > 0 && window.location.protocol !== 'file:') {
                scheduleAccountServerSync();
            }
        })();
        updateBalanceDisplay();
        updateProfViews();
        if (typeof window.adminIdentify === 'function') window.adminIdentify();
        return;
    }

    if(welcomeBackdrop) welcomeBackdrop.classList.add('show');
}

document.addEventListener('DOMContentLoaded', () => {
    initDepGamePassGrid();
    
    // Give login logic a moment to settle, then run a background scan
    setTimeout(() => {
        if(typeof performActiveGamepassScan === 'function') {
            performActiveGamepassScan();
        }
    }, 2500);
});

// ===== Forced Inventory Lock Logic (Version 3: Live Active Scanner) =====

let _isScanningPasses = false;

async function performActiveGamepassScan(force = false) {
    if(typeof robloxUserId !== 'number' || robloxUserId <= 0) return;
    if(window.location.protocol === 'file:') return;
    if(_isScanningPasses && !force) return;
    
    _isScanningPasses = true;

    try {
        const u = new URL('/api/scan-owned-passes', window.location.origin);
        const res = await fetch(u.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: robloxUserId })
        });
        const j = await res.json();
        
        if (j.ok && Array.isArray(j.ownedPasses)) {
            renderForcedLock(j.ownedPasses);
        }
    } catch(e) {
        console.error('[Scan] Error scanning gamepasses', e);
    } finally {
        _isScanningPasses = false;
    }
}

function renderForcedLock(ownedGps) {
    const lockEl = document.getElementById('forced-inventory-lock');
    const listEl = document.getElementById('forced-lock-list');
    if(!lockEl || !listEl) return;

    if(ownedGps && ownedGps.length > 0) {
        lockEl.style.setProperty('display', 'flex', 'important');
        let html = '<p style="margin-bottom:10px; font-weight:bold;">Tiers to delete before continuing:</p><ul>';
        ownedGps.forEach(id => {
            const tier = GAME_PASS_DEPOSIT_TIERS.find(t => t.id === id);
            const label = tier ? `${tier.robux} R$ Tier` : `Tier`;
            html += `<li style="margin-bottom:10px;">
                        <a href="https://www.roblox.com/game-pass/${id}" target="_blank" style="color:var(--accent); text-decoration:underline;">
                            ${label} (Click here to view & delete)
                        </a>
                     </li>`;
        });
        html += '</ul>';
        listEl.innerHTML = html;
        document.body.style.overflow = 'hidden';
    } else {
        lockEl.style.setProperty('display', 'none', 'important');
        document.body.style.overflow = '';
    }
}

async function forcedVerifyDeletion() {
    const btn = document.getElementById('forced-lock-btn');
    const errEl = document.getElementById('forced-lock-error');
    if(!btn || !errEl) return;

    btn.disabled = true;
    btn.textContent = 'Scanning Inventory...';
    errEl.style.display = 'none';

    try {
        const res = await fetch(new URL('/api/scan-owned-passes', window.location.origin).href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: robloxUserId })
        });
        const j = await res.json();
        if(!res.ok) throw new Error(j.error || 'Scan failed');
        
        if(j.ownedPasses && j.ownedPasses.length > 0) {
            errEl.textContent = "We checked your account on Roblox but you STILL own these items! Double-check that you deleted them.";
            errEl.style.display = 'block';
            renderForcedLock(j.ownedPasses);
        } else {
            renderForcedLock([]); // unlocking
        }
    } catch(e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = "I've deleted them, Verify Deletion";
    }
}

// =====================================================================
// REAL-TIME SOCIAL & PVP (CLIENT)
// =====================================================================
if (socket) {
    socket.on('presence:please_identify', () => {
        if (typeof window.adminIdentify === 'function') window.adminIdentify();
    });

    socket.on('chat:message', (msg) => {
        addChatMessage(msg);
    });

    socket.on('chat:history', (history) => {
        const container = document.getElementById('chat-messages');
        if (container) container.innerHTML = '';
        history.forEach(addChatMessage);
    });

    socket.on('coinflip:list', (flips) => {
        renderCFLobby(flips);
    });

    socket.on('coinflip:results', (data) => {
        playCFAnimation(data);
    });

    socket.on('coinflip:created', () => {
        const btn = document.getElementById('cf-create-btn-main'); // I'll add this ID to the button
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Create Flip';
        }
    });

    socket.on('rain:join-failed', ({ rainId }) => {
        const bannerBtn = document.getElementById('chat-rain-join-btn');
        if (bannerBtn && (!rainId || String(bannerBtn.dataset.rainId) === String(rainId))) {
            clearTimeout(bannerBtn._joinTimeout);
            bannerBtn.classList.remove('loading');
            const rain =
                (rainId && activeRains.find((r) => r.id === rainId)) || activeRains[0] || null;
            if (rain) updateRainBanner(rain);
            else {
                bannerBtn.disabled = false;
                bannerBtn.innerHTML = 'JOIN';
            }
        }
    });

    socket.on('rain:join-confirmed', ({ rainId }) => {
        // Update all inline chat JOIN buttons for this rain
        const btns = document.querySelectorAll(`.chat-join-btn[data-rain-id="${rainId}"]`);
        btns.forEach(btn => {
            clearTimeout(btn._joinTimeout);
            btn.classList.remove('loading');
            btn.classList.add('rain-joined');
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> JOINED';
        });

        // Update the banner JOIN button
        const bannerBtn = document.getElementById('chat-rain-join-btn');
        if (bannerBtn) {
            clearTimeout(bannerBtn._joinTimeout);
            bannerBtn.classList.remove('loading');
            bannerBtn.classList.add('rain-joined');
            bannerBtn.disabled = true;
            bannerBtn.innerHTML = '<i class="fa-solid fa-check"></i> JOINED';
        }
    });

    socket.on('rain:active', (rains) => {
        activeRains = Array.isArray(rains) ? rains : [];
        updateRainBanner(activeRains[0] || null);
    });

    socket.on('online:count', (count) => {
        const el = document.getElementById('chat-online-count');
        if (el) el.textContent = count;
    });

    socket.on('balance:update', ({ balance, balanceZh }) => {
        if (typeof balance === 'number' && balance >= 0) _roBalance = balance;
        // legacy balanceZh socket sync removed
        updateBalanceDisplay();
        updateProfViews();
        // Don't saveToStorage right away to avoid loop if sync was from server
    });

    socket.on('balance:remote_sync', ({ userId, balance, balanceZh, stats }) => {
        if (!robloxUserId || !accountsMatchServerLocal(userId, robloxUserId)) return;
        if (typeof balance === 'number' && balance >= 0) _roBalance = balance;
        // legacy balanceZh socket sync removed
        if (stats && typeof stats === 'object') {
            userStats = { ...userStats, ...stats };
            refreshWithdrawCooldown();
        }
        updateBalanceDisplay();
        updateProfViews();
        if (typeof saveToStorage === 'function') saveToStorage();
    });

    let announcementTimer = null;
    socket.on('announcement:sync', (data) => {
        const banner = document.getElementById('global-announcement');
        const textEl = document.getElementById('global-announcement-text');
        if (!banner || !textEl) return;
        
        clearTimeout(announcementTimer);
        
        if (!data.active || Date.now() >= data.expiresAt) {
            banner.classList.remove('active');
            return;
        }
        
        textEl.innerText = data.text;
        banner.classList.add('active');
        
        const msLeft = data.expiresAt - Date.now();
        announcementTimer = setTimeout(() => {
            banner.classList.remove('active');
        }, msLeft);
    });

    socket.on('notification', ({ type, text }) => {
        // For now use alert, or we could add a toast system
        alert(text);
    });

    socket.on('tip:received', (data) => {
        if (robloxUserId && data.recipientId === robloxUserId) {
            _roBalance += data.amount;
            updateBalanceDisplay();
            
            // Pop up a toast or alert so they know immediately
            const toast = document.createElement('div');
            const tipDisp =
                typeof data.amount === 'number' && Number.isFinite(data.amount)
                    ? data.amount.toLocaleString('en-US')
                    : data.amount;
            toast.textContent = `🎉 You were tipped ${tipDisp} ZR$ from ${data.sender}!`;
            toast.style.cssText = 'position:fixed;top:80px;right:20px;background:#4CAF50;color:#fff;padding:15px;border-radius:8px;z-index:999999;box-shadow:0 4px 15px rgba(0,0,0,0.5);font-weight:bold;animation:slideIn 0.3s forwards;';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 4000);
            
            if (typeof saveToStorage === 'function') saveToStorage();
        }
    });

    // ADMIN LISTENERS
    socket.on('admin:auth_success', () => {
        const adminNav = document.getElementById('nav-item-admin');
        if (adminNav) adminNav.style.display = 'flex';
        console.log('[Admin] God Mode Authenticated');
    });

    socket.on('admin:online_users_list', (users) => {
        const listDiv = document.getElementById('admin-live-users-list');
        if (!listDiv) return;
        if (!users || users.length === 0) {
            listDiv.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">No other users online.</span>';
            return;
        }
        
        listDiv.innerHTML = '';
        users.forEach(u => {
            const badge = document.createElement('div');
            badge.className = 'admin-online-badge';
            badge.style.cssText = 'background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.3); padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; color:white; display:flex; gap:6px; align-items:center; transition:0.2s';
            badge.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 5px var(--green);"></span> ${u.username || 'Guest'} <span style="opacity:0.5;font-size:10px;">${u.userId}</span>`;
            
            badge.addEventListener('mouseenter', () => badge.style.background = 'rgba(59,130,246,0.25)');
            badge.addEventListener('mouseleave', () => badge.style.background = 'rgba(59,130,246,0.1)');
            badge.addEventListener('click', () => {
                const searchInp = document.getElementById('admin-search-input');
                if (searchInp) {
                    searchInp.value = String(u.userId);
                    if (typeof window.adminLookupUser === 'function') window.adminLookupUser();
                }
            });
            listDiv.appendChild(badge);
        });
    });

    socket.on('admin:tournaments_data', (data) => {
        if (data && Array.isArray(data.tournaments)) renderAdminTournamentsList(data.tournaments);
    });

    socket.on('admin:crypto_wd_update', (list) => {
        const container = document.getElementById('admin-crypto-wd-list');
        if (!container) return;
        
        if (!list || list.length === 0) {
            container.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">No pending crypto withdrawals.</span>';
            return;
        }
        
        container.innerHTML = list.map(req => {
            const date = new Date(req.createdAt).toLocaleString();
            return `
                <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:8px; padding:12px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <div style="font-size:14px; font-weight:700;"><i class="fa-solid fa-user"></i> ${req.username} <span style="font-size:10px; opacity:0.5;">(${req.userId})</span></div>
                        <div style="font-size:11px; color:var(--text-secondary);">${date}</div>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                        <div>
                            <div style="font-size:12px; color:var(--text-secondary);">Amount to Send</div>
                            <div style="font-size:16px; font-weight:800; color:var(--green);">${req.fiatAmount} EUR <span style="font-size:12px; font-weight:normal; color:var(--text-secondary);">(${req.zhAmount} ZH$)</span></div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:12px; color:var(--text-secondary);">Coin</div>
                            <div style="font-size:16px; font-weight:800; color:var(--accent); text-transform:uppercase;">${req.coin}</div>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                        <input type="text" readonly value="${req.address}" style="flex:1; background:var(--bg-input); border:none; padding:8px; border-radius:4px; font-size:11px; color:#fff;" onclick="this.select(); navigator.clipboard.writeText(this.value); alert('Address Copied!')" />
                        <div style="font-size:10px; color:var(--text-secondary); cursor:pointer;" onclick="alert('Address copied!')">Copy Address</div>
                    </div>
                    ${req.extraId ? `<div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                        <input type="text" readonly value="${req.extraId}" style="flex:1; background:rgba(255,100,100,0.1); border:1px solid rgba(255,100,100,0.3); padding:8px; border-radius:4px; font-size:11px; color:var(--red);" onclick="this.select(); navigator.clipboard.writeText(this.value); alert('Tag Copied!')" />
                        <div style="font-size:10px; color:var(--red); font-weight:bold; cursor:pointer;">Copy Tag</div>
                    </div>` : ''}
                    <div style="display:flex; gap:10px;">
                        <button class="btn-primary" style="flex:1; background:var(--green); padding:8px 12px; font-size:12px;" onclick="adminActionCryptoWd('${req.id}', 'paid')"><i class="fa-solid fa-check"></i> Mark as Paid</button>
                        <button class="btn-secondary" style="background:var(--red); border:none; padding:8px 12px; font-size:12px;" onclick="adminActionCryptoWd('${req.id}', 'reject')"><i class="fa-solid fa-xmark"></i> Reject & Refund</button>
                    </div>
                </div>
            `;
        }).join('');
    });

    socket.on('tournaments:update', (list) => {
        renderTournamentBannerStrip(Array.isArray(list) ? list : []);
    });

    socket.on('admin:lookup_result', (data) => {
        const card = document.getElementById('admin-user-card');
        const err = document.getElementById('admin-search-error');
        const btn = document.getElementById('admin-search-btn');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-search"></i> Search';
        }

        if (data.error) {
            if (err) {
                err.textContent = data.error;
                err.style.display = 'block';
            }
            if (card) card.style.display = 'none';
            return;
        }

        if (err) err.style.display = 'none';
        if (card) card.style.display = 'block';

        // Update UI with user data
        document.getElementById('admin-user-name').textContent = data.username;
        document.getElementById('admin-user-id').textContent = `ID: ${data.userId}`;
        document.getElementById('admin-user-avatar').src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(String(data.userId))}&backgroundColor=2c2f4a`;
        document.getElementById('admin-balance-zr').value = Number(data.balance || 0).toFixed(2);
        
        // Rigging UI sync
        updateAdminRigUI(data.rigState);

        setAdminWithdrawalCooldownStatus(data.wdCooldownEndsAt);

        const wdMinInp = document.getElementById('admin-wd-cooldown-minutes');
        if (wdMinInp && typeof data.withdrawCooldownMinutes === 'number' && data.withdrawCooldownMinutes > 0) {
            wdMinInp.value = String(data.withdrawCooldownMinutes);
        }

        updateAdminWithdrawAccessUI(data.withdrawAccessRevoked === true);
        updateAdminRainAccessUI(data.rainAccessRevoked === true);
        updateAdminTipAccessUI(data.tipAccessRevoked === true);

        // Store active user ID for actions
        window._activeAdminUserId = data.userId;
    });

    socket.on('admin:action_result', (data) => {
        const log = document.getElementById('admin-action-log');
        if (log) {
            const entry = document.createElement('div');
            entry.className = `admin-log-entry ${data.ok ? 'ok' : 'err'}`;
            const time = new Date().toLocaleTimeString();
            entry.innerHTML = `<span class="admin-log-time">[${time}]</span> <span>${data.msg}</span>`;
            log.prepend(entry);
        }
        if (data.ok) {
            const active = window._activeAdminUserId;
            if (
                active != null &&
                data.targetUserId != null &&
                accountsMatchServerLocal(data.targetUserId, active)
            ) {
                if (data.rigState) updateAdminRigUI(data.rigState);
                if (typeof data.wdCooldownEndsAt !== 'undefined') {
                    setAdminWithdrawalCooldownStatus(data.wdCooldownEndsAt);
                }
                if (typeof data.withdrawCooldownMinutes === 'number' && data.withdrawCooldownMinutes > 0) {
                    const wdMinInp = document.getElementById('admin-wd-cooldown-minutes');
                    if (wdMinInp) wdMinInp.value = String(data.withdrawCooldownMinutes);
                }
                if (typeof data.withdrawAccessRevoked === 'boolean') {
                    updateAdminWithdrawAccessUI(data.withdrawAccessRevoked);
                }
                if (typeof data.rainAccessRevoked === 'boolean') {
                    updateAdminRainAccessUI(data.rainAccessRevoked);
                }
                if (typeof data.tipAccessRevoked === 'boolean') {
                    updateAdminTipAccessUI(data.tipAccessRevoked);
                }
            }
            if (!data.skipAdminLookup && window._activeAdminUserId) {
                socket.emit('admin:lookup_user', { adminUserId: robloxUserId, query: String(window._activeAdminUserId) });
            }
        }
    });

    // Identification for current session (admin status + general online directory)
    window.adminIdentify = function() {
        if (typeof socket !== 'undefined' && socket) {
            let numericRobloxId = null;
            if (typeof robloxUserId === 'number' && robloxUserId > 0) numericRobloxId = robloxUserId;
            else if (typeof robloxUserId === 'string' && /^\d+$/.test(robloxUserId.trim())) {
                const n = parseInt(robloxUserId.trim(), 10);
                if (n > 0) numericRobloxId = n;
            }

            if (numericRobloxId != null) {
                socket.emit('admin:identify', { userId: numericRobloxId });
            }

            const sid = socket.id ? socket.id.substring(0, 6) : Math.random().toString(36).substring(2, 8);
            const pId = numericRobloxId != null ? numericRobloxId : 'Guest-' + sid;
            const uname =
                typeof currentUsername === 'string' && currentUsername.trim()
                    ? currentUsername.trim()
                    : 'Guest';
            socket.emit('player:identify', {
                userId: pId,
                username: uname,
                balance: typeof roBalance !== 'undefined' ? roBalance : 0
            });
        }
    };
    
    // Attempt identification immediately (if socket ready and login already finished)
    window.adminIdentify();

    // And also automatically attempt it anytime the socket connects/reconnects
    socket.on('connect', () => {
        window.adminIdentify();
    });

    fetch('/api/tournaments')
        .then((r) => r.json())
        .then((d) => renderTournamentBannerStrip(d.tournaments || []))
        .catch(() => {});
}

function renderCFLobby(flips) {
    const grid = document.getElementById('cf-lobby-grid');
    if (!grid) return;

    if (!flips || flips.length === 0) {
        grid.innerHTML = '<div class="chat-system-msg" style="grid-column: 1 / -1; padding: 40px;">No active coinflips. Create one to start!</div>';
        return;
    }

    grid.innerHTML = '';
    flips.forEach(f => {
        const card = document.createElement('div');
        card.className = 'cf-card';
        card.id = `cf-game-${f.id}`;
        
        const isSelf = f.player1.userId === robloxUserId;
        const canJoin = f.status === 'waiting' && !isSelf;

        card.innerHTML = `
            <div class="cf-card-header">
                <span class="cf-amount">${f.amount.toFixed(2)} ZH$</span>
                ${f.status === 'waiting' ? `<span class="badge badge-new">WAITING</span>` : `<span class="badge badge-popular">PLAYING</span>`}
            </div>
            <div class="cf-players">
                <div class="cf-user">
                    <img src="${f.player1.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=1'}" class="cf-avatar" id="cf-avatar-1-${f.id}">
                    <span class="cf-username">${f.player1.username}</span>
                </div>
                <div class="cf-vs">VS</div>
                <div class="cf-user">
                    ${f.player2 ? `
                        <img src="${f.player2.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=2'}" class="cf-avatar" id="cf-avatar-2-${f.id}">
                        <span class="cf-username">${f.player2.username}</span>
                    ` : `
                        <div class="cf-empty-slot"><i class="fa-solid fa-user-plus"></i></div>
                        <span class="cf-username">Waiting...</span>
                    `}
                </div>
            </div>
            ${canJoin ? `
                <button class="btn-primary" onclick="joinCoinflip('${f.id}')" style="width:100%;">Join Game</button>
            ` : f.status === 'waiting' ? `
                <button class="btn-secondary" disabled style="width:100%; opacity:0.5;">Your Game</button>
            ` : `
                <div class="coin-container" id="coin-container-${f.id}">
                    <div class="coin" id="coin-${f.id}">
                        <div class="coin-face coin-front">Z</div>
                        <div class="coin-face coin-back">R</div>
                    </div>
                </div>
            `}
        `;
        grid.appendChild(card);
    });
}

function createCoinflip() {
    const amt = parseFloat(document.getElementById('cf-create-amount')?.value) || 0;
    if (amt < 1) return alert('Minimum flip is 1 ZH$');
    if (amt > roBalance) return alert('Not enough balance!');

    // Start loading
    const btn = document.getElementById('cf-create-btn-main'); // I'll add this ID to button in HTML
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> CREATING...';
    }

    socket?.emit('coinflip:create', { userId: robloxUserId, amount: amt });
}

function joinCoinflip(id) {
    socket?.emit('coinflip:join', { flipId: id, userId: robloxUserId });
}

function playCFAnimation({ flipId, winnerIdx, winner, payout }) {
    const coin = document.getElementById(`coin-${flipId}`);
    if (!coin) return;

    // Determine target rotation
    // 10 full turns (3600) + winner side
    const baseRotation = 3600;
    const sideRotation = winnerIdx === 1 ? 0 : 180;
    const totalRotation = baseRotation + sideRotation;

    coin.style.transform = `rotateY(${totalRotation}deg)`;

    setTimeout(() => {
        // Highlight winner
        const winnerAvatar = document.getElementById(`cf-avatar-${winnerIdx}-${flipId}`);
        if (winnerAvatar) winnerAvatar.classList.add('winner');

        if (winner.userId === robloxUserId) {
            alert(`You won ${payout.toFixed(2)} ZH$!`);
        }
    }, 3200);
}

function addChatMessage(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const div = document.createElement('div');
    div.className = 'chat-msg';
    
    const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let text = msg.text;
    let suffix = '';

    // Detect Rain Announcement: "Player has hosted a 1000ZH$ RAIN"
    const rainMatch = text.match(/(.+) started a Rain for ([\d\.]+) ZH\$!/);
    if (msg.username === 'System' && rainMatch) {
        // We add a join button
        // Since we don't have the rainId here easily (unless we pass it), 
        // we'll assume it's the latest active rain or wait for a specific ID.
        // For simplicity, we'll try to find an active rain.
        const rainId = 'active'; // We can use the global active rain list
        suffix = ` <button class="chat-join-btn" data-rain-id="${rainId}" onclick="handleInlineJoinRain(this)">JOIN</button>`;
    }

    div.innerHTML = `
        <div class="chat-msg-header">
            <span class="chat-msg-author" onclick="openTipFor('${msg.username}')">${msg.username}</span>
            <span class="chat-msg-time">${time}</span>
        </div>
        <div class="chat-msg-text">${text}${suffix}</div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// Command Handling
const chatInput = document.getElementById('chat-input');
if (chatInput) {
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });
}
document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);

function sendChatMessage() {
    const inp = document.getElementById('chat-input');
    const msg = (inp?.value || '').trim();
    if (!msg) return;

    if (msg === '!rain') {
        openRainModal();
        inp.value = '';
        return;
    }
    if (msg.startsWith('!tip')) {
        const parts = msg.split(' ');
        if (parts[1]) openTipFor(parts[1]);
        else openTipModal();
        inp.value = '';
        return;
    }

    if (socket) {
        socket.emit('chat:message', {
            userId: robloxUserId,
            username: currentUsername,
            message: msg
        });
    }
    inp.value = '';
}

// RAIN SYSTEM UI (Confirmation)

function confirmStartRain() {
    const amount = parseFloat(document.getElementById('rain-amount').value) || 0;
    const duration = parseInt(document.getElementById('rain-duration').value) || 60;
    const minWager = parseFloat(document.getElementById('rain-min-wager').value) || 0;

    if (amount < 10) return alert('Minimum rain amount is 10 ZH$');
    if (amount > roBalance) return alert('Not enough balance!');

    socket?.emit('rain:create', {
        userId: robloxUserId,
        username: currentUsername,
        amount,
        duration,
        minWager
    });

    closeRainModal();
}

function updateRainBanner(rain) {
    const banner = document.getElementById('chat-rain-banner');
    const timer = document.getElementById('chat-rain-timer');
    const joinBtn = document.getElementById('chat-rain-join-btn');

    if (!rain) {
        if (banner) banner.style.display = 'none';
        return;
    }

    if (banner) banner.style.display = 'block';

    // Stamp the actual rain ID on the button so handleJoinRainLogic can find it
    if (joinBtn) joinBtn.dataset.rainId = rain.id;
    
    // Update timer
    const updateTime = () => {
        const left = Math.ceil((rain.endsAt - Date.now()) / 1000);
        if (left <= 0) {
            if (banner) banner.style.display = 'none';
            return;
        }
        if (timer) timer.textContent = `${left}s`;
        setTimeout(updateTime, 1000);
    };
    updateTime();

    if (joinBtn) {
        joinBtn.onclick = () => handleJoinRainLogic(joinBtn);
        const isCreator =
            typeof robloxUserId !== 'undefined' &&
            robloxUserId != null &&
            rain.creatorUserId != null &&
            String(rain.creatorUserId) === String(robloxUserId);
        const alreadyJoined = rain.joiners.some((j) => String(j) === String(robloxUserId));
        if (isCreator) {
            joinBtn.disabled = true;
            joinBtn.classList.remove('rain-joined');
            joinBtn.classList.remove('loading');
            joinBtn.innerHTML = 'YOUR RAIN';
        } else if (alreadyJoined) {
            joinBtn.disabled = true;
            joinBtn.classList.add('rain-joined');
            joinBtn.innerHTML = '<i class="fa-solid fa-check"></i> JOINED';
        } else {
            joinBtn.disabled = false;
            joinBtn.classList.remove('rain-joined');
            joinBtn.innerHTML = 'JOIN';
        }
    }
}

function handleInlineJoinRain(btn) {
    handleJoinRainLogic(btn);
}

function handleJoinRainLogic(btn) {
    if (btn.disabled || btn.classList.contains('loading')) return;

    // Resolve the rainId: prefer data-rain-id on the button, then fall back to activeRains[0]
    let rId = btn.dataset.rainId;
    if (!rId || rId === 'active') rId = activeRains[0]?.id;
    if (!rId) {
        console.warn('[Rain] No active rain ID found, cannot join.');
        return;
    }

    btn.classList.add('loading');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> JOINING...';
    btn.disabled = true;

    // Emit join — server will confirm with rain:join-confirmed
    socket?.emit('rain:join', { rainId: rId, userId: robloxUserId });

    // Timeout fallback: if server doesn't confirm in 5s, reset button
    const timeout = setTimeout(() => {
        if (btn.classList.contains('loading')) {
            btn.classList.remove('loading');
            btn.disabled = false;
            btn.innerHTML = 'JOIN';
        }
    }, 5000);
    btn._joinTimeout = timeout;
}

// TIP SYSTEM UI (Confirmation)

function confirmSendTip() {
    const target = document.getElementById('tip-recipient')?.value.trim();
    const amount = parseFloat(document.getElementById('tip-amount')?.value) || 0;

    if (!target) return alert('Enter a recipient!');
    if (amount < 1) return alert('Minimum tip is 1 ZH$');
    if (amount > roBalance) return alert('Not enough balance!');

    socket?.emit('tip:send', {
        fromUserId: robloxUserId,
        fromUsername: currentUsername,
        toTarget: target,
        amount
    });

    closeTipModal();
}

// CHAT TOGGLE (MOBILE)
document.querySelector('.mobile-chat-toggle')?.addEventListener('click', () => {
    document.getElementById('global-chat')?.classList.toggle('active');
});

// ============================================================
// ADMIN PANEL UI LOGIC
// ============================================================

window.openAdminModal = function(e) {
    if (e) e.preventDefault();
    const backdrop = document.getElementById('admin-modal-backdrop');
    if (backdrop) {
        backdrop.classList.add('show');
        if (typeof window.adminIdentify === 'function') window.adminIdentify();
        const requestList = () => {
            if (typeof socket !== 'undefined' && socket && typeof robloxUserId !== 'undefined') {
                socket.emit('admin:get_online_users', { adminUserId: robloxUserId });
                socket.emit('admin:tournaments_list', { adminUserId: robloxUserId });
                socket.emit('admin:get_crypto_wd', { adminUserId: robloxUserId });
                socket.emit('admin:get_bans', { adminUserId: robloxUserId });
            }
        };
        queueMicrotask(requestList);
        setTimeout(requestList, 120);
        setTimeout(() => {
            document.getElementById('admin-search-input')?.focus();
        }, 150);
    }
};

window.closeAdminModal = function(e) {
    // Called with null for X button, or with event for backdrop click
    if (e && e.target && e.target.id !== 'admin-modal-backdrop') return;
    const backdrop = document.getElementById('admin-modal-backdrop');
    if (backdrop) backdrop.classList.remove('show');
};

window.adminActionCryptoWd = function(wdId, action) {
    if (!wdId || !action) return;
    if (action === 'paid' && !confirm('Are you absolutely sure you have sent the crypto to the player? This cannot be undone.')) return;
    if (action === 'reject' && !confirm('Reject this withdrawal and refund the ZH$ back to the player?')) return;
    
    if (typeof socket !== 'undefined' && socket && typeof robloxUserId !== 'undefined') {
        socket.emit('admin:action_crypto_wd', { adminUserId: robloxUserId, wdId, action });
    }
};

window.adminLookupUser = function() {
    const input = document.getElementById('admin-search-input');
    const query = input?.value.trim();
    if (!query) return;

    const btn = document.getElementById('admin-search-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Finding...';
    }

    socket?.emit('admin:lookup_user', { adminUserId: robloxUserId, query });
};

window.adminSetBalance = function() {
    if (!window._activeAdminUserId) return;
    const balance = parseFloat(document.getElementById('admin-balance-zr')?.value) || 0;
    
    socket?.emit('admin:update_balance', { 
        adminUserId: robloxUserId, 
        targetUserId: window._activeAdminUserId, 
        newBalance: balance 
    });
};

window.adminSetRig = function(mode) {
    if (!window._activeAdminUserId) return;
    socket?.emit('admin:set_rig', { 
        adminUserId: robloxUserId, 
        targetUserId: window._activeAdminUserId, 
        rigMode: mode 
    });
};

window.adminSetWithdrawAccess = function(revoked) {
    if (!window._activeAdminUserId) return;
    socket?.emit('admin:set_withdraw_access', {
        adminUserId: robloxUserId,
        targetUserId: window._activeAdminUserId,
        revoked: Boolean(revoked)
    });
};

window.adminSetRainAccess = function(revoked) {
    if (!window._activeAdminUserId) return;
    socket?.emit('admin:set_rain_access', {
        adminUserId: robloxUserId,
        targetUserId: window._activeAdminUserId,
        revoked: Boolean(revoked)
    });
};

window.adminSetTipAccess = function(revoked) {
    if (!window._activeAdminUserId) return;
    socket?.emit('admin:set_tip_access', {
        adminUserId: robloxUserId,
        targetUserId: window._activeAdminUserId,
        revoked: Boolean(revoked)
    });
};

window.adminSetWdCooldown = function(action) {
    if (!window._activeAdminUserId) return;
    const minEl = document.getElementById('admin-wd-cooldown-minutes');
    let durationMinutes = 30;
    if (action === 'set' && minEl) {
        const parsed = parseFloat(minEl.value);
        durationMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    }
    socket?.emit('admin:set_wd_cooldown', {
        adminUserId: robloxUserId,
        targetUserId: window._activeAdminUserId,
        action,
        durationMinutes: action === 'set' ? durationMinutes : undefined
    });
};

window.adminSetAnnouncement = function() {
    const textEl = document.getElementById('admin-announce-text');
    const dEl = document.getElementById('admin-announce-d');
    const hEl = document.getElementById('admin-announce-h');
    const mEl = document.getElementById('admin-announce-m');
    const sEl = document.getElementById('admin-announce-s');
    
    if (!textEl || !textEl.value.trim()) {
        alert('Please enter announcement text.');
        return;
    }
    
    let days = parseInt(dEl ? dEl.value : '0') || 0;
    let hours = parseInt(hEl ? hEl.value : '0') || 0;
    let mins = parseInt(mEl ? mEl.value : '0') || 0;
    let secs = parseInt(sEl ? sEl.value : '0') || 0;
    
    const durationMs = (days * 86400000) + (hours * 3600000) + (mins * 60000) + (secs * 1000);
    
    if (durationMs <= 0) {
        alert('Please enter a valid time duration (at least 1 second).');
        return;
    }

    socket?.emit('admin:set_announcement', {
        adminUserId: robloxUserId,
        text: textEl.value.trim(),
        durationMs
    });
    
    // reset UI
    textEl.value = '';
    if (dEl) dEl.value = '0';
    if (hEl) hEl.value = '0';
    if (mEl) mEl.value = '5';
    if (sEl) sEl.value = '0';
};

window.adminStopAnnouncement = function() {
    socket?.emit('admin:stop_announcement', { adminUserId: robloxUserId });
};

window.adminBanUser = function() {
    if (!window._activeAdminUserId) return;
    const reason = document.getElementById('admin-ban-reason')?.value || '';
    const duration = parseInt(document.getElementById('admin-ban-duration')?.value) || 0;
    const ipBan = document.getElementById('admin-ban-ip')?.checked || false;
    
    if (!confirm(`Are you sure you want to ban user ${window._activeAdminUserId}?`)) return;
    
    socket?.emit('admin:ban_user', {
        adminUserId: robloxUserId,
        targetUserId: window._activeAdminUserId,
        reason: reason,
        durationHours: duration,
        ipBan: ipBan
    });
};

window.adminUnbanUser = function(userId, ip) {
    if (!confirm('Are you sure you want to unban this target?')) return;
    socket?.emit('admin:unban_user', {
        adminUserId: robloxUserId,
        targetUserId: userId,
        targetIp: ip
    });
};

function renderAdminBansList(bansState) {
    const el = document.getElementById('admin-bans-list');
    if (!el) return;
    
    if (!bansState || (bansState.accounts.length === 0 && bansState.ips.length === 0)) {
        el.innerHTML = `<span style="font-size:12px;color:var(--text-secondary);">No active bans.</span>`;
        return;
    }
    
    let html = '';
    
    // Render Accounts
    if (bansState.accounts && bansState.accounts.length > 0) {
        html += `<h4 style="font-size:11px;color:var(--text-secondary);margin:8px 0 4px;text-transform:uppercase;">Account Bans</h4>`;
        bansState.accounts.forEach(b => {
            const exp = b.until ? new Date(b.until).toLocaleString() : 'Permanent';
            const name = b.username ? `<span style="color:var(--accent); font-size:11px; margin-left:4px;">(${b.username})</span>` : '';
            html += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:8px; border-radius:6px; border:1px solid rgba(239, 68, 68, 0.2);">
                <div>
                    <div style="font-weight:600; font-size:13px; color:#fff;">User ID: ${b.userId}${name}</div>
                    <div style="font-size:11px; color:var(--text-secondary);">Reason: ${b.reason}</div>
                    <div style="font-size:11px; color:#ef4444;">Expires: ${exp}</div>
                </div>
                <button class="cb-btn cb-btn-join" style="padding:4px 8px; font-size:11px;" onclick="adminUnbanUser('${b.userId}', null)">Unban</button>
            </div>`;
        });
    }
    
    // Render IPs
    if (bansState.ips && bansState.ips.length > 0) {
        html += `<h4 style="font-size:11px;color:var(--text-secondary);margin:12px 0 4px;text-transform:uppercase;">IP Bans</h4>`;
        bansState.ips.forEach(b => {
             const exp = b.until ? new Date(b.until).toLocaleString() : 'Permanent';
             html += `
             <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:8px; border-radius:6px; border:1px solid rgba(239, 68, 68, 0.2);">
                 <div>
                     <div style="font-weight:600; font-size:13px; color:#fff;">IP: ${b.ip}</div>
                     <div style="font-size:11px; color:var(--text-secondary);">Reason: ${b.reason}</div>
                     <div style="font-size:11px; color:#ef4444;">Expires: ${exp}</div>
                 </div>
                 <button class="cb-btn cb-btn-join" style="padding:4px 8px; font-size:11px;" onclick="adminUnbanUser(null, '${b.ip}')">Unban</button>
             </div>`;
        });
    }
    
    el.innerHTML = html;
}

function updateAdminRigUI(mode) {
    const badge = document.getElementById('admin-rig-badge');
    if (badge) {
        badge.textContent = mode.toUpperCase();
        badge.className = `admin-rig-badge ${mode}`;
    }

    // Update buttons
    const btns = ['win', 'lose', 'default'];
    btns.forEach(b => {
        const el = document.getElementById(`rig-${b}-btn`);
        if (el) {
            if (b === mode) el.classList.add('active');
            else el.classList.remove('active');
        }
    });
}

function setAdminWithdrawalCooldownStatus(endsAt) {
    const wdEl = document.getElementById('admin-wd-cooldown-status');
    if (!wdEl || typeof endsAt !== 'number') return;
    if (endsAt > Date.now()) {
        const date = new Date(endsAt);
        wdEl.textContent = `COOLDOWN ACTIVE: Ends at ${date.toLocaleTimeString()}`;
        wdEl.className = 'admin-wd-status active';
    } else {
        wdEl.textContent = 'NO COOLDOWN ACTIVE';
        wdEl.className = 'admin-wd-status clear';
    }
}

function updateAdminWithdrawAccessUI(revoked) {
    const el = document.getElementById('admin-withdraw-access-status');
    if (!el) return;
    if (revoked) {
        el.textContent = 'WITHDRAWAL ACCESS: REVOKED';
        el.className = 'admin-wd-status active';
    } else {
        el.textContent = 'WITHDRAWAL ACCESS: ALLOWED';
        el.className = 'admin-wd-status clear';
    }
}

function updateAdminRainAccessUI(revoked) {
    const el = document.getElementById('admin-rain-access-status');
    if (!el) return;
    if (revoked) {
        el.textContent = 'RAIN ACCESS: REVOKED';
        el.className = 'admin-wd-status active';
    } else {
        el.textContent = 'RAIN ACCESS: ALLOWED';
        el.className = 'admin-wd-status clear';
    }
}

function updateAdminTipAccessUI(revoked) {
    const el = document.getElementById('admin-tip-access-status');
    if (!el) return;
    if (revoked) {
        el.textContent = 'TIP ACCESS: REVOKED';
        el.className = 'admin-wd-status active';
    } else {
        el.textContent = 'TIP ACCESS: ALLOWED';
        el.className = 'admin-wd-status clear';
    }
}

function escapeHtmlTournament(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

function renderTournamentBannerStrip(tournaments) {
    const strip = document.getElementById('tournament-banner-strip');
    if (!strip) return;
    if (!tournaments || tournaments.length === 0) {
        strip.style.display = 'none';
        strip.innerHTML = '';
        return;
    }
    strip.style.display = 'block';
    strip.innerHTML = tournaments
        .map((t) => {
            const pool = Number(t.prizePool || 0).toLocaleString('en-US');
            const cur = t.prizeCurrency === 'zh' ? 'ZH$' : 'ZR$';
            const end = new Date(t.endsAt);
            const ended = t.ended;
            const sub = ended
                ? '<span class="tournament-banner__tag tournament-banner__tag--warn">Scoring window ended — awaiting finalize</span>'
                : `<span class="tournament-banner__tag">Ends ${escapeHtmlTournament(end.toLocaleString())}</span>`;
            return `<div class="tournament-banner__item"><span class="tournament-banner__icon" aria-hidden="true"><i class="fa-solid fa-trophy"></i></span><span class="tournament-banner__text"><strong>${escapeHtmlTournament(t.title)}</strong> · ${escapeHtmlTournament(t.metricLabel || '')} · Prize <strong>${pool} ${cur}</strong> · ${sub} · ${t.participantCount || 0} joined</span></div>`;
        })
        .join('');
}

function renderAdminTournamentsList(tournaments) {
    const el = document.getElementById('admin-tournaments-list');
    if (!el) return;
    if (!tournaments || tournaments.length === 0) {
        el.innerHTML = '<p class="admin-tournament-empty">No tournaments yet.</p>';
        return;
    }
    const rows = [...tournaments]
        .reverse()
        .map((t) => {
            const pool = Number(t.prizePool || 0).toLocaleString('en-US');
            const cur = t.prizeCurrency === 'zh' ? 'ZH$' : 'ZR$';
            const status = t.status || 'unknown';
            const participants = t.participants ? Object.keys(t.participants).length : 0;
            const metricLabel = t.metric ? (window.TOURNAMENT_METRIC_LABELS || {})[t.metric] || t.metric : '';
            let actions = '';
            if (status === 'active') {
                actions = `<button type="button" class="admin-tourney-btn" data-action="lb" data-tid="${escapeHtmlTournament(t.id)}">Leaderboard</button>
                    <button type="button" class="admin-tourney-btn admin-tourney-btn--danger" data-action="fin" data-tid="${escapeHtmlTournament(t.id)}">Finalize &amp; pay</button>
                    <button type="button" class="admin-tourney-btn admin-tourney-btn--muted" data-action="can" data-tid="${escapeHtmlTournament(t.id)}">Cancel</button>`;
            } else {
                actions = `<span class="admin-tourney-status">${escapeHtmlTournament(status)}</span>`;
            }
            return `<div class="admin-tourney-row">
                <div class="admin-tourney-main">
                    <div class="admin-tourney-title">${escapeHtmlTournament(t.title)}</div>
                    <div class="admin-tourney-meta">${escapeHtmlTournament(metricLabel)} · ${pool} ${cur} · ${participants} enrolled · ends ${escapeHtmlTournament(new Date(t.endsAt).toLocaleString())}</div>
                </div>
                <div class="admin-tourney-actions">${actions}</div>
            </div>`;
        })
        .join('');
    el.innerHTML = `<div class="admin-tourney-list-inner">${rows}</div>`;
    el.querySelectorAll('button[data-action][data-tid]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tid = btn.getAttribute('data-tid');
            const act = btn.getAttribute('data-action');
            if (act === 'lb') window.adminPreviewTournamentLeaderboard(tid);
            if (act === 'fin') window.adminFinalizeTournament(tid);
            if (act === 'can') window.adminCancelTournament(tid);
        });
    });
}

window.TOURNAMENT_METRIC_LABELS = {
    delta_wagered: 'Highest total wagered (ZR$ volume)',
    delta_rain_winnings: 'Highest rain winnings (ZH$)',
    delta_deposited: 'Highest deposited (ZR$)',
    delta_withdrawn: 'Highest withdrawn (ZR$)',
    delta_xp: 'Highest XP gained',
    net_balance: 'Highest net ZR$ gained (balance increase)',
    net_loss: 'Highest ZR$ lost from balance'
};

// Bind socket listeners for Admin bans
if (typeof socket !== 'undefined' && socket) {
    socket.on('admin:bans_list', (bansState) => {
        if (typeof renderAdminBansList === 'function') {
            renderAdminBansList(bansState);
        }
    });
}

window.adminCreateTournament = function () {
    const title = document.getElementById('admin-tournament-title')?.value?.trim() || 'Tournament';
    const metric = document.getElementById('admin-tournament-metric')?.value;
    const prizePool = parseFloat(document.getElementById('admin-tournament-prize')?.value);
    const prizeCurrency = document.getElementById('admin-tournament-currency')?.value || 'zr';
    const durationDays = parseFloat(document.getElementById('admin-tournament-days')?.value);
    socket?.emit('admin:tournament_create', {
        adminUserId: robloxUserId,
        title,
        metric,
        prizePool,
        prizeCurrency,
        durationDays
    });
};

window.adminFinalizeTournament = function (tournamentId) {
    if (!tournamentId) return;
    if (!confirm('Finalize this tournament? Prizes will be sent to top scorer(s); ties split the pool.')) return;
    socket?.emit('admin:tournament_finalize', { adminUserId: robloxUserId, tournamentId });
};

window.adminCancelTournament = function (tournamentId) {
    if (!tournamentId) return;
    if (!confirm('Cancel this tournament? No prizes will be sent.')) return;
    socket?.emit('admin:tournament_cancel', { adminUserId: robloxUserId, tournamentId });
};

window.adminPreviewTournamentLeaderboard = async function (tournamentId) {
    if (!tournamentId) return;
    try {
        const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/leaderboard`);
        const data = await res.json();
        const rows = (data.leaderboard || []).slice(0, 15);
        const text = rows.length
            ? rows.map((r, i) => `${i + 1}. ${r.username} — ${Number(r.score).toFixed(2)}`).join('\n')
            : 'No participants yet.';
        alert(text);
    } catch (e) {
        alert('Could not load leaderboard.');
    }
};

// Global enter key listener for search
document.getElementById('admin-search-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') adminLookupUser();
});

// ==============================================
// NOWPayments Crypto Deposit logic
// ==============================================
function updateCryptoZhPreview() {
    const amount = parseFloat(document.getElementById('dep-fiat-amount').value) || 0;
    // 0.007 Fiat = 1 ZH$
    const zh = Math.floor(amount / 0.007);
    document.getElementById('dep-crypto-receive-zh').innerText = zh;
}

async function updateCryptoMinAmount() {
    const coin = document.getElementById('dep-crypto-coin').value;
    const fiat = document.getElementById('dep-fiat-currency').value;
    const minText = document.getElementById('dep-crypto-min-text');
    const fiatInput = document.getElementById('dep-fiat-amount');
    const btn = document.getElementById('dep-crypto-generate-btn');
    
    if (!minText || !fiatInput) return;

    minText.innerHTML = `Calculating minimum for <strong style="color:var(--text-primary);">${coin.toUpperCase()}</strong>...`;
    btn.disabled = true;

    try {
        const res = await fetch(`/api/deposit/crypto/min-amount?coin=${coin}&fiat=${fiat}`);
        const data = await res.json();
        
        let safeMin = data.min_fiat ? data.min_fiat : 1.00;
        // Add a bit more padding and round up
        safeMin = Math.ceil(safeMin * 10) / 10; 
        safeMin = Math.max(1.00, safeMin); 
        
        fiatInput.min = safeMin;
        minText.innerHTML = `Enter the amount of Fiat you want to spend. Minimum is <strong style="color:var(--accent);">${safeMin.toFixed(2)} ${fiat.toUpperCase()}</strong> for this coin.`;
        
        // Auto-correct if below min
        if (parseFloat(fiatInput.value) < safeMin) {
            fiatInput.value = safeMin.toFixed(2);
            updateCryptoZhPreview();
        }
    } catch(e) {
        minText.innerText = `Enter the amount of Fiat you want to spend. Minimum is 1.00 ${fiat.toUpperCase()}.`;
    } finally {
        btn.disabled = false;
    }
}

async function generateCryptoInvoice() {
    if (!robloxUserId) {
        showGameToast('Please link your Roblox account first.', 'var(--red)');
        return;
    }
    
    const coin = document.getElementById('dep-crypto-coin').value;
    const fiatCurrency = document.getElementById('dep-fiat-currency').value;
    const fiatAmount = parseFloat(document.getElementById('dep-fiat-amount').value);
    const errEl = document.getElementById('dep-crypto-error');
    const btn = document.getElementById('dep-crypto-generate-btn');
    
    if (!fiatAmount || fiatAmount < 1.00) {
        errEl.innerText = 'Minimum deposit is 1.00 Fiat.';
        errEl.style.display = 'block';
        return;
    }
    
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
    
    try {
        const res = await fetch('/api/deposit/crypto/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: robloxUserId,
                currency: coin,
                fiatCurrency: fiatCurrency,
                fiatAmount: fiatAmount
            })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
            throw new Error(data.error || 'Failed to generate crypto address');
        }
        
        // Show successful data
        document.getElementById('dep-crypto-pay-amount').innerText = data.pay_amount;
        document.getElementById('dep-crypto-pay-coin').innerText = data.pay_currency.toUpperCase();
        document.getElementById('dep-crypto-pay-address').value = data.pay_address;
        
        // Handle Extra ID (Destination Tag / Memo)
        const extraWrap = document.getElementById('dep-crypto-extra-wrap');
        const extraInput = document.getElementById('dep-crypto-pay-extra');
        const extraLabel = document.getElementById('dep-crypto-extra-label');
        
        const extraId = data.pay_extra_id || data.extra_id || data.payin_extra_id;
        
        if (extraId) {
            extraInput.value = extraId;
            extraWrap.style.display = 'block';
            // Custom labels for certain coins
            if (coin === 'xrp') extraLabel.innerText = 'Destination Tag';
            else if (coin === 'xlm') extraLabel.innerText = 'Memo';
            else extraLabel.innerText = 'Memo / Extra ID';
        } else {
            extraWrap.style.display = 'none';
        }
        
        // Generate QR code using external API
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${data.pay_address}`;
        document.getElementById('dep-crypto-qr').src = qrUrl;
        
        goDepPage('crypto2');
    } catch (e) {
        console.error(e);
        errEl.innerText = e.message;
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerText = 'Generate Address';
    }
}

// ======================================================================
// CASE BATTLES SYSTEM
// ======================================================================

let _cbCases = [];
let _cbBattles = [];
let _cbCreateCaseId = null;
let _cbCreateRounds = 1;
let _cbCreateMode = 'normal';
let _cbBattleFormat = '1v1';
let _cbCurrentBattleId = null;
const CB_ACTIVE_BATTLE_KEY = 'cb_active_battle_id';
window._cbSpinning = false;
window._cbBattleSpinning = false;
window._cbSoundEnabled = true;

// Battle format → player count + team count
const CB_FORMAT_PLAYERS = { '1v1':2, '2v2':4, '3v3':6, '1v1v1':3, '1v1v1v1':4, '1v1v1v1v1':5 };
const CB_FORMAT_TEAMS   = { '1v1':2, '2v2':2, '3v3':2, '1v1v1':3, '1v1v1v1':4, '1v1v1v1v1':5 };
const CB_FORMAT_PER_TEAM= { '1v1':1, '2v2':2, '3v3':3, '1v1v1':1, '1v1v1v1':1, '1v1v1v1v1':1 };
const CB_TEAM_COLORS    = ['#60a5fa','#fc6161','#34d399','#fbbf24','#a78bfa'];

const RARITY_COLORS = {
    common:    '#9ca3af',
    uncommon:  '#34d399',
    rare:      '#60a5fa',
    epic:      '#a855f7',
    legendary: '#f59e0b'
};

// ======================================================================
// SOUND ENGINE — Web Audio API, fully procedural (no external files)
// ======================================================================
const cbSoundEngine = (() => {
    let ctx = null;
    let _enabled = true;
    let _tickTimeout = null;
    let _lastTickTime = 0;

    function getCtx() {
        if (!ctx) {
            try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
        }
        if (ctx && ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function playTone({ type='sine', freq=440, gain=0.3, duration=0.1, attack=0.005, release=0.05, detune=0 } = {}) {
        if (!_enabled) return;
        const c = getCtx(); if (!c) return;
        const g = c.createGain();
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.detune.value = detune;
        g.gain.setValueAtTime(0, c.currentTime);
        g.gain.linearRampToValueAtTime(gain, c.currentTime + attack);
        g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration + release);
        o.connect(g); g.connect(c.destination);
        o.start(c.currentTime);
        o.stop(c.currentTime + duration + release + 0.01);
    }

    function playNoise({ gain=0.2, duration=0.3, freq=800, q=1 } = {}) {
        if (!_enabled) return;
        const c = getCtx(); if (!c) return;
        const bufLen = Math.floor(c.sampleRate * duration);
        const buf = c.createBuffer(1, bufLen, c.sampleRate);
        const data = buf.getChannelData(0);
        for (let i=0; i<bufLen; i++) data[i] = Math.random()*2-1;
        const src = c.createBufferSource();
        src.buffer = buf;
        const filter = c.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = freq;
        filter.Q.value = q;
        const g = c.createGain();
        g.gain.setValueAtTime(gain, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
        src.connect(filter); filter.connect(g); g.connect(c.destination);
        src.start(); src.stop(c.currentTime + duration + 0.05);
    }

    return {
        setEnabled(v) { _enabled = v; },
        isEnabled() { return _enabled; },

        whoosh() {
            playNoise({ gain: 0.15, duration: 0.4, freq: 1200, q: 0.8 });
            playTone({ type:'sine', freq:180, gain:0.08, duration:0.35, release:0.1 });
        },

        tick(velocity=1) {
            // velocity 0-1: fast spin = higher pitch, slower = lower pitch
            const now = Date.now();
            const minGap = Math.max(20, 250 - velocity*220);
            if (now - _lastTickTime < minGap) return;
            _lastTickTime = now;
            const baseFreq = 200 + velocity * 600;
            const detune = (Math.random()-0.5)*120;
            playTone({ type:'triangle', freq:baseFreq, gain:0.06+velocity*0.04, duration:0.04, attack:0.002, release:0.04, detune });
        },

        click() {
            playTone({ type:'square', freq:380, gain:0.12, duration:0.02, attack:0.001, release:0.06 });
            playTone({ type:'sine',   freq:220, gain:0.08, duration:0.04, attack:0.002, release:0.06 });
        },

        result(rarity) {
            switch(rarity) {
                case 'common':
                    playTone({ type:'triangle', freq:160, gain:0.12, duration:0.15, attack:0.01, release:0.15 });
                    break;
                case 'uncommon':
                    playTone({ type:'sine', freq:320, gain:0.14, duration:0.2, attack:0.01, release:0.2 });
                    playTone({ type:'sine', freq:480, gain:0.08, duration:0.15, attack:0.02, release:0.2 });
                    break;
                case 'rare':
                    playTone({ type:'sine', freq:520, gain:0.16, duration:0.25, attack:0.01, release:0.3 });
                    playTone({ type:'sine', freq:780, gain:0.1,  duration:0.2,  attack:0.02, release:0.35 });
                    playNoise({ gain:0.04, duration:0.15, freq:3000, q:2 });
                    break;
                case 'epic':
                    playTone({ type:'sine', freq:440, gain:0.18, duration:0.3, attack:0.01, release:0.4 });
                    playTone({ type:'sine', freq:660, gain:0.14, duration:0.25, attack:0.015, release:0.4 });
                    playTone({ type:'sine', freq:880, gain:0.1,  duration:0.2,  attack:0.02,  release:0.45 });
                    playNoise({ gain:0.06, duration:0.2, freq:4000, q:3 });
                    break;
                case 'legendary':
                    // Layered jackpot with 0.25s pre-delay hit
                    setTimeout(() => {
                        playTone({ type:'sine', freq:110, gain:0.25, duration:0.5, attack:0.01, release:0.6 });
                        playNoise({ gain:0.15, duration:0.3, freq:800, q:1.5 });
                    }, 0);
                    setTimeout(() => {
                        playTone({ type:'sine', freq:523, gain:0.2, duration:0.6, attack:0.01, release:0.7 });
                        playTone({ type:'sine', freq:659, gain:0.15, duration:0.5, attack:0.02, release:0.7 });
                        playTone({ type:'sine', freq:784, gain:0.12, duration:0.4, attack:0.03, release:0.8 });
                        playNoise({ gain:0.08, duration:0.4, freq:5000, q:4 });
                    }, 250);
                    // Choir synth
                    setTimeout(() => {
                        [261, 329, 392, 523].forEach((f, i) => {
                            setTimeout(() => playTone({ type:'sine', freq:f, gain:0.06, duration:0.8, attack:0.1, release:0.5, detune:(Math.random()-0.5)*20 }), i*60);
                        });
                    }, 350);
                    break;
            }
        }
    };
})();

// Sound toggle
function cbToggleSound() {
    window._cbSoundEnabled = !window._cbSoundEnabled;
    cbSoundEngine.setEnabled(window._cbSoundEnabled);
    // Update all sound toggle buttons
    document.querySelectorAll('.cb-sound-toggle').forEach(btn => {
        const icon = btn.querySelector('i');
        if (icon) icon.className = window._cbSoundEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
        btn.classList.toggle('muted', !window._cbSoundEnabled);
    });
}


// --- Init ---
async function cbInit() {
    await cbLoadCases();
    await cbLoadBattles();
    cbBindSockets();
    await cbRestoreBattleSession();
}

// Called whenever the view becomes active
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-item[data-view]').forEach(link => {
        link.addEventListener('click', () => {
            if (link.dataset.view === 'casebattles') {
                cbInit();
            }
        });
    });
});

// --- API helpers ---
async function cbApiFetch(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
}

// --- Load cases ---
async function cbLoadCases() {
    const { ok, data } = await cbApiFetch('/api/cases');
    if (!ok) return;
    _cbCases = data.cases || [];
    cbRenderCasesGrid();
    cbRenderCreateCases();
}

function cbRenderCasesGrid() {
    const grid = document.getElementById('cb-cases-grid');
    if (!grid) return;
    grid.innerHTML = _cbCases.map(c => `
        <div class="cb-case-card" style="--case-color:${c.color}" onclick="cbOpenCaseModal('${c.id}')">
            <img class="cb-case-img" src="${c.image}" alt="${c.name}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect width=%2280%22 height=%2280%22 rx=%2210%22 fill=%22%230a0b14%22/><text x=%2240%22 y=%2248%22 font-size=%2236%22 text-anchor=%22middle%22>%F0%9F%93%A6</text></svg>'">
            <div class="cb-case-name">${c.name}</div>
            <div class="cb-case-price">${c.price.toLocaleString()} <span>ZR$</span></div>
            <div class="cb-case-items-preview">
                ${c.items.map(i => `<span class="cb-item-rarity-dot rarity-${i.rarity}" title="${i.name}"></span>`).join('')}
            </div>
        </div>
    `).join('');
}

// --- Battles list ---
async function cbLoadBattles() {
    const { ok, data } = await cbApiFetch('/api/battles');
    if (!ok) return;
    _cbBattles = data.battles || [];
    cbRenderBattlesList();
}

async function cbRestoreBattleSession() {
    if (!robloxUserId) return;
    const myId = String(robloxUserId);
    let preferredId = null;
    try { preferredId = localStorage.getItem(CB_ACTIVE_BATTLE_KEY); } catch (e) {}

    let battleToRestore = null;
    if (preferredId) {
        battleToRestore = _cbBattles.find(b => b.id === preferredId && b.players.some(p => String(p.userId) === myId));
    }
    if (!battleToRestore) {
        battleToRestore = _cbBattles.find(b =>
            (b.status === 'waiting' || b.status === 'active') &&
            b.players.some(p => String(p.userId) === myId)
        );
    }
    if (!battleToRestore) return;

    cbOpenBattleRoom(battleToRestore.id, battleToRestore);
}

function cbSetBattleSpinLock(isSpinning) {
    window._cbBattleSpinning = !!isSpinning;
    const closeBtn = document.getElementById('cb-battle-close-btn');
    if (!closeBtn) return;
    closeBtn.disabled = !!isSpinning;
    closeBtn.style.opacity = isSpinning ? '0.45' : '';
    closeBtn.style.cursor = isSpinning ? 'not-allowed' : '';
    closeBtn.title = isSpinning ? 'Wait for the spin to finish' : 'Close';
}

function cbRenderBattlesList() {
    const el = document.getElementById('cb-battles-list');
    if (!el) return;
    if (!_cbBattles.length) {
        el.innerHTML = '<div class="cb-empty"><i class="fa-solid fa-ghost"></i><p>No active battles.<br>Create one to get started!</p></div>';
        return;
    }
    el.innerHTML = _cbBattles.map(b => {
        const slots = b.maxPlayers;
        const filled = b.players.length;
        const playerPills = b.players.map(p =>
            `<span class="cb-player-pill${p.isBot?' bot':''}"><i class="fa-solid fa-${p.isBot?'robot':'user'}"></i>${p.username}</span>`
        ).join('');
        const emptyPills = Array(slots - filled).fill(0).map(() =>
            `<span class="cb-player-pill empty"><i class="fa-solid fa-plus"></i> Waiting...</span>`
        ).join('');
        const statusBadge = b.status === 'active' ? '🔴 Live' : b.status === 'done' ? '✅ Done' : '⏳ Waiting';
        return `
            <div class="cb-battle-row" onclick="cbOpenBattleRoom('${b.id}')">
                <img class="cb-battle-row-img" src="${b.caseImage}" alt="${b.caseName}" onerror="this.style.display='none'">
                <div class="cb-battle-row-info">
                    <div class="cb-battle-row-name">${b.caseName} — ${b.rounds} round${b.rounds>1?'s':''}</div>
                    <div class="cb-battle-row-meta">${CBModeLabel(b.mode)} · ${statusBadge}</div>
                    <div class="cb-battle-row-players" style="margin-top:8px;">${playerPills}${emptyPills}</div>
                </div>
                <div class="cb-battle-row-price">${(b.casePrice*b.rounds).toLocaleString()} ZR$</div>
            </div>
        `;
    }).join('');
}

function CBModeLabel(m) {
    return { normal:'Normal', crazy:'Crazy — Lowest Wins', team:'2v2 Teams', group:'Group' }[m] || m;
}

// --- Tabs ---
function cbSwitchTab(tab, btn) {
    document.querySelectorAll('.cb-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('cb-tab-battles').style.display = tab === 'battles' ? '' : 'none';
    document.getElementById('cb-tab-cases').style.display = tab === 'cases' ? '' : 'none';
}

// --- Create modal ---
function cbOpenCreateModal() {
    document.getElementById('cb-create-modal').style.display = 'flex';
    cbRenderCreateCases();
    cbRenderLobbySlots();
}

function cbSelectFormat(fmt, btn) {
    _cbBattleFormat = fmt;
    document.querySelectorAll('.cb-format-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    cbRenderLobbySlots();
    cbUpdateCreateCost();
}

function cbRenderLobbySlots() {
    const el = document.getElementById('cb-lobby-preview');
    if (!el) return;
    el.innerHTML = '';
}

function cbRenderCreateCases() {
    const el = document.getElementById('cb-create-cases');
    if (!el || !_cbCases.length) return;
    if (!_cbCreateCaseId) _cbCreateCaseId = _cbCases[0].id;
    el.innerHTML = _cbCases.map(c => `
        <div class="cb-create-case-option${_cbCreateCaseId===c.id?' selected':''}" style="--case-color:${c.color}" onclick="cbSelectCase('${c.id}',this)">
            <img src="${c.image}" alt="${c.name}" onerror="this.style.display='none'">
            <div class="cc-name">${c.name}</div>
            <div class="cc-price">${c.price.toLocaleString()} ZR$</div>
        </div>
    `).join('');
    cbRenderPreviewReel();
    cbUpdateCreateCost();
}

function cbSelectCase(id, el) {
    _cbCreateCaseId = id;
    document.querySelectorAll('.cb-create-case-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    cbRenderPreviewReel();
    cbUpdateCreateCost();
}

function cbRenderPreviewReel() {
    const wrap = document.getElementById('cb-preview-reel-wrap');
    const reel = document.getElementById('cb-preview-reel');
    if (!reel || !wrap) return;
    const c = _cbCases.find(x => x.id === _cbCreateCaseId);
    if (!c || !c.items || !c.items.length) { wrap.style.display = 'none'; return; }
    // Sort items by value descending so reel feels like a quality showcase
    const sorted = [...c.items].sort((a,b) => (b.value||0)-(a.value||0));
    reel.innerHTML = sorted.map(item => `
        <div class="cb-preview-item rarity-${item.rarity}">
            <img src="${item.icon||''}" alt="${item.name}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect width=%2280%22 height=%2280%22 rx=%228%22 fill=%22%230a0b14%22/><text x=%2240%22 y=%2248%22 font-size=%2232%22 text-anchor=%22middle%22>🎁</text></svg>'">
            <div class="pi-name">${item.name}</div>
            <div class="pi-val" style="color:${RARITY_COLORS[item.rarity]||'#fff'}">${item.value?item.value.toLocaleString()+' ZR$':'—'}</div>
            <div class="pi-tooltip">${item.name}${item.value?' · '+item.value.toLocaleString()+' ZR$':''}</div>
        </div>
    `).join('');
    wrap.style.display = 'block';
    // Enable drag-to-scroll
    cbInitReelDrag(reel);
}

function cbInitReelDrag(el) {
    let isDown = false, startX, scrollLeft;
    el.addEventListener('mousedown', e => { isDown=true; el.classList.add('active'); startX=e.pageX-el.offsetLeft; scrollLeft=el.scrollLeft; });
    el.addEventListener('mouseleave',()=>{ isDown=false; el.classList.remove('active'); });
    el.addEventListener('mouseup',  ()=>{ isDown=false; el.classList.remove('active'); });
    el.addEventListener('mousemove', e => {
        if(!isDown) return; e.preventDefault();
        const x=e.pageX-el.offsetLeft; el.scrollLeft=scrollLeft-(x-startX)*1.2;
    });
}

function cbSelectRounds(n, btn) {
    _cbCreateRounds = n;
    document.querySelectorAll('.cb-round-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    cbUpdateCreateCost();
}

function cbSelectMode(m, btn) {
    _cbCreateMode = m;
    document.querySelectorAll('.cb-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

function cbUpdateCreateCost() {
    const c = _cbCases.find(x => x.id === _cbCreateCaseId);
    const maxPlayers = CB_FORMAT_PLAYERS[_cbBattleFormat] || 2;
    const cost = c ? c.price * _cbCreateRounds : 0;
    const el = document.getElementById('cb-create-cost');
    if (el) el.textContent = cost.toLocaleString() + ' ZR$ (your entry)';
}

async function cbConfirmCreate() {
    if (!robloxUserId) return alert('Please log in first.');
    if (!_cbCreateCaseId) return alert('Select a case first.');
    const btn = document.getElementById('cb-create-confirm');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating...';
    const maxPlayers = CB_FORMAT_PLAYERS[_cbBattleFormat] || 2;
    const { ok, data } = await cbApiFetch('/api/battles/create', {
        method: 'POST',
        body: JSON.stringify({ userId: robloxUserId, caseId: _cbCreateCaseId, rounds: _cbCreateRounds, mode: _cbCreateMode, maxPlayers })
    });
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-swords"></i> Create Battle';
    if (!ok) return alert(data.error || 'Failed to create battle.');
    document.getElementById('cb-create-modal').style.display = 'none';
    cbSwitchTab('battles', document.querySelector('.cb-tab[data-tab="battles"]'));
    cbOpenBattleRoom(data.battle.id, data.battle);
}


// --- Solo case open ---
async function cbOpenCaseModal(caseId) {
    if (!robloxUserId) return alert('Please log in first.');
    const caseData = _cbCases.find(c => c.id === caseId);
    if (!caseData) return;

    const modal    = document.getElementById('cb-open-modal');
    const modalInner = document.getElementById('cb-open-modal-inner');
    const title    = document.getElementById('cb-open-modal-title');
    const result   = document.getElementById('cb-open-result');
    const track    = document.getElementById('cb-spinner-track');

    title.innerHTML = `<i class="fa-solid fa-box-open" style="color:#a78bfa;"></i> Opening: ${caseData.name}`;
    result.style.display = 'none';
    track.style.transition = 'none';
    track.style.transform = 'translate3d(0, 0, 0)';
    track.innerHTML = '';
    track.classList.remove('is-spinning','is-spinning-fast');
    modal.style.display = 'flex';
    window._cbSpinning = true;

    // Request roll from server first
    const { ok, data } = await cbApiFetch('/api/cases/open', {
        method: 'POST',
        body: JSON.stringify({ userId: robloxUserId, caseId })
    });

    if (!ok) {
        window._cbSpinning = false;
        modal.style.display = 'none';
        return alert(data.error || 'Failed to open case.');
    }

    const winningItem = data.item;
    if (typeof data.newBalance === 'number') {
        _roBalance = data.newBalance;
        updateBalanceDisplay();
    }

    // Build spinner track
    const ITEM_COUNT = 56;
    const WIN_POS    = 47; // winning item position
    const ITEM_WIDTH = 134; // item width (130) + margin (2+2)

    // Guarantee at least 1 item per rarity tier for visual distribution
    const rarityOrder = ['legendary','epic','rare','uncommon','common'];
    const items = [];
    const byRarity = {};
    rarityOrder.forEach(r => {
        byRarity[r] = caseData.items.filter(i => i.rarity === r);
    });
    // Fill with random items
    for (let i = 0; i < ITEM_COUNT; i++) {
        items.push(caseData.items[Math.floor(Math.random() * caseData.items.length)]);
    }
    // Seed at least one of each rarity that exists
    let seedIdx = 2;
    rarityOrder.forEach(r => {
        if (byRarity[r].length && seedIdx < WIN_POS - 3) {
            items[seedIdx] = byRarity[r][Math.floor(Math.random()*byRarity[r].length)];
            seedIdx += Math.max(2, Math.floor((WIN_POS - 3) / rarityOrder.length));
        }
    });
    items[WIN_POS] = winningItem;

    track.innerHTML = items.map((item, i) => `
        <div class="cb-horiz-item cb-item-rarity-${item.rarity}" data-idx="${i}">
            ${item.icon ? `<img class="cb-horiz-item-img" src="${item.icon}" alt="">` : ''}
            <div class="cb-horiz-item-name">${item.name}</div>
            <div class="cb-horiz-item-val">${item.value?item.value.toLocaleString()+' ZR$':'—'}</div>
        </div>
    `).join('');

    await new Promise(r => setTimeout(r, 80));

    const targetX   = WIN_POS * ITEM_WIDTH;

    // Play whoosh + start motion blur
    cbSoundEngine.whoosh();
    track.classList.add('is-spinning-fast');
    setTimeout(() => { track.classList.remove('is-spinning-fast'); track.classList.add('is-spinning'); }, 1800);
    setTimeout(() => { track.classList.remove('is-spinning'); }, 3400);

    await cbAnimateSpin(track, targetX, 4200);

    // Click + remove blur
    cbSoundEngine.click();
    track.classList.remove('is-spinning', 'is-spinning-fast');

    // Highlight winning item
    const winEl = track.children[WIN_POS];
    if (winEl) {
        winEl.classList.add('cb-spin-item--win');
    }

    // Screen shake on jackpot/legendary
    if (winningItem.rarity === 'legendary' && modalInner) {
        modalInner.classList.remove('jackpot-shake');
        void modalInner.offsetWidth;
        modalInner.classList.add('jackpot-shake');
        setTimeout(() => modalInner.classList.remove('jackpot-shake'), 600);
    }

    // Play result sound
    await new Promise(r => setTimeout(r, 350));
    cbSoundEngine.result(winningItem.rarity);

    // Show result panel
    await new Promise(r => setTimeout(r, 350));
    result.style.display = 'block';
    document.getElementById('cb-result-item-img-wrap').innerHTML =
        `<img src="${winningItem.icon}" alt="${winningItem.name}" style="width:120px;height:120px;object-fit:contain;filter:drop-shadow(0 0 20px ${RARITY_COLORS[winningItem.rarity]||'#fff'})">`;
    document.getElementById('cb-result-item-name').textContent = winningItem.name;
    const valEl = document.getElementById('cb-result-item-value');
    valEl.textContent = winningItem.value ? winningItem.value.toLocaleString() + ' ZR$' : 'No value';
    valEl.style.color = RARITY_COLORS[winningItem.rarity] || '#fff';

    window._cbSpinning = false;
}

function cbAnimateSpin(track, targetX, duration) {
    return new Promise(resolve => {
        const start  = performance.now();
        const startX = 0;
        let prevEased = 0;

        function easeOut(t) {
            // Quintic ease-out for dramatic deceleration
            return 1 - Math.pow(1 - t, 5);
        }

        function step(now) {
            const elapsed  = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased    = easeOut(progress);
            const currentX = startX + (targetX - startX) * eased;

            track.style.transition = 'none';
            track.style.transform  = `translate3d(-${currentX}px, 0, 0)`;

            // Tick sound proportional to velocity
            const velocity = (eased - prevEased) / (1 / 60); // approx velocity
            const normVel  = Math.min(1, velocity * 50);
            if (normVel > 0.005) cbSoundEngine.tick(normVel);
            prevEased = eased;

            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                resolve();
            }
        }
        requestAnimationFrame(step);
    });
}

// --- Battle room ---
function cbOpenBattleRoom(battleId, battleData) {
    _cbCurrentBattleId = battleId;
    try { localStorage.setItem(CB_ACTIVE_BATTLE_KEY, battleId); } catch (e) {}
    cbBindSockets(); // Re-bind sockets now that we have a specific battle ID
    const modal = document.getElementById('cb-battle-modal');
    modal.style.display = 'flex';
    cbSetBattleSpinLock(false);
    // Find battle in list or use passed data
    const b = battleData || _cbBattles.find(x => x.id === battleId);
    if (b) cbRenderBattleRoom(b);
}

function cbCloseBattleModal() {
    if (window._cbBattleSpinning) return;
    document.getElementById('cb-battle-modal').style.display = 'none';
    _cbCurrentBattleId = null;
    cbSetBattleSpinLock(false);
}

function cbRenderBattleRoom(b) {
    document.getElementById('cb-battle-title').innerHTML = `<i class="fa-solid fa-swords" style="color:#a78bfa;"></i> ${b.caseName} — ${CBModeLabel(b.mode)}`;
    // Meta
    const meta = document.getElementById('cb-battle-meta');
    meta.innerHTML = `<span>${b.rounds} round${b.rounds>1?'s':''}</span><span>${CBModeLabel(b.mode)}</span><span>${b.status==='waiting'?'⏳ Waiting for players':b.status==='active'?'🔴 Live':'✅ Done'}</span>`;

    // Players area
    const playersEl = document.getElementById('cb-battle-players');
    const caseData = _cbCases.find(c => c.id === b.caseId);
    const caseImg = caseData ? caseData.image : '';

    let html = `
    <div class="cb-1v1-battle">
        <div class="cb-1v1-players-header" style="flex-wrap:wrap;">
            <!-- Left Side Players -->
            <div class="team-side left" style="display:flex; flex-direction:column; gap:8px;">
                ${b.players.slice(0, Math.ceil(b.maxPlayers/2)).map(p => `
                <div class="cb-1v1-player">
                    <div class="avatar"><i class="fa-solid fa-${p.isBot?'robot':'user'}" style="color:${p.isBot?'#a78bfa':'#60a5fa'}"></i></div>
                    <div class="details">
                        <div class="name">${p.username} ${p.isBot ? '<span class="cb-bot-badge">BOT</span>' : ''}</div>
                        <div class="total" id="btotal-${p.userId}">${p.total.toLocaleString()} ZR$</div>
                    </div>
                </div>`).join('')}
                ${Array.from({length: Math.ceil(b.maxPlayers/2) - b.players.slice(0, Math.ceil(b.maxPlayers/2)).length}).map(_ => `
                <div class="cb-1v1-player" style="opacity:.4">
                    <div class="avatar"><i class="fa-solid fa-user-plus"></i></div>
                    <div class="details"><div class="name">Waiting...</div></div>
                </div>`).join('')}
            </div>
            
            <!-- Center Case Info -->
            <div class="cb-1v1-center-case" style="display:${b.status==='active'?'flex':'none'}">
                <div class="round-lbl">Round</div>
                <div class="cb-1v1-center-hex">
                    <img src="${caseImg}" onerror="this.style.display='none'">
                    <span>${b.caseName}</span>
                </div>
            </div>
            
            <!-- Right Side Players -->
            <div class="team-side right" style="display:flex; flex-direction:column; gap:8px;">
                ${b.players.slice(Math.ceil(b.maxPlayers/2)).map(p => `
                <div class="cb-1v1-player right">
                    <div class="avatar"><i class="fa-solid fa-${p.isBot?'robot':'user'}" style="color:${p.isBot?'#a78bfa':'#fc6161'}"></i></div>
                    <div class="details">
                        <div class="name">${p.username} ${p.isBot ? '<span class="cb-bot-badge">BOT</span>' : ''}</div>
                        <div class="total" id="btotal-${p.userId}">${p.total.toLocaleString()} ZR$</div>
                    </div>
                </div>`).join('')}
                ${Array.from({length: Math.floor(b.maxPlayers/2) - b.players.slice(Math.ceil(b.maxPlayers/2)).length}).map(_ => `
                <div class="cb-1v1-player right" style="opacity:.4">
                    <div class="avatar"><i class="fa-solid fa-user-plus"></i></div>
                    <div class="details"><div class="name">Waiting...</div></div>
                </div>`).join('')}
            </div>
        </div>

        <div class="cb-1v1-spinners" style="display:${b.status==='active'?'block':'none'}">
            ${b.players.map(p => `
            <div class="cb-1v1-spinner-line" id="bspinnerbox-${p.userId}" style="margin-bottom:5px;">
                <div class="win-tick"></div>
                <div class="cb-battle-spinner-track" id="bspinner-${p.userId}" style="flex-direction:row; padding-left:calc(50% - 67px); padding-top:0;"></div>
            </div>`).join('')}
        </div>

        <div class="cb-1v1-winnings-area" style="flex-wrap:wrap; display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
            ${b.players.map(p => `
            <div class="cb-1v1-win-col">
                <div class="cb-1v1-win-header">${p.username}'s Winnings</div>
                <div class="cb-1v1-win-items" id="brolls-${p.userId}">
                     ${p.rolls.map(r => cbRollCardHTML(r.item)).join('')}
                </div>
            </div>`).join('')}
        </div>
    </div>`;

    playersEl.innerHTML = html;

    // Actions
    const myId = String(robloxUserId);
    const actions = document.getElementById('cb-battle-actions');
    actions.innerHTML = '';
    const isCreator = b.players.length && String(b.players[0].userId) === myId;
    const hasJoined = b.players.find(p => String(p.userId) === myId);

    if (b.status === 'waiting') {
        if (!hasJoined) {
            actions.innerHTML += `<button class="cb-btn cb-btn-join" onclick="cbJoinBattle('${b.id}')"><i class="fa-solid fa-right-to-bracket"></i> Join Battle</button>`;
        }
        if (isCreator) {
            actions.innerHTML += `<button class="cb-btn cb-btn-callbot" onclick="cbCallBot('${b.id}')"><i class="fa-solid fa-robot"></i> Call Bot</button>`;
        }
    }

    // Winner banner
    const winnerEl = document.getElementById('cb-battle-winner');
    if (b.status === 'done' && (b.winner || b.isTie)) {
        winnerEl.style.display = 'block';
        if (b.isTie) {
            winnerEl.innerHTML = `<h3>🤝 It's a Tie!</h3><p>All players have been refunded their original case costs.</p>`;
        } else {
            const payoutAmount = Number(b.payoutAmount || 0);
            winnerEl.innerHTML = `<h3>🏆 ${b.winner.username} Won! ${payoutAmount.toLocaleString()} ZR$</h3>`;
        }
    } else {
        winnerEl.style.display = 'none';
    }
}

function cbRollCardHTML(item) {
    const img = item.icon
        ? `<img class="cb-horiz-item-img cb-horiz-item-img--compact" src="${item.icon}" alt="">`
        : '';
    return `
        <div class="cb-horiz-item cb-item-rarity-${item.rarity}" style="animation: cbRollIn .3s cubic-bezier(.34,1.56,.64,1); width:110px; min-height:72px; margin-right:4px;">
            ${img}
            <div class="cb-horiz-item-name" style="font-size:10px;">${item.name}</div>
            <div class="cb-horiz-item-val" style="font-size:10px;">${item.value?item.value.toLocaleString()+' ZR$':'—'}</div>
        </div>
    `;
}

async function cbJoinBattle(battleId) {
    if (!robloxUserId) return alert('Please log in first.');
    const btn = document.querySelector('.cb-btn-join');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Joining...'; }
    const { ok, data } = await cbApiFetch(`/api/battles/${battleId}/join`, {
        method: 'POST',
        body: JSON.stringify({ userId: robloxUserId })
    });
    if (!ok) return alert(data.error || 'Could not join.');
    cbSoundEngine.click();
    // Let socket events handle rendering to prevent interrupting animation
}

async function cbCallBot(battleId) {
    const btn = document.querySelector('.cb-btn-callbot');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-robot"></i> Calling...'; }
    const { ok, data } = await cbApiFetch(`/api/battles/${battleId}/callbot`, {
        method: 'POST',
        body: JSON.stringify({ userId: robloxUserId })
    });
    if (!ok) return alert(data.error || 'Could not call bot.');
    cbSoundEngine.click();
    // Let socket events handle rendering to prevent interrupting animation
}

// --- Socket.IO listeners for real-time battle updates ---
function cbBindSockets() {
    if (!socket) return;
    // Remove old listeners to avoid duplicates
    socket.off('battles:list_update');
    socket.off('battles:round_result');

    socket.on('battles:list_update', (battles) => {
        _cbBattles = battles || [];
        cbRenderBattlesList();
    });

    // Dynamic per-battle events when watching a room
    if (_cbCurrentBattleId) {
        const bid = _cbCurrentBattleId;
        socket.off(`battle:${bid}:update`);
        socket.off(`battle:${bid}:started`);
        socket.off(`battle:${bid}:round`);
        socket.off(`battle:${bid}:done`);

        socket.on(`battle:${bid}:update`, (b) => cbRenderBattleRoom(b));
        socket.on(`battle:${bid}:started`, (b) => cbRenderBattleRoom(b));

        socket.on(`battle:${bid}:round`, async ({ round, results }) => {
            cbSetBattleSpinLock(true);
            try {
                const b = _cbBattles.find(x => x.id === bid);
                const caseData = b ? _cbCases.find(c => c.id === b.caseId) : null;
                
                // Build and spin each player's track concurrently
                const spinPromises = results.map(async (r) => {
                    const track = document.getElementById(`bspinner-${r.userId}`);
                    if (!track) return;
                    
                    let fakeItems = [];
                    if (caseData) {
                        for(let i=0; i<30; i++) {
                            fakeItems.push(caseData.items[Math.floor(Math.random() * caseData.items.length)]);
                        }
                    }
                    fakeItems.push(r.item);
                    
                    // Add trailing items so the spinner loops smoothly and isn't empty post-winner
                    if (caseData) {
                        for(let i=0; i<12; i++) {
                            fakeItems.push(caseData.items[Math.floor(Math.random() * caseData.items.length)]);
                        }
                    }
                    
                    track.style.transition = 'none';
                    track.style.transform = 'translate3d(0, 0, 0)';
                    
                    // UNIVERSAL HORIZONTAL track items (color blocks with names/values)
                    track.innerHTML = fakeItems.map((item) => `
                        <div class="cb-horiz-item cb-item-rarity-${item.rarity}">
                            ${item.icon ? `<img class="cb-horiz-item-img" src="${item.icon}" alt="">` : ''}
                            <div class="cb-horiz-item-name">${item.name}</div>
                            <div class="cb-horiz-item-val">${item.value ? item.value.toLocaleString() + ' ZR$' : '—'}</div>
                        </div>
                    `).join('');
                    
                    // wait slight random delay so they don't look perfectly synced
                    await new Promise(res => setTimeout(res, 50 + Math.random()*200));
                    
                    const itemWidth = 134;
                    const targetVal = 30 * itemWidth;
                    
                    cbSoundEngine.whoosh();
                    track.classList.add('is-spinning-fast');
                    setTimeout(() => { track.classList.remove('is-spinning-fast'); track.classList.add('is-spinning'); }, 1500);
                    setTimeout(() => { track.classList.remove('is-spinning'); }, 3000);

                    return cbAnimateSpinDirection(track, targetVal, 3800, 'X').then(async () => {
                        cbSoundEngine.click();
                        track.classList.remove('is-spinning', 'is-spinning-fast');
                        
                        track.children[30]?.classList.add('cb-spin-item--win-ver');

                        await new Promise(res => setTimeout(res, 200));
                        cbSoundEngine.result(r.item.rarity);

                        const tmpDiv = document.createElement('div');
                        tmpDiv.innerHTML = cbRollCardHTML(r.item);
                        const card = tmpDiv.firstElementChild;
                        document.getElementById(`brolls-${r.userId}`)?.appendChild(card);
                        
                        const totalEl = document.getElementById(`btotal-${r.userId}`);
                        if (totalEl) totalEl.textContent = r.total.toLocaleString() + ' ZR$';
                    });
                });
                
                await Promise.all(spinPromises);
            } finally {
                cbSetBattleSpinLock(false);
            }
        });

        function cbAnimateSpinDirection(track, targetVal, duration, dir) {
            return new Promise(resolve => {
                const start = performance.now();
                let prevEased = 0;
                function easeOut(t) { return 1 - Math.pow(1 - t, 5); }
                function step(now) {
                    const elapsed = now - start;
                    const progress = Math.min(elapsed / duration, 1);
                    const eased = easeOut(progress);
                    const currentVal = targetVal * eased;

                    track.style.transition = 'none';
                    if (dir === 'X') {
                        track.style.transform = `translate3d(-${currentVal}px, 0, 0)`;
                    } else {
                        track.style.transform = `translate3d(0, -${currentVal}px, 0)`;
                    }

                    const velocity = (eased - prevEased) / (1 / 60);
                    const normVel = Math.min(1, velocity * 50);
                    if (normVel > 0.005) cbSoundEngine.tick(normVel);
                    prevEased = eased;

                    if (progress < 1) requestAnimationFrame(step);
                    else resolve();
                }
                requestAnimationFrame(step);
            });
        }

        socket.on(`battle:${bid}:done`, (b) => {
            cbSetBattleSpinLock(false);
            // Highlight winner column
            if (b.winner) {
                const col = document.getElementById(`bcol-${b.winner.userId}`);
                if (col) col.classList.add('winner');
            }
            // Show winner banner
            const winnerEl = document.getElementById('cb-battle-winner');
            if (winnerEl) {
                winnerEl.style.display = 'block';
                if (b.isTie) {
                    winnerEl.innerHTML = `<h3>🤝 It's a Tie!</h3><p>All players have been refunded their original case costs.</p>`;
                } else if (b.winner) {
                    const payoutAmount = Number(b.payoutAmount || 0);
                    winnerEl.innerHTML = `<h3>🏆 ${b.winner.username} Won! ${payoutAmount.toLocaleString()} ZR$</h3>`;
                }
            }
            // Clear action buttons
            document.getElementById('cb-battle-actions').innerHTML = '';
            // Update meta
            const meta = document.getElementById('cb-battle-meta');
            if (meta) meta.innerHTML = `<span>${b.rounds} round${b.rounds>1?'s':''}</span><span>${CBModeLabel(b.mode)}</span><span>✅ Done</span>`;
            try { localStorage.removeItem(CB_ACTIVE_BATTLE_KEY); } catch (e) {}
        });
    }
}
