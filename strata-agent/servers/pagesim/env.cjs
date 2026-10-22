'use strict';
/**
 * Deterministic browser-environment shim for running a page's own JS headlessly in Node.
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent repeatedly needed to verify a browser game/app (run N frames, read game state,
 * check a level is winnable) but the tool set only offered "open the page once and take a
 * screenshot". So the model hand-wrote a Node stub per session, and every session hit a new
 * missing global:
 *
 *     ReferenceError: location is not defined        <- user bug report 2026-10-20
 *     TypeError: canvas.getContext is not a function
 *     TypeError: document.createElement is not a function
 *
 * Each miss cost a whole tool round-trip and the stub was rebuilt from scratch next time.
 * That is a *tool gap*, not a model failure: a hand-rolled stub is always one API short.
 *
 * This module is the single canonical environment. It implements the surface a real page
 * actually touches -- window/document/location/canvas-2d/audio/timers/storage/observers --
 * on a VIRTUAL clock (rAF + setTimeout + Date + performance.now + Math.random all driven by
 * one counter), so a run is reproducible frame-by-frame instead of wall-clock dependent.
 *
 * Two escape hatches replace the old whack-a-mole:
 *   - unknown members on ctx/element/style are answered with a recording no-op and reported
 *     in `stubCalls`, so one missing draw call never aborts a whole verification;
 *   - an unknown GLOBAL raises `SandboxGap` naming the identifier, listing what IS supported
 *     and how to add it (the `prelude` job field) -- one explicit round, not N blind ones.
 */

// ── helpers ────────────────────────────────────────────────────────────────────────────────

/** Small, fast, seedable PRNG (mulberry32) -- makes Math.random reproducible per run. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 1x1 transparent PNG: the only pixels a pixel-less simulator can honestly produce. */
const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Rough text width: CJK is ~1em, latin ~0.55em. Enough for canvas layout code to work. */
function textWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text)) {
    w += /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/
      .test(ch) ? fontSize : fontSize * 0.55;
  }
  return w;
}

const STYLE_METHODS = ['setProperty', 'removeProperty', 'getPropertyValue', 'item'];

/** `el.style` -- accepts both `style.width = '1px'` and `style.setProperty('width','1px')`. */
function makeStyle(seed) {
  const t = Object.assign({}, seed || {});
  return new Proxy(t, {
    get(target, k) {
      if (k === 'setProperty') return (n, v) => { target[n] = v == null ? '' : String(v); };
      if (k === 'removeProperty') return (n) => { const v = target[n]; delete target[n]; return v == null ? '' : v; };
      if (k === 'getPropertyValue') return (n) => (target[n] == null ? '' : String(target[n]));
      if (k === 'item') return (i) => Object.keys(target)[i] || '';
      if (k === 'cssText') return Object.entries(target).map(([a, b]) => `${a}:${b}`).join(';');
      if (typeof k === 'symbol') return undefined;
      if (k in target) return target[k];
      // Unknown CSS property: remember the read as an empty value (browsers return '' for
      // an unset computed property, so this matches, and it never yields `undefined`).
      return '';
    },
    set(target, k, v) { target[k] = v; return true; },
    has() { return true; },
  });
}

/**
 * Wrap an object so any UNKNOWN member answers with a recording no-op instead of throwing.
 * Used for the 2D context / WebGL context / elements, where "one draw call the shim forgot"
 * must not abort an otherwise valid verification. Every fake is reported back to the caller.
 */
function permissive(obj, onMiss) {
  return new Proxy(obj, {
    get(target, k, recv) {
      if (typeof k === 'symbol') return Reflect.get(target, k, recv);
      if (k in target) return Reflect.get(target, k, recv);
      const fn = function () { return undefined; };
      Object.defineProperty(target, k, { value: fn, writable: true, configurable: true });
      if (onMiss) onMiss(k);
      return fn;
    },
    set(target, k, v) { target[k] = v; return true; },
  });
}

// ── canvas 2D ─────────────────────────────────────────────────────────────────────────────

const CTX2D_METHODS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse',
  'rect', 'roundRect', 'bezierCurveTo', 'quadraticCurveTo', 'fill', 'stroke', 'clip',
  'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'translate', 'rotate',
  'scale', 'transform', 'setTransform', 'resetTransform', 'drawImage', 'setLineDash',
  'putImageData', 'createPattern', 'isPointInPath', 'isPointInStroke', 'drawFocusIfNeeded',
];

const CTX2D_PROPS = {
  globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000000',
  strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
  shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)', shadowOffsetX: 0, shadowOffsetY: 0,
  font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
  direction: 'inherit', lineDashOffset: 0, imageSmoothingEnabled: true, filter: 'none',
  letterSpacing: '0px', wordSpacing: '0px',
};

function makeContext2D(canvas, state) {
  const ctx = { canvas };
  Object.assign(ctx, CTX2D_PROPS);

  // Every draw call is counted: a non-zero count after stepping is hard evidence that the
  // render path actually executed (the previous stub of this game reported 0 and looked fine).
  for (const m of CTX2D_METHODS) {
    ctx[m] = function () { state.draws++; return undefined; };
  }

  ctx.measureText = (text) => {
    const m = /(\d+(?:\.\d+)?)px/.exec(String(ctx.font));
    const size = m ? parseFloat(m[1]) : 10;
    const w = textWidth(text, size);
    return { width: w, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
             actualBoundingBoxAscent: size * 0.8, actualBoundingBoxDescent: size * 0.2 };
  };
  ctx.getImageData = (x, y, w, h) => {
    const width = Math.max(0, Math.floor(w || 0));
    const height = Math.max(0, Math.floor(h || 0));
    // Guard the allocation: 4000x4000 would be 64MB of zeros for no benefit.
    const px = width * height <= 4_000_000 ? width * height : 0;
    return { data: new Uint8ClampedArray(px * 4), width, height,
             colorSpace: 'srgb' };
  };
  ctx.createImageData = (w, h) => {
    const width = Math.max(0, Math.floor((w && w.width) || w || 0));
    const height = Math.max(0, Math.floor((h && h.height) || h || 0));
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  };
  const gradient = () => ({ addColorStop() {}, stop: () => undefined });
  ctx.createLinearGradient = gradient;
  ctx.createRadialGradient = gradient;
  ctx.createConicGradient = gradient;
  ctx.getLineDash = () => [];
  ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

  return permissive(ctx, (name) => bump(state.stub, `ctx.${name}`));
}

function makeWebGL(canvas, state) {
  const gl = {
    canvas, drawingBufferWidth: canvas.width, drawingBufferHeight: canvas.height,
    getExtension: () => null, getParameter: () => 0, getShaderPrecisionFormat: () => ({ precision: 23 }),
    createShader: () => ({}), createProgram: () => ({}), getShaderParameter: () => true,
    getProgramParameter: () => true, getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    getContextAttributes: () => ({ alpha: true, antialias: false }),
  };
  return permissive(gl, (name) => bump(state.stub, `gl.${name}`));
}

// ── DOM ───────────────────────────────────────────────────────────────────────────────────

class Storage {
  constructor() { this._m = new Map(); }
  get length() { return this._m.size; }
  key(i) { const k = [...this._m.keys()][i]; return k === undefined ? null : k; }
  getItem(k) { const v = this._m.get(String(k)); return v === undefined ? null : v; }
  setItem(k, v) { this._m.set(String(k), String(v)); }
  removeItem(k) { this._m.delete(String(k)); }
  clear() { this._m.clear(); }
  toObject() { return Object.fromEntries(this._m); }
}

class El {
  constructor(tag, env, attrs) {
    const a = attrs || {};
    this.ownerDocument = null;            // set by Doc
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.id = a.id || '';
    this.className = a.class || '';
    this._attrs = Object.assign({}, a);
    this.style = makeStyle(a.style ? parseInlineStyle(a.style) : null);
    this.dataset = {};
    for (const k of Object.keys(a)) {
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a[k];
    }
    this.childNodes = [];
    this.children = this.childNodes;
    this.parentNode = null;
    this.parentElement = null;
    this.textContent = a.text || '';
    this.innerText = this.textContent;
    this.innerHTML = '';
    this.value = a.value || '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selectedIndex = 0;
    this.options = [];
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.files = [];
    // Geometry: the page's canvas/overlays are laid out by CSS we don't implement, so expose
    // the viewport box. `getBoundingClientRect()` on a canvas is what pointer maths uses.
    this.offsetWidth = a.width ? +a.width : env.__vp.width;
    this.offsetHeight = a.height ? +a.height : env.__vp.height;
    this.clientWidth = this.offsetWidth;
    this.clientHeight = this.offsetHeight;
    this.scrollWidth = this.offsetWidth;
    this.scrollHeight = this.offsetHeight;
    this.offsetLeft = 0; this.offsetTop = 0;
    this.__listeners = Object.create(null);
    this.__ctx = null;
    this.__env = env;
    if (this.tagName === 'CANVAS') {
      this.width = a.width ? +a.width : 300;
      this.height = a.height ? +a.height : 150;
    }
  }

  get classList() {
    const self = this;
    if (!this.__classList) {
      this.__classList = {
        add(...c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
        remove(...c) { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
        toggle(c, force) {
          const has = self.classList.contains(c);
          const want = force === undefined ? !has : !!force;
          if (want && !has) self.classList.add(c); else if (!want && has) self.classList.remove(c);
          return want;
        },
        contains(c) { return self.className.split(/\s+/).includes(c); },
        replace(a, b) { if (self.classList.contains(a)) { self.classList.remove(a); self.classList.add(b); return true; } return false; },
        item(i) { return self.className.split(/\s+/).filter(Boolean)[i] || null; },
        get length() { return self.className.split(/\s+/).filter(Boolean).length; },
        forEach(fn) { self.className.split(/\s+/).filter(Boolean).forEach(fn); },
        toString() { return self.className; },
      };
    }
    return this.__classList;
  }

  get attributes() {
    const out = [];
    for (const [k, v] of Object.entries(this._attrs)) out.push({ name: k, value: String(v) });
    return out;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

  addEventListener(type, fn, opts) {
    (this.__listeners[type] = this.__listeners[type] || []).push({ fn, once: !!(opts && opts.once) });
  }
  removeEventListener(type, fn) {
    const l = this.__listeners[type];
    if (l) this.__listeners[type] = l.filter((x) => x.fn !== fn);
  }
  dispatchEvent(ev) {
    const e = ev || {};
    const type = e.type;
    if (!type) return true;
    if (e.target === undefined || e.target === null) e.target = this;
    if (e.currentTarget === undefined) e.currentTarget = this;
    const l = (this.__listeners[type] || []).slice();
    for (const it of l) {
      try { it.fn.call(this, e); } catch (err) { this.__env.__onError(err, `event:${type}`); }
      if (it.once) this.removeEventListener(type, it.fn);
    }
    const inline = this[`on${type}`];
    if (typeof inline === 'function') {
      try { inline.call(this, e); } catch (err) { this.__env.__onError(err, `on${type}`); }
    }
    return !e.defaultPrevented;
  }
  click() { return this.dispatchEvent({ type: 'click', bubbles: true }); }
  focus() {} blur() {} select() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
  insertBefore(n, ref) { return this.appendChild(n, ref); }
  appendChild(n, before) {
    if (!n) return n;
    n.parentNode = this; n.parentElement = this;
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n);
    return n;
  }
  append(...ns) { ns.forEach((n) => this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n)); }
  prepend(...ns) { ns.forEach((n) => this.appendChild(n, this.childNodes[0])); }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); return n; }
  replaceChild(n, old) { this.removeChild(old); return this.appendChild(n); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  getBoundingClientRect() {
    const w = this.offsetWidth, h = this.offsetHeight;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h,
             toJSON() { return { x: 0, y: 0, width: w, height: h }; } };
  }
  getClientRects() { return [this.getBoundingClientRect()]; }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this._attrs[k] === undefined ? null : String(this._attrs[k]); }
  hasAttribute(k) { return this._attrs[k] !== undefined; }
  removeAttribute(k) { delete this._attrs[k]; }
  matches(sel) { return matchSimple(this, sel); }
  closest(sel) {
    let n = this;
    while (n) { if (matchSimple(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) { return queryAll(this.childNodes, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this.childNodes, sel); }
  getElementsByTagName(tag) { return queryAll(this.childNodes, tag); }
  getElementsByClassName(c) { return queryAll(this.childNodes, '.' + c); }
  /** Canvas surface. webgl is answered with a recording stub -- enough for feature detection. */
  getContext(kind) {
    const env = this.__env;
    if (kind === '2d') {
      if (!this.__ctx) this.__ctx = makeContext2D(this, env.__state);
      return this.__ctx;
    }
    if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') {
      if (!this.__gl) this.__gl = makeWebGL(this, env.__state);
      return this.__gl;
    }
    return null;
  }
  toDataURL() {
    bump(this.__env.__state.stub, 'canvas.toDataURL');
    return PLACEHOLDER_PNG;
  }
  toBlob(cb) { cb(null); }
  set capture(v) {} get capture() { return false; }
}

function parseInlineStyle(text) {
  const o = {};
  for (const part of String(text).split(';')) {
    const i = part.indexOf(':');
    if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return o;
}

function matchSimple(el, sel) {
  const s = String(sel || '').trim();
  if (!s) return false;
  if (s[0] === '#') return el.id === s.slice(1);
  if (s[0] === '.') return el.classList.contains(s.slice(1));
  return el.tagName === s.toUpperCase();
}

function flatten(nodes, out) {
  for (const n of nodes) {
    out.push(n);
    if (n.childNodes && n.childNodes.length) flatten(n.childNodes, out);
  }
  return out;
}

function queryAll(nodes, sel) {
  const all = flatten(nodes, []);
  const parts = String(sel || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return [];
  return all.filter((el) => parts.some((p) => matchSimple(el, p)));
}

class Doc {
  constructor(env) {
    this.__env = env;
    this.__byId = Object.create(null);
    this.__all = [];
    this.nodeType = 9;
    this.readyState = 'complete';
    this.hidden = false;
    this.visibilityState = 'visible';
    this.title = '';
    this.cookie = '';
    this.referrer = '';
    this.URL = 'file:///page.html';
    this.documentURI = this.URL;
    this.characterSet = 'UTF-8';
    this.contentType = 'text/html';
    this.pointerLockElement = null;
    this.fullscreenElement = null;
    this.activeElement = null;
    this.fonts = { ready: Promise.resolve(), load: () => Promise.resolve([]), add() {}, check: () => true };
    this.__listeners = Object.create(null);
    this.documentElement = this.__make('html');
    this.head = this.__make('head');
    this.body = this.__make('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  __make(tag, attrs) {
    const el = new El(tag, this.__env, attrs);
    el.ownerDocument = this;
    this.__all.push(el);
    if (el.id) this.__byId[el.id] = el;
    return el;
  }

  createElement(tag) { return this.__make(tag); }
  createElementNS(_ns, tag) { return this.__make(tag); }
  createTextNode(text) {
    const env = this.__env;
    const n = new El('#text', env, {});
    n.nodeType = 3; n.tagName = undefined; n.nodeName = '#text'; n.textContent = String(text);
    return n;
  }
  createDocumentFragment() { return this.__make('#fragment'); }
  createRange() { return { selectNodeContents() {}, setStart() {}, setEnd() {}, getBoundingClientRect: () => new El('div', this.__env).getBoundingClientRect() }; }
  getElementById(id) { return this.__byId[id] || null; }
  getElementsByTagName(tag) { return queryAll(this.__all, tag); }
  getElementsByClassName(c) { return queryAll(this.__all, '.' + c); }
  querySelector(sel) { return queryAll(this.__all, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this.__all, sel); }
  addEventListener(type, fn, opts) { (this.__listeners[type] = this.__listeners[type] || []).push({ fn, once: !!(opts && opts.once) }); }
  removeEventListener(type, fn) { const l = this.__listeners[type]; if (l) this.__listeners[type] = l.filter((x) => x.fn !== fn); }
  dispatchEvent(ev) {
    const type = ev && ev.type;
    if (!type) return true;
    const l = (this.__listeners[type] || []).slice();
    for (const it of l) {
      try { it.fn.call(this, ev); } catch (e) { this.__env.__onError(e, `document:${type}`); }
      if (it.once) this.removeEventListener(type, it.fn);
    }
    return true;
  }
  exitFullscreen() { return Promise.resolve(); }
  exitPointerLock() {}
  hasFocus() { return true; }
  elementFromPoint() { return this.body; }
  /** Register an element discovered while scanning the real HTML. */
  __register(el) {
    this.__all.push(el);
    el.ownerDocument = this;
    if (el.id) this.__byId[el.id] = el;
    return el;
  }
}

// ── audio ─────────────────────────────────────────────────────────────────────────────────

function makeAudioClasses(state, defer) {
  const param = (v) => ({
    value: v, defaultValue: v,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {}, setValueCurveAtTime() {},
  });
  const node = (extra) => Object.assign({
    connect() { return this; }, disconnect() {}, start() {}, stop() {},
  }, extra || {});

  class AudioContext {
    constructor() {
      this.sampleRate = 44100;
      this.state = 'running';
      this.destination = node({ maxChannelCount: 2 });
      this.listener = { positionX: param(0), positionY: param(0), positionZ: param(0) };
    }
    get currentTime() { return state.now / 1000; }
    createOscillator() { return node({ type: 'sine', frequency: param(440), detune: param(0), onended: null }); }
    createGain() { return node({ gain: param(1) }); }
    createBiquadFilter() { return node({ type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) }); }
    createDynamicsCompressor() { return node({ threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) }); }
    createStereoPanner() { return node({ pan: param(0) }); }
    createBufferSource() { return node({ buffer: null, loop: false, playbackRate: param(1) }); }
    createBuffer(ch, len, rate) {
      const d = new Float32Array(Math.max(1, ch * len));
      return { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / (rate || 44100), getChannelData: () => d };
    }
    createPeriodicWave() { return {}; }
    decodeAudioData(_buf, ok) { const p = Promise.resolve({ duration: 1 }); if (ok) p.then(ok); return p; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    addEventListener() {} removeEventListener() {}
  }

  class SimAudio {
    constructor(src) {
      this.src = src || '';
      this.currentTime = 0;
      this.duration = 1;
      this.volume = 1;
      this.loop = false;
      this.muted = false;
      this.paused = true;
      this.preload = 'auto';
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    cloneNode() { return new SimAudio(this.src); }
    addEventListener() {} removeEventListener() {}
  }

  class SimImage {
    constructor(w, h) {
      this.width = w || 0; this.height = h || 0;
      this.naturalWidth = this.width; this.naturalHeight = this.height;
      this.complete = false; this.crossOrigin = null; this.onload = null; this.onerror = null;
      this._src = '';
    }
    get src() { return this._src; }
    set src(v) {
      this._src = String(v);
      // Fire onload asynchronously, like a decoded image would: pages that gate their first
      // render on image loading must still make progress in the simulator.
      (defer || setTimeout)(() => {
        this.complete = true;
        if (!this.width) { this.width = 64; this.height = 64; this.naturalWidth = 64; this.naturalHeight = 64; }
        if (typeof this.onload === 'function') { try { this.onload({ target: this }); } catch (_) { /* page error */ } }
      }, 0);
    }
    addEventListener(t, fn) { if (t === 'load') this.onload = fn; }
    removeEventListener() {}
    decode() { return Promise.resolve(); }
  }

  return { AudioContext, SimAudio, SimImage };
}

// ── counters ──────────────────────────────────────────────────────────────────────────────

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

// ── the environment ───────────────────────────────────────────────────────────────────────

/**
 * Build the sandbox. Returns an object the runner drives:
 *   window        the sandbox object itself (also the vm context global)
 *   document      the Document
 *   addElement()  register an element parsed out of the page's HTML
 *   stepFrame(ms) advance the virtual clock by ms and run one animation frame
 *   finish()      drain microtasks/timers due at the final clock value
 */
function makeEnv(opts) {
  const o = opts || {};
  const viewport = { width: (o.viewport && o.viewport.width) || 1280,
                     height: (o.viewport && o.viewport.height) || 800 };
  const state = {
    now: 0, baseEpoch: 1700000000000, draws: 0, timersRun: 0, frames: 0,
    stub: new Map(), console: [], errors: [], warnings: [],
    consoleLimit: o.consoleLimit || 400,
    timers: new Map(), raf: [], timerSeq: 1, rafSeq: 1,
    rand: mulberry32(o.seed === undefined ? 12345 : (o.seed | 0)),
  };

  const env = {};
  env.__state = state;
  env.__vp = viewport;
  env.__onError = (err, where) => {
    state.errors.push({ where: where || 'runtime', name: err && err.name, message: String((err && err.message) || err) });
  };

  const doc = new Doc(env);
  doc.__env = env;
  env.document = doc;

  // ---- location ---------------------------------------------------------------------
  let search = o.search || '';
  if (search && search[0] !== '?') search = '?' + search;
  const loc = {
    href: (o.href || 'file:///page.html') + search,
    protocol: 'file:', host: '', hostname: '', port: '',
    pathname: o.pathname || '/page.html',
    search,
    hash: o.hash || '',
    origin: 'file://',
    reload() {}, assign(u) { this.href = String(u); }, replace(u) { this.href = String(u); },
    toString() { return this.href; },
  };
  env.location = loc;

  // ---- deterministic time ------------------------------------------------------------
  const RealDate = Date;
  class SimDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(state.baseEpoch + state.now);
      else super(...a);
    }
    static now() { return state.baseEpoch + state.now; }
  }
  SimDate.parse = RealDate.parse;
  SimDate.UTC = RealDate.UTC;

  const perf = {
    now: () => state.now,
    timeOrigin: state.baseEpoch,
    mark() {}, measure() {}, clearMarks() {}, clearMeasures() {},
    getEntries: () => [], getEntriesByName: () => [], getEntriesByType: () => [],
    memory: { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0 },
  };

  // ---- timers ------------------------------------------------------------------------
  const addTimer = (fn, ms, args, every) => {
    if (typeof fn !== 'function') {
      try { fn = new Function(String(fn)); } catch (_) { return 0; }   // setTimeout("code")
    }
    const id = state.timerSeq++;
    state.timers.set(id, { id, at: state.now + Math.max(0, +ms || 0), fn, args: args || [], every });
    return id;
  };
  const setTimeoutV = (fn, ms, ...args) => addTimer(fn, ms, args, 0);
  const setIntervalV = (fn, ms, ...args) => addTimer(fn, ms, args, Math.max(1, +ms || 1));
  const clearTimer = (id) => { state.timers.delete(id); };
  const requestAnimationFrame = (cb) => { const id = state.rafSeq++; state.raf.push({ id, cb }); return id; };
  const cancelAnimationFrame = (id) => { state.raf = state.raf.filter((x) => x.id !== id); };

  const runDueTimers = () => {
    let guard = 0;
    for (;;) {
      let best = null;
      for (const t of state.timers.values()) if (t.at <= state.now && (!best || t.at < best.at)) best = t;
      if (!best) break;
      if (++guard > 5000) { state.warnings.push('timer storm: >5000 timers due in one frame (0ms loop?) -- stopped'); break; }
      if (best.every) best.at = state.now + best.every; else state.timers.delete(best.id);
      state.timersRun++;
      try { best.fn(...best.args); } catch (e) { env.__onError(e, `timer:${best.id}`); }
    }
  };

  // ---- console -----------------------------------------------------------------------
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'number' || typeof a === 'boolean' || a === null || a === undefined) return String(a);
    try {
      const seen = new WeakSet();
      return JSON.stringify(a, (k, v) => {
        if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      });
    } catch (_) { return Object.prototype.toString.call(a); }
  };
  const pushLog = (level, args) => {
    if (state.console.length >= state.consoleLimit) {
      if (state.console.length === state.consoleLimit) state.console.push({ level: 'warn', text: `…console truncated at ${state.consoleLimit} lines` });
      return;
    }
    const text = args.map(fmt).join(' ');
    state.console.push({ level, text: text.length > 500 ? text.slice(0, 500) + '…' : text });
  };
  const consoleObj = {};
  for (const lv of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) {
    consoleObj[lv] = (...a) => pushLog(lv === 'dir' || lv === 'table' ? 'log' : lv, a);
  }
  Object.assign(consoleObj, {
    group: (...a) => pushLog('log', a), groupCollapsed: (...a) => pushLog('log', a), groupEnd() {},
    time() {}, timeEnd() {}, timeLog() {}, count() {}, countReset() {}, assert() {}, clear() {},
  });

  // ---- window level event target ------------------------------------------------------
  const winListeners = Object.create(null);
  const addWinListener = (type, fn, opts) => { (winListeners[type] = winListeners[type] || []).push({ fn, once: !!(opts && opts.once) }); };
  const removeWinListener = (type, fn) => { const l = winListeners[type]; if (l) winListeners[type] = l.filter((x) => x.fn !== fn); };

  const dispatchWindow = (type, ev) => {
    const e = Object.assign({ type, target: env, currentTarget: env, defaultPrevented: false,
                              preventDefault() { this.defaultPrevented = true; },
                              stopPropagation() {} }, ev || {});
    const l = (winListeners[type] || []).slice();
    for (const it of l) {
      try { it.fn.call(env, e); } catch (err) { env.__onError(err, `window:${type}`); }
      if (it.once) removeWinListener(type, it.fn);
    }
    const inline = env[`on${type}`];
    if (typeof inline === 'function') { try { inline.call(env, e); } catch (err) { env.__onError(err, `on${type}`); } }
    doc.dispatchEvent(e);                     // document listeners see window events too
  };

  // ---- audio / image -----------------------------------------------------------------
  const { AudioContext, SimAudio, SimImage } = makeAudioClasses(state, setTimeoutV);

  // ---- the sandbox object ------------------------------------------------------------
  const w = env;                              // `window` IS the global object
  Object.assign(w, {
    window: w, self: w, top: w, parent: w, frames: w, globalThis: w, frameElement: null,
    document: doc, location: loc,
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NebulaSim/1.0 (headless; no pixels)',
      appName: 'Netscape', appVersion: '5.0 (Windows)', platform: 'Win32',
      language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'], onLine: true,
      hardwareConcurrency: 8, maxTouchPoints: 0, cookieEnabled: true, doNotTrack: null,
      userAgentData: { mobile: false, platform: 'Windows' },
      vibrate: () => true, javaEnabled: () => false,
    },
    screen: { width: viewport.width, height: viewport.height,
              availWidth: viewport.width, availHeight: viewport.height,
              colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } },
    innerWidth: viewport.width, innerHeight: viewport.height,
    outerWidth: viewport.width, outerHeight: viewport.height,
    devicePixelRatio: 1, screenX: 0, screenY: 0, scrollX: 0, scrollY: 0,
    pageXOffset: 0, pageYOffset: 0, isSecureContext: false, origin: 'file://',
    name: '', status: '', closed: false, length: 0, opener: null,
    localStorage: new Storage(), sessionStorage: new Storage(),
    performance: perf, console: consoleObj,
    requestAnimationFrame, cancelAnimationFrame,
    webkitRequestAnimationFrame: requestAnimationFrame,
    mozRequestAnimationFrame: requestAnimationFrame,
    setTimeout: setTimeoutV, setInterval: setIntervalV,
    clearTimeout: clearTimer, clearInterval: clearTimer,
    queueMicrotask: (fn) => { Promise.resolve().then(() => { try { fn(); } catch (e) { env.__onError(e, 'microtask'); } }); },
    requestIdleCallback: (fn) => setTimeoutV(() => fn({ didTimeout: false, timeRemaining: () => 8 }), 1),
    cancelIdleCallback: clearTimer,
    AudioContext, webkitAudioContext: AudioContext,
    Audio: SimAudio, webkitAudio: SimAudio,
    Image: SimImage, HTMLImageElement: SimImage, HTMLCanvasElement: class {},
    addEventListener: addWinListener, removeEventListener: removeWinListener,
    dispatchEvent: (ev) => { dispatchWindow((ev && ev.type) || 'unknown', ev); return true; },
    matchMedia: (q) => ({ matches: false, media: String(q), onchange: null,
                          addListener() {}, removeListener() {},
                          addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: (el) => makeStyle(el && el.style ? undefined : undefined),
    alert: () => undefined, confirm: () => true, prompt: () => '',
    print: () => undefined, open: () => null, close() {}, focus() {}, blur() {},
    scrollTo() {}, scrollBy() {}, moveTo() {}, resizeTo() {},
    history: { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    locationbar: { visible: true }, menubar: { visible: true }, toolbar: { visible: true },
    crypto: {
      getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(state.rand() * 256); return arr; },
      randomUUID: () => '00000000-0000-4000-8000-' + String(Math.floor(state.rand() * 1e12)).padStart(12, '0'),
    },
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob, structuredClone,
    DOMException, Event: class Event { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    ResizeObserver: class ResizeObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class IntersectionObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class MutationObserver { constructor(cb) { this.cb = cb; } observe() {} takeRecords() { return []; } disconnect() {} },
    Element: El, HTMLElement: El, HTMLDivElement: El, HTMLBodyElement: El,
    Node: El, Document: Doc, CanvasRenderingContext2D: Object,
    Date: SimDate,
    // Honest boundaries: things a pixel-less, offline simulator cannot do.
    fetch: (u) => Promise.reject(new Error(`nebula-sim: no network (fetch ${String(u)} blocked) -- use browser__render for a real page`)),
    XMLHttpRequest: class XMLHttpRequest {
      constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; this.onload = null; this.onerror = null; }
      open(m, u) { this._u = u; } setRequestHeader() {} send() {
        const self = this;
        setTimeoutV(() => { self.readyState = 4; self.status = 0;
          if (typeof self.onerror === 'function') self.onerror(new Error('nebula-sim: no network'));
        }, 0);
      }
      abort() {} addEventListener() {} getAllResponseHeaders() { return ''; }
    },
    WebSocket: class WebSocket { constructor(u) { throw new Error(`nebula-sim: WebSocket not supported (${u}) -- use browser__render for a real page`); } },
    Worker: class Worker { constructor(u) { throw new Error(`nebula-sim: Worker not supported (${u})`); } },
    Notification: class Notification { constructor() {} static requestPermission() { return Promise.resolve('denied'); } close() {} },
    RTCPeerConnection: class RTCPeerConnection { constructor() { throw new Error('nebula-sim: WebRTC not supported'); } },
  });

  // getComputedStyle must answer with an object whose values reflect inline styles.
  w.getComputedStyle = (el) => makeStyle(el && el.style ? Object.assign({}, el.style) : null);

  // One deterministic Math.random per run (games reseed per frame otherwise).
  w.__rand = state.rand;

  // ---- driving API -------------------------------------------------------------------
  const api = {
    window: w,
    document: doc,
    state,
    addElement(spec) {
      const el = new El(spec.tag, env, spec.attrs || {});
      if (spec.parentId) {
        const p = doc.getElementById(spec.parentId);
        if (p) p.appendChild(el);
      } else if (spec.tag !== 'html' && spec.tag !== 'head' && spec.tag !== 'body') {
        doc.body.appendChild(el);
      }
      return doc.__register(el);
    },
    stepFrame(dtMs) {
      state.now += dtMs;
      state.frames++;
      runDueTimers();
      const q = state.raf;
      state.raf = [];
      for (const it of q) {
        try { it.cb(state.now); } catch (e) { env.__onError(e, `raf@${state.frames}`); }
      }
    },
    finish() {
      // Drain timers that are already due (macrotask tail), then let promise jobs settle.
      runDueTimers();
      return new Promise((res) => setImmediate(res));
    },
    dispatchKey(type, code, extra) {
      dispatchWindow(type, Object.assign({
        key: keyForCode(code), code, keyCode: keyCodeFor(code), which: keyCodeFor(code),
        bubbles: true, cancelable: true, repeat: false, defaultPrevented: false,
      }, extra || {}));
    },
    dispatchPointer(type, x, y, targetId) {
      const target = (targetId && doc.getElementById(targetId)) || doc.getElementById('game') || doc.body;
      const ev = { type, clientX: x, clientY: y, offsetX: x, offsetY: y, pageX: x, pageY: y,
                   x, y, button: 0, buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0,
                   bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
                   isPrimary: true, pressure: 0.5, preventDefault() {}, stopPropagation() {} };
      target.dispatchEvent(ev);
      dispatchWindow(type, ev);
    },
    dispatchClick(targetId) {
      const t = (targetId && doc.getElementById(targetId)) || doc.body;
      t.dispatchEvent({ type: 'click', bubbles: true, preventDefault() {}, stopPropagation() {} });
    },
    supportedGlobals: () => Object.keys(w).filter((k) => !k.startsWith('__')).sort(),
    readStorage() {
      return { local: w.localStorage.toObject(), session: w.sessionStorage.toObject() };
    },
  };
  env.__api = api;
  return api;
}

function keyForCode(code) {
  const map = {
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    Space: ' ', Enter: 'Enter', Escape: 'Escape', ShiftLeft: 'Shift', ShiftRight: 'Shift',
    KeyA: 'a', KeyD: 'd', KeyP: 'p', KeyR: 'r', KeyS: 's', KeyW: 'w', KeyM: 'm',
  };
  if (map[code]) return map[code];
  if (/^Key([A-Z])$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit(\d)$/.test(code)) return code.slice(5);
  return code;
}

function keyCodeFor(code) {
  const special = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32,
                    Enter: 13, Escape: 27, ShiftLeft: 16, ShiftRight: 16 };
  if (special[code]) return special[code];
  if (/^Key([A-Z])$/.test(code)) return code.charCodeAt(3);
  if (/^Digit(\d)$/.test(code)) return code.charCodeAt(5);
  return 0;
}

module.exports = { makeEnv, PLACEHOLDER_PNG, textWidth, CTX2D_METHODS };
