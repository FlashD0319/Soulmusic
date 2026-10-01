"use strict";

const $ = (id) => document.getElementById(id);

// ---------- 常量 ----------
const EQ_DEFS = [
  { type: "lowshelf", freq: 100, q: 0.7 },
  { type: "peaking", freq: 500, q: 1.0 },
  { type: "peaking", freq: 2000, q: 1.0 },
  { type: "highshelf", freq: 10000, q: 0.7 },
];

const REVERB_PRESETS = {
  smallRoom: { size: 0.4, decay: 1.6 },
  largeRoom: { size: 0.9, decay: 2.0 },
  largeHall: { size: 1.8, decay: 2.6 },
  cathedral: { size: 3.0, decay: 3.2 },
};

const DB_NAME = "vocalcoach";
const DB_STORE = "projects";

// ---------- 参数状态（旋钮 / 推子唯一数据源） ----------
const PARAMS = {
  vocalVol: 0,
  backingVol: 0,
  eq0g: 0, eq0f: 100,
  eq1g: 0, eq1f: 500, eq1q: 1,
  eq2g: 0, eq2f: 2000, eq2q: 1,
  eq3g: 0, eq3f: 10000,
  mix: 30, preDelay: 20, size: 1.8, decay: 2.6,
};

// ---------- 音频引擎状态 ----------
let ctx = null;
let micStream = null;
let micSource = null;
let recorderNode = null;
let recorderMute = null;
let monChain = null;
let playChain = null;
let backingGain = null;
let masterInput = null;
let masterLimiter = null;
let micAnalyser = null;
let meterData = null;

// ---------- 传输状态 ----------
let transportPlaying = false;
let transportStartOffset = 0;
let transportStartCtxTime = 0;
let backingSources = [];
let vocalSources = [];

// ---------- 伴奏 ----------
let backingBuffer = null;
let backingName = "";
let backingFile = null;
let backingMono = null;
let backingSampleRate = 48000;

// ---------- 录音 / 人声 ----------
let monitorOn = true;
let recording = false;
let recChunks = [];
let recSampleRate = 48000;
let recSongStart = 0;
let recTakeStart = 0;
let vocalBuffer = null;
let vocalSampleRate = 48000;
let vocalDuration = 0;
let vocalAudioBuffer = null;

// ---------- 裁剪 / 时间轴 ----------
let trimStart = 0;
let trimEnd = 0;
let backingPeaks = new Float32Array(0);
let vocalPeaks = new Float32Array(0);
let dragMode = null;
let scrubTime = 0;
let channelMode = "mono"; // "mono" | "stereo"
let loopOn = false;
let undoStack = [];

// 两条轨道共享同一视图窗口，保证唱针（播放头）同步
const DEFAULT_VIEW_SEC = 300; // 默认窗口 5 分钟
const view = { start: 0, dur: DEFAULT_VIEW_SEC, follow: true };
const peakCache = { backing: null, vocal: null };

let irTimer = null;
let decodeCtx = null;
let knobRegistry = {};
let faderRegistry = {};

// ---------- 工具 ----------
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lin(db) {
  return Math.pow(10, db / 20);
}

function showError(msg) {
  const el = $("err");
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function currentEnd() {
  const vocalEnd = recSongStart + vocalDuration;
  const backingDur = backingBuffer ? backingBuffer.duration : 0;
  let end = Math.max(vocalEnd, backingDur, 1);
  if (recording && ctx) end = Math.max(end, getPosition() + 0.001);
  return end;
}

function getPosition() {
  if (transportPlaying && ctx) {
    return transportStartOffset + (ctx.currentTime - transportStartCtxTime);
  }
  return transportStartOffset;
}

function fracFromValue(v, cfg) {
  if (cfg.curve === "log") {
    return Math.log(v / cfg.min) / Math.log(cfg.max / cfg.min);
  }
  return (v - cfg.min) / (cfg.max - cfg.min);
}

function knobValueFromFrac(f, cfg) {
  f = clamp(f, 0, 1);
  if (cfg.curve === "log") {
    return cfg.min * Math.pow(cfg.max / cfg.min, f);
  }
  return cfg.min + f * (cfg.max - cfg.min);
}

// ---------- 旋钮 / 推子定义 ----------
const KNOBS = [
  { key: "eq0g", label: "增益", dflt: 0, min: -12, max: 12, step: 0.5, curve: "lin", fmt: (v) => v.toFixed(1) + " dB", onChange: applyEQ },
  { key: "eq0f", label: "频率", dflt: 100, min: 20, max: 200, step: 0, curve: "log", fmt: (v) => v.toFixed(0) + " Hz", onChange: applyEQ },
  { key: "eq1g", label: "增益", dflt: 0, min: -12, max: 12, step: 0.5, curve: "lin", fmt: (v) => v.toFixed(1) + " dB", onChange: applyEQ },
  { key: "eq1f", label: "频率", dflt: 500, min: 200, max: 2000, step: 0, curve: "log", fmt: (v) => v.toFixed(0) + " Hz", onChange: applyEQ },
  { key: "eq1q", label: "Q 值", dflt: 1, min: 0.1, max: 12, step: 0.1, curve: "log", fmt: (v) => v.toFixed(2), onChange: applyEQ },
  { key: "eq2g", label: "增益", dflt: 0, min: -12, max: 12, step: 0.5, curve: "lin", fmt: (v) => v.toFixed(1) + " dB", onChange: applyEQ },
  { key: "eq2f", label: "频率", dflt: 2000, min: 1000, max: 8000, step: 0, curve: "log", fmt: (v) => v.toFixed(0) + " Hz", onChange: applyEQ },
  { key: "eq2q", label: "Q 值", dflt: 1, min: 0.1, max: 12, step: 0.1, curve: "log", fmt: (v) => v.toFixed(2), onChange: applyEQ },
  { key: "eq3g", label: "增益", dflt: 0, min: -12, max: 12, step: 0.5, curve: "lin", fmt: (v) => v.toFixed(1) + " dB", onChange: applyEQ },
  { key: "eq3f", label: "频率", dflt: 10000, min: 8000, max: 20000, step: 0, curve: "log", fmt: (v) => v.toFixed(0) + " Hz", onChange: applyEQ },
  { key: "mix", label: "干湿比", dflt: 30, min: 0, max: 100, step: 1, curve: "lin", fmt: (v) => v.toFixed(0) + " %", onChange: applyMix },
  { key: "preDelay", label: "预延迟", dflt: 20, min: 0, max: 200, step: 5, curve: "lin", fmt: (v) => v.toFixed(0) + " ms", onChange: applyPreDelay },
  { key: "size", label: "房间大小", dflt: 1.8, min: 0.1, max: 6, step: 0.1, curve: "lin", fmt: (v) => v.toFixed(1) + " s", onChange: scheduleIR },
  { key: "decay", label: "衰减", dflt: 2.6, min: 0.5, max: 8, step: 0.1, curve: "lin", fmt: (v) => v.toFixed(1), onChange: scheduleIR },
];

const FADERS = [
  { key: "vocalVol", label: "人声", dflt: 0, min: -24, max: 12, step: 0.5, fmt: (v) => v.toFixed(1) + " dB", onChange: applyMix },
  { key: "backingVol", label: "伴奏", dflt: 0, min: -24, max: 12, step: 0.5, fmt: (v) => v.toFixed(1) + " dB", onChange: applyMix },
];
// ---------- 旋钮组件 ----------
function tickMarkup() {
  let s = "";
  const n = 25;
  for (let i = 0; i <= n; i++) {
    const ang = ((-135 + (i / n) * 270) * Math.PI) / 180;
    const r1 = 17.5;
    const r2 = (i === 0 || i === n) ? 15 : 16.2;
    s += "<line x1='" + (Math.cos(ang) * r1).toFixed(2) + "' y1='" + (Math.sin(ang) * r1).toFixed(2) +
      "' x2='" + (Math.cos(ang) * r2).toFixed(2) + "' y2='" + (Math.sin(ang) * r2).toFixed(2) + "'/>";
  }
  return s;
}

function setKnob(k, value, fire) {
  const cfg = k.def;
  value = clamp(value, cfg.min, cfg.max);
  if (cfg.step) value = Math.round(value / cfg.step) * cfg.step;
  PARAMS[cfg.key] = value;
  const f = fracFromValue(value, cfg);
  k.pointer.setAttribute("transform", "rotate(" + (-135 + f * 270) + ")");
  k.valueEl.textContent = cfg.fmt ? cfg.fmt(value) : value.toFixed(2);
  if (fire !== false && cfg.onChange) cfg.onChange();
}

function createKnob(def) {
  const root = document.createElement("div");
  root.className = "knob";
  root.tabIndex = 0;
  root.setAttribute("role", "slider");
  root.setAttribute("aria-label", def.label);
  root.innerHTML =
    "<div class='knob-dial'><svg class='knob-svg' viewBox='-26 -26 52 52'>" +
    "<circle class='knob-rim' r='23'/>" +
    "<circle class='knob-face' r='20'/>" +
    "<g class='knob-ticks'>" + tickMarkup() + "</g>" +
    "<line class='knob-pointer' x1='0' y1='2' x2='0' y2='-18'/>" +
    "</svg></div>" +
    "<div class='knob-label'>" + def.label + "</div>" +
    "<div class='knob-value'>-</div>";

  const k = {
    root: root,
    def: def,
    pointer: root.querySelector(".knob-pointer"),
    valueEl: root.querySelector(".knob-value"),
    drag: null,
  };

  root.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pushUndo();
    k.drag = { startY: e.clientY, startFrac: fracFromValue(PARAMS[def.key], def) };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", (e) => {
    if (!k.drag) return;
    const dy = k.drag.startY - e.clientY;
    const f = clamp(k.drag.startFrac + dy / 160, 0, 1);
    setKnob(k, knobValueFromFrac(f, def));
  });
  const endDrag = () => { k.drag = null; };
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", endDrag);
  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    pushUndo();
    const dir = e.deltaY < 0 ? 1 : -1;
    let v;
    if (def.curve === "log") {
      const f = clamp(fracFromValue(PARAMS[def.key], def) + dir * 0.03, 0, 1);
      v = knobValueFromFrac(f, def);
    } else {
      v = PARAMS[def.key] + dir * (def.step || 1);
    }
    setKnob(k, v);
  }, { passive: false });
  root.addEventListener("dblclick", () => { pushUndo(); setKnob(k, def.dflt); });
  root.addEventListener("keydown", (e) => {
    const dir = (e.key === "ArrowUp" || e.key === "ArrowRight") ? 1 :
      (e.key === "ArrowDown" || e.key === "ArrowLeft") ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    pushUndo();
    let v;
    if (def.curve === "log") {
      const f = clamp(fracFromValue(PARAMS[def.key], def) + dir * 0.03, 0, 1);
      v = knobValueFromFrac(f, def);
    } else {
      v = PARAMS[def.key] + dir * (def.step || 1);
    }
    setKnob(k, v);
  });

  knobRegistry[def.key] = k;
  setKnob(k, PARAMS[def.key], false);
  return root;
}

function refreshKnobUI(key) {
  const k = knobRegistry[key];
  if (k) setKnob(k, PARAMS[key], false);
}

function refreshAllUI() {
  for (const key in knobRegistry) refreshKnobUI(key);
  for (const key in faderRegistry) {
    const f = faderRegistry[key];
    setFader(f, PARAMS[key], false);
  }
}

// ---------- 推子组件 ----------
function setFader(f, value, fire) {
  const cfg = f.def;
  value = clamp(value, cfg.min, cfg.max);
  if (cfg.step) value = Math.round(value / cfg.step) * cfg.step;
  PARAMS[cfg.key] = value;
  const frac = (value - cfg.min) / (cfg.max - cfg.min);
  f.fill.style.height = (frac * 100) + "%";
  f.thumb.style.bottom = (frac * 100) + "%";
  f.valueEl.textContent = cfg.fmt ? cfg.fmt(value) : value.toFixed(2);
  if (fire !== false && cfg.onChange) cfg.onChange();
}

function createFader(def) {
  const root = document.createElement("div");
  root.className = "fader";
  root.tabIndex = 0;
  root.setAttribute("role", "slider");
  root.setAttribute("aria-label", def.label);
  root.innerHTML =
    "<div class='fader-track'><div class='fader-fill'></div><div class='fader-thumb'></div></div>" +
    "<div class='fader-label'>" + def.label + "</div>" +
    "<div class='fader-value'>-</div>";

  const f = {
    root: root,
    def: def,
    track: root.querySelector(".fader-track"),
    fill: root.querySelector(".fader-fill"),
    thumb: root.querySelector(".fader-thumb"),
    valueEl: root.querySelector(".fader-value"),
    drag: false,
  };

  const fracFromEvent = (e) => {
    const rect = f.track.getBoundingClientRect();
    return 1 - clamp((e.clientY - rect.top) / rect.height, 0, 1);
  };
  const setFromEvent = (e) => {
    const frac = fracFromEvent(e);
    setFader(f, def.min + frac * (def.max - def.min));
  };

  root.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pushUndo();
    f.drag = true;
    root.setPointerCapture(e.pointerId);
    setFromEvent(e);
  });
  root.addEventListener("pointermove", (e) => {
    if (!f.drag) return;
    setFromEvent(e);
  });
  const endDrag = () => { f.drag = false; };
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", endDrag);
  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    pushUndo();
    const dir = e.deltaY < 0 ? 1 : -1;
    setFader(f, PARAMS[def.key] + dir * (def.step || 1));
  }, { passive: false });
  root.addEventListener("dblclick", () => { pushUndo(); setFader(f, def.dflt); });
  root.addEventListener("keydown", (e) => {
    const dir = (e.key === "ArrowUp" || e.key === "ArrowRight") ? 1 :
      (e.key === "ArrowDown" || e.key === "ArrowLeft") ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    pushUndo();
    setFader(f, PARAMS[def.key] + dir * (def.step || 1));
  });

  faderRegistry[def.key] = f;
  setFader(f, PARAMS[def.key], false);
  return root;
}
// ---------- 渲染旋钮 / 推子 ----------
function renderKnobs() {
  const byKey = {};
  KNOBS.forEach((k) => { byKey[k.key] = k; });

  const eqHost = $("eqKnobs");
  const bands = [
    { t: "低频 · 低架", keys: ["eq0g", "eq0f"] },
    { t: "中低频 · 峰", keys: ["eq1g", "eq1f", "eq1q"] },
    { t: "中高频 · 峰", keys: ["eq2g", "eq2f", "eq2q"] },
    { t: "高频 · 高架", keys: ["eq3g", "eq3f"] },
  ];
  bands.forEach((b) => {
    const band = document.createElement("div");
    band.className = "band";
    const title = document.createElement("div");
    title.className = "band-title";
    title.textContent = b.t;
    const row = document.createElement("div");
    row.className = "knob-row";
    b.keys.forEach((key) => row.appendChild(createKnob(byKey[key])));
    band.appendChild(title);
    band.appendChild(row);
    eqHost.appendChild(band);
  });

  const rvHost = $("reverbKnobs");
  const presetRow = document.createElement("div");
  presetRow.className = "preset-row";
  const plabel = document.createElement("span");
  plabel.className = "preset-label";
  plabel.textContent = "预设";
  const sel = document.createElement("select");
  sel.id = "selPreset";
  const presetNames = { smallRoom: "小房间", largeRoom: "大房间", largeHall: "大厅", cathedral: "教堂" };
  for (const key in REVERB_PRESETS) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = presetNames[key] || key;
    if (key === "largeHall") o.selected = true;
    sel.appendChild(o);
  }
  presetRow.appendChild(plabel);
  presetRow.appendChild(sel);
  rvHost.appendChild(presetRow);
  const rrow = document.createElement("div");
  rrow.className = "knob-row";
  ["mix", "preDelay", "size", "decay"].forEach((key) => rrow.appendChild(createKnob(byKey[key])));
  rvHost.appendChild(rrow);
  sel.addEventListener("change", (e) => { pushUndo(); applyPreset(e.target.value, false); });

  $("faderVocal").appendChild(createFader(FADERS[0]));
  $("faderBacking").appendChild(createFader(FADERS[1]));
}

// ---------- 效果链 ----------
function createFxChain(ac) {
  const input = ac.createGain();
  let prev = input;
  const bands = [];
  for (let i = 0; i < 4; i++) {
    const f = ac.createBiquadFilter();
    f.type = EQ_DEFS[i].type;
    f.frequency.value = EQ_DEFS[i].freq;
    f.gain.value = 0;
    f.Q.value = EQ_DEFS[i].q;
    prev.connect(f);
    prev = f;
    bands.push(f);
  }
  const dry = ac.createGain();
  prev.connect(dry);
  const preDelay = ac.createDelay(1.0);
  preDelay.delayTime.value = PARAMS.preDelay / 1000;
  prev.connect(preDelay);
  const convolver = ac.createConvolver();
  preDelay.connect(convolver);
  const wet = ac.createGain();
  convolver.connect(wet);
  return { input: input, bands: bands, dry: dry, wet: wet, preDelay: preDelay, convolver: convolver };
}

function setBandParams(f, i) {
  f.frequency.value = PARAMS["eq" + i + "f"];
  f.gain.value = PARAMS["eq" + i + "g"];
  f.Q.value = (i === 1 || i === 2) ? PARAMS["eq" + i + "q"] : EQ_DEFS[i].q;
}

function applyEQ() {
  if (monChain) for (let i = 0; i < 4; i++) setBandParams(monChain.bands[i], i);
  if (playChain) for (let i = 0; i < 4; i++) setBandParams(playChain.bands[i], i);
}

function applyMix() {
  const mix = PARAMS.mix / 100;
  const vol = lin(PARAMS.vocalVol);
  const dry = vol * (1 - mix);
  const wet = vol * mix;
  const monOn = monitorOn && (!transportPlaying || recording);
  const playOn = transportPlaying && !recording;
  if (monChain) {
    monChain.dry.gain.value = monOn ? dry : 0;
    monChain.wet.gain.value = monOn ? wet : 0;
  }
  if (playChain) {
    playChain.dry.gain.value = playOn ? dry : 0;
    playChain.wet.gain.value = playOn ? wet : 0;
  }
  if (backingGain) backingGain.gain.value = lin(PARAMS.backingVol);
}

function applyPreDelay() {
  const s = PARAMS.preDelay / 1000;
  if (monChain) monChain.preDelay.delayTime.value = s;
  if (playChain) playChain.preDelay.delayTime.value = s;
}

function makeImpulseResponse(audioCtx, size, decay, channels) {
  const rate = audioCtx.sampleRate;
  const seconds = clamp(size, 0.1, 8);
  const len = Math.max(1, Math.floor(rate * seconds));
  const nCh = channels === 2 ? 2 : 1;
  const buf = audioCtx.createBuffer(nCh, len, rate);
  const decayPow = clamp(decay, 0.5, 8);

  for (let c = 0; c < nCh; c++) {
    const data = buf.getChannelData(c);
    let rng = c === 0 ? 0x12345678 : 0x9abcdef0;
    const rand = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return (rng / 4294967296) * 2 - 1;
    };

    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const env = Math.pow(1 - t / seconds, decayPow);
      const cutoff = Math.max(300, 14000 * Math.pow(1 - t / seconds, 1.4));
      const alpha = Math.min(1, cutoff / rate);
      const noise = rand();
      lp += alpha * (noise - lp);
      data[i] = lp * env * 0.6;
    }

    const early = [
      { t: 0.004, g: 0.55 },
      { t: 0.009, g: 0.42 },
      { t: 0.016, g: 0.34 },
      { t: 0.024, g: 0.26 },
      { t: 0.034, g: 0.20 },
      { t: 0.048, g: 0.15 },
    ];
    for (const er of early) {
      const idx = Math.floor(er.t * rate);
      if (idx < len) data[idx] += er.g * (c === 0 ? 1 : 0.92) * Math.pow(1 - er.t / seconds, 0.4);
    }

    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak > 0) {
      const scale = 0.8 / peak;
      for (let i = 0; i < len; i++) data[i] *= scale;
    }
  }
  return buf;
}

function applyReverbIR() {
  if (!ctx) return;
  const ir = makeImpulseResponse(ctx, PARAMS.size, PARAMS.decay, channelMode === "mono" ? 1 : 2);
  if (monChain) monChain.convolver.buffer = ir;
  if (playChain) playChain.convolver.buffer = ir;
}

function scheduleIR() {
  if (!ctx) return;
  if (irTimer) clearTimeout(irTimer);
  irTimer = setTimeout(applyReverbIR, 150);
}

function applyPreset(name, skipIR) {
  const p = REVERB_PRESETS[name] || REVERB_PRESETS.largeHall;
  PARAMS.size = p.size;
  PARAMS.decay = p.decay;
  refreshKnobUI("size");
  refreshKnobUI("decay");
  scheduleIR();
  if (skipIR === true) applyReverbIR();
}
// ---------- 引擎 ----------
async function startEngine() {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
      sampleRate: 48000,
    });

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: { ideal: 48000 },
      },
    });

    recSampleRate = ctx.sampleRate;
    micSource = ctx.createMediaStreamSource(micStream);

    await ctx.audioWorklet.addModule("recorder-worklet.js");
    recorderNode = new AudioWorkletNode(ctx, "dry-recorder");
    recorderNode.port.onmessage = (e) => {
      if (recording && e.data && e.data.length) {
        recChunks.push(new Float32Array(e.data));
      }
    };
    recorderMute = ctx.createGain();
    recorderMute.gain.value = 0;
    micSource.connect(recorderNode);
    recorderNode.connect(recorderMute);
    recorderMute.connect(ctx.destination);

    masterInput = ctx.createGain();
    masterLimiter = ctx.createDynamicsCompressor();
    masterLimiter.threshold.value = -1.5;
    masterLimiter.knee.value = 0;
    masterLimiter.ratio.value = 20;
    masterLimiter.attack.value = 0.003;
    masterLimiter.release.value = 0.25;
    masterInput.connect(masterLimiter);
    masterLimiter.connect(ctx.destination);

    monChain = createFxChain(ctx);
    micSource.connect(monChain.input);
    monChain.dry.connect(masterInput);
    monChain.wet.connect(masterInput);

    playChain = createFxChain(ctx);
    playChain.dry.connect(masterInput);
    playChain.wet.connect(masterInput);

    backingGain = ctx.createGain();
    backingGain.connect(masterInput);

    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 2048;
    meterData = new Uint8Array(micAnalyser.fftSize);
    micSource.connect(micAnalyser);

    applyEQ();
    applyReverbIR();
    applyPreDelay();
    applyMix();

    await ctx.resume();
    $("btnEngine").textContent = "停止引擎";
    $("status").textContent = "运行中";
    updateLatency();
    refreshDevices();
    showError("");
  } catch (err) {
    stopEngine();
    showError("启动失败：" + (err && err.message ? err.message : err));
  }
}

function stopEngine() {
  if (transportPlaying && ctx) transportStartOffset = getPosition();
  transportPlaying = false;
  stopSources();
  recording = false;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } }
  ctx = null;
  micStream = null;
  micSource = null;
  recorderNode = null;
  recorderMute = null;
  monChain = null;
  playChain = null;
  backingGain = null;
  masterInput = null;
  masterLimiter = null;
  micAnalyser = null;
  meterData = null;
  vocalAudioBuffer = null;
  recChunks = [];
  if ($("meterFill")) { $("meterFill").style.width = "0%"; $("meterFill").classList.remove("hot"); }
  $("btnEngine").textContent = "启动引擎";
  $("status").textContent = "已停止";
  updateTransportUI();
}

// ---------- 传输 ----------
function scheduleSources(sec) {
  if (backingBuffer) {
    const off = sec;
    if (off < backingBuffer.duration - 0.001) {
      const src = ctx.createBufferSource();
      src.buffer = channelMode === "mono" ? makeMonoBackingBuffer(ctx) : backingBuffer;
      src.connect(backingGain);
      src.start(0, off);
      backingSources.push(src);
    }
  }
  if (vocalBuffer && !recording) {
    const off = sec - recSongStart;
    if (off >= 0 && off < vocalDuration) {
      const src = ctx.createBufferSource();
      src.buffer = getVocalAudioBuffer();
      src.connect(playChain.input);
      src.start(0, off);
      vocalSources.push(src);
    }
  }
}

function stopSources() {
  for (const s of backingSources) { try { s.stop(); } catch (e) { /* ignore */ } try { s.disconnect(); } catch (e) { /* ignore */ } }
  for (const s of vocalSources) { try { s.stop(); } catch (e) { /* ignore */ } try { s.disconnect(); } catch (e) { /* ignore */ } }
  backingSources = [];
  vocalSources = [];
}

function play() {
  if (!ctx) { showError("请先启动引擎"); return; }
  if (transportPlaying) { pause(); return; }
  if (getPosition() >= currentEnd() - 0.001) transportStartOffset = 0;
  scheduleSources(transportStartOffset);
  transportStartCtxTime = ctx.currentTime;
  transportPlaying = true;
  applyMix();
  updateTransportUI();
}

function pause() {
  if (!transportPlaying) return;
  transportStartOffset = getPosition();
  stopSources();
  transportPlaying = false;
  applyMix();
  updateTransportUI();
}

function stopTransport() {
  pause();
  transportStartOffset = 0;
}

function seekTo(sec) {
  sec = clamp(sec, 0, currentEnd());
  if (transportPlaying) {
    transportStartOffset = sec;
    stopSources();
    scheduleSources(sec);
    transportStartCtxTime = ctx.currentTime;
  } else {
    transportStartOffset = sec;
  }
}

function updateTransportUI() {
  $("btnPlay").textContent = transportPlaying ? "暂停" : "播放";
  $("btnRecord").textContent = recording ? "停止录音" : "录音";
}

function setChannelMode(mode) {
  if (channelMode === mode) return;
  channelMode = mode;
  refreshChannelUI();
  applyReverbIR();
  if (ctx && transportPlaying) {
    const pos = getPosition();
    stopSources();
    scheduleSources(pos);
    transportStartCtxTime = ctx.currentTime;
  }
}

function refreshChannelUI() {
  $("btnChMono").classList.toggle("active", channelMode === "mono");
  $("btnChStereo").classList.toggle("active", channelMode === "stereo");
}

function getVocalAudioBuffer() {
  if (!vocalAudioBuffer && vocalBuffer && ctx) {
    vocalAudioBuffer = ctx.createBuffer(1, vocalBuffer.length, vocalSampleRate);
    vocalAudioBuffer.getChannelData(0).set(vocalBuffer);
  }
  return vocalAudioBuffer;
}

// ---------- 撤销 / 删除 / 循环 ----------
function captureState() {
  return {
    vocalBuffer: vocalBuffer,
    vocalSampleRate: vocalSampleRate,
    vocalDuration: vocalDuration,
    recSongStart: recSongStart,
    backingBuffer: backingBuffer,
    backingMono: backingMono,
    backingSampleRate: backingSampleRate,
    backingName: backingName,
    backingFile: backingFile,
    trimStart: trimStart,
    trimEnd: trimEnd,
    params: Object.assign({}, PARAMS),
    channelMode: channelMode,
    monitorOn: monitorOn,
  };
}

function pushUndo() {
  undoStack.push(captureState());
  if (undoStack.length > 50) undoStack.shift();
}

function restoreState(s) {
  vocalBuffer = s.vocalBuffer;
  vocalSampleRate = s.vocalSampleRate;
  vocalDuration = s.vocalDuration;
  recSongStart = s.recSongStart;
  vocalAudioBuffer = null;
  backingBuffer = s.backingBuffer;
  backingMono = s.backingMono;
  backingSampleRate = s.backingSampleRate;
  backingName = s.backingName;
  backingFile = s.backingFile;
  trimStart = s.trimStart;
  trimEnd = s.trimEnd;
  Object.assign(PARAMS, s.params);
  channelMode = s.channelMode;
  monitorOn = s.monitorOn;

  $("backingName").textContent = backingName || "未导入";
  $("recStatus").textContent = vocalBuffer ? ("已录 " + vocalDuration.toFixed(2) + "s") : "尚未录音";
  $("swMonitor").checked = monitorOn;
  refreshAllUI();
  refreshChannelUI();
  applyEQ();
  applyMix();
  applyPreDelay();
  scheduleIR();
  updateTrimReadout();
  updateTransportUI();
  rebuildPeaks();
}

function undo() {
  if (recording) { showError("录音中，请先停止录音再撤销"); return; }
  if (!undoStack.length) { showError("没有可撤销的操作"); return; }
  const s = undoStack.pop();
  if (transportPlaying) pause();
  restoreState(s);
  showError("");
}

function deleteVocal() {
  if (recording) { showError("录音中，请先停止录音再删除"); return; }
  if (!vocalBuffer && vocalDuration <= 0) { showError("没有录音可删除"); return; }
  pushUndo();
  if (transportPlaying) pause();
  vocalBuffer = null;
  vocalDuration = 0;
  recSongStart = 0;
  vocalAudioBuffer = null;
  trimStart = 0;
  trimEnd = 0;
  updateTrimReadout();
  rebuildPeaks();
  $("recStatus").textContent = "尚未录音";
  applyMix();
  showError("");
}

function deleteBacking() {
  if (recording) { showError("录音中，请先停止录音再删除"); return; }
  if (!backingBuffer) { showError("没有伴奏可删除"); return; }
  pushUndo();
  if (transportPlaying) pause();
  backingBuffer = null;
  backingName = "";
  backingFile = null;
  backingMono = null;
  backingSampleRate = 48000;
  $("backingName").textContent = "未导入";
  syncTrimToBounds();
  rebuildPeaks();
  applyMix();
  showError("");
}

function toggleLoop() {
  if (!loopOn) {
    const end = Math.min(trimEnd, currentEnd());
    if (end <= trimStart + 0.001) { showError("请先用裁剪标记框选循环区间"); return; }
  }
  loopOn = !loopOn;
  $("btnLoop").classList.toggle("active", loopOn);
}

// ---------- 录音 ----------
function startRecording() {
  if (!ctx) { showError("请先启动引擎"); return; }
  if (recording) return;
  pushUndo();
  recChunks = [];
  recTakeStart = getPosition();
  recording = true;
  recorderNode.port.postMessage({ recording: true });
  $("recStatus").textContent = "录音中…";
  if (!transportPlaying) {
    if (backingBuffer) scheduleSources(recTakeStart);
    transportStartOffset = recTakeStart;
    transportStartCtxTime = ctx.currentTime;
    transportPlaying = true;
  }
  view.follow = true;
  updateTransportUI();
  applyMix();
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  recorderNode.port.postMessage({ recording: false });
  const take = concatChunks(recChunks);
  const takeStart = recTakeStart;
  const takeDur = take.length / recSampleRate;
  recTakeStart = 0;
  recChunks = [];
  if (take.length === 0) {
    $("recStatus").textContent = vocalBuffer ? ("已录 " + vocalDuration.toFixed(2) + "s") : "尚未录音";
    if (!backingBuffer) pause();
    updateTransportUI();
    applyMix();
    showError("本次未录到有效音频，原录音已保留");
    return;
  }
  overdubVocal(take, takeStart, recSampleRate);
  vocalAudioBuffer = null;
  trimStart = takeStart;
  trimEnd = takeStart + takeDur;
  updateTrimReadout();
  resetView();
  $("recStatus").textContent = "已录 " + vocalDuration.toFixed(2) + "s";
  if (!backingBuffer) pause();
  updateTransportUI();
  applyMix();
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function resampleMono(src, srcRate, dstRate) {
  if (!src || src.length === 0) return new Float32Array(0);
  if (srcRate === dstRate) return src;
  const ratio = srcRate / dstRate;
  const len = Math.max(1, Math.round(src.length / ratio));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = src[i0] + (src[i1] - src[i0]) * frac;
  }
  return out;
}

function overdubVocal(newMono, newStart, newSampleRate) {
  if (!vocalBuffer || vocalDuration <= 0) {
    vocalBuffer = newMono;
    vocalSampleRate = newSampleRate;
    recSongStart = newStart;
    vocalDuration = newMono.length / newSampleRate;
    return;
  }

  const old = resampleMono(vocalBuffer, vocalSampleRate, newSampleRate);
  const oldStart = recSongStart;
  const unionStart = Math.min(oldStart, newStart);

  const oldOff = Math.round((oldStart - unionStart) * newSampleRate);
  const newOff = Math.round((newStart - unionStart) * newSampleRate);
  const outLen = Math.max(1, oldOff + old.length, newOff + newMono.length);
  const out = new Float32Array(outLen);

  out.set(old, oldOff);
  const copyLen = Math.min(newMono.length, out.length - newOff);
  for (let i = 0; i < copyLen; i++) out[newOff + i] = newMono[i];

  vocalBuffer = out;
  vocalSampleRate = newSampleRate;
  recSongStart = unionStart;
  vocalDuration = out.length / newSampleRate;
}

// ---------- 伴奏 ----------
function decodeAudio(arrayBuffer) {
  if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  return decodeCtx.decodeAudioData(arrayBuffer.slice(0));
}

function downmixToMono(buf) {
  const n = buf.length;
  const out = new Float32Array(n);
  const ch = buf.numberOfChannels;
  if (ch === 1) {
    out.set(buf.getChannelData(0));
    return out;
  }
  const channels = [];
  for (let c = 0; c < ch; c++) channels.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += channels[c][i];
    out[i] = s / ch;
  }
  return out;
}

function makeMonoBackingBuffer(ac) {
  if (!backingMono || backingMono.length === 0) return null;
  const buf = ac.createBuffer(1, backingMono.length, backingSampleRate);
  buf.getChannelData(0).set(backingMono);
  return buf;
}

async function importBacking(file) {
  if (!file) return;
  try {
    const ab = await file.arrayBuffer();
    const buf = await decodeAudio(ab);
    pushUndo();
    backingBuffer = buf;
    backingName = file.name;
    backingFile = file;
    backingMono = downmixToMono(buf);
    backingSampleRate = buf.sampleRate;
    if (transportPlaying) pause();
    transportStartOffset = 0;
    syncTrimToBounds();
    resetView();
    $("backingName").textContent = file.name;
    showError("");
  } catch (err) {
    showError("伴奏解码失败（格式可能不受支持）：" + (err && err.message ? err.message : err));
  }
}

function syncTrimToBounds() {
  const end = currentEnd();
  if (trimEnd <= 0 || trimEnd > end) trimEnd = end;
  if (trimStart < 0) trimStart = 0;
  if (trimStart > trimEnd) trimStart = Math.max(0, trimEnd - 1);
  updateTrimReadout();
}

function updateTrimReadout() {
  $("tlTrimStart").textContent = trimStart.toFixed(2);
  $("tlTrimEnd").textContent = trimEnd.toFixed(2);
}
// ---------- 时间轴 ----------
function computePeaks(mono, sampleRate, segStart, segEnd, viewStart, viewDur, width) {
  const peaks = new Float32Array(width * 2);
  if (!mono || mono.length === 0 || segEnd <= segStart || viewDur <= 0) return peaks;
  const viewEnd = viewStart + viewDur;
  for (let x = 0; x < width; x++) {
    const t0 = viewStart + (x / width) * viewDur;
    const t1 = viewStart + ((x + 1) / width) * viewDur;
    const s0 = Math.max(segStart, t0);
    const s1 = Math.min(segEnd, t1);
    if (s1 <= s0) continue;
    const i0 = Math.max(0, Math.floor(s0 * sampleRate));
    const i1 = Math.min(mono.length - 1, Math.ceil(s1 * sampleRate));
    let mn = Infinity;
    let mx = -Infinity;
    const step = Math.max(1, Math.floor((i1 - i0) / 256));
    for (let i = i0; i <= i1; i += step) {
      const v = mono[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    peaks[x * 2] = mn;
    peaks[x * 2 + 1] = mx;
  }
  return peaks;
}

function rebuildTrackPeaks(key) {
  const canvas = key === "backing" ? $("trackBacking") : $("trackVocal");
  const w = canvas ? canvas.clientWidth || 1 : 1;
  const viewDur = Math.max(view.dur, 0.001);
  if (key === "backing") {
    backingPeaks = computePeaks(backingMono, backingSampleRate, 0, backingBuffer ? backingBuffer.duration : 0, view.start, viewDur, w);
  } else {
    vocalPeaks = computePeaks(vocalBuffer, vocalSampleRate, recSongStart, recSongStart + vocalDuration, view.start, viewDur, w);
  }
  peakCache[key] = { w: w, start: view.start, dur: view.dur };
}

function rebuildPeaks() {
  rebuildTrackPeaks("backing");
  rebuildTrackPeaks("vocal");
}

function trackKeyOf(canvas) {
  return canvas.id === "trackBacking" ? "backing" : "vocal";
}

function txView(t, w) {
  return view.dur > 0 ? ((t - view.start) / view.dur) * w : 0;
}

function timeAtView(x, w) {
  return view.dur > 0 ? view.start + (x / w) * view.dur : 0;
}

function resetView() {
  view.start = 0;
  view.dur = DEFAULT_VIEW_SEC;
  view.follow = true;
  rebuildPeaks();
}

function updateFollow() {
  const active = transportPlaying || recording;
  if (!active || !ctx) return;
  if (!view.follow) return;
  const pos = getPosition();
  const end = Math.max(currentEnd(), 1);
  const frac = 0.7;
  view.start = clamp(pos - frac * view.dur, 0, Math.max(0, end - view.dur));
}

function drawTimeline() {
  drawTrackWave("trackBacking", "232,227,179", "top");
  drawTrackWave("trackVocal", "212,175,55", "bottom");
  const pos = (dragMode === "seek") ? scrubTime : getPosition();
  $("tlPos").textContent = pos.toFixed(2);
}

function drawTrackWave(id, rgb, outerEdge) {
  const canvas = $(id);
  if (!canvas) return;
  const key = trackKeyOf(canvas);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const c = peakCache[key];
  if (!c || c.w !== w || c.start !== view.start || c.dur !== view.dur) {
    rebuildTrackPeaks(key);
  }
  const peaks = key === "backing" ? backingPeaks : vocalPeaks;
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const end = currentEnd();
  const tx = (t) => txView(t, w);

  const x1 = tx(trimStart);
  const x2 = tx(trimEnd);
  if (x2 > x1) {
    g.fillStyle = "rgba(212,175,55,0.10)";
    g.fillRect(Math.max(0, x1), 0, Math.min(w, x2) - Math.max(0, x1), h);
  }

  drawWaveform(g, peaks, 0, h, rgb);

  if (recording && outerEdge === "bottom") {
    const rx0 = tx(recTakeStart);
    const rx1 = tx(getPosition());
    if (rx1 > rx0) {
      g.fillStyle = "rgba(212,175,55,0.14)";
      g.fillRect(Math.max(0, rx0), 0, Math.min(w, rx1) - Math.max(0, rx0), h);
    }
  }

  drawTrimLine(g, x1, h, outerEdge);
  drawTrimLine(g, x2, h, outerEdge);

  const pos = (dragMode === "seek") ? scrubTime : getPosition();
  const px = tx(clamp(pos, 0, end));
  g.strokeStyle = "#F5D67A";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(px, 0);
  g.lineTo(px, h);
  g.stroke();
}

function drawWaveform(g, peaks, y0, y1, rgb) {
  const mid = (y0 + y1) / 2;
  const amp = (y1 - y0) * 0.42;
  const n = peaks.length / 2;
  g.strokeStyle = "rgba(" + rgb + ",0.85)";
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x < n; x++) {
    const mn = peaks[x * 2];
    const mx = peaks[x * 2 + 1];
    const ymin = mid - mx * amp;
    const ymax = mid - mn * amp;
    g.moveTo(x + 0.5, ymin);
    g.lineTo(x + 0.5, ymax);
  }
  g.stroke();
}

function drawTrimLine(g, x, h, outerEdge) {
  g.strokeStyle = "#D4AF37";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x, 0);
  g.lineTo(x, h);
  g.stroke();
  g.fillStyle = "#D4AF37";
  if (outerEdge === "top") {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x - 6, 0);
    g.lineTo(x, 7);
    g.closePath();
    g.fill();
  } else {
    g.beginPath();
    g.moveTo(x, h);
    g.lineTo(x - 6, h);
    g.lineTo(x, h - 7);
    g.closePath();
    g.fill();
  }
}

function timelinePointerDown(e) {
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const end = currentEnd();
  const t = clamp(timeAtView(x, rect.width), 0, end);
  const xStart = txView(trimStart, rect.width);
  const xEnd = txView(trimEnd, rect.width);
  if (Math.abs(x - xStart) < 10) { pushUndo(); dragMode = "trimStart"; }
  else if (Math.abs(x - xEnd) < 10) { pushUndo(); dragMode = "trimEnd"; }
  else { dragMode = "seek"; scrubTime = t; view.follow = false; }
  canvas.setPointerCapture(e.pointerId);
  drawTimeline();
}

function timelinePointerMove(e) {
  if (!dragMode) return;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const end = currentEnd();
  const t = clamp(timeAtView(e.clientX - rect.left, rect.width), 0, end);
  if (dragMode === "trimStart") {
    trimStart = Math.min(t, trimEnd - 0.01);
    updateTrimReadout();
  } else if (dragMode === "trimEnd") {
    trimEnd = Math.max(t, trimStart + 0.01);
    updateTrimReadout();
  } else {
    scrubTime = t;
  }
  drawTimeline();
}

function timelinePointerUp() {
  if (dragMode === "seek") seekTo(scrubTime);
  dragMode = null;
  drawTimeline();
}

function timelineWheel(e) {
  e.preventDefault();
  const canvas = e.currentTarget;
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  if (e.shiftKey) {
    // Shift+滚轮：横向滚动
    const maxStart = Math.max(0, Math.max(currentEnd(), DEFAULT_VIEW_SEC) - view.dur);
    view.start = clamp(view.start + (e.deltaY / h) * view.dur, 0, maxStart);
    view.follow = false;
  } else {
    // 滚轮：缩放（以鼠标位置为中心调整视图大小）
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const anchor = timeAtView(x, w);
    const maxDur = Math.max(currentEnd(), DEFAULT_VIEW_SEC);
    const newDur = clamp(view.dur * Math.pow(1.0015, e.deltaY), 0.5, maxDur);
    view.dur = newDur;
    view.start = anchor - (x / w) * newDur;
    if (!(transportPlaying || recording)) view.follow = false;
  }
  drawTimeline();
}

function timelineDblClick() {
  view.start = 0;
  view.dur = DEFAULT_VIEW_SEC;
  view.follow = true;
  drawTimeline();
}
// ---------- 导出 ----------
async function exportMix() {
  try {
    const backingDur = backingBuffer ? backingBuffer.duration : 0;
    const vocalEnd = recSongStart + vocalDuration;
    const maxEnd = Math.max(vocalEnd, backingDur);
    if (maxEnd <= 0) { showError("请先录音或导入伴奏"); return; }

    let start = trimStart;
    let end = trimEnd;
    start = clamp(start, 0, maxEnd);
    if (end <= start || end > maxEnd) end = maxEnd;
    end = clamp(end, start, maxEnd);

    const sr = 48000;
    const channels = channelMode === "mono" ? 1 : 2;
    const total = Math.max(1, Math.ceil((end - start) * sr));
    const off = new OfflineAudioContext(channels, total, sr);

    const master = off.createDynamicsCompressor();
    master.threshold.value = -1.5;
    master.knee.value = 0;
    master.ratio.value = 20;
    master.attack.value = 0.003;
    master.release.value = 0.25;
    master.connect(off.destination);

    if (backingBuffer) {
      const from = Math.max(0, start);
      const to = Math.min(backingDur, end);
      if (to > from) {
        const src = off.createBufferSource();
        src.buffer = channelMode === "mono" ? makeMonoBackingBuffer(off) : backingBuffer;
        const g = off.createGain();
        g.gain.value = lin(PARAMS.backingVol);
        src.connect(g);
        g.connect(master);
        src.start(0, from, to - from);
      }
    }

    if (vocalBuffer && vocalDuration > 0) {
      const vstart = recSongStart;
      const vend = vstart + vocalDuration;
      const clipFrom = Math.max(start, vstart);
      const clipTo = Math.min(end, vend);
      if (clipTo > clipFrom) {
        const len = Math.ceil((clipTo - clipFrom) * sr);
        const buf = off.createBuffer(1, len, sr);
        const data = buf.getChannelData(0);
        const srcOff = Math.round((clipFrom - vstart) * vocalSampleRate);
        for (let i = 0; i < len; i++) data[i] = vocalBuffer[srcOff + i] || 0;

        const src = off.createBufferSource();
        src.buffer = buf;

        let prev = src;
        for (let i = 0; i < 4; i++) {
          const f = off.createBiquadFilter();
          f.type = EQ_DEFS[i].type;
          f.frequency.value = PARAMS["eq" + i + "f"];
          f.gain.value = PARAMS["eq" + i + "g"];
          f.Q.value = (i === 1 || i === 2) ? PARAMS["eq" + i + "q"] : EQ_DEFS[i].q;
          prev.connect(f);
          prev = f;
        }

        const mix = PARAMS.mix / 100;
        const vol = lin(PARAMS.vocalVol);

        const dry = off.createGain();
        dry.gain.value = vol * (1 - mix);
        prev.connect(dry);

        const pd = off.createDelay(1);
        pd.delayTime.value = PARAMS.preDelay / 1000;
        prev.connect(pd);
        const conv = off.createConvolver();
        conv.buffer = makeImpulseResponse(off, PARAMS.size, PARAMS.decay, channels);
        pd.connect(conv);
        const wet = off.createGain();
        wet.gain.value = vol * mix;
        conv.connect(wet);

        if (channels === 1) {
          dry.connect(master);
          wet.connect(master);
        } else {
          const merger = off.createChannelMerger(2);
          dry.connect(merger, 0, 0);
          dry.connect(merger, 0, 1);
          wet.connect(merger, 0, 0);
          wet.connect(merger, 1, 1);
          merger.connect(master);
        }

        src.start(clipFrom - start, 0);
      }
    }

    const rendered = await off.startRendering();
    normalizeBuffer(rendered);
    const wav = encodeWav(rendered, sr, channels, 24);
    downloadBlob(wav, "mix-" + Date.now() + ".wav", "audio/wav");
    showError("");
  } catch (err) {
    showError("导出失败：" + (err && err.message ? err.message : err));
  }
}

function normalizeBuffer(buf, targetDb) {
  targetDb = targetDb === undefined ? -1 : targetDb;
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= 0.000001) return;
  const target = Math.pow(10, targetDb / 20);
  let gain = target / peak;
  gain = clamp(gain, 0, 10);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
  }
}

function encodeWav(buffer, sampleRate, channels, bits) {
  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  const n = chans[0].length;
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = n * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let off = 44;
  if (bits === 16) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        const s = clamp(chans[c][i], -1, 1);
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        const s = clamp(chans[c][i], -1, 1);
        const v = Math.round(s * 0x7fffff);
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return ab;
}

function encodeWavMono24(samples, sampleRate) {
  const n = samples.length;
  const dataSize = n * 3;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 3, true);
  view.setUint16(32, 3, true);
  view.setUint16(34, 24, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = clamp(samples[i], -1, 1);
    const v = Math.round(s * 0x7fffff);
    view.setUint8(off, v & 0xff);
    view.setUint8(off + 1, (v >> 8) & 0xff);
    view.setUint8(off + 2, (v >> 16) & 0xff);
    off += 3;
  }
  return ab;
}

function downloadBlob(buf, filename, type) {
  const blob = new Blob([buf], { type: type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
// ---------- 工程 ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function collectParams() {
  const eq = EQ_DEFS.map((d, i) => ({
    type: d.type,
    freq: PARAMS["eq" + i + "f"],
    gain: PARAMS["eq" + i + "g"],
    q: (i === 1 || i === 2) ? PARAMS["eq" + i + "q"] : d.q,
  }));
  return {
    eq: eq,
    reverbPreset: $("selPreset").value,
    mix: PARAMS.mix,
    preDelay: PARAMS.preDelay,
    size: PARAMS.size,
    decay: PARAMS.decay,
    vocalVol: PARAMS.vocalVol,
    backingVol: PARAMS.backingVol,
    trimStart: trimStart,
    trimEnd: trimEnd,
    recSongStart: recSongStart,
    vocalDuration: vocalDuration,
    monitorOn: monitorOn,
    channelMode: channelMode,
  };
}

async function saveProject() {
  if (!vocalBuffer) { showError("请先录音，再保存工程"); return; }
  try {
    const vocalWav = encodeWavMono24(vocalBuffer, vocalSampleRate);
    let backingBlob = null;
    let backingType = "";
    if (backingFile) {
      backingBlob = await backingFile.arrayBuffer();
      backingType = backingFile.type;
    }
    const name = $("txtProjectName").value.trim() || ("工程 " + new Date().toLocaleString());
    const rec = {
      name: name,
      updated: Date.now(),
      vocalWav: vocalWav,
      vocalSampleRate: vocalSampleRate,
      vocalDuration: vocalDuration,
      backingName: backingName,
      backingType: backingType,
      backingBlob: backingBlob,
      params: collectParams(),
    };
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    $("projectStatus").textContent = "已保存：" + name;
    refreshProjects();
    showError("");
  } catch (err) {
    showError("保存失败：" + (err && err.message ? err.message : err));
  }
}

function applyParams(p) {
  PARAMS.eq0g = p.eq[0].gain; PARAMS.eq0f = p.eq[0].freq;
  PARAMS.eq1g = p.eq[1].gain; PARAMS.eq1f = p.eq[1].freq; PARAMS.eq1q = p.eq[1].q;
  PARAMS.eq2g = p.eq[2].gain; PARAMS.eq2f = p.eq[2].freq; PARAMS.eq2q = p.eq[2].q;
  PARAMS.eq3g = p.eq[3].gain; PARAMS.eq3f = p.eq[3].freq;
  PARAMS.mix = p.mix;
  PARAMS.preDelay = p.preDelay;
  PARAMS.size = p.size;
  PARAMS.decay = p.decay;
  PARAMS.vocalVol = p.vocalVol;
  PARAMS.backingVol = p.backingVol;
  trimStart = p.trimStart || 0;
  trimEnd = p.trimEnd || 0;
  recSongStart = p.recSongStart || 0;
  vocalDuration = p.vocalDuration || 0;
  monitorOn = !!p.monitorOn;
  channelMode = p.channelMode === "stereo" ? "stereo" : "mono";
  $("swMonitor").checked = monitorOn;
  if (p.reverbPreset) $("selPreset").value = p.reverbPreset;
  refreshAllUI();
  refreshChannelUI();
  applyEQ();
  applyMix();
  applyPreDelay();
  scheduleIR();
  updateTrimReadout();
}

async function loadProject(id) {
  try {
    const db = await openDB();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!rec) return;

    const vbuf = await decodeAudio(rec.vocalWav.slice(0));
    pushUndo();
    vocalBuffer = new Float32Array(vbuf.getChannelData(0));
    vocalSampleRate = rec.vocalSampleRate || 48000;
    vocalDuration = rec.vocalDuration || (vocalBuffer.length / vocalSampleRate);
    vocalAudioBuffer = null;

    backingName = rec.backingName || "";
    backingFile = null;
    if (rec.backingBlob && rec.backingBlob.byteLength) {
      backingBuffer = await decodeAudio(rec.backingBlob.slice(0));
      backingMono = downmixToMono(backingBuffer);
      backingSampleRate = backingBuffer.sampleRate;
      $("backingName").textContent = backingName;
    } else {
      backingBuffer = null;
      backingMono = null;
      $("backingName").textContent = "无";
    }
    if (transportPlaying) pause();
    transportStartOffset = 0;

    $("txtProjectName").value = rec.name || "";
    applyParams(rec.params);
    resetView();
    $("recStatus").textContent = "已载入工程（人声 " + vocalDuration.toFixed(2) + "s）";
    $("projectStatus").textContent = "已载入：" + rec.name;
    showError("");
  } catch (err) {
    showError("载入失败：" + (err && err.message ? err.message : err));
  }
}

async function deleteProject(id) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    refreshProjects();
  } catch (err) {
    showError("删除失败：" + (err && err.message ? err.message : err));
  }
}

async function refreshProjects() {
  const list = $("projectList");
  list.innerHTML = "";
  try {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    rows.sort((a, b) => b.updated - a.updated);
    for (const r of rows) {
      const item = document.createElement("div");
      item.className = "proj-item";
      const nameSpan = document.createElement("span");
      nameSpan.className = "proj-name";
      nameSpan.textContent = r.name;
      const meta = document.createElement("span");
      meta.className = "proj-meta";
      meta.textContent = new Date(r.updated).toLocaleString();
      const btnLoad = document.createElement("button");
      btnLoad.textContent = "载入";
      btnLoad.onclick = () => loadProject(r.id);
      const btnDel = document.createElement("button");
      btnDel.textContent = "删除";
      btnDel.onclick = () => deleteProject(r.id);
      item.appendChild(nameSpan);
      item.appendChild(meta);
      item.appendChild(btnLoad);
      item.appendChild(btnDel);
      list.appendChild(item);
    }
    if (!rows.length) {
      list.innerHTML = "<div class='proj-empty'>暂无已保存工程</div>";
    }
  } catch (err) {
    list.innerHTML = "<div class='proj-empty'>读取工程列表失败</div>";
  }
}

// ---------- 状态显示 ----------
function updateLatency() {
  if (!ctx) return;
  const base = (ctx.baseLatency || 0) * 1000;
  const out = (ctx.outputLatency || 0) * 1000;
  $("latency").textContent =
    ctx.sampleRate + " Hz · " + base.toFixed(1) + "ms + " + out.toFixed(1) + "ms ≈ " + (base + out).toFixed(1) + "ms";
}

async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const ins = devs.filter((d) => d.kind === "audioinput");
  const outs = devs.filter((d) => d.kind === "audiooutput");
  const inLabel = ins.map((d) => d.label || ("麦克风" + d.deviceId.slice(0, 4))).join(", ") || "无";
  const outLabel = outs.map((d) => d.label || ("扬声器" + d.deviceId.slice(0, 4))).join(", ") || "无";
  $("devices").textContent = "入：" + inLabel + " · 出：" + outLabel;
  const bt = [...ins, ...outs].some((d) => /bluetooth|airpod|无线|蓝牙|headset/i.test(d.label || ""));
  $("btWarn").hidden = !bt;
}

// ---------- 主循环 ----------
function updateMeter() {
  const fill = $("meterFill");
  if (!micAnalyser || !meterData || !fill) {
    if (fill) { fill.style.width = "0%"; fill.classList.remove("hot"); }
    return;
  }
  micAnalyser.getByteTimeDomainData(meterData);
  let peak = 0;
  for (let i = 0; i < meterData.length; i++) {
    const v = Math.abs(meterData[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  fill.style.width = (peak * 100).toFixed(1) + "%";
  fill.classList.toggle("hot", peak > 0.95);
}

function loop() {
  if (transportPlaying && !recording && ctx) {
    const pos = getPosition();
    const loopEnd = Math.min(trimEnd, currentEnd());
    if (loopOn && loopEnd > trimStart && pos >= loopEnd) {
      seekTo(trimStart);
    } else if (pos >= currentEnd()) {
      pause();
    }
  }
  updateFollow();
  updateMeter();
  drawTimeline();
  requestAnimationFrame(loop);
}

// ---------- 事件绑定 ----------
function wire() {
  renderKnobs();

  $("btnEngine").addEventListener("click", () => {
    if (ctx) stopEngine();
    else startEngine();
  });

  $("swMonitor").addEventListener("change", (e) => {
    monitorOn = e.target.checked;
    applyMix();
  });

  $("btnPlay").addEventListener("click", play);
  $("btnStop").addEventListener("click", stopTransport);
  $("btnRecord").addEventListener("click", () => {
    if (recording) stopRecording();
    else startRecording();
  });
  $("btnExport").addEventListener("click", exportMix);
  $("btnImport").addEventListener("click", () => $("fileBacking").click());
  $("fileBacking").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importBacking(e.target.files[0]);
    e.target.value = "";
  });
  $("btnSaveProject").addEventListener("click", saveProject);

  for (const id of ["trackBacking", "trackVocal"]) {
    const canvas = $(id);
    canvas.addEventListener("pointerdown", timelinePointerDown);
    canvas.addEventListener("pointermove", timelinePointerMove);
    canvas.addEventListener("pointerup", timelinePointerUp);
    canvas.addEventListener("pointercancel", () => { dragMode = null; });
    canvas.addEventListener("wheel", timelineWheel, { passive: false });
    canvas.addEventListener("dblclick", timelineDblClick);
  }

  $("btnChMono").addEventListener("click", () => setChannelMode("mono"));
  $("btnChStereo").addEventListener("click", () => setChannelMode("stereo"));
  $("btnLoop").addEventListener("click", toggleLoop);
  $("btnUndo").addEventListener("click", undo);
  $("btnDeleteVocal").addEventListener("click", deleteVocal);
  $("btnDeleteBacking").addEventListener("click", deleteBacking);
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== "z" && e.key !== "Z")) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    e.preventDefault();
    undo();
  });
  window.addEventListener("resize", rebuildPeaks);

  updateTransportUI();
  updateTrimReadout();
  refreshChannelUI();
  resetView();
  refreshProjects();
  requestAnimationFrame(loop);
}

document.addEventListener("DOMContentLoaded", wire);
