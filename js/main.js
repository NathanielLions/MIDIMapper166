// ==========================================
// 1. SOUNDFONT FETCH & AUDIO ENGINE STATE
// ==========================================
const SOUNDFONT_URL = "./Wurlitzer166.sf2"; 

let audioCtx;
let isPlaying = false;
let startTimeMs = 0;
let startMidiSeconds = 0;
let scheduledNotes = new Set();
let activeOscillators = [];

async function fetchSoundfont() {
    try {
        document.getElementById('audio-status').innerText = "⏳ Loading Wurlitzer166.sf2...";
        const response = await fetch(SOUNDFONT_URL);
        const arrayBuffer = await response.arrayBuffer();
        document.getElementById('audio-status').innerText = "";
    } catch (err) {
        document.getElementById('audio-status').innerText = "";
    }
}
window.onload = fetchSoundfont;

function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function togglePlay() {
    initAudio();
    if (isPlaying) {
        isPlaying = false;
        document.getElementById('play-btn').innerText = "▶ Play";
        killAllNotes();
    } else {
        if (!currentMidi) return alert("Please import a MIDI file first!");
        isPlaying = true;
        document.getElementById('play-btn').innerText = "⏸ Pause";
        
        let currentTick = parseInt(document.getElementById('tick-slider').value);
        startMidiSeconds = currentMidi.header.ticksToSeconds(currentTick);
        startTimeMs = performance.now();
        scheduledNotes.clear();
        scheduler();
    }
}

function stopPlayback() {
    isPlaying = false;
    document.getElementById('play-btn').innerText = "▶ Play";
    document.getElementById('tick-slider').value = 0;
    document.getElementById('current-tick').innerText = '0';
    syncSwitchesToTimeline(0);
    draw();
    killAllNotes();
}

function killAllNotes() {
    activeOscillators.forEach(osc => { try { osc.stop(); } catch(e){} });
    activeOscillators = [];
    scheduledNotes.clear();
}

function scheduler() {
    if (!isPlaying || !currentMidi) return;
    
    let now = performance.now();
    let elapsedSeconds = (now - startTimeMs) / 1000;
    let currentMidiSeconds = startMidiSeconds + elapsedSeconds;
    
    let newTick = Math.round(currentMidi.header.secondsToTicks(currentMidiSeconds));
    let sliderMax = parseInt(document.getElementById('tick-slider').max);
    
    if (newTick > sliderMax) { stopPlayback(); return; }
    
    document.getElementById('tick-slider').value = newTick;
    document.getElementById('current-tick').innerText = newTick;
    syncSwitchesToTimeline(newTick);
    draw();
    
    let lookaheadSeconds = 0.1; 
    let lookaheadMidiSeconds = currentMidiSeconds + lookaheadSeconds;
    
    currentMidi.tracks.forEach(track => {
        if (hiddenChannels.has(track.channel)) return;
        track.notes.forEach(note => {
            if (note.time >= currentMidiSeconds && note.time < lookaheadMidiSeconds) {
                let noteId = `${track.channel}-${note.midi}-${note.ticks}`;
                if (!scheduledNotes.has(noteId)) {
                    scheduledNotes.add(noteId);
                    scheduleNotePlay(note, track.channel, note.time - currentMidiSeconds); 
                }
            }
        });
    });
    
    requestAnimationFrame(scheduler);
}

function getActiveStopsForChannel(channel) {
    let activeStops = [];
    for (const [manual, stops] of Object.entries(organStructure)) {
        let match = manual.match(/Ch (\d+)/);
        if (match) {
            let rawChannel = parseInt(match[1]) - 1; 
            if (rawChannel === channel) {
                stops.forEach(s => {
                    // Ignore hidden stops
                    if (s.visible === false) return;
                    let cb = document.getElementById(`stop-${s.val}`);
                    if (cb && cb.checked) activeStops.push(s);
                });
            }
        }
    }
    return activeStops;
}

function scheduleNotePlay(note, channel, delaySeconds) {
    let playTime = audioCtx.currentTime + delaySeconds;
    let activeStops = getActiveStopsForChannel(channel);
    
    if (activeStops.length === 0) return; 

    let attack = 0.02;
    let release = 0.02;
    if (note.duration < 0.04) {
        attack = note.duration / 2;
        release = note.duration / 2;
    }
    
    activeStops.forEach(stop => {
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        if ([8, 10, 11].includes(stop.val)) osc.type = 'sine'; 
        else if ([19, 20, 73, 75, 70, 58].includes(stop.val)) osc.type = 'triangle';
        else if ([40, 82, 68, 48, 50].includes(stop.val)) osc.type = 'sawtooth';
        else if ([56, 57, 61, 71].includes(stop.val)) osc.type = 'square';
        else osc.type = 'square';
        
        osc.frequency.value = Math.pow(2, (note.midi - 69) / 12) * 440;
        
        let swellVal = document.getElementById('swell-switch').checked ? 1.0 : 0.4;
        let peakVolume = 0.08 * swellVal;
        
        gain.gain.setValueAtTime(0, playTime);
        gain.gain.linearRampToValueAtTime(peakVolume, playTime + attack); 
        gain.gain.setValueAtTime(peakVolume, Math.max(playTime + attack, playTime + note.duration - release)); 
        gain.gain.linearRampToValueAtTime(0, playTime + note.duration); 
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start(playTime);
        osc.stop(playTime + note.duration);
        activeOscillators.push(osc);
    });
    
    setTimeout(() => { activeOscillators = activeOscillators.filter(o => o !== null); }, (note.duration + delaySeconds) * 1000 + 100);
}

// ==========================================
// 2. CORE EDITOR LOGIC & STATE
// ==========================================
let currentMidi = null;
let fileName = "wurlitzer_output";
let ppq = 384; 
let minMidiNote = 127;
let maxMidiNote = 0;
let isUpdatingSwitches = false; 

let hiddenChannels = new Set();
window.pistonsAffectPercussion = false;

let swellCC = 4;
let percCC = 12;

const channelColors = [
    '#e74c3c', '#2ecc71', '#f1c40f', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#34495e',
    '#ff9ff3', '#8e44ad', '#48dbfb', '#1dd1a1', '#f368e0', '#ff9f43', '#0abde3', '#10ac84'
];

const groupColors = { "Countermelody": "#3498db", "Accompaniment": "#2ecc71", "Trumpetmelody": "#d4ac0d", "Bass": "#e74c3c", "Expression": "#8e44ad", "Presets": "#f39c12" };

let organStructure = {
    "Countermelody (Ch 2)": [ 
        { val: 8, name: "Glockenspiel", visible: true }, { val: 10, name: "Unaphone", visible: true }, { val: 19, name: "Prestant", visible: true }, 
        { val: 20, name: "Undamaris", visible: true }, { val: 71, name: "Clarinet", visible: true }, { val: 40, name: "Forte Violin", visible: true }, 
        { val: 73, name: "Flute", visible: true }, { val: 75, name: "Flageolet", visible: true }, { val: 82, name: "Soft Violin", visible: true } 
    ],
    "Trumpetmelody (Ch 1)": [ 
        { val: 68, name: "Viola Bassoon", visible: true }, { val: 56, name: "Wooden Trumpet", visible: true }, { val: 61, name: "Brass Trumpet", visible: true } 
    ],
    "Accompaniment (Ch 3)": [ 
        { val: 70, name: "Open Flute", visible: true }, { val: 48, name: "Strings", visible: true }, { val: 11, name: "Stopped Flute", visible: true } 
    ],
    "Bass (Ch 4)": [ 
        { val: 57, name: "Wooden Trombone", visible: true }, { val: 50, name: "Brass Trombone", visible: true }, { val: 58, name: "Bass Flute", visible: true }
    ]
};

// 3-State Piston System
let pistons = [
    { name: "Pianissimo", activeStops: [19, 82, 73, 75, 11, 70, 68, 58], swell: 127 },
    { name: "Forte", activeStops: [8, 19, 40, 82, 73, 75, 11, 70, 48, 68, 56, 58, 57, 61], swell: 127 },
    { name: "Piston Default 1", activeStops: [19, 40, 10, 70, 48, 70, 11, 68, 57, 61, 58, 50], swell: 127 }, 
    { name: "Piston Default 2", activeStops: [8, 19, 75, 82, 58, 70, 11, 68, 58 ], swell: 64 },
    { name: "Piston Default 3", activeStops: [19, 82, 40, 58, 50, 57, 61, 70, 11, 48, 56, 68], swell: 127 }, 
    { name: "Piston Default 4", activeStops: [], swell: 64 },
    { name: "General Cancel", activeStops: [], swell: 64 } 
];

let allPossibleStops = Object.values(organStructure).flat().map(s => s.val).concat([percCC]);
pistons.forEach(p => {
    if (!p.offStops) {
        p.offStops = [];
        allPossibleStops.forEach(cc => { if (!p.activeStops.includes(cc)) p.offStops.push(cc); });
    }
    // Initialize 3-state Swell (1 = Open, 0 = Ignore, -1 = Closed)
    if (p.swellState === undefined) {
        p.swellState = p.swell >= 127 ? 1 : -1;
    }
});

let editingPistonIndex = 0;

function toggleDarkMode(isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    draw(); 
}

function toggleMidiVals(show) {
    if (show) document.body.classList.remove('hide-midi-vals');
    else document.body.classList.add('hide-midi-vals');
}

// ==========================================
// NEW VISIBILITY & UI ENGINE (SETTINGS)
// ==========================================
function buildSettingsUI() {
    const container = document.getElementById('settings-mapping-container');
    container.innerHTML = '';

    let globalHtml = `<div class="panel"><h3>Global Setup (Ranks & Channels)</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 10px;">`;
    
    for (const [manual, stops] of Object.entries(organStructure)) {
        let color = groupColors[manual.split(' ')[0]] || "#3498db";
        globalHtml += `<div style="border-left: 3px solid ${color}; padding-left: 8px; background: var(--manual-bg); border-radius: 4px; padding-right:8px; padding-bottom:5px;">
            <h4 style="margin: 5px 0; color: ${color}; font-size: 0.85em;">${manual.split(' ')[0]}</h4>`;
        
        stops.forEach((s, i) => {
            let isVis = s.visible !== false;
            let eyeOp = isVis ? "1" : "0.3";
            let textDecor = isVis ? "none" : "line-through";
            let rowOp = isVis ? "1" : "0.6";

            globalHtml += `<div style="display:flex; align-items:center; gap: 5px; margin-bottom: 3px; opacity: ${rowOp};">
                <button style="background:transparent; border:none; cursor:pointer; font-size:1em; opacity:${eyeOp}; padding:0;" onclick="toggleRankVisibility('${manual}', ${i})" title="Toggle Visibility">👁️</button>
                <input type="number" class="mapping-input" style="width: 40px; padding: 2px;" value="${s.val}" onchange="updateMapping('${manual}', ${i}, 'val', this.value)" title="MIDI CC">
                <input type="text" style="background:transparent; border:none; border-bottom:1px dashed var(--border-color); color:var(--text-color); font-size:0.8em; outline:none; text-decoration:${textDecor};" value="${s.name}" onchange="updateMapping('${manual}', ${i}, 'name', this.value)">
            </div>`;
        });
        globalHtml += `</div>`;
    }
    
    globalHtml += `<div style="border-left: 3px solid #8e44ad; padding-left: 8px; background: var(--manual-bg); border-radius: 4px; padding-right:8px; padding-bottom:5px;">
        <h4 style="margin: 5px 0; color: #8e44ad; font-size: 0.85em;">Expression</h4>
        <div style="display:flex; align-items:center; gap: 5px; margin-bottom: 3px;"><input type="number" class="mapping-input" style="width: 40px; padding: 2px;" value="${swellCC}" onchange="updateExpMapping('swell', this.value)"><span style="font-size:0.8em;">Swell</span></div>
        <div style="display:flex; align-items:center; gap: 5px;"><input type="number" class="mapping-input" style="width: 40px; padding: 2px;" value="${percCC}" onchange="updateExpMapping('perc', this.value)"><span style="font-size:0.8em;">Percussion</span></div>
    </div></div></div>`;
    
    container.innerHTML += globalHtml;

    let piston = pistons[editingPistonIndex];
    
    let pistonHtml = `<div class="panel"><h3>Piston Configuration</h3>
        <div style="display: flex; gap: 5px; margin-bottom: 15px; flex-wrap: wrap; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">`;
    
    pistons.forEach((p, i) => {
        let activeClass = i === editingPistonIndex ? "background: #f39c12; color: white; border-color: #f39c12;" : "";
        pistonHtml += `<button class="nudge-btn" style="${activeClass}" onclick="switchPistonTab(${i})">${p.name}</button>`;
    });
    
    pistonHtml += `</div>
        <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 15px; background: var(--stop-row-bg); padding: 10px; border-radius: 5px; border: 1px solid var(--border-color);">
            <input type="text" class="mapping-input" style="width: 250px; text-align: left; font-size: 1em;" value="${piston.name}" onchange="updatePistonName(${editingPistonIndex}, this.value)" title="Rename Piston">
        </div>
        
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">`;

    for (const [manual, stops] of Object.entries(organStructure)) {
        stops.forEach(s => {
            // SKIP HIDDEN STOPS FROM PISTON UI
            if (s.visible === false) return;
            let state = piston.activeStops.includes(s.val) ? 1 : (piston.offStops.includes(s.val) ? -1 : 0);
            pistonHtml += buildTriStateBox(s.name, s.val, state, 'stop');
        });
    }
    
    let percState = piston.activeStops.includes(percCC) ? 1 : (piston.offStops.includes(percCC) ? -1 : 0);
    pistonHtml += buildTriStateBox("Percussion", percCC, percState, 'stop');
    
    // Add Swell directly to the grid
    pistonHtml += buildTriStateBox("Swell Shutters", swellCC, piston.swellState, 'swell');

    pistonHtml += `</div></div>`;
    container.innerHTML += pistonHtml;
}

function buildTriStateBox(name, val, state, type = 'stop') {
    let offOp = state === -1 ? '1' : '0.3';
    let neutOp = state === 0 ? '1' : '0.3';
    let onOp = state === 1 ? '1' : '0.3';

    // The 'On' color is now universally Green (#2ecc71)
    return `<div style="background: var(--stop-row-bg); padding: 8px; border: 1px solid var(--border-color); border-radius: 5px; display: flex; flex-direction: column; gap: 6px; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size: 0.85em; font-weight: bold; text-align: center; color: var(--text-color);">${name}</div>
        <div style="display: flex; gap: 4px;">
            <button style="flex:1; border:none; border-radius:3px; color:white; font-weight:bold; cursor:pointer; padding:6px 0; background:#e74c3c; opacity:${offOp}; transition:0.2s;" onclick="setTriState(${val}, -1, '${type}')">✖</button>
            <button style="flex:1; border:none; border-radius:3px; color:white; font-weight:bold; cursor:pointer; padding:6px 0; background:#95a5a6; opacity:${neutOp}; transition:0.2s;" onclick="setTriState(${val}, 0, '${type}')">/</button>
            <button style="flex:1; border:none; border-radius:3px; color:white; font-weight:bold; cursor:pointer; padding:6px 0; background:#2ecc71; opacity:${onOp}; transition:0.2s;" onclick="setTriState(${val}, 1, '${type}')">✔</button>
        </div>
    </div>`;
}

// --- TOGGLE RANK VISIBILITY ---
function toggleRankVisibility(manualKey, index) {
    let stop = organStructure[manualKey][index];
    stop.visible = stop.visible === false ? true : false;
    buildSettingsUI();
    buildEditorUI();
}

function switchPistonTab(index) {
    editingPistonIndex = index;
    buildSettingsUI();
}

function updatePistonName(index, newName) {
    pistons[index].name = newName;
    buildSettingsUI();
    buildEditorUI();
}

function setTriState(val, targetState, type) {
    let p = pistons[editingPistonIndex];
    
    if (type === 'swell') {
        p.swellState = targetState;
    } else {
        p.activeStops = p.activeStops.filter(v => v !== val);
        p.offStops = p.offStops.filter(v => v !== val);
        
        if (targetState === 1) p.activeStops.push(val);
        else if (targetState === -1) p.offStops.push(val);
    }
    
    buildSettingsUI(); 
}

function updateMapping(manualKey, index, type, newVal) {
    if (type === 'val') organStructure[manualKey][index].val = parseInt(newVal);
    if (type === 'name') organStructure[manualKey][index].name = newVal;
    buildSettingsUI(); 
    buildEditorUI();
    if(currentMidi) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
}

function updateExpMapping(type, newVal) {
    if (type === 'swell') swellCC = parseInt(newVal);
    if (type === 'perc') percCC = parseInt(newVal);
    buildSettingsUI();
    buildEditorUI();
    if(currentMidi) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
}

function buildEditorUI() {
    document.getElementById('col-countermelody').innerHTML = '';
    document.getElementById('col-accomp-trumpet').innerHTML = '';
    document.getElementById('col-bass-exp').innerHTML = '';
    document.getElementById('col-pistons').innerHTML = '';

    let hasVisibleCountermelody = false;
    let hasVisibleAccompaniment = false;
    let hasVisibleBass = false;

    for (const [manual, stops] of Object.entries(organStructure)) {
        let shortMan = manual.split(' ')[0]; let color = groupColors[shortMan] || "#3498db";
        
        // Skip building the group if ALL stops inside it are hidden
        if (stops.every(s => s.visible === false)) continue;

        const groupDiv = document.createElement('div'); groupDiv.className = 'manual-group'; groupDiv.style.borderLeftColor = color;
        groupDiv.innerHTML = `<h4 style="color: ${color};">${shortMan} <span class="midi-val" style="color: var(--text-color); font-weight: normal; font-size: 0.8em;">${manual.replace(shortMan, '').trim()}</span></h4><div class="stop-grid"></div>`;
        const grid = groupDiv.querySelector('.stop-grid');
        
        stops.forEach(s => {
            // SKIP HIDDEN STOPS FROM EDITOR UI
            if (s.visible === false) return;
            grid.innerHTML += `<div class="stop-row"><span class="stop-name">${s.name} <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(${s.val})</span></span><label class="switch"><input type="checkbox" id="stop-${s.val}" onchange="handleStopToggle(${s.val}, '${s.name}', '${shortMan}', this.checked)"><span class="slider-switch"></span></label></div>`;
        });
        
        if (shortMan === "Countermelody") { document.getElementById('col-countermelody').appendChild(groupDiv); hasVisibleCountermelody = true; }
        else if (shortMan === "Accompaniment" || shortMan === "Trumpetmelody") { document.getElementById('col-accomp-trumpet').appendChild(groupDiv); hasVisibleAccompaniment = true; }
        else if (shortMan === "Bass") { document.getElementById('col-bass-exp').appendChild(groupDiv); hasVisibleBass = true; }
    }

    const expDiv = document.createElement('div'); expDiv.className = 'manual-group'; expDiv.style.borderLeftColor = "#8e44ad";
    expDiv.innerHTML = `<h4 style="color: #8e44ad;">Expression & Percussion</h4><div class="stop-grid"><div class="stop-row"><span class="stop-name" style="color: #8e44ad;">Swell Shutters <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(CC ${swellCC})</span></span><label class="switch"><input type="checkbox" id="swell-switch" onchange="handleSwellToggle(this.checked)"><span class="slider-switch swell-bg"></span></label></div><div class="stop-row"><span class="stop-name">Percussion <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(${percCC})</span></span><label class="switch"><input type="checkbox" id="stop-${percCC}" onchange="handleStopToggle(${percCC}, 'Percussion', 'Perc', this.checked)"><span class="slider-switch"></span></label></div></div>`;
    document.getElementById('col-bass-exp').appendChild(expDiv);

    let pistonsHtml = `<div class="manual-group" style="border-left-color: #f39c12; flex: 1;"><h4 style="color: #f39c12;">Saved Pistons</h4><div class="stop-grid" style="gap: 5px;">`;
    pistons.forEach((p, i) => {
        let extraStyle = i === pistons.length - 1 ? "margin-top: 15px; border-color: #e74c3c; color: #e74c3c;" : "";
        pistonsHtml += `<button class="nudge-btn" style="width: 100%; text-align: left; padding: 10px; font-size: 1em; ${extraStyle}" onclick="applyRegistrationState(${i})">${p.name}</button>`;
    });
    pistonsHtml += `</div></div>`;
    document.getElementById('col-pistons').innerHTML = pistonsHtml;
}

buildSettingsUI(); buildEditorUI();

function openTab(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    if(btnElement) btnElement.classList.add('active');
    if (tabId === 'page-editor' && currentMidi) setTimeout(() => draw(), 10);
}

document.getElementById('midi-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    fileName = file.name.replace(".mid", ""); const arrayBuffer = await file.arrayBuffer();
    currentMidi = new Midi(arrayBuffer); ppq = currentMidi.header.ppq || 384; 
    let maxTicks = 0; minMidiNote = 127; maxMidiNote = 0; let activeChannels = new Set(); hiddenChannels.clear();
    currentMidi.tracks.forEach(t => {
        if (t.notes.length > 0) activeChannels.add(t.channel);
        t.notes.forEach(n => { if(n.ticks + n.durationTicks > maxTicks) maxTicks = n.ticks + n.durationTicks; if(n.midi < minMidiNote) minMidiNote = n.midi; if(n.midi > maxMidiNote) maxMidiNote = n.midi; });
    });
    const filtersDiv = document.getElementById('channel-filters');
    filtersDiv.innerHTML = '<strong style="display:flex; align-items:center; margin-right:10px; font-size:0.9em;">Tracks:</strong>';
    Array.from(activeChannels).sort((a,b)=>a-b).forEach(ch => {
        const btn = document.createElement('button'); btn.className = 'filter-btn'; btn.style.backgroundColor = channelColors[ch % 16]; btn.innerText = `Ch ${ch + 1}`; 
        btn.onclick = () => { if (hiddenChannels.has(ch)) { hiddenChannels.delete(ch); btn.classList.remove('inactive'); } else { hiddenChannels.add(ch); btn.classList.add('inactive'); } draw(); };
        filtersDiv.appendChild(btn);
    });
    const slider = document.getElementById('tick-slider'); slider.max = maxTicks + ppq; slider.value = 0; slider.disabled = false;
    document.getElementById('zoom-slider').disabled = false; document.getElementById('current-tick').innerText = '0';
    document.getElementById('export-btn').style.display = 'block'; renderLog(); syncSwitchesToTimeline(0); openTab('page-editor', document.getElementById('tab-editor'));
});

window.addEventListener('resize', () => { if (currentMidi) draw(); });

document.getElementById('tick-slider').addEventListener('input', (e) => {
    const newTick = parseInt(e.target.value); document.getElementById('current-tick').innerText = newTick;
    syncSwitchesToTimeline(newTick); draw();
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(newTick); startTimeMs = performance.now(); }
});

document.getElementById('zoom-slider').addEventListener('input', (e) => { document.getElementById('zoom-level').innerText = e.target.value + 'x'; draw(); });

function nudge(amount) {
    const slider = document.getElementById('tick-slider'); if (slider.disabled) return;
    let newVal = Math.max(0, Math.min(parseInt(slider.max), parseInt(slider.value) + amount));
    slider.value = newVal; document.getElementById('current-tick').innerText = newVal;
    syncSwitchesToTimeline(newVal); draw();
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(newVal); startTimeMs = performance.now(); }
}

function handleSwellToggle(isChecked) { if (isUpdatingSwitches) return; if (isChecked) addEvent(swellCC, 127, 'Swell OPEN', 'Exp'); else addEvent(swellCC, 64, 'Swell CLOSED', 'Exp'); }
function handleStopToggle(val, name, manual, isChecked) { if (isUpdatingSwitches) return; if (isChecked) addEvent(81, val, `${name} ON`, manual); else addEvent(80, val, `${name} OFF`, manual); }

function renderLog() {
    const tbody = document.getElementById('log-body'); tbody.innerHTML = '';
    if (!currentMidi) return; let track = currentMidi.tracks.find(t => t.channel === 15); if (!track) return;
    let events = []; [swellCC, 80, 81].forEach(cc => { if (track.controlChanges[cc]) track.controlChanges[cc].forEach(e => { events.push({ cc: cc, val: Math.round(e.value * 127), ticks: e.ticks }); }); });
    events.sort((a, b) => b.ticks - a.ticks);
    events.forEach(e => {
        let label = ""; let manual = "Sys"; let labelColor = "var(--text-color)";
        if (e.cc === swellCC) { label = e.val >= 127 ? "Swell OPEN" : "Swell CLOSED"; manual = "Exp"; labelColor = "#9b59b6"; }
        else {
            let foundName = "Unknown";
            for (const [man, stops] of Object.entries(organStructure)) { let stop = stops.find(s => s.val === e.val); if (stop) { foundName = stop.name; manual = man.split(' ')[0]; break; } }
            if (e.val === percCC) { foundName = "Percussion"; manual = "Perc"; }
            if (e.cc === 81) { label = foundName + " ON"; labelColor = "#27ae60"; } else { label = foundName + " OFF"; labelColor = "#e74c3c"; }
        }
        tbody.innerHTML += `<tr><td><strong>${e.ticks}</strong></td><td>${manual}</td><td style="color:${labelColor}"><strong>${label}</strong></td><td><button class="del-btn" onclick="removeEvent(${e.cc}, ${e.val}, ${e.ticks})">X</button></td></tr>`;
    });
}

function applyRegistrationState(pistonIndex) {
    if (!currentMidi) return alert("Please load a MIDI file first!");
    let p = pistons[pistonIndex];
    let baseTick = parseInt(document.getElementById('tick-slider').value);
    let track = currentMidi.tracks.find(t => t.channel === 15) || currentMidi.addTrack();
    track.channel = 15;
    
    [swellCC, 80, 81].forEach(cc => { if (track.controlChanges[cc]) track.controlChanges[cc] = track.controlChanges[cc].filter(e => { if (!window.pistonsAffectPercussion && (cc === 80 || cc === 81)) if (Math.round(e.value * 127) === percCC) return true; return Math.abs(e.ticks - baseTick) > 40; }); });
    let currentOffset = 0; 
    
    // APPLY 3-STATE SWELL
    if (p.swellState !== 0) {
        let swellVal = p.swellState === 1 ? 127 : 64;
        if (!track.controlChanges[swellCC]) track.controlChanges[swellCC] = [];
        track.controlChanges[swellCC].push({ ticks: baseTick + currentOffset, number: swellCC, value: swellVal / 127, time: currentMidi.header.ticksToSeconds(baseTick + currentOffset) });
        currentOffset++;
    }
    
    // ONLY APPLY PISTONS FOR VISIBLE STOPS
    let activeOrganStops = Object.values(organStructure).flat().filter(s => s.visible !== false).map(s => s.val).concat([percCC]);
    
    activeOrganStops.forEach(val => {
        if (!window.pistonsAffectPercussion && val === percCC) return;
        let targetCC = null;
        if (p.activeStops.includes(val)) targetCC = 81;
        else if (p.offStops.includes(val)) targetCC = 80;
        
        if (targetCC !== null) {
            if (!track.controlChanges[targetCC]) track.controlChanges[targetCC] = [];
            track.controlChanges[targetCC].push({ ticks: baseTick + currentOffset, number: targetCC, value: val / 127, time: currentMidi.header.ticksToSeconds(baseTick + currentOffset) });
            currentOffset++;
        }
    });
    
    [swellCC, 80, 81].forEach(cc => { if(track.controlChanges[cc]) track.controlChanges[cc].sort((a,b) => a.ticks - b.ticks); });
    let syncTick = Math.min(parseInt(document.getElementById('tick-slider').max), baseTick + currentOffset);
    document.getElementById('tick-slider').value = syncTick; document.getElementById('current-tick').innerText = syncTick;
    renderLog(); syncSwitchesToTimeline(syncTick); draw(); 
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(syncTick); startTimeMs = performance.now(); }
}

function addEvent(cc, val, label, manual) {
    if (!currentMidi) return;
    let baseTick = parseInt(document.getElementById('tick-slider').value);
    let track = currentMidi.tracks.find(t => t.channel === 15) || currentMidi.addTrack();
    track.channel = 15;
    [swellCC, 80, 81].forEach(checkCc => { if (track.controlChanges[checkCc]) track.controlChanges[checkCc] = track.controlChanges[checkCc].filter(e => !( ((cc === swellCC && checkCc === swellCC) || (Math.round(e.value * 127) === val)) && Math.abs(e.ticks - baseTick) <= 10)); });
    if (!track.controlChanges[cc]) track.controlChanges[cc] = [];
    let safeTick = baseTick; while (track.controlChanges[cc].some(e => e.ticks === safeTick)) { safeTick++; }
    track.controlChanges[cc].push({ ticks: safeTick, number: cc, value: val / 127, time: currentMidi.header.ticksToSeconds(safeTick) });
    track.controlChanges[cc].sort((a, b) => a.ticks - b.ticks); renderLog(); draw(); 
}

function removeEvent(cc, val, tick) {
    let track = currentMidi.tracks.find(t => t.channel === 15);
    if (track && track.controlChanges[cc]) track.controlChanges[cc] = track.controlChanges[cc].filter(e => !(e.ticks === tick && Math.round(e.value * 127) === val));
    renderLog(); syncSwitchesToTimeline(parseInt(document.getElementById('tick-slider').value)); draw();
}

function syncSwitchesToTimeline(currentTick) {
    if (!currentMidi) return;
    isUpdatingSwitches = true; 
    let track = currentMidi.tracks.find(t => t.channel === 15);
    let stopStates = {}; let swellState = false; 
    if (track) {
        let events = []; [swellCC, 80, 81].forEach(cc => { if (track.controlChanges[cc]) track.controlChanges[cc].forEach(e => { if (e.ticks <= currentTick) events.push({ cc: cc, val: Math.round(e.value * 127), ticks: e.ticks }); }); });
        events.sort((a, b) => a.ticks - b.ticks).forEach(e => { if (e.cc === 81) stopStates[e.val] = true; if (e.cc === 80) stopStates[e.val] = false; if (e.cc === swellCC) swellState = (e.val >= 127); });
    }
    Object.values(organStructure).flat().forEach(s => { 
        if (s.visible === false) return;
        let cb = document.getElementById(`stop-${s.val}`); 
        if (cb) cb.checked = !!stopStates[s.val]; 
    });
    let pc = document.getElementById(`stop-${percCC}`); if (pc) pc.checked = !!stopStates[percCC];
    let sw = document.getElementById('swell-switch'); if (sw) sw.checked = swellState;
    isUpdatingSwitches = false; 
}

function draw() {
    if (!currentMidi) return;
    const canvas = document.getElementById('piano-roll'); if (canvas.offsetParent === null) return; 
    const ctx = canvas.getContext('2d'); const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; ctx.scale(dpr, dpr);
    ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#111' : '#1a1a1a';
    ctx.fillRect(0, 0, rect.width, rect.height);
    const sliderMax = parseInt(document.getElementById('tick-slider').max); const currentTick = parseInt(document.getElementById('tick-slider').value);
    const zoom = parseFloat(document.getElementById('zoom-slider').value); const windowTicks = sliderMax / zoom;
    let st = Math.max(0, Math.min(sliderMax - windowTicks, currentTick - (windowTicks / 2)));
    const scaleX = rect.width / windowTicks; const noteHeight = rect.height / (maxMidiNote - minMidiNote + 4);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    for(let i = Math.ceil(st / ppq) * ppq; i <= st + windowTicks; i += ppq) { ctx.beginPath(); ctx.moveTo((i - st) * scaleX, 0); ctx.lineTo((i - st) * scaleX, rect.height); ctx.stroke(); }
    currentMidi.tracks.forEach(t => {
        if (hiddenChannels.has(t.channel)) return; ctx.fillStyle = channelColors[t.channel % 16];
        t.notes.forEach(n => { if (n.ticks + n.durationTicks > st && n.ticks < st + windowTicks) ctx.fillRect((n.ticks - st) * scaleX, rect.height - ((n.midi - minMidiNote + 2) * noteHeight), Math.max(n.durationTicks * scaleX, 2), Math.max(noteHeight - 1, 3)); });
    });
    let trk = currentMidi.tracks.find(t => t.channel === 15);
    if (trk) {
        [swellCC, 80, 81].forEach(cc => { if (trk.controlChanges[cc]) trk.controlChanges[cc].forEach(e => { if (e.ticks >= st && e.ticks <= st + windowTicks) { ctx.fillStyle = cc === swellCC ? '#9b59b6' : (cc === 81 ? '#2ecc71' : '#e74c3c'); ctx.fillRect(((e.ticks - st) * scaleX) - 2, cc === swellCC ? 16 : 0, 4, 12); } }); });
    }
    ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo((currentTick - st) * scaleX, 0); ctx.lineTo((currentTick - st) * scaleX, rect.height); ctx.stroke();
}

function exportMidi() { if (!currentMidi) return; const blob = new Blob([currentMidi.toArray()], { type: "audio/midi" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName + "_W166.mid"; a.click(); }

// ==========================================
// 3. WINDOW BINDINGS FOR HTML INTERACTION
// ==========================================
window.openTab = openTab; window.togglePlay = togglePlay; window.stopPlayback = stopPlayback; window.nudge = nudge; window.toggleDarkMode = toggleDarkMode; window.toggleMidiVals = toggleMidiVals; window.updateMapping = updateMapping; window.updateExpMapping = updateExpMapping; window.handleSwellToggle = handleSwellToggle; window.handleStopToggle = handleStopToggle; window.removeEvent = removeEvent; window.applyRegistrationState = applyRegistrationState; window.exportMidi = exportMidi; window.pistons = pistons;
window.setTriState = setTriState; window.switchPistonTab = switchPistonTab; window.updatePistonName = updatePistonName; window.toggleRankVisibility = toggleRankVisibility;
