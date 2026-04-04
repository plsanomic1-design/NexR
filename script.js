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

        let deck = [];
        let dHand = [];
        let pHand = [];
        let isPlaying = false;

        function buildDeck() {
            /** ASCII suit letters — Unicode suit glyphs and some FA icons are missing in fonts / free sets. */
            const suits = [
                { letter: 'S', isRed: false },
                { letter: 'H', isRed: true },
                { letter: 'D', isRed: true },
                { letter: 'C', isRed: false }
            ];
            const values = [{v:'2',s:2},{v:'3',s:3},{v:'4',s:4},{v:'5',s:5},{v:'6',s:6},{v:'7',s:7},{v:'8',s:8},{v:'9',s:9},{v:'10',s:10},{v:'J',s:10},{v:'Q',s:10},{v:'K',s:10},{v:'A',s:11}];
            deck = [];
            for(const suit of suits) {
                for(let val of values) {
                    deck.push({
                        suitLetter: suit.letter,
                        value: val.v,
                        score: val.s,
                        isRed: suit.isRed
                    });
                }
            }
            deck.sort(() => Math.random() - 0.5);
        }

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
            isPlaying = false;
            renderHands(false);
            bjHitBtn.disabled = true;
            bjStandBtn.disabled = true;
            bjPlayBtn.disabled = false;
            bjPlayBtn.textContent = 'Place bet';
            
            bjMsg.textContent = msg;
            bjMsg.style.color = color;
            bjMsg.style.display = 'block';
        }

        bjPlayBtn.addEventListener('click', () => {
            if(isPlaying) return;
            buildDeck();
            pHand = [deck.pop(), deck.pop()];
            dHand = [deck.pop(), deck.pop()];
            isPlaying = true;
            bjMsg.style.display = 'none';
            
            bjHitBtn.disabled = false;
            bjStandBtn.disabled = false;
            bjPlayBtn.disabled = true;
            bjPlayBtn.textContent = 'Playing...';
            
            renderHands();
            if(getScore(pHand) === 21) {
                endGame('Blackjack! You Win', 'var(--gold)');
            }
        });

        bjHitBtn.addEventListener('click', () => {
            if(!isPlaying) return;
            pHand.push(deck.pop());
            renderHands();
            if(getScore(pHand) > 21) endGame('Bust! You Lose', 'var(--red)');
        });

        bjStandBtn.addEventListener('click', () => {
            if(!isPlaying) return;
            while(getScore(dHand) < 17) {
                dHand.push(deck.pop());
            }
            const pScore = getScore(pHand);
            const dScore = getScore(dHand);
            
            if(dScore > 21) endGame('Dealer Busts! You Win', 'var(--green)');
            else if(pScore > dScore) endGame('You Win!', 'var(--green)');
            else if(dScore > pScore) endGame('Dealer Wins', 'var(--red)');
            else endGame('Push', 'var(--text-secondary)');
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
        let mMultiplier = 1.0;
        let currentBet = 0;

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
            minesPlayBtn.classList.add('mines-cashout');
            minesPlayBtn.style.background = '';
        }

        minesPlayBtn.addEventListener('click', () => {
            if(mIsPlaying) {
                // Cash out
                endMines(true);
            } else {
                // Start
                mIsPlaying = true;
                minesMsg.style.display = 'none';
                currentBet = parseFloat(betInp.value) || 0;
                let bombs = parseInt(countInp.value) || 3;
                if(bombs < 1) bombs = 1; if(bombs > 24) bombs = 24;
                
                mGrid = Array(25).fill(false);
                let placed = 0;
                while(placed < bombs) {
                    let idx = Math.floor(Math.random() * 25);
                    if(!mGrid[idx]) { mGrid[idx] = true; placed++; }
                }
                
                mRevealed = 0;
                mMultiplier = 1.0;
                earningsInp.value = currentBet.toFixed(2);
                minesPlayBtn.disabled = true; // must reveal at least one gem first
                syncMinesCashoutButton();
                
                const tiles = minesGrid.querySelectorAll('.mines-tile');
                tiles.forEach((t) => {
                    t.className = 'mines-tile';
                    t.innerHTML = '<span class="tile-mark">G</span>';
                });
            }
        });

        function handleTileClick(i, tileEl) {
            if(!mIsPlaying || tileEl.classList.contains('revealed')) return;
            
            tileEl.classList.add('revealed');
            if(mGrid[i]) {
                // Bomb hit — SFX only here (not DOM observer) so gem+bomb never stack
                tileEl.classList.add('bomb');
                tileEl.innerHTML = '<span class="tile-mark">B</span>';
                soundBomb();
                endMines(false);
            } else {
                // Gem hit
                tileEl.classList.add('gem');
                tileEl.innerHTML = '<span class="tile-mark">G</span>';
                soundGem();
                mRevealed++;
                minesPlayBtn.disabled = false; // can now cashout
                let bombs = parseInt(countInp.value) || 3;
                mMultiplier = getMulti(bombs, mRevealed);
                earningsInp.value = (currentBet * parseFloat(mMultiplier)).toFixed(2);
                syncMinesCashoutButton();
                
                if(mRevealed + bombs === 25) {
                    endMines(true); // auto cashout if all found
                }
            }
        }

        function endMines(win) {
            mIsPlaying = false;
            minesPlayBtn.textContent = 'Start new game';
            minesPlayBtn.classList.remove('mines-cashout');
            minesPlayBtn.style.background = '';
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

        tPlayBtn.addEventListener('click', () => {
            if(tIsPlaying) {
                // Cashout
                endTowers(true);
            } else {
                tIsPlaying = true;
                tMsg.style.display = 'none';
                curRow = 0;
                curBet = parseFloat(tBetInp.value) || 0;
                const cfg = getDiffConfig();
                tMulti = 1.0;
                tLogic = [];
                
                for(let r=0; r<rows; r++) {
                    let rArr = Array(cfg.w).fill(false);
                    let placed = 0;
                    while(placed < cfg.b) {
                        let i = Math.floor(Math.random()*cfg.w);
                        if(!rArr[i]) { rArr[i] = true; placed++; }
                    }
                    tLogic.push(rArr);
                }
                
                tPlayBtn.textContent = 'Cashout';
                tPlayBtn.style.background = 'var(--green)';
                tPlayBtn.disabled = true; // must pick at least one tile first
                
                // Reset UI classes
                Array.from(tGrid.children).forEach((row, i) => {
                    row.className = 'tower-row ' + (i===0 ? 'active-row' : '');
                    Array.from(row.children).forEach(t => {
                        let origVal = Math.pow(cfg.base, i+1).toFixed(2);
                        t.className = 'tower-tile';
                        t.innerHTML = `${origVal}x <span class="tower-zr-suffix">ZH$</span>`;
                        t.style.pointerEvents = (i===0) ? 'auto' : 'none';
                    });
                });
            }
        });

        function handleTowerClick(r, c, tileEl) {
            if(!tIsPlaying || r !== curRow) return;
            const cfg = getDiffConfig();
            
            if(tLogic[curRow][c]) {
                tileEl.classList.add('bomb');
                tileEl.innerHTML = '<span class="tile-mark">B</span>';
                endTowers(false);
            } else {
                tileEl.classList.add('gem');
                tileEl.innerHTML = '<span class="tile-mark">S</span>';
                tMulti = Math.pow(cfg.base, curRow+1);
                curRow++;
                tPlayBtn.disabled = false; // can now cashout
                
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
        }

        function endTowers(win) {
            tIsPlaying = false;
            tPlayBtn.textContent = 'Start new game';
            tPlayBtn.style.background = 'var(--accent)';
            tPlayBtn.disabled = false;
            
            document.querySelectorAll('.tower-tile').forEach(t => t.style.pointerEvents='none');
            
            if(!win) {
                const rElements = Array.from(tGrid.children);
                const crow = rElements[curRow];
                Array.from(crow.children).forEach((el, idx) => {
                    if(!el.classList.contains('bomb') && !el.classList.contains('gem')) {
                        if(tLogic[curRow][idx]) {
                            el.classList.add('bomb');
                            el.innerHTML = '<span class="tile-mark" style="opacity:0.5">B</span>';
                        }
                    }
                });
            }

            if(win && curRow > 0) {
                tMsg.textContent = `Won ${(curBet * tMulti).toFixed(2)}`;
                tMsg.style.color = 'var(--green)';
                tMsg.style.display = 'block';
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

        dPlayBtn.addEventListener('click', () => {
            dPlayBtn.disabled = true;
            resultMarker.classList.remove('show');
            
            // simulate roll
            setTimeout(() => {
                let roll = (Math.random() * 100).toFixed(2);
                let target = parseFloat(targetInp.value);
                let win = isOver ? (roll > target) : (roll < target);
                
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
                    hard: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000]
                }
            };
            return payouts[rows][diff] || payouts[8]['easy'];
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
                    
                    const bucketEl = bucketsContainer.children[idx];
                    if(bucketEl) {
                        bucketEl.classList.add('hit');
                        setTimeout(() => bucketEl.classList.remove('hit'), 150);
                        const multi = parseFloat(bucketEl.dataset.multi);
                        awardWin(b.bet * multi);
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

        pPlayBtn.addEventListener('click', (e) => {
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
            
            deductBet(bet);
            
            balls.push({
                x: 300 + (Math.random()-0.5)*2, // start exactly at top center with tiny variance
                y: 15,
                vx: 0,
                vy: 0,
                r: 6,
                bet: bet,
                done: false
            });
            
            if(!pIsAnimating) {
                pIsAnimating = true;
                requestAnimationFrame(updatePhysics);
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
        let hasCashedOut = false;
        
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
                const padX = 40;
                const padY = 40;
                const maxW = canvas.width - padX*2;
                const maxH = canvas.height - padY*2 - 80;
                
                ctx.beginPath();
                ctx.moveTo(padX, canvas.height - padY);
                
                let steps = 50;
                let lastX = padX;
                let lastY = canvas.height - padY;
                for(let i=0; i<=steps; i++) {
                    let frac = i/steps;
                    let t = timeMs * frac;
                    let m = 1.00 * Math.pow(Math.E, t * 0.00006);
                    
                    let px = padX + (t / (timeMs || 1)) * maxW;
                    let py = (canvas.height - padY) - ((m - 1.0) / ((multi || 1.01) - 1.0)) * maxH;
                    if(isNaN(py)) py = canvas.height - padY;
                    
                    ctx.lineTo(px, py);
                    lastX = px;
                    lastY = py;
                }
                
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

                /** Marker at curve end — no emoji (canvas default fonts often lack color emoji → tofu boxes). */
                ctx.save();
                ctx.translate(lastX, lastY);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                if(cState === 'running') {
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = '#f5af19';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(0, -16);
                    ctx.lineTo(12, 10);
                    ctx.lineTo(0, 4);
                    ctx.lineTo(-12, 10);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = '#f5af19';
                    ctx.beginPath();
                    ctx.moveTo(-5, 10);
                    ctx.lineTo(0, 20);
                    ctx.lineTo(5, 10);
                    ctx.closePath();
                    ctx.fill();
                } else if(cState === 'crashed') {
                    ctx.strokeStyle = '#ff6b6b';
                    ctx.lineWidth = 3;
                    for(let i = 0; i < 8; i++) {
                        const a = (i / 8) * Math.PI * 2;
                        ctx.beginPath();
                        ctx.moveTo(0, 0);
                        ctx.lineTo(Math.cos(a) * 22, Math.sin(a) * 22);
                        ctx.stroke();
                    }
                    ctx.fillStyle = '#ff6b6b';
                    ctx.beginPath();
                    ctx.arc(0, 0, 7, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        };

        const doCashout = () => {
            if(hasCashedOut || cState !== 'running' || cBet <= 0) return;
            hasCashedOut = true;
            let winAmt = cBet * cMulti;
            awardWin(winAmt);
            postLiveFeedRound('crash', cBet, cMulti, winAmt);
            if(typeof soundWin === 'function') soundWin();
            
            crashPlayBtn.textContent = 'Cashed out';
            crashPlayBtn.style.background = 'var(--accent)';
            crashPlayBtn.disabled = true;
            
            playersList.innerHTML = `<div style="color:var(--green)">
                <span style="display:flex;align-items:center;gap:6px;"><img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(currentUsername)}&backgroundColor=2c2f4a" style="width:16px;border-radius:4px;"> You</span>
                <span>${cMulti.toFixed(2)}x</span>
                <span>+${winAmt.toFixed(2)}</span>
            </div>` + playersList.innerHTML;
        };

        const updateCrash = (timestamp) => {
            if(!startTime) startTime = timestamp;
            let elapsed = timestamp - startTime;
            
            cMulti = 1.00 * Math.pow(Math.E, elapsed * 0.00006);
            
            if(cMulti >= cCrashPoint) {
                cMulti = cCrashPoint;
                cState = 'crashed';
                display.textContent = cMulti.toFixed(2) + 'x';
                display.style.color = '#ff6b6b';
                statusText.textContent = 'Crashed';
                statusText.style.color = '#ff6b6b';
                
                drawGraph(elapsed, cMulti);
                if(typeof soundLose === 'function' && !hasCashedOut && cBet > 0) soundLose();
                if(!hasCashedOut && cBet > 0) postLiveFeedRound('crash', cBet, 0, -cBet);
                
                const hist = document.getElementById('crash-history');
                const p = document.createElement('span');
                p.className = 'history-pill ' + (cCrashPoint > 2 ? 'win' : 'lose');
                if(cCrashPoint >= 10) { p.style.background = '#f5af19'; p.style.color = '#1a1c2d'; }
                p.textContent = cCrashPoint.toFixed(2);
                hist.prepend(p);
                if(hist.children.length > 7) hist.lastChild.remove();
                
                setTimeout(resetGame, 3000);
                return;
            }

            display.textContent = cMulti.toFixed(2) + 'x';
            drawGraph(elapsed, cMulti);
            
            if(!hasCashedOut && cBet > 0) {
                if(cAuto > 1.0 && cMulti >= cAuto) {
                    doCashout();
                }
            }
            
            animFrame = requestAnimationFrame(updateCrash);
        };
        
        const startRunning = () => {
            cState = 'running';
            hasCashedOut = false;
            startTime = 0;
            
            let e = 100;
            if(Math.random() < 0.05) cCrashPoint = 1.00;
            else cCrashPoint = Math.max(1.00, (e / (e - Math.random() * e)) * 0.99);
            if(cCrashPoint > 1000) cCrashPoint = 1000;
            
            display.style.color = 'white';
            statusText.textContent = 'Current payout';
            statusText.style.color = 'var(--text-secondary)';
            
            if(cBet > 0) {
                crashPlayBtn.textContent = 'Cashout';
                crashPlayBtn.style.background = 'var(--green)';
            }
            
            animFrame = requestAnimationFrame(updateCrash);
        };

        const countdown = () => {
            let left = 5.0;
            cState = 'starting';
            display.style.color = 'white';
            statusText.textContent = 'Starting in';
            statusText.style.color = 'var(--text-secondary)';
            
            playersList.innerHTML = `<div>
                <span style="display:flex;align-items:center;gap:6px;"><img src="https://api.dicebear.com/7.x/avataaars/svg?seed=john&backgroundColor=2c2f4a" style="width:16px;border-radius:4px;"> John</span>
                <span>-</span>
                <span>15.00</span>
            </div><div>
                <span style="display:flex;align-items:center;gap:6px;"><img src="https://api.dicebear.com/7.x/avataaars/svg?seed=alex&backgroundColor=2c2f4a" style="width:16px;border-radius:4px;"> Alex</span>
                <span>-</span>
                <span>50.00</span>
            </div>`;
            
            let intv = setInterval(() => {
                left -= 0.1;
                if(left <= 0) {
                    clearInterval(intv);
                    startRunning();
                } else {
                    display.textContent = left.toFixed(1) + 's';
                    drawGraph(0, 1.0);
                }
            }, 100);
        };

        const resetGame = () => {
            cState = 'idle';
            cBet = 0;
            hasCashedOut = false;
            crashPlayBtn.textContent = 'Join next game';
            crashPlayBtn.style.background = 'var(--accent)';
            crashPlayBtn.disabled = false;
            countdown(); 
        };

        setTimeout(resetGame, 1000); 

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
                deductBet(bet);
                
                crashPlayBtn.textContent = 'Joined';
                crashPlayBtn.style.background = 'var(--bg-panel-light)';
                
                playersList.innerHTML = `<div>
                    <span style="display:flex;align-items:center;gap:6px;"><img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(currentUsername)}&backgroundColor=2c2f4a" style="width:16px;border-radius:4px;"> You</span>
                    <span>-</span>
                    <span>${bet.toFixed(2)}</span>
                </div>` + playersList.innerHTML;
            } else if(cState === 'running') {
                doCashout();
            }
        });
    }

});

// ===== GLOBAL BALANCE SYSTEM =====
let roBalance = 0.00;
let referralEarned = 0;
let referredCount = 0;

function getZephrsChatUser() {
    return {
        name: currentUsername || 'Guest',
        level: Math.max(1, Math.floor((userStats.xp || 0) / 100) + 1)
    };
}

function updateBalanceDisplay() {
    const tbEl = document.getElementById('tb-balance');
    const homeEl = document.getElementById('home-balance');
    const formatted = roBalance.toFixed(2);
    if(tbEl) tbEl.textContent = formatted;
    if(homeEl) homeEl.textContent = formatted;

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
function deductBet(amount) {
    roBalance = Math.max(0, roBalance - amount);
    userStats.wagered += amount;
    addTransaction('Game Play', -amount, 'game');
    updateBalanceDisplay();
    updateProfViews();
    saveToStorage();
}
function awardWin(amount) {
    roBalance += amount;
    addTransaction('Game Win', amount, 'game');
    updateBalanceDisplay();
    updateProfViews();
    saveToStorage();
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

    // Intercept "Place bet" to deduct balance
    const origClick = playBtn.onclick;
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
            deductBet(bet);
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
            const txt = txtRaw.toLowerCase();
            if(txtRaw === bjLiveFeedLast) return;
            const bet = parseFloat(document.getElementById('bj-bet-input').value) || 0;
            if(txt.includes('win') || txt.includes('blackjack')) {
                bjLiveFeedLast = txtRaw;
                const gross = txt.includes('blackjack') ? bet * 1.5 : bet * 2;
                const mult = bet > 0 ? gross / bet : 0;
                awardWin(gross);
                postLiveFeedRound('blackjack', bet, mult, gross);
                soundWin();
            } else if(txt.includes('push')) {
                bjLiveFeedLast = txtRaw;
                awardWin(bet); // return bet
                postLiveFeedRound('blackjack', bet, 1, bet);
                soundClick();
            } else if(txt.includes('lose') || txt.includes('bust')) {
                bjLiveFeedLast = txtRaw;
                postLiveFeedRound('blackjack', bet, 0, -bet);
                soundLose();
            }
        });
        obs.observe(bjMsg, { attributes: true, attributeFilter: ['style'] });
    }
}

function patchMinesBalance() {
    const playBtn = document.getElementById('mines-play-btn');
    const minesMsg = document.getElementById('mines-message');
    if(!playBtn) return;

    // Intercept "Start new game"
    playBtn.addEventListener('click', function(e) {
        if(playBtn.textContent.trim() === 'Start new game') {
            const bet = parseFloat(document.getElementById('mines-bet-input').value) || 0;
            if(bet <= 0 || bet > roBalance) {
                e.stopImmediatePropagation();
                if(minesMsg) { minesMsg.textContent= bet <= 0 ? 'Enter a valid bet amount!' : 'Not enough ZR$!'; minesMsg.style.color='var(--red)'; minesMsg.style.display='block'; }
                return;
            }
            deductBet(bet);
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
                awardWin(val);
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
            deductBet(bet);
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
                awardWin(val);
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
            // Show floating warning
            const warn = document.createElement('div');
            warn.textContent = bet <= 0 ? 'Enter a valid bet amount!' : 'Not enough ZR$!';
            warn.style.cssText='position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#2a1515;border:1px solid var(--red);color:var(--red);padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;';
            document.body.appendChild(warn);
            setTimeout(()=>warn.remove(), 2000);
            return;
        }
        deductBet(bet);
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
                awardWin(gross);
                postLiveFeedRound('dice', bet, multi, gross);
                soundWin();
            } else {
                postLiveFeedRound('dice', bet, 0, -bet);
                soundLose();
            }
        });
        obs.observe(resultMarker, { attributes: true, attributeFilter: ['class'] });
    }
}

// ===== DEPOSIT MODAL (game pass tiers: Robux paid = same ZR$ credit; IDs must match server GAME_PASS_CREDIT_BY_ID) =====
const GAME_PASS_DEPOSIT_TIERS = [
    { id: 1783449405, robux: 8 },
    { id: 1784194501, robux: 7 },
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
    { id: 1784464672, robux: 80 },
    { id: 1784464674, robux: 90 },
    { id: 1783918985, robux: 100 }
];

function initDepGamePassSelect() {
    const sel = document.getElementById('dep-gamepass-select');
    if(!sel) return;
    const sorted = [...GAME_PASS_DEPOSIT_TIERS].sort((a, b) => a.robux - b.robux);
    sel.innerHTML = sorted
        .map(
            (t) =>
                `<option value="${t.id}">${t.robux} Robux - ${t.robux} ZR$</option>`
        )
        .join('');
    sel.removeEventListener('change', syncDepGamePassLink);
    sel.addEventListener('change', syncDepGamePassLink);
    syncDepGamePassLink();
}

function syncDepGamePassLink() {
    const sel = document.getElementById('dep-gamepass-select');
    const link = document.getElementById('dep-gamepass-store-link');
    const desc = document.getElementById('dep-gamepass-tier-desc');
    if(!sel || !link) return;
    const id = parseInt(sel.value, 10);
    const tier = GAME_PASS_DEPOSIT_TIERS.find((t) => t.id === id);
    if(!tier) return;
    link.href = `https://www.roblox.com/game-pass/${tier.id}/${tier.robux}`;
    if(desc) {
        desc.textContent = `You pay ${tier.robux} Robux on Roblox; we credit ${tier.robux} ZR$ after verification.`;
    }
}

function getSelectedDepGamePassId() {
    const sel = document.getElementById('dep-gamepass-select');
    if(!sel) return 0;
    const n = parseInt(sel.value, 10);
    return n > 0 ? n : 0;
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
}

function updateDepGamePassUi() {
    const btn = document.getElementById('dep-gamepass-verify-btn');
    if(btn && !btn.disabled) btn.textContent = 'Verify purchase';
    syncDepGamePassLink();
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
                save: buildSaveObject(),
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
    
    const inp = document.getElementById('wd-amount-input');
    if(inp) {
        inp.value = 15;
        inp.dispatchEvent(new Event('input'));
    }
}

function goWdPage(num) {
    document.querySelectorAll('#withdraw-backdrop .wd-page').forEach(p => p.style.display = 'none');
    const page = document.getElementById('wd-page-' + num);
    if(page) page.style.display = 'block';
    
    if(num === 2) {
        const avail = document.getElementById('wd-avail-bal');
        if(avail) avail.textContent = roBalance.toFixed(2);
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
        if(bEl) bEl.value = beforeTax;
        if(aEl) aEl.textContent = afterTax;

        // Update the required gamepass price label
        const priceLabel = document.getElementById('wd-req-gamepass-price');
        if(priceLabel) priceLabel.textContent = beforeTax + ' R$';
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

    const wdWrap = inp && inp.closest('.wd-input-wrap');
    if(afterTax < 7) {
        if(wdWrap) wdWrap.style.borderColor = 'var(--red)';
        setTimeout(() => { if(wdWrap) wdWrap.style.borderColor = ''; }, 2000);
        showErr('Minimum withdrawal is 7 R$ after tax.');
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
        roBalance -= coins;
        userStats.withdrawn += coins;
        addTransaction('Withdrawal (' + afterTax + ' R$ received)', -coins, 'withdraw');
        updateBalanceDisplay();
        updateProfViews();
        saveToStorage();
        syncBalanceToServer();

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

// ===== PROFILE SYSTEM =====
let userStats = {
    rainWinnings: 0,
    deposited: 0,
    withdrawn: 0,
    wagered: 0,
    xp: 0
};
let transactions = [];
let currentUsername = 'artirzu';
/** Set after Roblox username API confirms account; used with avatar URL. */
let robloxUserId = null;
/** CDN headshot URL from server (thumbnails.roblox.com) — survives reloads; www.roblox.com image URLs often break in <img>. */
let robloxAvatarUrl = null;

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
        });
    });
});

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

    roBalance -= amt;
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
const SAVE_KEY = 'zephrs_sim_v1';

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
    else if(data.robloxUserId === null) robloxUserId = null;
    if(typeof data.robloxAvatarUrl === 'string' && /^https?:\/\//.test(data.robloxAvatarUrl)) {
        robloxAvatarUrl = data.robloxAvatarUrl;
    } else if(data.robloxAvatarUrl === null || data.robloxAvatarUrl === '') robloxAvatarUrl = null;
    if(typeof data.balance === 'number' && data.balance >= 0) roBalance = data.balance;
    if(typeof data.flipBalance === 'number' && data.flipBalance > 0) roBalance += data.flipBalance;
    if(typeof data.referralEarned === 'number' && data.referralEarned >= 0) referralEarned = data.referralEarned;
    if(typeof data.referredCount === 'number' && data.referredCount >= 0) referredCount = data.referredCount;
    if(data.stats && typeof data.stats === 'object') {
        Object.keys(userStats).forEach(k => {
            if(typeof data.stats[k] === 'number') userStats[k] = data.stats[k];
        });
    }
    if(Array.isArray(data.transactions)) transactions = data.transactions;
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
        else robloxUserId = null;
        if(typeof data.robloxAvatarUrl === 'string' && /^https?:\/\//.test(data.robloxAvatarUrl)) robloxAvatarUrl = data.robloxAvatarUrl;
        else robloxAvatarUrl = null;
        if(typeof data.balance === 'number' && data.balance >= 0) roBalance = data.balance;
        if(typeof data.flipBalance === 'number' && data.flipBalance > 0) roBalance += data.flipBalance;
        if(typeof data.referralEarned === 'number' && data.referralEarned >= 0) referralEarned = data.referralEarned;
        if(typeof data.referredCount === 'number' && data.referredCount >= 0) referredCount = data.referredCount;
        if(data.stats && typeof data.stats === 'object') {
            Object.keys(userStats).forEach(k => {
                if(typeof data.stats[k] === 'number') userStats[k] = data.stats[k];
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
    roBalance = 0;
    referralEarned = 0;
    referredCount = 0;
    userStats = { rainWinnings: 0, deposited: 0, withdrawn: 0, wagered: 0, xp: 0 };
    transactions = [];
    applyUsername('Guest');
    updateBalanceDisplay();
    updateProfViews();
    window.location.hash = 'home';
    document.querySelector('.top-nav-links a[data-view="home"]')?.click();
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
                roBalance = 0;
                referralEarned = 0;
                referredCount = 0;
                userStats = { rainWinnings: 0, deposited: 0, withdrawn: 0, wagered: 0, xp: 0 };
                transactions = [];
            }
        }

        applyUsername(currentUsername);
        saveToStorage();
        updateBalanceDisplay();
        updateProfViews();
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
        return;
    }

    if(welcomeBackdrop) welcomeBackdrop.classList.add('show');
}

document.addEventListener('DOMContentLoaded', () => {
    initDepGamePassSelect();
});
