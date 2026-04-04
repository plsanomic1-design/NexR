/**
 * voice.js - WebRTC Mesh Voice Chat Integration
 * Utilizes PeerJS for P2P audio streaming and MQTT for decentralized discovery.
 */

(function () {
    const VOICE_TOPIC = 'games/zephrs_sim_v1/voice_presence';
    const MQTT_URL = 'wss://broker.hivemq.com:8884/mqtt';

    let localStream = null;
    let peer = null;
    let mqttClient = null;
    let localPeerId = null;
    
    let isMicMuted = false;
    let isDeafened = false;

    // activeCalls: Map<peerId, { call, audioEl, cardEl, isLocalMuted, stream }>
    const activeCalls = new Map();

    const btnConnect = document.getElementById('voice-connect-btn');
    const btnDisconnect = document.getElementById('voice-disconnect-btn');
    const btnMute = document.getElementById('voice-mute-btn');
    const btnDeaf = document.getElementById('voice-deaf-btn');
    const grid = document.getElementById('voice-participants-grid');
    const statusBanner = document.getElementById('voice-status-banner');

    if (!btnConnect) return; // Prevent errors if DOM missing

    function getUser() {
        try {
            if (typeof getZephrsChatUser === 'function') return getZephrsChatUser();
            let u = document.getElementById('prof-username-disp');
            if (u && u.innerText) return { name: u.innerText.trim(), level: 1 };
        } catch (e) {}
        return { name: 'Guest', level: 1 };
    }

    function generateParticipantCard(peerId, name) {
        if (activeCalls.has(peerId) && activeCalls.get(peerId).cardEl) return activeCalls.get(peerId).cardEl;

        const card = document.createElement('div');
        card.className = 'voice-participant speaking';
        card.id = 'voice-card-' + peerId;

        card.innerHTML = `
            <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}&backgroundColor=2c2f4a" class="voice-avatar" alt="">
            <div class="voice-p-name">${name}</div>
            <div class="voice-p-status">Connected</div>
            <div class="voice-p-controls">
                <button class="voice-local-mute" title="Local Mute" data-peer="${peerId}">
                    <i class="fa-solid fa-volume-high"></i>
                </button>
                <input type="range" class="voice-vol-slider" min="0" max="1" step="0.05" value="1" data-peer="${peerId}">
            </div>
        `;

        // Event Listeners for controls
        const muteBtn = card.querySelector('.voice-local-mute');
        const volSlider = card.querySelector('.voice-vol-slider');

        muteBtn.addEventListener('click', () => {
            const callData = activeCalls.get(peerId);
            if (!callData) return;

            callData.isLocalMuted = !callData.isLocalMuted;
            if (callData.audioEl) {
                callData.audioEl.muted = callData.isLocalMuted || isDeafened;
            }

            if (callData.isLocalMuted) {
                muteBtn.classList.add('active');
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
                card.classList.add('muted');
            } else {
                muteBtn.classList.remove('active');
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
                card.classList.remove('muted');
            }
        });

        volSlider.addEventListener('input', (e) => {
            const callData = activeCalls.get(peerId);
            if (callData && callData.audioEl) {
                callData.audioEl.volume = e.target.value;
            }
        });

        grid.appendChild(card);
        return card;
    }

    function removeParticipantCard(peerId) {
        const card = document.getElementById('voice-card-' + peerId);
        if (card) card.remove();
        
        const callData = activeCalls.get(peerId);
        if (callData) {
            if (callData.call) callData.call.close();
            if (callData.audioEl) callData.audioEl.remove();
            activeCalls.delete(peerId);
        }
    }

    function createAudioElement(peerId, stream) {
        let audio = document.createElement('audio');
        audio.autoplay = true;
        // Connect stream
        // Wait for connection to load slightly
        audio.srcObject = stream;
        audio.muted = isDeafened; // Initial deafen state
        document.body.appendChild(audio);
        return audio;
    }

    function addCall(peerId, call, username, stream) {
        if (activeCalls.has(peerId)) return; // Prevent duplicates
        
        const cardEl = generateParticipantCard(peerId, username);
        const audioEl = createAudioElement(peerId, stream);

        activeCalls.set(peerId, {
            call: call,
            audioEl: audioEl,
            cardEl: cardEl,
            isLocalMuted: false,
            stream: stream
        });

        call.on('close', () => {
            removeParticipantCard(peerId);
        });
        call.on('error', () => {
            removeParticipantCard(peerId);
        });
    }

    function broadcastPresence() {
        if (!mqttClient || !mqttClient.connected || !localPeerId) return;
        const payload = JSON.stringify({
            action: 'join',
            peerId: localPeerId,
            username: getUser().name,
            ts: Date.now()
        });
        mqttClient.publish(VOICE_TOPIC, payload, { qos: 0 });
    }

    function handleMqttMessage(topic, payload) {
        if (topic !== VOICE_TOPIC) return;
        let data;
        try {
            data = JSON.parse(payload.toString());
        } catch (e) { return; }

        if (data.action === 'join' && data.peerId !== localPeerId && peer) {
            // New user joined, we should call them if we haven't already
            if (!activeCalls.has(data.peerId)) {
                // Wait briefly to ensure they are ready to accept
                setTimeout(() => {
                    const call = peer.call(data.peerId, localStream, {
                        metadata: { username: getUser().name }
                    });
                    
                    if (!call) return; // Peer closed or error

                    call.on('stream', (remoteStream) => {
                        addCall(data.peerId, call, data.username, remoteStream);
                    });

                    // Temporarily store just the call in case it closes fast
                    activeCalls.set(data.peerId, { call: call }); 
                }, 500);
            }
        }
    }

    function disconnectAll() {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        if (peer) {
            peer.destroy();
            peer = null;
        }
        if (mqttClient) {
            mqttClient.end(true);
            mqttClient = null;
        }
        
        activeCalls.forEach((val, key) => {
            removeParticipantCard(key);
        });
        activeCalls.clear();

        btnConnect.style.display = 'block';
        btnDisconnect.style.display = 'none';
        btnMute.style.display = 'none';
        btnDeaf.style.display = 'none';
        
        statusBanner.style.display = 'block';
        statusBanner.textContent = 'You are currently disconnected. Click "Connect to Voice" to join the lobby.';

        // Reset toggles
        isMicMuted = false;
        isDeafened = false;
        btnMute.classList.remove('active');
        btnDeaf.classList.remove('active');
    }

    async function connectToVoice() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch(err) {
            alert('Microphone access denied or error: ' + err.message);
            return;
        }

        btnConnect.style.display = 'none';
        btnDisconnect.style.display = 'inline-block';
        btnMute.style.display = 'inline-block';
        btnDeaf.style.display = 'inline-block';
        
        statusBanner.style.display = 'block';
        statusBanner.textContent = 'Connecting to signaling server...';

        // Initialize PeerJS
        peer = new Peer({ debug: 1 });

        peer.on('open', (id) => {
            localPeerId = id;
            statusBanner.style.display = 'none';

            // Add self to grid purely for visual feedback
            const selfCard = generateParticipantCard(localPeerId, getUser().name + " (You)");
            selfCard.classList.remove('speaking');
            selfCard.style.opacity = '0.8';
            selfCard.querySelector('.voice-p-controls').style.display = 'none'; // Cant adjust own volume
            const selfAudio = document.createElement('audio');
            selfAudio.muted = true;
            activeCalls.set(localPeerId, { call: null, cardEl: selfCard, audioEl: selfAudio });

            // Connect MQTT for discovery
            mqttClient = mqtt.connect(MQTT_URL, {
                clientId: 'vtx_' + id,
                clean: true
            });

            mqttClient.on('connect', () => {
                mqttClient.subscribe(VOICE_TOPIC);
                broadcastPresence();
                // Broadcast presence every 10 seconds to discover dropped connections
                setInterval(broadcastPresence, 10000); 
            });

            mqttClient.on('message', handleMqttMessage);
        });

        // Handle Incoming Calls
        peer.on('call', (call) => {
            call.answer(localStream); // Answer automatically with our mic
            const remoteName = (call.metadata && call.metadata.username) ? call.metadata.username : 'Unknown';

            call.on('stream', (remoteStream) => {
                addCall(call.peer, call, remoteName, remoteStream);
            });
        });

        peer.on('error', (err) => {
            console.error('PeerJS error:', err);
        });
    }


    /* --- Interactive Toggles --- */
    
    btnConnect.addEventListener('click', connectToVoice);
    btnDisconnect.addEventListener('click', disconnectAll);

    btnMute.addEventListener('click', () => {
        isMicMuted = !isMicMuted;
        if (localStream) {
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !isMicMuted;
            });
        }
        
        if (isMicMuted) {
            btnMute.classList.add('active');
            btnMute.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
        } else {
            btnMute.classList.remove('active');
            btnMute.innerHTML = '<i class="fa-solid fa-microphone"></i>';
        }
    });

    btnDeaf.addEventListener('click', () => {
        isDeafened = !isDeafened;
        
        // Update all active remote audios
        activeCalls.forEach((val) => {
            if (val.audioEl && val.call) { // Avoid self audio
                val.audioEl.muted = val.isLocalMuted || isDeafened;
            }
        });

        if (isDeafened) {
            btnDeaf.classList.add('active');
        } else {
            btnDeaf.classList.remove('active');
        }
    });

})();
