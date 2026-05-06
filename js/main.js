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
        if(document.getElementById('audio-status')) document.getElementById('audio-status').innerText = "⏳ Loading Wurlitzer166.sf2...";
        const response = await fetch(SOUNDFONT_URL);
        const arrayBuffer = await response.arrayBuffer();
        if(document.getElementById('audio-status')) document.getElementById('audio-status').innerText = "🔊 Audio Ready";
    } catch (err) {
        if(document.getElementById('audio-status')) document.getElementById('audio-status').innerText = "⚠️ Audio Offline";
    }
}

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
    updateDisplays(0);
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
    updateDisplays(newTick);
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
        else if ([40, 82, 68, 48, 50, 42].includes(stop.val)) osc.type = 'sawtooth'; 
        else if ([56, 57, 61, 71].includes(stop.val)) osc.type = 'square';
        else osc.type = 'square';
        
        osc.frequency.value = Math.pow(2, (note.midi - 69) / 12) * 440;
        
        let swellVal = document.getElementById('swell-switch') && document.getElementById('swell-switch').checked ? 1.0 : 0.4;
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
// 2. PROJECT METADATA ENGINE
// ==========================================
function getTodayString() {
    let d = new Date();
    let month = '' + (d.getMonth() + 1);
    let day = '' + d.getDate();
    let year = d.getFullYear();
    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    return [year, month, day].join('-');
}

let songMetadata = {
    title: "",
    arranger: "",
    version: "1.0",
    created: getTodayString(),
    modified: getTodayString(),
    copyright: "https://nathaniellions.github.io/MIDIMapper166/"
};

function buildMetadataUI() {
    if (document.getElementById('meta-title')) document.getElementById('meta-title').value = songMetadata.title || "";
    if (document.getElementById('meta-arranger')) document.getElementById('meta-arranger').value = songMetadata.arranger || "";
    if (document.getElementById('meta-version')) document.getElementById('meta-version').value = songMetadata.version || "1.0";
    if (document.getElementById('meta-created')) document.getElementById('meta-created').value = songMetadata.created || getTodayString();
    if (document.getElementById('meta-modified')) document.getElementById('meta-modified').value = songMetadata.modified || getTodayString();
    if (document.getElementById('meta-copyright')) document.getElementById('meta-copyright').value = songMetadata.copyright || "";
}

window.updateMetadata = function(key, val) {
    songMetadata[key] = val;
    songMetadata.modified = getTodayString();
    if (document.getElementById('meta-modified')) document.getElementById('meta-modified').value = songMetadata.modified;
};

// ==========================================
// 3. TIME & DISPLAY ENGINE
// ==========================================
let timeDisplayFormat = 'ticks'; 

window.updateTimeFormat = function(format) {
    timeDisplayFormat = format;
    let lbl = "Tick";
    if (format === 'time') lbl = "Time";
    if (format === 'measures') lbl = "Meas";
    
    if (document.getElementById('time-label')) document.getElementById('time-label').innerText = lbl;
    if (document.getElementById('log-time-header')) document.getElementById('log-time-header').innerText = lbl;
    savePreferences();
    
    let currentTick = document.getElementById('tick-slider') ? parseInt(document.getElementById('tick-slider').value) || 0 : 0;
    updateDisplays(currentTick);
    renderLog(); 
};

function formatTimeDisplay(ticks) {
    if (!currentMidi) return ticks;
    if (timeDisplayFormat === 'time') {
        let sec = currentMidi.header.ticksToSeconds(ticks);
        let mins = Math.floor(sec / 60);
        let remSec = (sec % 60).toFixed(2);
        return `${mins}:${remSec.padStart(5, '0')}`;
    } else if (timeDisplayFormat === 'measures') {
        let bar = Math.floor(ticks / (ppq * 4)) + 1;
        let beat = Math.floor((ticks % (ppq * 4)) / ppq) + 1;
        let t = Math.round(ticks % ppq);
        return `${bar}:${beat}:${t.toString().padStart(3, '0')}`;
    }
    return ticks;
}

function updateDisplays(tickValue) {
    if(document.getElementById('current-tick')) document.getElementById('current-tick').innerText = formatTimeDisplay(tickValue);
}

window.nudgeTicks = function(amount) { nudge(amount); };
window.nudgeBeats = function(amount) { nudge(amount * ppq); };

window.nudgeSeconds = function(amountSec) {
    if (!currentMidi || !document.getElementById('tick-slider') || document.getElementById('tick-slider').disabled) return;
    let currentTick = parseInt(document.getElementById('tick-slider').value);
    let currentSec = currentMidi.header.ticksToSeconds(currentTick);
    let targetSec = Math.max(0, currentSec + amountSec);
    let targetTick = Math.round(currentMidi.header.secondsToTicks(targetSec));
    let diff = targetTick - currentTick;
    nudge(diff);
};

// ==========================================
// 4. CORE EDITOR LOGIC & STATE
// ==========================================
let currentMidi = null;
let fileName = "wurlitzer_output";
let ppq = 384; 
let minMidiNote = 127;
let maxMidiNote = 0;
let isUpdatingSwitches = false; 

let hiddenChannels = new Set();

const channelColors = [
    '#e74c3c', '#2ecc71', '#f1c40f', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#34495e',
    '#ff9ff3', '#8e44ad', '#48dbfb', '#1dd1a1', '#f368e0', '#ff9f43', '#0abde3', '#10ac84'
];

const groupColors = { "Countermelody": "#3498db", "Accompaniment": "#2ecc71", "Trumpetmelody": "#d4ac0d", "Bass": "#e74c3c", "Expression": "#8e44ad", "Presets": "#f39c12" };

const DEFAULT_SWELL_CC = 4;
const DEFAULT_PERC_CC = 12;

const DEFAULT_ORGAN_STRUCTURE = {
    "Accompaniment (Ch 2)": [ 
        { val: 70, name: "Open Flute", visible: true }, { val: 48, name: "Strings", visible: true }, { val: 11, name: "Stopped Flute", visible: true } 
    ],
    "Trumpetmelody (Ch 3)": [ 
        { val: 68, name: "Viola Bassoon", visible: true }, { val: 56, name: "Wooden Trumpet", visible: true }, { val: 61, name: "Brass Trumpet", visible: true },
        { val: 42, name: "Cello", visible: true } 
    ],
    "Countermelody (Ch 4)": [ 
        { val: 8, name: "Glockenspiel", visible: true }, { val: 10, name: "Unaphone", visible: true }, { val: 19, name: "Prestant", visible: true }, 
        { val: 20, name: "Undamaris", visible: true }, { val: 71, name: "Clarinet", visible: true }, { val: 40, name: "Forte Violin", visible: true }, 
        { val: 73, name: "Flute", visible: true }, { val: 75, name: "Flageolet", visible: true }, { val: 82, name: "Soft Violin", visible: true } 
    ],
    "Bass (Ch 4)": [ 
        { val: 57, name: "Wooden Trombone", visible: true }, { val: 50, name: "Brass Trombone", visible: true }, { val: 58, name: "Bass Flute", visible: true }
    ]
};

const DEFAULT_PISTONS = [
    { name: "Pianissimo", activeStops: [82, 73, 75, 70, 48, 11, 68, 58, 12], swell: 64 }, 
    { name: "Forte", activeStops: [8, 10, 19, 20, 71, 40, 73, 75, 82, 68, 56, 61, 42, 70, 48, 11, 57, 50, 58, 12], swell: 127 },
    { name: "Piston Default 1", activeStops: [19, 40, 73, 75, 82, 70, 48, 11, 58, 12], swell: 127 }, 
    { name: "Piston Default 2", activeStops: [71, 40, 73, 75, 82, 68, 42, 70, 48, 11, 50, 58, 12], swell: 127 },
    { name: "Piston Default 3", activeStops: [19, 20, 71, 40, 73, 75, 82, 68, 56, 42, 70, 48, 11, 57, 50, 58, 12], swell: 127 }, 
    { name: "Piston Default 4", activeStops: [8, 10, 19, 71, 40, 73, 75, 82, 68, 56, 61, 42, 70, 48, 11, 57, 50, 58, 12], swell: 127 },
    { name: "General Cancel", activeStops: [], swell: 64 } 
];

let swellCC = DEFAULT_SWELL_CC;
let percCC = DEFAULT_PERC_CC;
let organStructure = JSON.parse(JSON.stringify(DEFAULT_ORGAN_STRUCTURE));
let pistons = JSON.parse(JSON.stringify(DEFAULT_PISTONS));

function updateGlobalStopList() {
    let newAllStops = Object.values(organStructure).flat().map(s => s.val).concat([percCC]);
    pistons.forEach(p => {
        if (!p.offStops) p.offStops = [];
        newAllStops.forEach(cc => { if (!p.activeStops.includes(cc) && !p.offStops.includes(cc)) p.offStops.push(cc); });
        p.activeStops = p.activeStops.filter(cc => newAllStops.includes(cc));
        p.offStops = p.offStops.filter(cc => newAllStops.includes(cc));
        if (p.swellState === undefined) p.swellState = p.swell >= 127 ? 1 : -1;
    });
}
updateGlobalStopList();

let editingPistonIndex = 0;

window.resetToDefaults = function() {
    if (confirm("⚠️ Are you sure you want to restore the default Wurlitzer 166 settings? \n\nThis will erase any custom stops, remappings, and piston modifications you have made!")) {
        swellCC = DEFAULT_SWELL_CC;
        percCC = DEFAULT_PERC_CC;
        organStructure = JSON.parse(JSON.stringify(DEFAULT_ORGAN_STRUCTURE));
        pistons = JSON.parse(JSON.stringify(DEFAULT_PISTONS));
        editingPistonIndex = 0;
        
        updateGlobalStopList();
        buildSettingsUI();
        buildEditorUI();
        
        if (currentMidi) {
            let currentTick = parseInt(document.getElementById('tick-slider').value);
            syncSwitchesToTimeline(currentTick);
            renderLog();
            draw();
        }
        alert("Success: Factory settings have been restored.");
    }
};

// ==========================================
// 5. LOCAL PREFERENCES
// ==========================================
function savePreferences() {
    const prefs = {
        darkMode: document.getElementById('dark-mode-toggle') ? document.getElementById('dark-mode-toggle').checked : false,
        showMidi: document.getElementById('show-midi-toggle') ? document.getElementById('show-midi-toggle').checked : false,
        timeFormat: timeDisplayFormat
    };
    localStorage.setItem('w166_prefs', JSON.stringify(prefs));
}

function loadPreferences() {
    const saved = localStorage.getItem('w166_prefs');
    if (saved) {
        try {
            const prefs = JSON.parse(saved);
            
            if (document.getElementById('dark-mode-toggle')) {
                document.getElementById('dark-mode-toggle').checked = prefs.darkMode;
                document.documentElement.setAttribute('data-theme', prefs.darkMode ? 'dark' : 'light');
            }
            
            if (document.getElementById('show-midi-toggle')) {
                document.getElementById('show-midi-toggle').checked = prefs.showMidi;
                if (prefs.showMidi) document.body.classList.remove('hide-midi-vals');
                else document.body.classList.add('hide-midi-vals');
            }
            
            if (document.getElementById('time-format-select')) {
                document.getElementById('time-format-select').value = prefs.timeFormat || 'ticks';
                timeDisplayFormat = prefs.timeFormat || 'ticks';
                let lbl = "Tick";
                if (timeDisplayFormat === 'time') lbl = "Time";
                if (timeDisplayFormat === 'measures') lbl = "Meas";
                if (document.getElementById('time-label')) document.getElementById('time-label').innerText = lbl;
                if (document.getElementById('log-time-header')) document.getElementById('log-time-header').innerText = lbl;
            }
        } catch(e) { console.warn("Could not load preferences."); }
    }
}

window.toggleDarkMode = function(isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    savePreferences();
    draw(); 
};

window.toggleMidiVals = function(show) {
    if (show) document.body.classList.remove('hide-midi-vals');
    else document.body.classList.add('hide-midi-vals');
    savePreferences();
};

function getSystemTrack() {
    if (!currentMidi) return null;
    return currentMidi.tracks.find(t => 
        t.channel === 15 || 
        (t.controlChanges[80] && t.controlChanges[80].length > 0) || 
        (t.controlChanges[81] && t.controlChanges[81].length > 0)
    );
}

function getOrCreateSystemTrack() {
    let trk = getSystemTrack();
    if (!trk) {
        trk = currentMidi.addTrack();
        trk.channel = 15;
    }
    trk.channel = 15; // Ensure channel property stays accurate
    return trk;
}

// ==========================================
// 6. SETTINGS & MAPPING UI
// ==========================================
window.addRank = function(manualKey) {
    let usedCCs = Object.values(organStructure).flat().map(s => s.val).concat([percCC, swellCC, 80, 81]);
    let newVal = 21; 
    while (usedCCs.includes(newVal) && newVal < 120) { newVal++; }
    
    organStructure[manualKey].push({ val: newVal, name: "New Stop", visible: true });
    updateGlobalStopList();
    buildSettingsUI();
    buildEditorUI();
};

window.deleteRank = function(manualKey, index) {
    if (confirm(`Are you sure you want to delete ${organStructure[manualKey][index].name}?`)) {
        organStructure[manualKey].splice(index, 1);
        updateGlobalStopList();
        buildSettingsUI();
        buildEditorUI();
    }
};

function buildSettingsUI() {
    const container = document.getElementById('settings-mapping-container');
    if(!container) return;
    container.innerHTML = '';

    let globalHtml = `<div class="panel"><h3>Global Setup (Ranks & Channels)</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 10px;">`;
    
    for (const [manual, stops] of Object.entries(organStructure)) {
        let color = groupColors[manual.split(' ')[0]] || "#3498db";
        globalHtml += `<div style="border-left: 3px solid ${color}; padding-left: 8px; background: var(--manual-bg); border-radius: 4px; padding-right:8px; padding-bottom:10px;">
            <h4 style="margin: 5px 0; color: ${color}; font-size: 0.85em;">${manual.split(' ')[0]}</h4>`;
        
        stops.forEach((s, i) => {
            let isVis = s.visible !== false;
            let eyeOp = isVis ? "1" : "0.3";
            let textDecor = isVis ? "none" : "line-through";
            let rowOp = isVis ? "1" : "0.6";

            globalHtml += `<div style="display:flex; align-items:center; gap: 5px; margin-bottom: 5px; opacity: ${rowOp};">
                <button style="background:#e74c3c; border:none; border-radius: 3px; cursor:pointer; font-size:0.7em; color: white; padding:2px 5px; margin-right: 5px;" onclick="deleteRank('${manual}', ${i})" title="Delete Stop">🗑️</button>
                <button style="background:transparent; border:none; cursor:pointer; font-size:1em; opacity:${eyeOp}; padding:0;" onclick="toggleRankVisibility('${manual}', ${i})" title="Toggle Visibility">👁️</button>
                <input type="number" class="mapping-input" style="width: 40px; padding: 2px;" value="${s.val}" onchange="updateMapping('${manual}', ${i}, 'val', this.value)" title="MIDI CC">
                <input type="text" style="background:transparent; border:none; border-bottom:1px dashed var(--border-color); color:var(--text-color); font-size:0.8em; outline:none; text-decoration:${textDecor}; width: 120px;" value="${s.name}" onchange="updateMapping('${manual}', ${i}, 'name', this.value)">
            </div>`;
        });
        
        globalHtml += `<button class="nudge-btn" style="width:100%; margin-top:5px; font-size:0.8em; padding: 5px; background: rgba(52, 152, 219, 0.1); border: 1px dashed ${color}; color: ${color};" onclick="addRank('${manual}')">➕ Add Stop</button>`;
        globalHtml += `</div>`;
    }
    
    globalHtml += `<div style="border-left: 3px solid #8e44ad; padding-left: 8px; background: var(--manual-bg); border-radius: 4px; padding-right:8px; padding-bottom:10px;">
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
            if (s.visible === false) return;
            let state = piston.activeStops.includes(s.val) ? 1 : (piston.offStops.includes(s.val) ? -1 : 0);
            pistonHtml += buildTriStateBox(s.name, s.val, state, 'stop');
        });
    }
    
    let percState = piston.activeStops.includes(percCC) ? 1 : (piston.offStops.includes(percCC) ? -1 : 0);
    pistonHtml += buildTriStateBox("Percussion", percCC, percState, 'stop');
    pistonHtml += buildTriStateBox("Swell Shutters", swellCC, piston.swellState, 'swell');

    pistonHtml += `</div></div>`;
    container.innerHTML += pistonHtml;

    container.innerHTML += `<div style="margin-top: 25px; text-align: center; border-top: 1px solid var(--border-color); padding-top: 25px;">
        <button class="nudge-btn" style="background: #c0392b; color: white; padding: 12px 24px; font-size: 1.1em; font-weight: bold; border: none; border-radius: 5px;" onclick="resetToDefaults()">⚠️ Reset to Default W166 Settings</button>
        <p style="color: #7f8c8d; font-size: 0.85em; margin-top: 10px;">This will safely restore all original ranks, CC values, and piston configurations.</p>
    </div>`;
}

function buildTriStateBox(name, val, state, type = 'stop') {
    let offOp = state === -1 ? '1' : '0.3';
    let neutOp = state === 0 ? '1' : '0.3';
    let onOp = state === 1 ? '1' : '0.3';

    return `<div style="background: var(--stop-row-bg); padding: 8px; border: 1px solid var(--border-color); border-radius: 5px; display: flex; flex-direction: column; gap: 6px; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size: 0.85em; font-weight: bold; text-align: center; color: var(--text-color);">${name}</div>
        <div style="display: flex; gap: 4px;">
            <button style="flex:1; border:none; border-radius:3px; color:white; font-weight:bold; cursor:pointer; padding:6px 0; background:#e74c3c; opacity:${offOp}; transition:0.2s;" onclick="setTriState(${val}, -1, '${type}')">✖</button>
            <button style="flex:1; border:none; border-radius:3px; color:white; font-weight:bold; cursor:pointer; padding:6px 0; background:#95a5a6; opacity:${neutOp}; transition:0.2s;" onclick="setTriState(${val}, 0, '${type}')">/</button>
            <button style="flex:1; border:none; border-radius:3px; color:white; font-weight:bold; cursor:pointer; padding:6px 0; background:#2ecc71; opacity:${onOp}; transition:0.2s;" onclick="setTriState(${val}, 1, '${type}')">✔</button>
        </div>
    </div>`;
}

window.toggleRankVisibility = function(manualKey, index) {
    let stop = organStructure[manualKey][index];
    stop.visible = stop.visible === false ? true : false;
    buildSettingsUI();
    buildEditorUI();
};

window.switchPistonTab = function(index) {
    editingPistonIndex = index;
    buildSettingsUI();
};

window.updatePistonName = function(index, newName) {
    pistons[index].name = newName;
    buildSettingsUI();
    buildEditorUI();
};

window.setTriState = function(val, targetState, type) {
    let p = pistons[editingPistonIndex];
    if (type === 'swell') { p.swellState = targetState; } 
    else {
        p.activeStops = p.activeStops.filter(v => v !== val);
        p.offStops = p.offStops.filter(v => v !== val);
        if (targetState === 1) p.activeStops.push(val);
        else if (targetState === -1) p.offStops.push(val);
    }
    buildSettingsUI(); 
};

window.updateMapping = function(manualKey, index, type, newVal) {
    if (type === 'val') organStructure[manualKey][index].val = parseInt(newVal);
    if (type === 'name') organStructure[manualKey][index].name = newVal;
    buildSettingsUI(); buildEditorUI();
    if(currentMidi && document.getElementById('tick-slider')) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
};

window.updateExpMapping = function(type, newVal) {
    if (type === 'swell') swellCC = parseInt(newVal);
    if (type === 'perc') percCC = parseInt(newVal);
    buildSettingsUI(); buildEditorUI();
    if(currentMidi && document.getElementById('tick-slider')) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
};

// ==========================================
// 7. DASHBOARD EDITOR UI
// ==========================================
function buildEditorUI() {
    if(!document.getElementById('col-countermelody')) return;
    document.getElementById('col-countermelody').innerHTML = '';
    document.getElementById('col-accomp-trumpet').innerHTML = '';
    document.getElementById('col-bass-exp').innerHTML = '';
    document.getElementById('col-pistons').innerHTML = '';

    for (const [manual, stops] of Object.entries(organStructure)) {
        let shortMan = manual.split(' ')[0]; let color = groupColors[shortMan] || "#3498db";
        if (stops.every(s => s.visible === false)) continue;

        const groupDiv = document.createElement('div'); groupDiv.className = 'manual-group'; groupDiv.style.borderLeftColor = color;
        groupDiv.innerHTML = `<h4 style="color: ${color};">${shortMan} <span class="midi-val" style="color: var(--text-color); font-weight: normal; font-size: 0.8em;">${manual.replace(shortMan, '').trim()}</span></h4><div class="stop-grid"></div>`;
        const grid = groupDiv.querySelector('.stop-grid');
        
        stops.forEach(s => {
            if (s.visible === false) return;
            grid.innerHTML += `<div class="stop-row"><span class="stop-name">${s.name} <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(${s.val})</span></span><label class="switch"><input type="checkbox" id="stop-${s.val}" onchange="handleStopToggle(${s.val}, '${s.name}', '${shortMan}', this.checked)"><span class="slider-switch"></span></label></div>`;
        });
        
        if (shortMan === "Countermelody") { document.getElementById('col-countermelody').appendChild(groupDiv); }
        else if (shortMan === "Accompaniment" || shortMan === "Trumpetmelody") { document.getElementById('col-accomp-trumpet').appendChild(groupDiv); }
        else if (shortMan === "Bass") { document.getElementById('col-bass-exp').appendChild(groupDiv); }
    }

    const expDiv = document.createElement('div'); expDiv.className = 'manual-group'; expDiv.style.borderLeftColor = "#8e44ad";
    expDiv.innerHTML = `<h4 style="color: #8e44ad;">Expression & Percussion</h4><div class="stop-grid"><div class="stop-row"><span class="stop-name" style="color: #8e44ad;">Swell Shutters <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(CC ${swellCC})</span></span><label class="switch"><input type="checkbox" id="swell-switch" onchange="handleSwellToggle(this.checked)"><span class="slider-switch swell-bg"></span></label></div><div class="stop-row"><span class="stop-name">Percussion Master <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(${percCC})</span></span><label class="switch"><input type="checkbox" id="stop-${percCC}" onchange="handleStopToggle(${percCC}, 'Percussion Master', 'Perc', this.checked)"><span class="slider-switch"></span></label></div></div>`;
    document.getElementById('col-bass-exp').appendChild(expDiv);

    let pistonsHtml = `<div class="manual-group" style="border-left-color: #f39c12; flex: 1;"><h4 style="color: #f39c12;">Saved Pistons</h4><div class="stop-grid" style="gap: 5px;">`;
    pistons.forEach((p, i) => {
        let extraStyle = i === pistons.length - 1 ? "margin-top: 15px; border-color: #e74c3c; color: #e74c3c;" : "";
        pistonsHtml += `<button class="nudge-btn" style="width: 100%; text-align: left; padding: 10px; font-size: 1em; ${extraStyle}" onclick="applyRegistrationState(${i})">${p.name}</button>`;
    });
    pistonsHtml += `</div></div>`;
    document.getElementById('col-pistons').innerHTML = pistonsHtml;
}

window.openTab = function(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    if(btnElement) btnElement.classList.add('active');
    if (tabId === 'page-editor' && currentMidi) setTimeout(() => draw(), 10);
};

// ==========================================
// 8. IMPORT INTERCEPTOR & REMAP MODAL
// ==========================================
function getUnknownStops(track) {
    if (!track) return [];
    let knownVals = Object.values(organStructure).flat().map(s => s.val).concat([percCC]);
    let foundVals = new Set();
    [80, 81].forEach(cc => {
        if (track.controlChanges[cc]) {
            track.controlChanges[cc].forEach(e => {
                let val = Math.round(e.value * 127);
                if (!knownVals.includes(val)) foundVals.add(val);
            });
        }
    });
    return Array.from(foundVals);
}

function createImportModal() {
    if(document.getElementById('import-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'import-modal';
    modal.style.cssText = "display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:9999; justify-content:center; align-items:center; backdrop-filter: blur(3px);";
    modal.innerHTML = `
        <div style="background:var(--manual-bg, #222); padding:25px; border-radius:8px; max-width:400px; text-align:center; border: 1px solid var(--border-color, #444); box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
            <h3 style="margin-top:0; color:#f39c12; font-size:1.4em;">Organ Data Detected</h3>
            <p style="font-size:0.95em; color:var(--text-color, #eee); margin-bottom:20px; line-height:1.4;">This MIDI file already contains Wurlitzer registration data. How would you like to proceed?</p>
            <div style="display:flex; flex-direction:column; gap:12px;">
                <button class="nudge-btn" style="background:#3498db; color:white; border:none; padding:12px; font-size:1em;" onclick="handleImportChoice('modify')">Modify Existing Mappings</button>
                <button class="nudge-btn" style="background:#e74c3c; color:white; border:none; padding:12px; font-size:1em;" onclick="handleImportChoice('clear')">Start Over (Clear Mappings)</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

window.toggleRemapRow = function(val) {
    let act = document.getElementById(`action-${val}`).value;
    document.getElementById(`target-${val}`).style.display = act === 'replace' ? 'block' : 'none';
    document.getElementById(`name-${val}`).style.display = act === 'add' ? 'block' : 'none';
    document.getElementById(`manual-${val}`).style.display = act === 'add' ? 'block' : 'none';
};

function showRemapModal(unknowns) {
    if(!document.getElementById('remap-modal')) {
        const modal = document.createElement('div');
        modal.id = 'remap-modal';
        modal.style.cssText = "display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:9999; justify-content:center; align-items:center; backdrop-filter: blur(3px);";
        document.body.appendChild(modal);
    }
    const modal = document.getElementById('remap-modal');
    
    let manualOptions = Object.keys(organStructure).map(k => `<option value="${k}">${k.split(' ')[0]}</option>`).join('');
    
    let stopOptions = '';
    for (const [man, stops] of Object.entries(organStructure)) {
        let shortMan = man.split(' ')[0];
        stops.forEach(s => {
            stopOptions += `<option value="${s.val}">${s.name} (${shortMan})</option>`;
        });
    }

    let html = `<div style="background:var(--manual-bg, #222); padding:25px; border-radius:8px; max-width:650px; width: 100%; text-align:left; border: 1px solid var(--border-color, #444); box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-height: 85vh; overflow-y: auto;">
        <h3 style="margin-top:0; color:#e74c3c; font-size:1.4em; text-align:center;">Unknown Stops Detected</h3>
        <p style="font-size:0.95em; color:var(--text-color, #eee); margin-bottom:20px; line-height:1.4; text-align:center;">Choose how you want to handle these unrecognized CC signals.</p>
        <div id="remap-list" style="display:flex; flex-direction:column; gap:10px; margin-bottom: 25px;">`;

    unknowns.forEach(val => {
        html += `<div style="display:flex; gap: 8px; align-items:center; background: var(--stop-row-bg); padding: 12px; border-radius: 5px; border: 1px solid var(--border-color); flex-wrap: wrap;">
            <span style="font-weight:bold; color:#f1c40f; width: 60px; font-size: 1.1em;">CC ${val}</span>
            
            <select id="action-${val}" class="mapping-input" style="flex: 1; min-width: 130px; cursor:pointer;" onchange="toggleRemapRow(${val})">
                <option value="ignore" selected>Ignore (Keep in File)</option>
                <option value="replace">Replace Existing Stop</option>
                <option value="add">Add as New Stop</option>
                <option value="delete">Delete from MIDI</option>
            </select>

            <select id="target-${val}" class="mapping-input" style="flex: 2; display:none; cursor:pointer;">
                ${stopOptions}
            </select>

            <input type="text" id="name-${val}" class="mapping-input" placeholder="New Stop Name" style="flex: 1.5; display:none;">
            <select id="manual-${val}" class="mapping-input" style="flex: 1; display:none; cursor:pointer;">
                ${manualOptions}
            </select>
        </div>`;
    });

    html += `</div>
        <div style="display:flex; justify-content:center; gap: 10px; flex-wrap: wrap;">
            <button class="nudge-btn" style="background:#95a5a6; color:white; border:none; padding:10px 15px; font-size:0.9em;" onclick="ignoreAllRemap()">Ignore All</button>
            <button class="nudge-btn" style="background:#c0392b; color:white; border:none; padding:10px 15px; font-size:0.9em;" onclick="deleteAllRemap([${unknowns.join(',')}])">Delete All Unknowns</button>
            <button class="nudge-btn" style="background:#2ecc71; color:white; border:none; padding:10px 20px; font-size:1em; font-weight:bold;" onclick="processRemap([${unknowns.join(',')}])">Process Mappings</button>
        </div>
    </div>`;
    modal.innerHTML = html;
    modal.style.display = 'flex';
}

window.handleImportChoice = function(choice) {
    document.getElementById('import-modal').style.display = 'none';
    let sysTrack = getSystemTrack();

    if (choice === 'clear') {
        if (sysTrack) {
            for (let i = currentMidi.tracks.length - 1; i >= 0; i--) {
                if (currentMidi.tracks[i] === sysTrack) {
                    currentMidi.tracks.splice(i, 1);
                }
            }
        }
        buildRoutingUI();
    } else {
        let unknowns = getUnknownStops(sysTrack);
        if (unknowns.length > 0) {
            showRemapModal(unknowns);
        } else {
            buildRoutingUI();
        }
    }
};

window.processRemap = function(unknowns) {
    let sysTrack = getSystemTrack();
    let oldToNewCCs = {};

    unknowns.forEach(val => {
        let act = document.getElementById(`action-${val}`).value;

        if (act === 'ignore') {
            return; 
        } 
        else if (act === 'delete') {
            if (sysTrack) {
                [80, 81].forEach(cc => {
                    if(sysTrack.controlChanges[cc]) {
                        let arr = sysTrack.controlChanges[cc];
                        for(let i = arr.length - 1; i >= 0; i--) {
                            if (Math.round(arr[i].value * 127) === val) arr.splice(i, 1);
                        }
                    }
                });
            }
        } 
        else if (act === 'replace') {
            let oldCC = parseInt(document.getElementById(`target-${val}`).value);
            let existingStop = null;
            for (const [man, stops] of Object.entries(organStructure)) {
                let found = stops.find(s => s.val === oldCC);
                if (found) { existingStop = found; break; }
            }
            if (existingStop) {
                existingStop.val = val;
                oldToNewCCs[oldCC] = val; 
            }
        } 
        else if (act === 'add') {
            let name = document.getElementById(`name-${val}`).value.trim() || `Recovered CC ${val}`;
            let manualKey = document.getElementById(`manual-${val}`).value;
            organStructure[manualKey].push({ val: val, name: name, visible: true });
        }
    });

    updateGlobalStopList();

    pistons.forEach(p => {
        for (let oldCC in oldToNewCCs) {
            let oldInt = parseInt(oldCC);
            let newInt = oldToNewCCs[oldCC];

            if (p.activeStops.includes(oldInt)) {
                p.activeStops = p.activeStops.filter(c => c !== oldInt);
                p.activeStops.push(newInt);
            }
            if (p.offStops.includes(oldInt)) {
                p.offStops = p.offStops.filter(c => c !== oldInt);
                p.offStops.push(newInt);
            }
        }
    });

    document.getElementById('remap-modal').style.display = 'none';
    buildSettingsUI();
    buildEditorUI();
    buildRoutingUI();
};

window.ignoreAllRemap = function() {
    document.getElementById('remap-modal').style.display = 'none';
    buildRoutingUI();
};

window.deleteAllRemap = function(unknowns) {
    let sysTrack = getSystemTrack();
    if (sysTrack) {
        unknowns.forEach(val => {
            [80, 81].forEach(cc => {
                if(sysTrack.controlChanges[cc]) {
                    let arr = sysTrack.controlChanges[cc];
                    for (let i = arr.length - 1; i >= 0; i--) {
                        if (Math.round(arr[i].value * 127) === val) arr.splice(i, 1);
                    }
                }
            });
        });
    }
    document.getElementById('remap-modal').style.display = 'none';
    buildRoutingUI();
};

// ==========================================
// 9. ROUTING, IMPORT & SOFT RESET
// ==========================================
window.hardReset = function() {
    if(confirm("Are you sure? This will clear the current file and return to the upload screen. Your preferences will be saved.")) {
        if(isPlaying) stopPlayback();
        
        currentMidi = null;
        fileName = "wurlitzer_output";
        scheduledNotes.clear();
        killAllNotes();
        
        if(document.getElementById('midi-upload')) document.getElementById('midi-upload').value = '';
        if(document.getElementById('upload-panel')) document.getElementById('upload-panel').style.display = 'block';
        if(document.getElementById('routing-panel')) document.getElementById('routing-panel').style.display = 'none';
        if(document.getElementById('routing-list')) document.getElementById('routing-list').innerHTML = '';
        
        if(document.getElementById('col-countermelody')) {
            document.getElementById('col-countermelody').innerHTML = '';
            document.getElementById('col-accomp-trumpet').innerHTML = '';
            document.getElementById('col-bass-exp').innerHTML = '';
            document.getElementById('col-pistons').innerHTML = '';
        }
        
        if(document.getElementById('tick-slider')) {
            document.getElementById('tick-slider').value = 0;
            document.getElementById('tick-slider').disabled = true;
        }
        if(document.getElementById('zoom-slider')) {
            document.getElementById('zoom-slider').value = 1;
            document.getElementById('zoom-slider').disabled = true;
        }
        
        updateDisplays(0);
        
        const canvas = document.getElementById('piano-roll');
        if(canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        
        if(document.getElementById('log-body')) {
            document.getElementById('log-body').innerHTML = '';
        }
        
        songMetadata = {
            title: "",
            arranger: "", 
            version: "1.0",
            created: getTodayString(),
            modified: getTodayString(),
            copyright: "https://nathaniellions.github.io/MIDIMapper166/"
        };
        buildMetadataUI();
        
        openTab('page-import', document.getElementById('tab-import'));
    }
};

document.getElementById('midi-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    fileName = file.name.replace(".mid", ""); const arrayBuffer = await file.arrayBuffer();
    currentMidi = new Midi(arrayBuffer); ppq = currentMidi.header.ppq || 384; 
    
    let systemTrack = getSystemTrack();
    
    if (systemTrack) {
        document.getElementById('import-modal').style.display = 'flex';
    } else {
        buildRoutingUI(); 
    }
});

window.buildRoutingUI = function() {
    let activeChannels = new Set();
    let channelNames = {};
    
    currentMidi.tracks.forEach(t => {
        if (t.notes.length > 0 && t.channel !== 15) {
            activeChannels.add(t.channel);
            if (!channelNames[t.channel] && t.name) channelNames[t.channel] = t.name;
        }
    });

    let routingHtml = '';
    Array.from(activeChannels).sort((a,b)=>a-b).forEach(ch => {
        let chNameExt = channelNames[ch] ? ` (${channelNames[ch]})` : '';
        let color = channelColors[ch % 16];
        
        let sel1 = ch === 0 ? 'selected' : '';
        let sel2 = ch === 1 ? 'selected' : '';
        let sel3 = ch === 2 ? 'selected' : '';
        let sel4c = ch === 3 ? 'selected' : '';
        let sel4b = ch === 4 ? 'selected' : '';
        
        routingHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--stop-row-bg); padding:12px; border-radius:5px; border-left: 5px solid ${color}; border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); border-right: 1px solid var(--border-color); margin-bottom: 8px;">
            <span style="font-weight:bold; color: var(--text-color);">Incoming Channel ${ch + 1}${chNameExt}</span>
            <select id="route-ch-${ch}" class="mapping-input" style="width: 250px; cursor: pointer; font-size: 0.95em;">
                <option value="1" ${sel1}>Percussion (Out Ch 1)</option>
                <option value="2" ${sel2}>Accompaniment (Out Ch 2)</option>
                <option value="3" ${sel3}>Trumpetmelody (Out Ch 3)</option>
                <option value="4-counter" ${sel4c}>Countermelody (Out Ch 4)</option>
                <option value="4-bass" ${sel4b}>Bass (Out Ch 4)</option>
                <option value="ignore">🗑️ Ignore / Mute Track</option>
            </select>
        </div>`;
    });

    if(document.getElementById('routing-list')) document.getElementById('routing-list').innerHTML = routingHtml;
    if(document.getElementById('upload-panel')) document.getElementById('upload-panel').style.display = 'none';
    if(document.getElementById('routing-panel')) document.getElementById('routing-panel').style.display = 'block';
};

window.applyRoutingAndStart = function() {
    let activeChannels = new Set();
    currentMidi.tracks.forEach(t => {
        if (t.notes.length > 0 && t.channel !== 15) activeChannels.add(t.channel);
    });

    let channelMap = {};
    Array.from(activeChannels).forEach(ch => {
        let select = document.getElementById(`route-ch-${ch}`);
        if(select) channelMap[ch] = select.value;
    });

    const targetMap = {
        "1": { ch: 0, name: "Percussion", gm: 115 }, 
        "2": { ch: 1, name: "Accompaniment", gm: 4 }, 
        "3": { ch: 2, name: "Trumpetmelody", gm: 56 }, 
        "4-counter": { ch: 3, name: "Countermelody", gm: 0 }, 
        "4-bass": { ch: 3, name: "Bass", gm: 32 } 
    };

    let tracksToRemove = [];
    currentMidi.tracks.forEach(t => {
        if (t.channel !== 15 && channelMap[t.channel] !== undefined) {
            let mapped = channelMap[t.channel];
            if (mapped === 'ignore') {
                tracksToRemove.push(t);
            } else if (targetMap[mapped]) {
                let dest = targetMap[mapped];
                t.channel = dest.ch;
                t.name = dest.name;
                if (!t.instrument) t.instrument = {};
                t.instrument.number = dest.gm; 
                t.instrument.name = dest.name;
            }
        }
    });

    for (let i = currentMidi.tracks.length - 1; i >= 0; i--) {
        if (tracksToRemove.includes(currentMidi.tracks[i])) currentMidi.tracks.splice(i, 1);
    }
    
    finalizeImport();
};

function finalizeImport() {
    let maxTicks = 0; minMidiNote = 127; maxMidiNote = 0; let activeChannels = new Set(); hiddenChannels.clear();
    
    let sysTrack = getSystemTrack();
    if (sysTrack && sysTrack.name && sysTrack.name.startsWith("W166_META:")) {
        try {
            let parsedMeta = JSON.parse(sysTrack.name.substring(10));
            songMetadata = { ...songMetadata, ...parsedMeta };
            songMetadata.modified = getTodayString(); 
        } catch(e) {}
    } else {
        songMetadata.title = fileName; 
        songMetadata.created = getTodayString();
        songMetadata.modified = getTodayString();
    }
    buildMetadataUI();

    currentMidi.tracks.forEach(t => {
        if (t.notes.length > 0) activeChannels.add(t.channel);
        t.notes.forEach(n => { if(n.ticks + n.durationTicks > maxTicks) maxTicks = n.ticks + n.durationTicks; if(n.midi < minMidiNote) minMidiNote = n.midi; if(n.midi > maxMidiNote) maxMidiNote = n.midi; });
    });
    
    const filtersDiv = document.getElementById('channel-filters');
    if(filtersDiv) {
        filtersDiv.innerHTML = '<strong style="display:flex; align-items:center; margin-right:10px; font-size:0.9em;">Tracks:</strong>';
        Array.from(activeChannels).sort((a,b)=>a-b).forEach(ch => {
            const btn = document.createElement('button'); btn.className = 'filter-btn'; btn.style.backgroundColor = channelColors[ch % 16]; btn.innerText = `Ch ${ch + 1}`; 
            btn.onclick = () => { if (hiddenChannels.has(ch)) { hiddenChannels.delete(ch); btn.classList.remove('inactive'); } else { hiddenChannels.add(ch); btn.classList.add('inactive'); } draw(); };
            filtersDiv.appendChild(btn);
        });
    }
    
    const slider = document.getElementById('tick-slider'); 
    if(slider) {
        slider.max = maxTicks + ppq; slider.value = 0; slider.disabled = false;
    }
    if(document.getElementById('zoom-slider')) document.getElementById('zoom-slider').disabled = false; 
    
    updateDisplays(0);
    if(document.getElementById('export-btn')) document.getElementById('export-btn').style.display = 'block'; 
    renderLog(); 
    syncSwitchesToTimeline(0); 
    openTab('page-editor', document.getElementById('tab-editor'));
}

window.addEventListener('resize', () => { if (currentMidi) draw(); });

if(document.getElementById('tick-slider')) {
    document.getElementById('tick-slider').addEventListener('input', (e) => {
        const newTick = parseInt(e.target.value); 
        updateDisplays(newTick);
        syncSwitchesToTimeline(newTick); draw();
        if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(newTick); startTimeMs = performance.now(); }
    });
}

if(document.getElementById('zoom-slider')) {
    document.getElementById('zoom-slider').addEventListener('input', (e) => { 
        if(document.getElementById('zoom-level')) document.getElementById('zoom-level').innerText = e.target.value + 'x'; 
        draw(); 
    });
}

function nudge(amount) {
    const slider = document.getElementById('tick-slider'); if (!slider || slider.disabled) return;
    let newVal = Math.max(0, Math.min(parseInt(slider.max), parseInt(slider.value) + amount));
    slider.value = newVal; 
    updateDisplays(newVal);
    syncSwitchesToTimeline(newVal); draw();
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(newVal); startTimeMs = performance.now(); }
}

// ==========================================
// 10. SWITCH LOGIC & RENDER ENGINE
// ==========================================
window.handleSwellToggle = function(isChecked) { if (isUpdatingSwitches) return; if (isChecked) addEvent(swellCC, 127, 'Swell OPEN', 'Exp'); else addEvent(swellCC, 64, 'Swell CLOSED', 'Exp'); };
window.handleStopToggle = function(val, name, manual, isChecked) { if (isUpdatingSwitches) return; if (isChecked) addEvent(81, val, `${name} ON`, manual); else addEvent(80, val, `${name} OFF`, manual); };

function renderLog() {
    const tbody = document.getElementById('log-body'); if(!tbody) return;
    tbody.innerHTML = '';
    if (!currentMidi) return; let track = getSystemTrack(); if (!track) return;
    let events = []; [swellCC, 80, 81].forEach(cc => { if (track.controlChanges[cc]) track.controlChanges[cc].forEach(e => { events.push({ cc: cc, val: Math.round(e.value * 127), ticks: e.ticks }); }); });
    events.sort((a, b) => b.ticks - a.ticks);
    events.forEach(e => {
        let label = ""; let manual = "Sys"; let labelColor = "var(--text-color)";
        if (e.cc === swellCC) { label = e.val >= 127 ? "Swell OPEN" : "Swell CLOSED"; manual = "Exp"; labelColor = "#9b59b6"; }
        else {
            let foundName = "Unknown";
            for (const [man, stops] of Object.entries(organStructure)) { let stop = stops.find(s => s.val === e.val); if (stop) { foundName = stop.name; manual = man.split(' ')[0]; break; } }
            if (e.val === percCC) { foundName = "Percussion Master"; manual = "Perc"; }
            if (e.cc === 81) { label = foundName + " ON"; labelColor = "#27ae60"; } else { label = foundName + " OFF"; labelColor = "#e74c3c"; }
        }
        
        let displayTime = formatTimeDisplay(e.ticks);
        
        tbody.innerHTML += `<tr><td><strong>${displayTime}</strong></td><td>${manual}</td><td style="color:${labelColor}"><strong>${label}</strong></td><td><button class="del-btn" onclick="removeEvent(${e.cc}, ${e.val}, ${e.ticks})">X</button></td></tr>`;
    });
}

window.applyRegistrationState = function(pistonIndex) {
    if (!currentMidi) return alert("Please load a MIDI file first!");
    let p = pistons[pistonIndex];
    let baseTick = parseInt(document.getElementById('tick-slider').value);
    let track = getOrCreateSystemTrack();
    
    [swellCC, 80, 81].forEach(cc => { 
        if (track.controlChanges[cc]) {
            let arr = track.controlChanges[cc];
            for (let i = arr.length - 1; i >= 0; i--) {
                if (Math.abs(arr[i].ticks - baseTick) <= 40) {
                    arr.splice(i, 1);
                }
            }
        }
    });
    
    let currentOffset = 0; 
    
    if (p.swellState !== 0) {
        let swellVal = p.swellState === 1 ? 127 : 64;
        track.addCC({ number: swellCC, value: swellVal / 127, ticks: baseTick + currentOffset });
        currentOffset++;
    }
    
    let activeOrganStops = Object.values(organStructure).flat().filter(s => s.visible !== false).map(s => s.val).concat([percCC]);
    
    activeOrganStops.forEach(val => {
        let targetCC = null;
        if (p.activeStops.includes(val)) targetCC = 81;
        else if (p.offStops.includes(val)) targetCC = 80;
        
        if (targetCC !== null) {
            track.addCC({ number: targetCC, value: val / 127, ticks: baseTick + currentOffset });
            currentOffset++;
        }
    });
    
    let syncTick = Math.min(parseInt(document.getElementById('tick-slider').max), baseTick + currentOffset);
    document.getElementById('tick-slider').value = syncTick; 
    updateDisplays(syncTick);
    renderLog(); syncSwitchesToTimeline(syncTick); draw(); 
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(syncTick); startTimeMs = performance.now(); }
};

function addEvent(cc, val, label, manual) {
    if (!currentMidi) return;
    let baseTick = parseInt(document.getElementById('tick-slider').value);
    let track = getOrCreateSystemTrack();
    
    [swellCC, 80, 81].forEach(checkCc => { 
        if (track.controlChanges[checkCc]) {
            let arr = track.controlChanges[checkCc];
            for(let i = arr.length - 1; i >= 0; i--) {
                let e = arr[i];
                let isConflict = ((cc === swellCC && checkCc === swellCC) || (Math.round(e.value * 127) === val));
                if (isConflict && Math.abs(e.ticks - baseTick) <= 10) arr.splice(i, 1);
            }
        }
    });

    let safeTick = baseTick; 
    while (track.controlChanges[cc] && track.controlChanges[cc].some(e => e.ticks === safeTick)) { safeTick++; }
    
    track.addCC({ number: cc, value: val / 127, ticks: safeTick });
    renderLog(); draw(); 
}

window.removeEvent = function(cc, val, tick) {
    let track = getSystemTrack();
    if (track && track.controlChanges[cc]) {
        let arr = track.controlChanges[cc];
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].ticks === tick && Math.round(arr[i].value * 127) === val) {
                arr.splice(i, 1);
            }
        }
    }
    renderLog(); syncSwitchesToTimeline(parseInt(document.getElementById('tick-slider').value)); draw();
};

function syncSwitchesToTimeline(currentTick) {
    if (!currentMidi) return;
    isUpdatingSwitches = true; 
    let track = getSystemTrack();
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
    const canvas = document.getElementById('piano-roll'); if (!canvas || canvas.offsetParent === null) return; 
    const ctx = canvas.getContext('2d'); const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; ctx.scale(dpr, dpr);
    ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#111' : '#1a1a1a';
    ctx.fillRect(0, 0, rect.width, rect.height);
    
    const sliderMax = parseInt(document.getElementById('tick-slider').max); 
    const currentTick = parseInt(document.getElementById('tick-slider').value);
    const zoom = parseFloat(document.getElementById('zoom-slider').value); 
    const windowTicks = sliderMax / zoom;
    let st = Math.max(0, Math.min(sliderMax - windowTicks, currentTick - (windowTicks / 2)));
    
    const scaleX = rect.width / windowTicks; 
    const noteHeight = rect.height / (maxMidiNote - minMidiNote + 4);
    
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    for(let i = Math.ceil(st / ppq) * ppq; i <= st + windowTicks; i += ppq) { 
        ctx.beginPath(); ctx.moveTo((i - st) * scaleX, 0); ctx.lineTo((i - st) * scaleX, rect.height); ctx.stroke(); 
    }
    
    currentMidi.tracks.forEach(t => {
        if (hiddenChannels.has(t.channel)) return; 
        ctx.fillStyle = channelColors[t.channel % 16];
        t.notes.forEach(n => { 
            if (n.ticks + n.durationTicks > st && n.ticks < st + windowTicks) {
                ctx.fillRect((n.ticks - st) * scaleX, rect.height - ((n.midi - minMidiNote + 2) * noteHeight), Math.max(n.durationTicks * scaleX, 2), Math.max(noteHeight - 1, 3)); 
            }
        });
    });
    
    let trk = getSystemTrack();
    if (trk) {
        [swellCC, 80, 81].forEach(cc => { 
            if (trk.controlChanges[cc]) {
                trk.controlChanges[cc].forEach(e => { 
                    if (e.ticks >= st && e.ticks <= st + windowTicks) { 
                        ctx.fillStyle = cc === swellCC ? '#9b59b6' : (cc === 81 ? '#2ecc71' : '#e74c3c'); 
                        ctx.fillRect(((e.ticks - st) * scaleX) - 2, cc === swellCC ? 16 : 0, 4, 12); 
                    } 
                }); 
            }
        });
    }
    
    ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 2; 
    ctx.beginPath(); ctx.moveTo((currentTick - st) * scaleX, 0); ctx.lineTo((currentTick - st) * scaleX, rect.height); ctx.stroke();
}

// ==========================================
// 11. EXPORT ENGINE (REVERTED & SORT-FIXED)
// ==========================================
window.exportMidi = function() { 
    if (!currentMidi) return; 
    
    songMetadata.modified = getTodayString();
    buildMetadataUI();

    let safeName = (songMetadata.title || "Export").replace(/[^a-z0-9\s]/gi, '').trim();
    currentMidi.header.name = safeName.substring(0, 32);
    currentMidi.name = safeName.substring(0, 32);

    const blockedCCs = [1, 7, 10, 91, 121]; 

    currentMidi.tracks.forEach(track => {
        track.channel = parseInt(track.channel) || 0;
        
        if (track.name && track.name.startsWith("W166_META")) {
            track.name = safeName.substring(0, 32);
        }

        blockedCCs.forEach(cc => {
            if (track.controlChanges[cc]) {
                delete track.controlChanges[cc];
            }
        });

        track.notes.sort((a, b) => a.ticks - b.ticks);
        
        for (let ccNum in track.controlChanges) {
            track.controlChanges[ccNum].sort((a, b) => a.ticks - b.ticks);
        }
    });

    try {
        const blob = new Blob([currentMidi.toArray()], { type: "audio/midi" }); 
        const a = document.createElement("a"); 
        a.href = URL.createObjectURL(blob); 
        
        let safeFilename = safeName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        a.download = safeFilename + "_mapped.mid"; 
        a.click(); 
    } catch (e) {
        alert("Export Encoding Error: " + e.message);
    }
};

// Start Up
fetchSoundfont(); 
createImportModal();
buildMetadataUI();
loadPreferences();
buildSettingsUI();
buildEditorUI();

// Bind transport controls to the global window
window.togglePlay = togglePlay;
window.stopPlayback = stopPlayback;
window.hardReset = hardReset;
window.openTab = openTab;
