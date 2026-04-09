
(function() {
    let ctx = null;
    let muted = false;

    function getCtx() {
        if (!ctx) {
            try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
        }
        if (ctx && ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function tone(freq, vol, dur, type, attack, decay) {
        const c = getCtx(); if (!c || muted) return;
        const o = c.createOscillator();
        const g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = type || 'sine';
        o.frequency.setValueAtTime(freq, c.currentTime);
        g.gain.setValueAtTime(0, c.currentTime);
        g.gain.linearRampToValueAtTime(vol, c.currentTime + (attack || 0.01));
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + (dur || 0.2));
        o.start(c.currentTime);
        o.stop(c.currentTime + (dur || 0.2) + (decay || 0.05));
    }

    function noise(vol, dur) {
        const c = getCtx(); if (!c || muted) return;
        const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
        const src = c.createBufferSource();
        const g = c.createGain();
        src.buffer = buf;
        src.connect(g); g.connect(c.destination);
        g.gain.setValueAtTime(vol, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        src.start(); src.stop(c.currentTime + dur);
    }

    window.sfx = {
        muted: false,

        click: function() {
            if (this.muted) return;
            tone(880, 0.08, 0.06, 'sine', 0.003, 0.02);
        },

        softClick: function() {
            if (this.muted) return;
            tone(660, 0.05, 0.04, 'sine', 0.002, 0.01);
        },

        swoosh: function() {
            if (this.muted) return;
            const c = getCtx(); if (!c) return;
            const o = c.createOscillator();
            const g = c.createGain();
            o.connect(g); g.connect(c.destination);
            o.type = 'sine';
            o.frequency.setValueAtTime(200, c.currentTime);
            o.frequency.exponentialRampToValueAtTime(600, c.currentTime + 0.12);
            g.gain.setValueAtTime(0.12, c.currentTime);
            g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.18);
            o.start(); o.stop(c.currentTime + 0.2);
        },

        swooshClose: function() {
            if (this.muted) return;
            const c = getCtx(); if (!c) return;
            const o = c.createOscillator();
            const g = c.createGain();
            o.connect(g); g.connect(c.destination);
            o.type = 'sine';
            o.frequency.setValueAtTime(600, c.currentTime);
            o.frequency.exponentialRampToValueAtTime(180, c.currentTime + 0.12);
            g.gain.setValueAtTime(0.1, c.currentTime);
            g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.16);
            o.start(); o.stop(c.currentTime + 0.18);
        },

        win: function() {
            if (this.muted) return;
            const c = getCtx(); if (!c) return;
            const freqs = [523, 659, 784, 1047];
            freqs.forEach(function(f, i) {
                setTimeout(function() { tone(f, 0.18, 0.3, 'sine', 0.01, 0.1); }, i * 60);
            });
        },

        bigWin: function() {
            if (this.muted) return;
            const c = getCtx(); if (!c) return;
            const freqs = [392, 523, 659, 784, 1047, 1319];
            freqs.forEach(function(f, i) {
                setTimeout(function() {
                    tone(f, 0.2, 0.4, 'sine', 0.01, 0.15);
                    tone(f * 2, 0.08, 0.3, 'triangle', 0.01, 0.1);
                }, i * 55);
            });
        },

        lose: function() {
            if (this.muted) return;
            const c = getCtx(); if (!c) return;
            tone(220, 0.15, 0.4, 'sawtooth', 0.01, 0.2);
            setTimeout(function() { tone(180, 0.1, 0.5, 'sawtooth', 0.01, 0.3); }, 120);
        },

        coin: function() {
            if (this.muted) return;
            tone(1200, 0.1, 0.08, 'sine', 0.002, 0.05);
            setTimeout(function() { tone(1600, 0.07, 0.06, 'sine', 0.001, 0.04); }, 70);
        },

        tick: function() {
            if (this.muted) return;
            noise(0.06, 0.04);
        },

        notification: function() {
            if (this.muted) return;
            tone(800, 0.1, 0.1, 'sine', 0.005, 0.05);
            setTimeout(function() { tone(1000, 0.08, 0.12, 'sine', 0.005, 0.06); }, 100);
        },

        error: function() {
            if (this.muted) return;
            tone(300, 0.12, 0.15, 'square', 0.005, 0.1);
            setTimeout(function() { tone(250, 0.1, 0.2, 'square', 0.005, 0.1); }, 100);
        },

        toggleMute: function() {
            this.muted = !this.muted;
            return this.muted;
        }
    };

    document.addEventListener('click', function(e) {
        const target = e.target.closest('button, .nav-item, .game-card, .dep-method, .dep-tier-btn, .feed-tab, .bet-tab, .cb-tab, .cb-format-pill, .cb-round-btn, .cb-mode-btn, .diff-btn, .row-btn, .prof-tab, .mines-tile, .tower-tile, [data-sfx]');
        if (!target) return;
        if (target.classList.contains('mines-tile') || target.classList.contains('tower-tile')) return;
        if (target.dataset.sfx === 'none') return;
        sfx.click();
    }, true);
})();
