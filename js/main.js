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

    // Audio Safety Check for orchestrion short notes
    let attack = 0.02;
    let release = 0.02;
    if (note.duration < 0.04) {
        attack = note.duration / 2;
        release = note.duration / 2;
    }
    
    activeStops.forEach(stop => {
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        // Instrument Texture Mapping
        if ([8, 10, 11].includes(stop.val)) osc.type = 'sine'; 
        else if ([19, 20, 73, 75, 70, 58].includes(stop.val)) osc.type = 'triangle';
        else if ([40, 82, 68, 48, 50].includes(stop.val)) osc.type = 'sawtooth';
        else if ([56, 57, 71].includes(stop.val)) osc.type = 'square';
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

let swellCC = 11;
let percCC = 10;

const channelColors = [
    '#e74c3c', '#2ecc71', '#f1c40f', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#34495e',
    '#ff9ff3', '#8e44ad', '#48dbfb', '#1dd1a1', '#f368e0', '#ff9f43', '#0abde3', '#10ac84'
];

const groupColors = { "Countermelody": "#3498db", "Accompaniment": "#2ecc71", "Trumpetmelody": "#d4ac0d", "Bass": "#e74c3c", "Expression": "#8e44ad", "Presets": "#f39c12" };

let organStructure = {
    "Countermelody (Ch 2)": [ 
        { val: 8, name: "Glockenspiel" }, 
        { val: 10, name: "Unaphone" }, 
        { val: 19, name: "Prestant" }, 
        { val: 20, name: "Undamaris" }, 
        { val: 71, name: "Clarinet" }, 
        { val: 40, name: "Forte Violin" }, 
        { val: 73, name: "Flute" }, 
        { val: 75, name: "Flageolet" }, 
        { val: 82, name: "Soft Violin" } 
    ],
    "Trumpetmelody (Ch 1)": [ 
        { val: 68, name: "Viola Bassoon" }, 
        { val: 56, name: "Wooden Trumpet" }, 
        { val: 57, name: "Brass Trumpet" } 
    ],
    "Accompaniment (Ch 3)": [ 
        { val: 70, name: "Open Flute" }, 
        { val: 48, name: "Strings" }, 
        { val: 11, name: "Stopped Flute" } 
    ],
    "Bass (Ch 4)": [ 
        { val: 57, name: "Wooden Trombone" }, 
        { val: 50, name: "Brass Trombone" }, 
        { val: 58, name: "Bass Flute" }
    ]
};

let pistons = [
    { name: "Pianissimo", activeStops: [19, 82, 73, 75, 11, 70, 68, 58], swell: 127 },
    { name: "Forte", activeStops: [8, 19, 40, 82, 73, 75, 11, 70, 48, 68, 56, 58, 57], swell: 127 },
    { name: "Piston Default 1", activeStops: [19, 40, 10, 70, 48, 70, 11, 68, 57, 58, 50], swell: 127 }, 
    { name: "Piston Default 2", activeStops: [8, 19, 75, 82, 58, 70, 11, 68, 58 ], swell: 64 },
    { name: "Piston Default 3", activeStops: [19, 82, 40, 58, 50, 57, 70, 11, 48, 56, 68, 57], swell: 127 }, 
    { name: "Piston Default 4", activeStops: [], swell: 64 },
    { name: "General Cancel", activeStops: [], swell: 64 } 
];

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
// DISCORD-STYLE SETTINGS ENGINE
// ==========================================
let activeSettingsTab = 'ranks';

function buildSettingsUI() {
    const container = document.getElementById('settings-mapping-container');
    let html = `<div class="discord-settings-layout">
        <div class="discord-sidebar">
            <div class="discord-sidebar-header">Global Settings</div>
            <div class="discord-sidebar-item ${activeSettingsTab === 'ranks' ? 'active' : ''}" onclick="openSettingsTab('ranks')">Organ Ranks & Names</div>
            <div class="discord-sidebar-header">Pistons</div>`;
    
    pistons.forEach((p, i) => {
        html += `<div class="discord-sidebar-item ${activeSettingsTab === 'piston-'+i ? 'active' : ''}" onclick="openSettingsTab('piston-${i}')">🔘 ${p.name}</div>`;
    });
    
    html += `</div>
        <div class="discord-main">
            <div class="discord-content" id="settings-content-area"></div>
        </div>
    </div>`;
    
    container.innerHTML = html;
    renderSettingsContent();
}

function openSettingsTab(tabId) {
    activeSettingsTab = tabId;
    buildSettingsUI(); 
}

function renderSettingsContent() {
    const area = document.getElementById('settings-content-area');
    
    if (activeSettingsTab === 'ranks') {
        let content = `<h3 style="border-bottom:none; margin-bottom: 20px;">Rank Dictionary & MIDI CCs</h3>
        <div class="settings-grid">`;
        
        for (const [manual, stops] of Object.entries(organStructure)) {
            content += `<div><h4 style="color: ${groupColors[manual.split(' ')[0]] || '#3498db'};">${manual.split(' ')[0]}</h4>`;
            stops.forEach((s, i) => {
                 content += `<div class="rank-input-group">
                    <div style="display:flex; justify-content: space-between; align-items:center;">
                        <span style="font-size:0.8em; color:#7f8c8d; font-weight:bold;">MIDI CC:</span>
                        <input type="number" class="mapping-input" value="${s.val}" onchange="updateMapping('${manual}', ${i}, 'val', this.value)">
                    </div>
                    <input type="text" class="rank-input-name" value="${s.name}" onchange="updateMapping('${manual}', ${i}, 'name', this.value)" title="Rename this rank">
                 </div>`;
            });
            content += `</div>`;
        }
        
        // Expression CC Configuration
        content += `<div><h4 style="color: #8e44ad;">Expression & Percussion</h4>
            <div class="rank-input-group">
                <div style="display:flex; justify-content: space-between; align-items:center;">
                    <span style="font-size:0.8em; color:#7f8c8d; font-weight:bold;">Swell CC:</span>
                    <input type="number" class="mapping-input" value="${swellCC}" onchange="updateExpMapping('swell', this.value)">
                </div>
            </div>
            <div class="rank-input-group">
                <div style="display:flex; justify-content: space-between; align-items:center;">
                    <span style="font-size:0.8em; color:#7f8c8d; font-weight:bold;">Percussion CC:</span>
                    <input type="number" class="mapping-input" value="${percCC}" onchange="updateExpMapping('perc', this.value)">
                </div>
            </div>
        </div></div>`;
        
        area.innerHTML = content;
        
    } else if (activeSettingsTab.startsWith('piston-')) {
        let pIndex = parseInt(activeSettingsTab.split('-')[1]);
        let p = pistons[pIndex];
        
        let content = `
        <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom: 20px;">
            <h3 style="margin:0; border:none;">Piston Configuration</h3>
            <input type="text" class="mapping-input" style="width:250px; font-size:1em; text-align:left; padding:8px;" value="${p.name}" onchange="pistons[${pIndex}].name = this.value; buildSettingsUI();" title="Rename Piston">
        </div>
        
        <h4 style="margin-top:10px; border-bottom: 1px solid var(--border-color); padding-bottom:5px;">Active Stops for this Piston</h4>
        <div class="settings-grid">`;

        for (const [manual, stops] of Object.entries(organStructure)) {
             content += `<div><h4 style="color: ${groupColors[manual.split(' ')[0]] || '#3498db'};">${manual.split(' ')[0]}</h4>`;
             stops.forEach(s => {
                 let isChecked = p.activeStops.includes(s.val) ? "checked" : "";
                 content += `<div class="settings-row" style="padding: 6px 10px;">
                    <span style="font-size: 0.85em;">${s.name}</span>
                    <label class="switch">
                        <input type="checkbox" ${isChecked} onchange="togglePistonStop(${pIndex}, ${s.val}, this.checked)">
                        <span class="slider-switch piston-switch-bg"></span>
                    </label>
                 </div>`;
             });
             content += `</div>`;
        }
        
        content += `<div><h4 style="color: #8e44ad;">Expression Settings</h4>
             <div class="settings-row" style="padding: 6px 10px;">
                <span style="font-size: 0.85em;">Swell Shutters Open</span>
                <label class="switch">
                    <input type="checkbox" ${p.swell >= 127 ? "checked" : ""} onchange="pistons[${pIndex}].swell = this.checked ? 127 : 64">
                    <span class="slider-switch swell-bg"></span>
                </label>
             </div>
        </div></div>`;

        area.innerHTML = content + `</div>
        <div class="discord-save-bar">
            <span style="font-size: 0.9em;">Careful — you have unsaved changes! Configure your stops above.</span>
            <button class="discord-save-btn" onclick="commitPistonChanges()">Commit Changes</button>
        </div>`;
    }
}

function updateMapping(manualKey, index, type, newVal) {
    if (type === 'val') organStructure[manualKey][index].val = parseInt(newVal);
    if (type === 'name') organStructure[manualKey][index].name = newVal;
    buildEditorUI();
    if(currentMidi) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
}

function updateExpMapping(type, newVal) {
    if (type === 'swell') swellCC = parseInt(newVal);
    if (type === 'perc') percCC = parseInt(newVal);
    buildEditorUI();
    if(currentMidi) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
}

function togglePistonStop(pIndex, stopVal, isChecked) {
     let p = pistons[pIndex];
     if (isChecked) {
         if (!p.activeStops.includes(stopVal)) p.activeStops.push(stopVal);
     } else {
         p.activeStops = p.activeStops.filter(v => v !== stopVal);
     }
}

function commitPistonChanges() {
    buildEditorUI(); 
    alert("✅ Piston Changes Committed! Check the Dashboard.");
}

function buildEditorUI() {
    document.getElementById('col-countermelody').innerHTML = '';
    document.getElementById('col-accomp-trumpet').innerHTML = '';
    document.getElementById('col-bass-exp').innerHTML = '';
    document.getElementById('col-pistons').innerHTML = '';

    for (const [manual, stops] of Object.entries(organStructure)) {
        let shortMan = manual.split(' ')[0]; let color = groupColors[shortMan] || "#3498db";
        const groupDiv = document.createElement('div'); groupDiv.className = 'manual-group'; groupDiv.style.borderLeftColor = color;
        groupDiv.innerHTML = `<h4 style="color: ${color};">${shortMan} <span class="midi-val" style="color: var(--text-color); font-weight: normal; font-size: 0.8em;">${manual.replace(shortMan, '').trim()}</span></h4><div class="stop-grid"></div>`;
        const grid = groupDiv.querySelector('.stop-grid');
        stops.forEach(s => {
            grid.innerHTML += `<div class="stop-row"><span class="stop-name">${s.name} <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(${s.val})</span></span><label class="switch"><input type="checkbox" id="stop-${s.val}" onchange="handleStopToggle(${s.val}, '${s.name}', '${shortMan}', this.checked)"><span class="slider-switch"></span></label></div>`;
        });
        if (shortMan === "Countermelody") document.getElementById('col-countermelody').appendChild(groupDiv);
        else if (shortMan === "Accompaniment" || shortMan === "Trumpetmelody") document.getElementById('col-accomp-trumpet').appendChild(groupDiv);
        else if (shortMan === "Bass") document.getElementById('col-bass-exp').appendChild(groupDiv);
    }

    const expDiv = document.createElement('div'); expDiv.className = 'manual-group'; expDiv.style.borderLeftColor = "#8e44ad";
    expDiv.innerHTML = `<h4 style="color: #8e44ad;">Expression</h4><div class="stop-grid"><div class="stop-row"><span class="stop-name" style="color: #8e44ad;">Swell Shutters</span><label class="switch"><input type="checkbox" id="swell-switch" onchange="handleSwellToggle(this.checked)"><span class="slider-switch swell-bg"></span></label></div><div class="stop-row"><span class="stop-name">Percussion</span><label class="switch"><input type="checkbox" id="stop-${percCC}" onchange="handleStopToggle(${percCC}, 'Percussion', 'Perc', this.checked)"><span class="slider-switch"></span></label></div></div>`;
    document.getElementById('col-bass-exp').appendChild(expDiv);

    let pistonsHtml = `<div class="manual-group" style="border-left-color: #f39c12;"><h4 style="color: #f39c12;">Saved Pistons</h4><div class="stop-grid">`;
    pistons.forEach((p, i) => {
        pistonsHtml += `<div class="stop-row"><span class="stop-name" style="color:#e67e22">${p.name}</span><label class="switch"><input type="checkbox" onchange="if(this.checked) { applyRegistrationState(pistons[${i}].activeStops, pistons[${i}].swell); setTimeout(()=>this.checked=false, 500); }"><span class="slider-switch piston-switch-bg"></span></label></div>`;
    });
    document.getElementById('col-pistons').innerHTML = pistonsHtml + `</div></div>`;
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

function applyRegistrationState(activeStopsArr, swellVal) {
    if (!currentMidi) return alert("Please load a MIDI file first!");
    let baseTick = parseInt(document.getElementById('tick-slider').value);
    let track = currentMidi.tracks.find(t => t.channel === 15) || currentMidi.addTrack();
    track.channel = 15;
    [swellCC, 80, 81].forEach(cc => { if (track.controlChanges[cc]) track.controlChanges[cc] = track.controlChanges[cc].filter(e => { if (!window.pistonsAffectPercussion && (cc === 80 || cc === 81)) if (Math.round(e.value * 127) === percCC) return true; return Math.abs(e.ticks - baseTick) > 40; }); });
    let currentOffset = 0; 
    if (!track.controlChanges[swellCC]) track.controlChanges[swellCC] = [];
    track.controlChanges[swellCC].push({ ticks: baseTick + currentOffset, number: swellCC, value: swellVal / 127, time: currentMidi.header.ticksToSeconds(baseTick + currentOffset) });
    currentOffset++;
    Object.values(organStructure).flat().map(s => s.val).concat([percCC]).forEach(val => {
        if (!window.pistonsAffectPercussion && val === percCC) return;
        let targetCC = activeStopsArr.includes(val) ? 81 : 80;
        if (!track.controlChanges[targetCC]) track.controlChanges[targetCC] = [];
        track.controlChanges[targetCC].push({ ticks: baseTick + currentOffset, number: targetCC, value: val / 127, time: currentMidi.header.ticksToSeconds(baseTick + currentOffset) });
        currentOffset++;
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
    Object.values(organStructure).flat().forEach(s => { let cb = document.getElementById(`stop-${s.val}`); if (cb) cb.checked = !!stopStates[s.val]; });
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
window.openSettingsTab = openSettingsTab; window.togglePistonStop = togglePistonStop; window.commitPistonChanges = commitPistonChanges;
