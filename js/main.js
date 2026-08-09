// ==========================================
// 1. SOUNDFONT FETCH & AUDIO ENGINE STATE
// ==========================================
let audioCtx;
let isPlaying = false;
let startTimeMs = 0;
let startMidiSeconds = 0;
let scheduledNotes = new Set();
let synth;

async function initAudio() {

    if (!synth) {

        synth = new WebAudioTinySynth({
            quality: 1,
            useReverb: 1
        });

        audioCtx = synth.audioContext;

        document.getElementById('audio-status').innerText =
            "🔊 TinySynth Ready";
    }
}

async function togglePlay() {
    await initAudio();
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
    if (synth) {
        synth.stopAllChannels();
    }

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

function getActiveStopsForNote(channel, midiNote) {

    let activeStops = [];

    for (const [manual, stops] of Object.entries(organStructure)) {

        let match = manual.match(/Ch (\d+)/);

        if (!match) continue;

        let rawChannel = parseInt(match[1]) - 1;

        if (rawChannel !== channel) continue;

        // =====================================
        // NOTE RANGE SPLITTING
        // =====================================

        if (
            manual.includes("Bass") &&
            (midiNote < 36 || midiNote > 48)
        ) {
            continue;
        }

        if (
            manual.includes("Countermelody") &&
            (midiNote < 65 || midiNote > 96)
        ) {
            continue;
        }

        stops.forEach(s => {

            if (s.visible === false) return;

            let cb = document.getElementById(`stop-${s.val}`);

            if (cb && cb.checked) {
                activeStops.push(s);
            }

        });
    }

    return activeStops;
}

function getInstrumentForStop(stop) {
    if (
        tremulantActive &&
        stop.tremulantInstrument !== undefined &&
        stop.tremulantInstrument !== null
    ) {
        return stop.tremulantInstrument;
    }

    return stop.instrument || 0;
}

function scheduleNotePlay(note, channel, delaySeconds) {
    const activeStops = getActiveStopsForNote(channel, note.midi);

    setTimeout(() => {
        activeStops.forEach(stop => {
            const finalMidi = note.midi + (stop.octave || 0);

            const velocity = Math.min(
                127,
                Math.floor(
                    ((note.velocity || 1) * 127) *
                    (stop.volume || 1)
                )
            );

            const program = getInstrumentForStop(stop);

            synth.send([
                0xC0 + channel,
                program
            ]);

            synth.send([
                0x90 + channel,
                finalMidi,
                velocity
            ]);

            setTimeout(() => {
                synth.send([
                    0x80 + channel,
                    finalMidi,
                    0
                ]);
            }, note.duration * 1000);
        });
    }, delaySeconds * 1000);
}
// ==========================================
// TIME & DISPLAY ENGINE
// ==========================================
let timeDisplayFormat = 'ticks'; 

window.updateTimeFormat = function(format) {
    timeDisplayFormat = format;
    let lbl = "Tick";
    if (format === 'time') lbl = "Time";
    if (format === 'measures') lbl = "Meas";
    
    document.getElementById('time-label').innerText = lbl;
    document.getElementById('log-time-header').innerText = lbl;
    
    let currentTick = parseInt(document.getElementById('tick-slider').value) || 0;
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
    document.getElementById('current-tick').innerText = formatTimeDisplay(tickValue);
}

window.nudgeTicks = function(amount) { nudge(amount); };
window.nudgeBeats = function(amount) { nudge(amount * ppq); };

window.nudgeSeconds = function(amountSec) {
    if (!currentMidi || document.getElementById('tick-slider').disabled) return;
    let currentTick = parseInt(document.getElementById('tick-slider').value);
    let currentSec = currentMidi.header.ticksToSeconds(currentTick);
    let targetSec = Math.max(0, currentSec + amountSec);
    let targetTick = Math.round(currentMidi.header.secondsToTicks(targetSec));
    let diff = targetTick - currentTick;
    nudge(diff);
};

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

const channelColors = [
    '#e74c3c', '#2ecc71', '#f1c40f', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#34495e',
    '#ff9ff3', '#8e44ad', '#48dbfb', '#1dd1a1', '#f368e0', '#ff9f43', '#0abde3', '#10ac84'
];

const groupColors = { "Countermelody": "#3498db", "Accompaniment": "#2ecc71", "Trumpetmelody": "#d4ac0d", "Bass": "#e74c3c", "Expression": "#8e44ad", "Presets": "#f39c12" };

const DEFAULT_SWELL_CC = 4;
const DEFAULT_PERC_CC = 12;

const DEFAULT_ORGAN_STRUCTURE = {

    "Accompaniment (Ch 2)": [

        {
            val: 70,
            name: "Open Flute",
            visible: true,
            instrument: 70,
            octave: 0,
            volume: 1.0
        },

        {
            val: 18,
            name: "Stopped Flute",
            visible: true,
            instrument: 18,
            octave: 0,
            volume: 1.0
        },

        {
            val: 42,
            name: "Strings 8",
            visible: true,
            instrument: 42,
            octave: 0,
            volume: 1.0
        },

        {
            val: 41,
            name: "Strings 4",
            visible: true,
            instrument: 41,
            octave: 12,
            volume: 1.0
        },

        {
            val: 17,
            name: "Octave",
            visible: true,
            instrument: 17,
            octave: 12,
            volume: 1.0
        }
    ],

    "Trumpetmelody (Ch 3)": [

        {
            val: 56,
            name: "Wooden Trumpet",
            visible: true,
            instrument: 56,
            octave: 0,
            volume: 1.0
        },

        {
            val: 68,
            name: "Baritone",
            visible: true,
            instrument: 68,
            octave: 0,
            volume: 1.0
        },

        {
            val: 57,
            name: "Brass Trumpet",
            visible: true,
            instrument: 57,
            octave: 0,
            volume: 1.0
        },

        {
            val: 44,
            name: "Cello",
            visible: true,
            instrument: 44,
            octave: -12,
            volume: 1.0
        }
    ],

    "Countermelody (Ch 4)": [

        {
            val: 20,
            name: "Tibia",
            visible: true,
            instrument: 20,
            tremulantInstrument: 22,
            octave: 0,
            volume: 1.0
        },

        {
            val: 19,
            name: "Bourdon",
            visible: true,
            instrument: 19,
            tremulantInstrument: 21,
            octave: -12,
            volume: 1.0
        },

        {
            val: 82,
            name: "Soft Violin",
            visible: true,
            instrument: 82,
            octave: 0,
            volume: 1.0
        },

        {
            val: 40,
            name: "Forte Violin",
            visible: true,
            instrument: 40,
            octave: 0,
            volume: 1.0
        },

        {
            val: 72,
            name: "Clarinet",
            visible: true,
            instrument: 72,
            octave: 0,
            volume: 1.0
        },

        {
            val: 73,
            name: "Flute",
            visible: true,
            instrument: 73,
            tremulantInstrument: 77,
            octave: 0,
            volume: 1.0
        },

        {
            val: 49,
            name: "Undamaris",
            visible: true,
            instrument: 49,
            tremulantInstrument: 79,
            octave: 0,
            volume: 1.0
        },

        {
            val: 75,
            name: "Flageolet",
            visible: true,
            instrument: 75,
            tremulantInstrument: 78,
            octave: 12,
            volume: 1.0
        },

        {
            val: 74,
            name: "Piccolo",
            visible: true,
            instrument: 74,
            tremulantInstrument: 76,
            octave: 12,
            volume: 1.0
        },

        {
            val: 50,
            name: "Prestant",
            visible: true,
            instrument: 50,
            octave: 0,
            volume: 1.0
        },

        {
            val: 46,
            name: "Celeste",
            visible: true,
            instrument: 46,
            octave: 12,
            volume: 1.0
        },

        {
            val: 8,
            name: "Bells",
            visible: true,
            instrument: 8,
            octave: 24,
            volume: 1.0
        },

        {
            val: 9,
            name: "Unaphone",
            visible: true,
            instrument: 9,
            octave: 12,
            volume: 1.0
        },

               {
            val: 14,
            name: "Xylophone",
            visible: true,
            instrument: 14,
            octave: 0,
            volume: 1.0
        }
    ],

    "Bass (Ch 4)": [
        {
            val: 58,
            name: "Bass Flutes",
            visible: true,
            instrument: 58,
            octave: -12,
            volume: 1.0
        },

        {
            val: 43,
            name: "Trombone",
            visible: true,
            instrument: 43,
            octave: -12,
            volume: 1.0
        },

        {
            val: 62,
            name: "Tuba",
            visible: true,
            instrument: 62,
            octave: -12,
            volume: 1.0
        },

        {
            val: 59,
            name: "Diaphone",
            visible: true,
            instrument: 59,
            octave: -12,
            volume: 1.0
        }
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

let tremulantActive = false;

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
        tremulantActive = false;

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

function toggleDarkMode(isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    draw(); 
}

function toggleMidiVals(show) {
    if (show) document.body.classList.remove('hide-midi-vals');
    else document.body.classList.add('hide-midi-vals');
}

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
    return trk;
}

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
               <input type="number"
class="mapping-input"
style="width: 40px; padding: 2px;"
value="${s.val}"
onchange="updateMapping('${manual}', ${i}, 'val', this.value)"
title="MIDI CC">

<input type="text"
style="background:transparent; border:none; border-bottom:1px dashed var(--border-color); color:var(--text-color); font-size:0.8em; outline:none; text-decoration:${textDecor}; width: 120px;"
value="${s.name}"
onchange="updateMapping('${manual}', ${i}, 'name', this.value)">

<select
class="mapping-input"
style="width: 180px;"
onchange="updateMapping('${manual}', ${i}, 'instrument', this.value)"

>

<option value="0" ${s.instrument == 0 ? 'selected' : ''}>Acoustic Grand Piano</option>
<option value="1" ${s.instrument == 1 ? 'selected' : ''}>Bright Piano</option>
<option value="2" ${s.instrument == 2 ? 'selected' : ''}>Electric Grand Piano</option>
<option value="3" ${s.instrument == 3 ? 'selected' : ''}>Honky-tonk Piano</option>
<option value="4" ${s.instrument == 4 ? 'selected' : ''}>Electric Piano 1</option>
<option value="5" ${s.instrument == 5 ? 'selected' : ''}>Electric Piano 2</option>
<option value="6" ${s.instrument == 6 ? 'selected' : ''}>Harpsichord</option>
<option value="7" ${s.instrument == 7 ? 'selected' : ''}>Clavinet</option>

<option value="8" ${s.instrument == 8 ? 'selected' : ''}>Celesta</option>
<option value="9" ${s.instrument == 9 ? 'selected' : ''}>Glockenspiel</option>
<option value="10" ${s.instrument == 10 ? 'selected' : ''}>Music Box</option>
<option value="11" ${s.instrument == 11 ? 'selected' : ''}>Vibraphone</option>
<option value="12" ${s.instrument == 12 ? 'selected' : ''}>Marimba</option>
<option value="13" ${s.instrument == 13 ? 'selected' : ''}>Xylophone</option>
<option value="14" ${s.instrument == 14 ? 'selected' : ''}>Tubular Bells</option>
<option value="15" ${s.instrument == 15 ? 'selected' : ''}>Calliope</option>

<option value="16" ${s.instrument == 16 ? 'selected' : ''}>Drawbar Organ</option>
<option value="17" ${s.instrument == 17 ? 'selected' : ''}>Percussive Organ</option>
<option value="18" ${s.instrument == 18 ? 'selected' : ''}>Rock Organ</option>
<option value="19" ${s.instrument == 19 ? 'selected' : ''}>Church Organ</option>
<option value="20" ${s.instrument == 20 ? 'selected' : ''}>Reed Organ</option>
<option value="21" ${s.instrument == 21 ? 'selected' : ''}>Accordion</option>
<option value="22" ${s.instrument == 22 ? 'selected' : ''}>Harmonica</option>
<option value="23" ${s.instrument == 23 ? 'selected' : ''}>Bandoneon</option>

<option value="24" ${s.instrument == 24 ? 'selected' : ''}>Nylon Guitar</option>
<option value="25" ${s.instrument == 25 ? 'selected' : ''}>Steel Guitar</option>
<option value="26" ${s.instrument == 26 ? 'selected' : ''}>Jazz Guitar</option>
<option value="27" ${s.instrument == 27 ? 'selected' : ''}>Clean Guitar</option>
<option value="28" ${s.instrument == 28 ? 'selected' : ''}>Muted Guitar</option>
<option value="29" ${s.instrument == 29 ? 'selected' : ''}>Overdrive Guitar</option>
<option value="30" ${s.instrument == 30 ? 'selected' : ''}>Distortion Guitar</option>
<option value="31" ${s.instrument == 31 ? 'selected' : ''}>Guitar Harmonics</option>

<option value="32" ${s.instrument == 32 ? 'selected' : ''}>Acoustic Bass</option>
<option value="33" ${s.instrument == 33 ? 'selected' : ''}>Finger Bass</option>
<option value="34" ${s.instrument == 34 ? 'selected' : ''}>Picked Bass</option>
<option value="35" ${s.instrument == 35 ? 'selected' : ''}>Fretless Bass</option>
<option value="36" ${s.instrument == 36 ? 'selected' : ''}>Slap Bass 1</option>
<option value="37" ${s.instrument == 37 ? 'selected' : ''}>Slap Bass 2</option>
<option value="38" ${s.instrument == 38 ? 'selected' : ''}>Synth Bass 1</option>
<option value="39" ${s.instrument == 39 ? 'selected' : ''}>Synth Bass 2</option>

<option value="40" ${s.instrument == 40 ? 'selected' : ''}>Violin</option>
<option value="41" ${s.instrument == 41 ? 'selected' : ''}>Viola</option>
<option value="42" ${s.instrument == 42 ? 'selected' : ''}>Cello</option>
<option value="43" ${s.instrument == 43 ? 'selected' : ''}>Contrabass</option>
<option value="44" ${s.instrument == 44 ? 'selected' : ''}>Tremolo Strings</option>
<option value="45" ${s.instrument == 45 ? 'selected' : ''}>Pizzicato Strings</option>
<option value="46" ${s.instrument == 46 ? 'selected' : ''}>Orchestral Harp</option>
<option value="47" ${s.instrument == 47 ? 'selected' : ''}>Timpani</option>

<option value="48" ${s.instrument == 48 ? 'selected' : ''}>Strings Ensemble 1</option>
<option value="49" ${s.instrument == 49 ? 'selected' : ''}>Strings Ensemble 2</option>
<option value="50" ${s.instrument == 50 ? 'selected' : ''}>Synth Strings 1</option>
<option value="51" ${s.instrument == 51 ? 'selected' : ''}>Synth Strings 2</option>
<option value="52" ${s.instrument == 52 ? 'selected' : ''}>Choir Aahs</option>
<option value="53" ${s.instrument == 53 ? 'selected' : ''}>Voice Oohs</option>
<option value="54" ${s.instrument == 54 ? 'selected' : ''}>Synth Choir</option>
<option value="55" ${s.instrument == 55 ? 'selected' : ''}>Orchestra Hit</option>

<option value="56" ${s.instrument == 56 ? 'selected' : ''}>Trumpet</option>
<option value="57" ${s.instrument == 57 ? 'selected' : ''}>Trombone</option>
<option value="58" ${s.instrument == 58 ? 'selected' : ''}>Tuba</option>
<option value="59" ${s.instrument == 59 ? 'selected' : ''}>Muted Trumpet</option>
<option value="60" ${s.instrument == 60 ? 'selected' : ''}>French Horn</option>
<option value="61" ${s.instrument == 61 ? 'selected' : ''}>Brass Section</option>
<option value="62" ${s.instrument == 62 ? 'selected' : ''}>Synth Brass 1</option>
<option value="63" ${s.instrument == 63 ? 'selected' : ''}>Synth Brass 2</option>

<option value="64" ${s.instrument == 64 ? 'selected' : ''}>Soprano Sax</option>
<option value="65" ${s.instrument == 65 ? 'selected' : ''}>Alto Sax</option>
<option value="66" ${s.instrument == 66 ? 'selected' : ''}>Tenor Sax</option>
<option value="67" ${s.instrument == 67 ? 'selected' : ''}>Baritone Sax</option>
<option value="68" ${s.instrument == 68 ? 'selected' : ''}>Oboe</option>
<option value="69" ${s.instrument == 69 ? 'selected' : ''}>English Horn</option>
<option value="70" ${s.instrument == 70 ? 'selected' : ''}>Bassoon</option>
<option value="71" ${s.instrument == 71 ? 'selected' : ''}>Clarinet</option>

<option value="72" ${s.instrument == 72 ? 'selected' : ''}>Piccolo</option>
<option value="73" ${s.instrument == 73 ? 'selected' : ''}>Flute</option>
<option value="74" ${s.instrument == 74 ? 'selected' : ''}>Recorder</option>
<option value="75" ${s.instrument == 75 ? 'selected' : ''}>Pan Flute</option>
<option value="76" ${s.instrument == 76 ? 'selected' : ''}>Bottle Blow</option>
<option value="77" ${s.instrument == 77 ? 'selected' : ''}>Shakuhachi</option>
<option value="78" ${s.instrument == 78 ? 'selected' : ''}>Whistle</option>
<option value="79" ${s.instrument == 79 ? 'selected' : ''}>Ocarina</option>

<option value="80" ${s.instrument == 80 ? 'selected' : ''}>Lead Square</option>
<option value="81" ${s.instrument == 81 ? 'selected' : ''}>Lead Sawtooth</option>
<option value="82" ${s.instrument == 82 ? 'selected' : ''}>Lead Calliope</option>
<option value="83" ${s.instrument == 83 ? 'selected' : ''}>Lead Chiff</option>
<option value="84" ${s.instrument == 84 ? 'selected' : ''}>Lead Charang</option>
<option value="85" ${s.instrument == 85 ? 'selected' : ''}>Lead Voice</option>
<option value="86" ${s.instrument == 86 ? 'selected' : ''}>Lead Fifths</option>
<option value="87" ${s.instrument == 87 ? 'selected' : ''}>Lead Bass+Lead</option>

<option value="88" ${s.instrument == 88 ? 'selected' : ''}>Pad New Age</option>
<option value="89" ${s.instrument == 89 ? 'selected' : ''}>Pad Warm</option>
<option value="90" ${s.instrument == 90 ? 'selected' : ''}>Pad Polysynth</option>
<option value="91" ${s.instrument == 91 ? 'selected' : ''}>Pad Choir</option>
<option value="92" ${s.instrument == 92 ? 'selected' : ''}>Pad Bowed</option>
<option value="93" ${s.instrument == 93 ? 'selected' : ''}>Pad Metallic</option>
<option value="94" ${s.instrument == 94 ? 'selected' : ''}>Pad Halo</option>
<option value="95" ${s.instrument == 95 ? 'selected' : ''}>Pad Sweep</option>

<option value="96" ${s.instrument == 96 ? 'selected' : ''}>FX Rain</option>
<option value="97" ${s.instrument == 97 ? 'selected' : ''}>FX Soundtrack</option>
<option value="98" ${s.instrument == 98 ? 'selected' : ''}>FX Crystal</option>
<option value="99" ${s.instrument == 99 ? 'selected' : ''}>FX Atmosphere</option>
<option value="100" ${s.instrument == 100 ? 'selected' : ''}>FX Brightness</option>
<option value="101" ${s.instrument == 101 ? 'selected' : ''}>FX Goblins</option>
<option value="102" ${s.instrument == 102 ? 'selected' : ''}>FX Echoes</option>
<option value="103" ${s.instrument == 103 ? 'selected' : ''}>FX Sci-Fi</option>

<option value="104" ${s.instrument == 104 ? 'selected' : ''}>Sitar</option>
<option value="105" ${s.instrument == 105 ? 'selected' : ''}>Banjo</option>
<option value="106" ${s.instrument == 106 ? 'selected' : ''}>Shamisen</option>
<option value="107" ${s.instrument == 107 ? 'selected' : ''}>Koto</option>
<option value="108" ${s.instrument == 108 ? 'selected' : ''}>Kalimba</option>
<option value="109" ${s.instrument == 109 ? 'selected' : ''}>Bagpipe</option>
<option value="110" ${s.instrument == 110 ? 'selected' : ''}>Fiddle</option>
<option value="111" ${s.instrument == 111 ? 'selected' : ''}>Shanai</option>

<option value="112" ${s.instrument == 112 ? 'selected' : ''}>Tinkle Bell</option>
<option value="113" ${s.instrument == 113 ? 'selected' : ''}>Agogo</option>
<option value="114" ${s.instrument == 114 ? 'selected' : ''}>Steel Drums</option>
<option value="115" ${s.instrument == 115 ? 'selected' : ''}>Woodblock</option>
<option value="116" ${s.instrument == 116 ? 'selected' : ''}>Taiko Drum</option>
<option value="117" ${s.instrument == 117 ? 'selected' : ''}>Melodic Tom</option>
<option value="118" ${s.instrument == 118 ? 'selected' : ''}>Synth Drum</option>
<option value="119" ${s.instrument == 119 ? 'selected' : ''}>Reverse Cymbal</option>

<option value="120" ${s.instrument == 120 ? 'selected' : ''}>Guitar Fret Noise</option>
<option value="121" ${s.instrument == 121 ? 'selected' : ''}>Breath Noise</option>
<option value="122" ${s.instrument == 122 ? 'selected' : ''}>Seashore</option>
<option value="123" ${s.instrument == 123 ? 'selected' : ''}>Bird Tweet</option>
<option value="124" ${s.instrument == 124 ? 'selected' : ''}>Telephone Ring</option>
<option value="125" ${s.instrument == 125 ? 'selected' : ''}>Helicopter</option>
<option value="126" ${s.instrument == 126 ? 'selected' : ''}>Applause</option>
<option value="127" ${s.instrument == 127 ? 'selected' : ''}>Gunshot</option>

</select>

<input
type="number"
step="0.1"
min="0"
max="3"
class="mapping-input"
style="width: 60px;"
value="${s.volume || 1}"
onchange="updateMapping('${manual}', ${i}, 'volume', this.value)"
title="Volume"
>

<input
type="number"
class="mapping-input"
style="width: 60px;"
value="${s.octave || 0}"
onchange="updateMapping('${manual}', ${i}, 'octave', this.value)"
title="Octave"
>
            </div>`;
        });
        
        globalHtml += `<button class="nudge-btn" style="width:100%; margin-top:5px; font-size:0.8em; padding: 5px; background: rgba(52, 152, 219, 0.1); border: 1px dashed ${color}; color: ${color};" onclick="addRank('${manual}')">➕ Add Stop</button>`;
        globalHtml += `</div>`;
    }
    
    globalHtml += `<div style="border-left: 3px solid #8e44ad; padding-left: 8px; background: var(--manual-bg); border-radius: 4px; padding-right:8px; padding-bottom:10px;">
    <h4 style="margin: 5px 0; color: #8e44ad; font-size: 0.85em;">Expression & Percussion</h4>

    <div style="display:flex; align-items:center; gap:5px; margin-bottom:3px;">
        <input
            type="number"
            class="mapping-input"
            style="width:40px; padding:2px;"
            value="${swellCC}"
            onchange="updateExpMapping('swell', this.value)"
        >
        <span style="font-size:0.8em;">Swell</span>
    </div>

    <div style="display:flex; align-items:center; gap:5px; margin-bottom:3px;">
        <input
            type="number"
            class="mapping-input"
            style="width:40px; padding:2px;"
            value="${percCC}"
            onchange="updateExpMapping('perc', this.value)"
        >
        <span style="font-size:0.8em;">Percussion</span>
    </div>
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

window.updateMapping = function(manual, index, field, value) {

    if (field === 'val') {
        organStructure[manual][index][field] = parseInt(value);
    }

    else if (field === 'instrument') {
        organStructure[manual][index][field] = parseInt(value);
    }

    else if (field === 'octave') {
        organStructure[manual][index][field] = parseInt(value);
    }

    else if (field === 'volume') {
        organStructure[manual][index][field] = parseFloat(value);
    }

    else {
        organStructure[manual][index][field] = value;
    }

    buildSettingsUI();
    buildEditorUI();

    if(currentMidi) {
        syncSwitchesToTimeline(
            document.getElementById('tick-slider').value
        );

        renderLog();
    }
};

function buildEditorUI() {
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

   const expDiv = document.createElement('div');
expDiv.className = 'manual-group';
expDiv.style.borderLeftColor = "#8e44ad";

expDiv.innerHTML = `
    <h4 style="color: #8e44ad;">Expression & Percussion</h4>

    <div class="stop-grid">

        <div class="stop-row">
            <span
                class="stop-name"
                style="color: #8e44ad;"
            >
                Swell Shutters
                <span
                    class="midi-val"
                    style="color: #7f8c8d; font-weight: normal;"
                >
                    (CC ${swellCC})
                </span>
            </span>

            <label class="switch">
                <input
                    type="checkbox"
                    id="swell-switch"
                    onchange="handleSwellToggle(this.checked)"
                >
                <span class="slider-switch swell-bg"></span>
            </label>
        </div>

        <div class="stop-row">
            <span class="stop-name">
                Percussion Master
                <span
                    class="midi-val"
                    style="color: #7f8c8d; font-weight: normal;"
                >
                    (CC ${percCC})
                </span>
            </span>

            <label class="switch">
                <input
                    type="checkbox"
                    id="stop-${percCC}"
                    onchange="handleStopToggle(
                        ${percCC},
                        'Percussion Master',
                        'Perc',
                        this.checked
                    )"
                >
                <span class="slider-switch"></span>
            </label>
        </div>

      <div class="stop-row">
    <span
        class="stop-name"
        style="color: #8e44ad;"
    >
        Tremulant
    </span>

    <label class="switch">
        <input
            type="checkbox"
            id="tremulant-switch"
            onchange="handleTremulantToggle(this.checked)"
        >
        <span class="slider-switch swell-bg"></span>
    </label>
</div>

    </div>
`;

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
// 3. IMPORT INTERCEPTOR & ROUTING ENGINE
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

window.onload = () => { 
    createImportModal();
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

window.handleImportChoice = function(choice) {
    document.getElementById('import-modal').style.display = 'none';
    let sysTrack = getSystemTrack();

    if (choice === 'clear') {
        if (sysTrack) {
            currentMidi.tracks = currentMidi.tracks.filter(t => t !== sysTrack);
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
                        sysTrack.controlChanges[cc] = sysTrack.controlChanges[cc].filter(e => Math.round(e.value * 127) !== val);
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
                    sysTrack.controlChanges[cc] = sysTrack.controlChanges[cc].filter(e => Math.round(e.value * 127) !== val);
                }
            });
        });
    }
    document.getElementById('remap-modal').style.display = 'none';
    buildRoutingUI();
};

// ==========================================
// 4. NEW: PRE-EDITOR ROUTING ENGINE
// ==========================================
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
        
        routingHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--stop-row-bg); padding:12px; border-radius:5px; border-left: 5px solid ${color}; border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); border-right: 1px solid var(--border-color);">
            <span style="font-weight:bold; color: var(--text-color);">Incoming Channel ${ch + 1}${chNameExt}</span>
            <select id="route-ch-${ch}" class="mapping-input" style="width: 250px; cursor: pointer; font-size: 0.95em;">
                <option value="1" ${sel1}>Percussion (Out Ch 10 - Rhythm)</option>
                <option value="2" ${sel2}>Accompaniment (Out Ch 2)</option>
                <option value="3" ${sel3}>Trumpetmelody (Out Ch 3)</option>
                <option value="4-counter" ${sel4c}>Countermelody (Out Ch 4)</option>
                <option value="4-bass" ${sel4b}>Bass (Out Ch 4)</option>
                <option value="ignore">🗑️ Ignore / Mute Track</option>
            </select>
        </div>`;
    });

    document.getElementById('routing-list').innerHTML = routingHtml;
    document.getElementById('upload-panel').style.display = 'none';
    document.getElementById('routing-panel').style.display = 'block';
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

    // GENERAL MIDI (GM) DESCRIPTIVE INSTRUMENT MAP
    const targetMap = {
        "1": { ch: 9, name: "Percussion (Rhythm)", gm: 115 }, // 115 = Woodblock / Trap Drums, Ch 9 = MIDI Ch 10 Rhythm
        "2": { ch: 1, name: "Accompaniment", gm: 4 }, // 4 = Electric Piano 1
        "3": { ch: 2, name: "Trumpetmelody", gm: 56 }, // 56 = Trumpet
        "4-counter": { ch: 3, name: "Countermelody", gm: 0 }, // 0 = Acoustic Grand Piano
        "4-bass": { ch: 3, name: "Bass", gm: 32 } // 32 = Acoustic Bass
    };

    let tracksToRemove = [];
    currentMidi.tracks.forEach(t => {
        if (t.channel !== 15 && channelMap[t.channel] !== undefined) {
            let mapped = channelMap[t.channel];
            if (mapped === 'ignore') {
                tracksToRemove.push(t);
            } else if (targetMap[mapped]) {
                let dest = targetMap[mapped];
                
                // Update Track Logic
                t.channel = dest.ch;
                t.name = dest.name;
                
                // Inject General MIDI descriptives
                if (!t.instrument) t.instrument = {};
                t.instrument.number = dest.gm; 
                t.instrument.name = dest.name;
            }
        }
    });

    currentMidi.tracks = currentMidi.tracks.filter(t => !tracksToRemove.includes(t));
    
    finalizeImport();
};

function finalizeImport() {
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
    document.getElementById('zoom-slider').disabled = false; 
    
    updateDisplays(0);
    document.getElementById('export-btn').style.display = 'block'; 
    renderLog(); 
    syncSwitchesToTimeline(0); 
    openTab('page-editor', document.getElementById('tab-editor'));
}

window.addEventListener('resize', () => { if (currentMidi) draw(); });

document.getElementById('tick-slider').addEventListener('input', (e) => {
    const newTick = parseInt(e.target.value); 
    updateDisplays(newTick);
    syncSwitchesToTimeline(newTick); draw();
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(newTick); startTimeMs = performance.now(); }
});

document.getElementById('zoom-slider').addEventListener('input', (e) => { document.getElementById('zoom-level').innerText = e.target.value + 'x'; draw(); });

function nudge(amount) {
    const slider = document.getElementById('tick-slider'); if (slider.disabled) return;
    let newVal = Math.max(0, Math.min(parseInt(slider.max), parseInt(slider.value) + amount));
    slider.value = newVal; 
    updateDisplays(newVal);
    syncSwitchesToTimeline(newVal); draw();
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(newVal); startTimeMs = performance.now(); }
}

window.handleSwellToggle = function(isChecked) {
    if (isUpdatingSwitches) return;

    if (isChecked) {
        addEvent(swellCC, 127, 'Swell OPEN', 'Exp');
    } else {
        addEvent(swellCC, 64, 'Swell CLOSED', 'Exp');
    }
};

window.handleTremulantToggle = function(isChecked) {
    if (isUpdatingSwitches) return;

    tremulantActive = isChecked;

    // Stop currently sounding notes so the next notes
    // immediately use the correct Tremulant instrument.
    if (isPlaying) {
        killAllNotes();
    }
};

window.handleStopToggle = function(val, name, manual, isChecked) {
    if (isUpdatingSwitches) return;

    if (isChecked) {
        addEvent(81, val, `${name} ON`, manual);
    } else {
        addEvent(80, val, `${name} OFF`, manual);
    }
};

function renderLog() {
    const tbody = document.getElementById('log-body'); tbody.innerHTML = '';
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
            track.controlChanges[cc] = track.controlChanges[cc].filter(e => Math.abs(e.ticks - baseTick) > 40); 
        }
    });
    
    let currentOffset = 0; 
    
    if (p.swellState !== 0) {
        let swellVal = p.swellState === 1 ? 127 : 64;
        if (!track.controlChanges[swellCC]) track.controlChanges[swellCC] = [];
        track.controlChanges[swellCC].push({ ticks: baseTick + currentOffset, number: swellCC, value: swellVal / 127, time: currentMidi.header.ticksToSeconds(baseTick + currentOffset) });
        currentOffset++;
    }
    
    let activeOrganStops = Object.values(organStructure).flat().filter(s => s.visible !== false).map(s => s.val).concat([percCC]);
    
    activeOrganStops.forEach(val => {
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
    document.getElementById('tick-slider').value = syncTick; 
    updateDisplays(syncTick);
    renderLog(); syncSwitchesToTimeline(syncTick); draw(); 
    if (isPlaying) { killAllNotes(); startMidiSeconds = currentMidi.header.ticksToSeconds(syncTick); startTimeMs = performance.now(); }
};

function addEvent(cc, val, label, manual) {
    if (!currentMidi) return;

    let baseTick = parseInt(
        document.getElementById('tick-slider').value
    );

    let track = getOrCreateSystemTrack();

    const systemCCs = [
    swellCC,
    80,
    81
];

    systemCCs.forEach(checkCc => {

        if (!track.controlChanges[checkCc]) return;

        track.controlChanges[checkCc] =
            track.controlChanges[checkCc].filter(e => {

                const sameSwell =
                    cc === swellCC &&
                    checkCc === swellCC;

                const sameStopValue =
                    (cc === 80 || cc === 81) &&
                    (checkCc === 80 || checkCc === 81) &&
                    Math.round(e.value * 127) === val;

                return !(
    (sameSwell || sameStopValue) &&
    Math.abs(e.ticks - baseTick) <= 10
);
            });
    });

    if (!track.controlChanges[cc]) {
        track.controlChanges[cc] = [];
    }

    let safeTick = baseTick;

    while (
        track.controlChanges[cc].some(
            e => e.ticks === safeTick
        )
    ) {
        safeTick++;
    }

    track.controlChanges[cc].push({
        ticks: safeTick,
        number: cc,
        value: val / 127,
        time: currentMidi.header.ticksToSeconds(safeTick)
    });

    track.controlChanges[cc].sort(
        (a, b) => a.ticks - b.ticks
    );

    renderLog();
    draw();
}

window.removeEvent = function(cc, val, tick) {
    let track = getSystemTrack();
    if (track && track.controlChanges[cc]) track.controlChanges[cc] = track.controlChanges[cc].filter(e => !(e.ticks === tick && Math.round(e.value * 127) === val));
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
    let sw = document.getElementById('swell-switch');
if (sw) sw.checked = swellState;

let trem = document.getElementById('tremulant-switch');
if (trem) trem.checked = tremulantActive;

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
    let trk = getSystemTrack();
    if (trk) {
        [swellCC, 80, 81].forEach(cc => { if (trk.controlChanges[cc]) trk.controlChanges[cc].forEach(e => { if (e.ticks >= st && e.ticks <= st + windowTicks) { ctx.fillStyle = cc === swellCC ? '#9b59b6' : (cc === 81 ? '#2ecc71' : '#e74c3c'); ctx.fillRect(((e.ticks - st) * scaleX) - 2, cc === swellCC ? 16 : 0, 4, 12); } }); });
    }
    ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo((currentTick - st) * scaleX, 0); ctx.lineTo((currentTick - st) * scaleX, rect.height); ctx.stroke();
}

window.exportMidi = function() { 
    if (!currentMidi) return; 
    
    // Safety sync: Ensure Tone.js binds the notes to the newly updated track channels before compiling
    currentMidi.tracks.forEach(t => {
        t.notes.forEach(n => n.channel = t.channel);
        Object.values(t.controlChanges).flat().forEach(cc => cc.channel = t.channel);
    });

    const blob = new Blob([currentMidi.toArray()], { type: "audio/midi" }); 
    const a = document.createElement("a"); 
    a.href = URL.createObjectURL(blob); 
    a.download = fileName + "_FAIRO.mid"; 
    a.click(); 
};

// ==========================================
// 5. WINDOW BINDINGS FOR HTML INTERACTION
// ==========================================
window.togglePlay = togglePlay;
window.stopPlayback = stopPlayback;
window.toggleDarkMode = toggleDarkMode;
window.toggleMidiVals = toggleMidiVals;

buildSettingsUI(); buildEditorUI();
