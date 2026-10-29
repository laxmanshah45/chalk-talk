// Chalk Talk lesson player
// Plays a lesson scene by scene. Each scene's chalk picture starts as a faint sketch; the moment
// the narration mentions a part, the player traces that part's outline in chalk, colours it in,
// and writes its label with an arrow. Students can raise their hand to ask a question at any time.

const $ = (sel) => document.querySelector(sel);
const els = {
  form: $("#topic-form"), topic: $("#topic"), level: $("#level"), make: $("#make"),
  sample: $("#sample"), saved: $("#saved"), askError: $("#ask-error"), title: $("#lesson-title"),
  board: $("#board"), picture: $("#picture"), heading: $("#scene-heading"), visuals: $("#visuals"),
  build: $("#build"), status: $("#board-status"), wipe: $("#wipe"),
  caption: $("#caption"), play: $("#play"), prev: $("#prev"), next: $("#next"),
  replay: $("#replay"), hand: $("#hand"), dots: $("#dots"), quiz: $("#quiz"),
  handPanel: $("#hand-panel"), handStatus: $("#hand-status"), handForm: $("#hand-form"),
  handText: $("#hand-text"), handClose: $("#hand-close"),
  voice: $("#voice"), rate: $("#rate"), voiceNote: $("#voice-note"), browserVoiceRow: $("#browser-voice-row"),
};

const SVG_NS = "http://www.w3.org/2000/svg";
const SAMPLE = "/samples/volcano/";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const synth = window.speechSynthesis;
// One shared audio element. The first click "unlocks" it, so Safari lets it play later on.
const player = new Audio();

let serverVoice = null; // Kokoro voice name when the server can narrate, else null
let voices = [];
let lesson = null;
let base = "";          // folder the lesson's pictures and audio live in
let ready = [];         // ready[i] once scene i has its picture, outlines and voice
let sceneIndex = 0;
let playing = false;
let waitingFor = -1;    // scene index playback is waiting on while it's still being made
let runId = 0;          // bumps on every stop, so events from old speech are ignored
let sentenceAt = 0;     // sentence to resume from after a pause
let words = [];         // { el, start, end, norm } for each word in the caption
let marks = [];         // { wordIndex, fire, activate, done } for each part of the board
let activeMark = null;
let board = null;       // what's drawn for the current scene (picture or cards)
let building = false;
let buildToken = 0;     // bumps when a different lesson is opened, so a running build stops driving the player
let started = false;
let finishClip = null;  // resolves the clip that's playing, so stop() never leaves it hanging
let finding = null;     // the "Find it" round after the last scene: { rounds, at, score, round, locked }

// ---------- Startup ----------

fetch("/api/config").then((r) => r.json()).then((cfg) => {
  serverVoice = cfg.voice;
  els.voiceNote.textContent = serverVoice
    ? `Narration uses Kokoro (${serverVoice}), an open-weight voice running on your computer. Lessons made without it use the browser voice below.`
    : "Narration uses your browser's voice. Run npm install to add the natural Kokoro voice.";
  if (!cfg.hasKey) els.askError.textContent = "Add your Meta Model API key to .env to make new lessons. The sample lesson works without one.";
}).catch(() => {});
document.fonts?.load('64px "Patrick Hand"');
refreshSaved();

// Quick start guide: open on the first visit, remember once it's dismissed.
const howto = $("#howto");
const HOWTO_SEEN = "chalk-talk-howto-seen";
try { if (!localStorage.getItem(HOWTO_SEEN)) howto.hidden = false; } catch { howto.hidden = false; }
$("#howto-open").addEventListener("click", () => {
  howto.hidden = !howto.hidden;
  if (!howto.hidden) howto.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
});
$("#howto-close").addEventListener("click", () => {
  howto.hidden = true;
  try { localStorage.setItem(HOWTO_SEEN, "1"); } catch {}
});

// ---------- Making a new lesson ----------

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const topic = els.topic.value.trim();
  if (!topic) {
    els.askError.textContent = "Type a topic first, like “How do volcanoes erupt?”";
    els.topic.focus();
    return;
  }
  els.askError.textContent = "";
  unlockAudio();
  resetPlayer();
  const token = ++buildToken;
  els.make.disabled = true;
  building = true;
  started = false;
  showBuild();
  try {
    const res = await fetch("/api/lesson", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, level: els.level.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server returned ${res.status}`);
    }
    // Keep reading even if another lesson was opened meanwhile, so this one still finishes and saves.
    for await (const event of readLines(res.body)) if (token === buildToken) onBuildEvent(event);
    if (token === buildToken && !lesson) throw new Error("The lesson didn't arrive. Try again.");
  } catch (err) {
    if (token !== buildToken) return;
    if (!started) { hideBuild(); showMessage("That didn’t work."); }
    els.askError.textContent = location.protocol === "file:"
      ? "Open this page through the server: run npm start, then go to http://localhost:3000"
      : err.message;
  } finally {
    building = false;
    els.make.disabled = false;
    updateTitle();
    refreshSaved();
  }
});

els.topic.addEventListener("input", () => { els.askError.textContent = ""; });
els.sample.addEventListener("click", () => openLesson(SAMPLE));

function onBuildEvent(ev) {
  if (ev.type === "error") throw new Error(ev.error);
  if (ev.type === "script") {
    lesson = normalize(ev.lesson);
    base = ev.base;
    ready = lesson.scenes.map(() => false);
    sceneIndex = 0;
    buildScript();
    renderDots();
    updateButtons();
    updateTitle();
  } else if (ev.type === "progress") {
    buildStep(ev.index, ev.step, ev.src);
  } else if (ev.type === "scene") {
    lesson.scenes[ev.index] = normalizeScene(ev.scene);
    ready[ev.index] = true;
    preload(ev.index);
    buildStep(ev.index, "ready");
    renderDots();
    updateTitle();
    if (!started && ev.index === 0) startLesson();
    else if (waitingFor === ev.index) { waitingFor = -1; renderScene(ev.index); play(); }
  } else if (ev.type === "done") {
    lesson.cost = ev.cost;
    lesson.seconds = ev.seconds;
    building = false;
    updateTitle();
  }
}

// Read a stream of one-JSON-object-per-line.
async function* readLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

function startLesson() {
  started = true;
  hideBuild();
  renderScene(0);
  play();
}

// ---------- Saved lessons ----------

// The lesson gallery: the sample first, then lessons you've made, newest first.
async function refreshSaved() {
  const data = await fetch("/api/lessons").then((r) => r.json()).catch(() => null);
  els.saved.innerHTML = "";
  els.saved.append(lessonCard({ title: "How Volcanoes Erupt", thumb: `${SAMPLE}scene-4.jpg`, meta: "Works without an API key", folder: SAMPLE, sample: true }));
  for (const item of (data?.lessons || []).slice(0, 12)) {
    const when = item.createdAt ? new Date(item.createdAt) : null;
    const meta = [item.scenes ? `${item.scenes} scenes` : "", when ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""].filter(Boolean).join(" · ");
    els.saved.append(lessonCard({ title: item.title, thumb: item.thumb, meta, folder: `/lessons/${item.id}/` }));
  }
}

function lessonCard({ title, thumb, meta, folder, sample }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lesson-card" + (sample ? " sample" : "");
  const pic = document.createElement("span");
  pic.className = "lesson-card-pic";
  if (thumb) {
    const img = document.createElement("img");
    img.src = thumb;
    img.alt = "";
    img.loading = "lazy";
    pic.append(img);
  }
  if (sample) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Sample";
    pic.append(badge);
  }
  const t = document.createElement("span");
  t.className = "lesson-card-title";
  t.textContent = title;
  const m = document.createElement("span");
  m.className = "lesson-card-meta";
  m.textContent = meta;
  b.append(pic, t, m);
  b.addEventListener("click", () => openLesson(folder));
  return b;
}

// "Try" ideas fill in the topic box; Make lesson is still one click away, so nothing is spent by accident.
for (const idea of document.querySelectorAll(".idea")) {
  idea.addEventListener("click", () => {
    els.topic.value = idea.textContent;
    els.askError.textContent = "";
    els.make.focus();
  });
}

async function openLesson(folder) {
  unlockAudio();
  els.askError.textContent = "";
  try {
    const res = await fetch(folder + "lesson.json");
    if (!res.ok) throw new Error("That lesson couldn’t be opened.");
    const data = await res.json();
    resetPlayer();
    buildToken++;
    building = false;
    lesson = normalize(data);
    base = folder;
    ready = lesson.scenes.map(() => true);
    lesson.scenes.forEach((_, i) => preload(i));
    updateTitle();
    startLesson();
  } catch (err) {
    els.askError.textContent = err.message;
  }
}

function resetPlayer() {
  stop();
  hideQuiz();
  closeHand();
  lesson = null;
  ready = [];
  sceneIndex = 0;
  waitingFor = -1;
  updateTitle();
  renderDots();
  updateButtons();
}

// Lessons made by the first version had "visuals" instead of "parts".
function normalize(data) {
  data.scenes = (data.scenes || []).map(normalizeScene);
  return data;
}
function normalizeScene(s) {
  if (!Array.isArray(s.parts)) s.parts = (s.visuals || []).map((v) => ({ label: v.label, find: v.note, trigger: v.trigger }));
  return s;
}

const media = (src) => (/^(\/|https?:|data:|blob:)/.test(src) ? src : base + src);

function preload(i) {
  const s = lesson.scenes[i];
  if (s.image) new Image().src = media(s.image.src);
  for (const clip of s.speech || []) fetch(media(clip.src)).catch(() => {});
}

function updateTitle() {
  els.title.textContent = "";
  if (!lesson) return;
  const left = ready.filter((r) => !r).length;
  const note = document.createElement("span");
  note.className = "title-note";
  if (building && left && started) note.textContent = `still making ${left} scene${left > 1 ? "s" : ""}…`;
  else if (lesson.cost && lesson.seconds) {
    const cents = lesson.cost.usd * 100;
    note.textContent = `made in ${Math.floor(lesson.seconds / 60)}:${String(lesson.seconds % 60).padStart(2, "0")} for about ${cents < 1 ? cents.toFixed(1) : Math.round(cents)}¢ of API credit`;
  }
  els.title.append(lesson.title, note);
}

// ---------- Build panel: each Meta model's step, live ----------

const STEP_TEXT = {
  waiting: "Waiting for the script",
  painting: "Muse Image is painting",
  repainting: "Not clear enough, so Muse Image is repainting",
  painted: "Muse Spark is finding the parts",
  looking: "Muse Spark is finding the parts",
  tracing: "SAM 3.1 is tracing the outlines",
  ready: "Ready",
};
const PIPELINE = [
  ["script", "Muse Spark", "writes the lesson"],
  ["paint", "Muse Image", "paints every scene"],
  ["find", "Muse Spark", "finds each part"],
  ["trace", "SAM 3.1", "traces the outlines"],
  ["voice", "Kokoro", "records the narration"],
];
const STEP_ORDER = ["waiting", "painting", "painted", "looking", "tracing", "ready"];
let buildTimer = null;

function showBuild() {
  showMessage("");
  els.heading.textContent = "";
  const steps = PIPELINE.filter(([k]) => k !== "voice" || serverVoice);
  els.build.innerHTML = `
    <p class="build-title chalk">Making your lesson <span class="build-time">0:00</span></p>
    <p class="build-stage">Muse Spark is writing the script, the pictures it needs, and a quiz…</p>
    <ol class="pipeline">${steps.map(([k, who, what]) => `<li data-k="${k}"><b>${who}</b><span>${what}</span></li>`).join("")}</ol>
    <ol class="film">${Array.from({ length: 5 }, () => `<li class="shot pending"><div class="shot-img"></div><p class="shot-head">&nbsp;</p><p class="shot-step">&nbsp;</p></li>`).join("")}</ol>`;
  updatePipeline();
  els.build.hidden = false;
  const t0 = Date.now();
  clearInterval(buildTimer);
  buildTimer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    const t = els.build.querySelector(".build-time");
    if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
}

function buildScript() {
  els.build.querySelector(".build-stage").textContent = `“${lesson.title}”: every scene is now being painted, studied and traced at the same time.`;
  const film = els.build.querySelector(".film");
  film.innerHTML = "";
  lesson.scenes.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "shot";
    li.dataset.step = "waiting";
    li.innerHTML = `<div class="shot-img"></div><p class="shot-head"></p><p class="shot-step"></p>`;
    li.querySelector(".shot-head").textContent = `${i + 1}. ${s.heading}`;
    li.querySelector(".shot-step").textContent = STEP_TEXT.waiting;
    film.append(li);
  });
  updatePipeline();
}

// Light up whichever models are working right now, and tick off the ones that are done.
function updatePipeline() {
  const steps = [...els.build.querySelectorAll(".shot[data-step]")].map((s) => STEP_ORDER.indexOf(s.dataset.step === "repainting" ? "painting" : s.dataset.step));
  const all = (min) => steps.length > 0 && steps.every((r) => r >= min);
  const any = (lo, hi) => steps.some((r) => r >= lo && r <= hi);
  const state = {
    script: lesson ? "done" : "now",
    paint: !lesson ? "" : all(2) ? "done" : "now",
    find: all(4) ? "done" : any(2, 3) ? "now" : "",
    trace: all(5) ? "done" : any(4, 4) ? "now" : "",
    voice: !lesson ? "" : all(5) ? "done" : "now",
  };
  for (const li of els.build.querySelectorAll(".pipeline li")) li.className = state[li.dataset.k];
}

function buildStep(i, step, src) {
  const li = els.build.querySelectorAll(".shot")[i];
  if (!li) return;
  li.dataset.step = step;
  li.querySelector(".shot-step").textContent = STEP_TEXT[step] || step;
  updatePipeline();
  if (src) {
    // A repainted picture replaces the first one.
    let img = li.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.onload = () => img.classList.add("on");
      li.querySelector(".shot-img").append(img);
    }
    img.src = media(src);
  }
}

function hideBuild() {
  clearInterval(buildTimer);
  els.build.hidden = true;
  els.build.innerHTML = "";
}

function showMessage(text) {
  clearBoard();
  els.heading.textContent = "";
  els.caption.textContent = "";
  els.status.textContent = text;
}

// ---------- Drawing a scene ----------

const norm = (w) => (w || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function renderScene(i) {
  const scene = lesson.scenes[i];
  els.heading.textContent = scene.heading || "";
  els.heading.classList.remove("write");
  void els.heading.offsetWidth;
  els.heading.classList.add("write");
  els.status.textContent = "";
  renderCaption(scene.narration);
  clearBoard();

  if (!ready[i]) {
    els.status.textContent = "Muse Image is still painting this scene…";
  } else {
    board = scene.image ? drawPicture(scene) : drawCards(scene);
  }
  marks = sceneMarks(scene);
  sentenceAt = 0;
  renderDots();
  updateButtons();
}

function renderCaption(text) {
  els.caption.innerHTML = "";
  words = [];
  for (const m of text.matchAll(/\S+/g)) {
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = m[0];
    els.caption.append(span, " ");
    words.push({ el: span, start: m.index, end: m.index + m[0].length, norm: norm(m[0]) });
  }
  activeMark = null;
}

// When each part should appear: at its trigger word. A part whose trigger isn't in the
// narration is spread evenly through the scene instead of all landing at the start.
function sceneMarks(scene) {
  let searchFrom = 0;
  const n = scene.parts.length;
  return scene.parts.map((p, k) => {
    let wi = findWord(p.trigger, searchFrom);
    if (wi === -1) wi = findWord(p.trigger, 0);
    if (wi === -1) wi = Math.round((words.length * (k + 1)) / (n + 1)); else searchFrom = wi + 1;
    return {
      wordIndex: wi,
      done: !!board?.isRevealed(k),
      fire: () => board?.reveal(k),
      activate: () => board?.activate(k),
    };
  });
}

function findWord(trigger, from) {
  const t = norm(trigger);
  if (!t) return -1;
  for (let i = from; i < words.length; i++) {
    const w = words[i].norm;
    if (w === t) return i;
    if (t.length >= 4 && w.length >= 4 && (w.startsWith(t) || t.startsWith(w))) return i;
  }
  return -1;
}

// Light up spoken words, and draw every part whose trigger word has been reached.
function markProgress(idx) {
  words.forEach((w, i) => {
    w.el.classList.toggle("spoken", i < idx);
    w.el.classList.toggle("current", i === idx);
  });
  let latest = null;
  for (const m of marks) {
    if (m.wordIndex > idx) continue;
    if (!m.done) { m.done = true; m.fire(); }
    latest = m;
  }
  if (latest && latest !== activeMark) { activeMark = latest; latest.activate(); }
}

function wordAt(charIndex) {
  let found = 0;
  for (let i = 0; i < words.length; i++) if (words[i].start <= charIndex) found = i;
  return found;
}

function clearBoard() {
  board = null;
  els.sample.hidden = true; // the empty board's "Play the sample lesson" button is only for the first visit
  els.picture.toggleAttribute("hidden", true);
  els.picture.innerHTML = "";
  els.picture.classList.remove("on");
  els.visuals.innerHTML = "";
  els.board.classList.remove("has-picture");
}

// Scenes without a picture fall back to chalk cards.
function drawCards(scene) {
  const cards = scene.parts.map((p) => {
    const card = document.createElement("div");
    card.className = "visual";
    const label = document.createElement("span");
    label.className = "v-label";
    label.textContent = p.label;
    const note = document.createElement("span");
    note.className = "v-note";
    note.textContent = p.find || "";
    card.append(label, note);
    els.visuals.append(card);
    return card;
  });
  return {
    isRevealed: (k) => cards[k]?.classList.contains("shown"),
    reveal: (k) => cards[k]?.classList.add("shown"),
    activate: (k) => cards.forEach((c, j) => c.classList.toggle("active", j === k)),
    pulse: (k) => { cards[k]?.classList.add("shown"); cards.forEach((c, j) => c.classList.toggle("active", j === k)); },
    finish: () => cards.forEach((c) => c.classList.add("shown")),
  };
}

// ---------- The chalk picture ----------

let uid = 0;

function svg(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

// The board's SVG layers, bottom to top: a faint sketch of the whole picture, each part in
// full colour (clipped to its SAM outline, hidden until spoken), the full picture (shown at
// the end of the scene), the chalk outlines, the labels and arrows, and the chalk stick.
function drawPicture(scene) {
  const { width: W, height: H, src } = scene.image;
  const href = media(src);
  const id = `p${++uid}`;
  const root = els.picture;
  root.setAttribute("viewBox", `0 0 ${W} ${H}`);
  root.innerHTML = "";
  root.toggleAttribute("hidden", false); // SVG elements have no .hidden property
  els.board.classList.add("has-picture");

  const defs = svg("defs", {}, root);
  defs.innerHTML = `
    <filter id="${id}-sketch"><feColorMatrix type="saturate" values="0.15"/></filter>
    <filter id="${id}-chalk" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="4" result="wobble"/>
      <feDisplacementMap in="SourceGraphic" in2="wobble" scale="6" xChannelSelector="R" yChannelSelector="G" result="rough"/>
      <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="1" seed="9" result="grain"/>
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.75" result="holes"/>
      <feComposite in="rough" in2="holes" operator="in"/>
    </filter>`;

  svg("image", { href, width: W, height: H, class: "sketch", filter: `url(#${id}-sketch)` }, root);
  const litLayer = svg("g", {}, root);
  const full = svg("image", { href, width: W, height: H, class: "full" }, root);
  const lineLayer = svg("g", { class: "lines", filter: `url(#${id}-chalk)` }, root);
  const labelLayer = svg("g", { class: "labels" }, root);
  const tip = svg("g", { class: "tip" }, root);
  svg("rect", { x: -7, y: -78, width: 26, height: 86, rx: 8, transform: "rotate(30)" }, tip);

  const shapes = scene.parts.map((p) => p.shape || (p.hint ? ellipseShape(p.hint) : null));
  const layout = layoutLabels(scene.parts, shapes, W, H);
  const parts = scene.parts.map((p, k) => {
    const shape = shapes[k];
    const part = { k, shape, revealed: false };
    if (shape) {
      const clip = svg("clipPath", { id: `${id}-clip-${k}` }, defs);
      svg("path", { d: polygonPath(shape.contours), "clip-rule": "evenodd" }, clip);
      part.lit = svg("image", { href, width: W, height: H, class: "lit", "clip-path": `url(#${id}-clip-${k})` }, litLayer);
      part.outline = svg("g", { class: "outline" }, lineLayer);
      part.traces = shape.contours.map((c) => svg("path", { d: smoothPath(c), pathLength: 1, class: "trace" }, part.outline));
    }
    part.label = drawLabel(labelLayer, p.label, layout[k], shape, k, id, defs);
    return part;
  });

  requestAnimationFrame(() => root.classList.add("on"));

  // A slow camera move toward the part being explained, and back out at the end of the scene.
  let view = [0, 0, W, H];
  let viewRun = 0;
  const moveView = (to, ms) => {
    const from = view.slice();
    const run = ++viewRun;
    tween(reduceMotion ? 0 : ms, (t) => {
      if (run !== viewRun || board !== self) return;
      const e = easeInOut(t);
      view = from.map((v, i) => v + (to[i] - v) * e);
      root.setAttribute("viewBox", view.map((v) => Math.round(v * 10) / 10).join(" "));
    });
  };
  const focus = (k) => {
    const box = shapes[k]?.box;
    if (!box) return;
    const [l, t, r, b] = box;
    // Big parts already fill the board; keep the whole picture in view for them.
    if (r - l > W * 0.7 || b - t > H * 0.7) { moveView([0, 0, W, H], 1600); return; }
    const w = W * 0.82, h = H * 0.82;
    // Lean toward the part rather than centring it, so the move stays gentle.
    const fx = W / 2 + ((l + r) / 2 - W / 2) * 0.75, fy = H / 2 + ((t + b) / 2 - H / 2) * 0.75;
    moveView([Math.max(0, Math.min(W - w, fx - w / 2)), Math.max(0, Math.min(H - h, fy - h / 2)), w, h], 1600);
  };

  const self = {
    isRevealed: (k) => !!parts[k]?.revealed,
    reveal: (k) => revealPart(self, parts[k], tip),
    activate: (k) => {
      parts.forEach((p) => {
        p.outline?.classList.toggle("active", p.k === k);
        p.label?.group.classList.toggle("active", p.k === k);
      });
      focus(k);
    },
    // "Find it": show the whole picture with no labels, and test where the student tapped.
    showAll: () => full.classList.add("on"),
    hitTest: (clientX, clientY, target) => {
      const pt = root.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const p = pt.matrixTransform(root.getScreenCTM().inverse());
      // Count taps just outside the target's outline too: fingers aren't precise.
      const near = W * 0.015;
      let k = shapes[target] && (insideShape(shapes[target], p.x, p.y) || distanceToShape(shapes[target], p.x, p.y) < near) ? target : -1;
      if (k === -1) k = shapes.findIndex((s) => s && insideShape(s, p.x, p.y));
      return { k, x: p.x, y: p.y };
    },
    miss: (x, y) => {
      const s = W * 0.018;
      const mark = svg("path", { d: `M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}`, pathLength: 1, class: "miss" }, lineLayer);
      tween(reduceMotion ? 0 : 300, (t) => { mark.style.strokeDashoffset = String(1 - t); });
    },
    answer: (k) => {
      parts[k]?.outline?.classList.add("answer");
      parts[k]?.label?.group.classList.add("answer");
      revealPart(self, parts[k], tip);
    },
    pulse: (k) => {
      const p = parts[k];
      if (!p) return;
      if (!p.revealed) revealPart(self, p, tip);
      for (const node of [p.outline, p.label?.group]) {
        if (!node) continue;
        node.classList.remove("pulse");
        void node.getBoundingClientRect();
        node.classList.add("pulse");
      }
    },
    finish: () => {
      parts.forEach((p) => { if (!p.revealed) revealPart(self, p, tip, true); });
      full.classList.add("on");
      parts.forEach((p) => p.outline?.classList.add("rest"));
      moveView([0, 0, W, H], 1800);
    },
  };
  return self;
}

// Even-odd point-in-polygon across all of a shape's contours (so holes stay holes).
function insideShape(shape, x, y) {
  let inside = false;
  for (const c of shape.contours) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const [xi, yi] = c[i], [xj, yj] = c[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function distanceToShape(shape, x, y) {
  let best = Infinity;
  for (const c of shape.contours) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const [ax, ay] = c[j], [bx, by] = c[i];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
  }
  return best;
}

// Trace the outline with a moving chalk stick, colour the part in, then write its label.
function revealPart(owner, part, tip, quick) {
  if (!part || part.revealed) return;
  part.revealed = true;
  const fast = quick || reduceMotion;
  const alive = () => board === owner;

  part.lit?.classList.add("on");
  const traceMs = fast ? 0 : Math.min(1500, 650 + (part.shape ? perimeter(part.shape.contours[0]) * 0.45 : 0));
  const main = part.traces?.[0];
  const len = main ? main.getTotalLength() : 0;
  if (!fast && main) tip.classList.add("on");
  tween(traceMs, (t) => {
    if (!alive()) return;
    const e = easeInOut(t);
    part.traces?.forEach((p) => { p.style.strokeDashoffset = String(1 - e); });
    if (main && !fast) {
      const pt = main.getPointAtLength(len * e);
      tip.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
    }
  }, () => {
    if (!alive()) return;
    tip.classList.remove("on");
    writeLabel(part.label, fast);
  });
}

function writeLabel(label, fast) {
  if (!label) return;
  label.group.classList.add("on");
  const arrowMs = fast ? 0 : 380;
  label.arrows.forEach((p) => { p.style.strokeDashoffset = "1"; });
  tween(arrowMs, (t) => label.arrows.forEach((p) => { p.style.strokeDashoffset = String(1 - easeOut(t)); }), () => {
    tween(fast ? 0 : 520, (t) => label.wipe.setAttribute("width", String(label.width * easeOut(t))));
  });
}

// A label is chalk text in a clip that widens left to right (so it looks written),
// plus a hand-drawn arrow to the nearest edge of the part.
function drawLabel(layer, text, spot, shape, k, id, defs) {
  const [x1, y1, x2, y2] = spot.rect;
  const group = svg("g", { class: "label" }, layer);
  const arrows = [];
  if (shape && !spot.inside) {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const target = arrowTarget(shape, cx, cy);
    const start = rectExit([x1 - 10, y1 - 6, x2 + 10, y2 + 6], cx, cy, target[0], target[1]);
    for (const d of arrowPaths(start, target, k)) arrows.push(svg("path", { d, pathLength: 1, class: "arrow" }, group));
  }
  const clip = svg("clipPath", { id: `${id}-label-${k}` }, defs);
  const wipe = svg("rect", { x: x1 - 20, y: y1 - 20, width: 0, height: y2 - y1 + 40 }, clip);
  const t = svg("text", {
    x: (x1 + x2) / 2, y: (y1 + y2) / 2, "font-size": spot.fontSize,
    "text-anchor": "middle", "dominant-baseline": "central", "clip-path": `url(#${id}-label-${k})`,
  }, group);
  t.textContent = text;
  return { group, arrows, wipe, width: x2 - x1 + 40 };
}

// ---------- Label layout ----------

// Place each label near its part, inside the board, clear of the heading, the other parts,
// and the labels already placed. Very large parts get their label written on top of them.
function layoutLabels(parts, shapes, W, H) {
  const fontSize = Math.round(W * 0.03);
  const h = Math.round(fontSize * 1.25);
  const margin = Math.round(W * 0.015);
  const heading = [0, 0, W * 0.62, H * 0.15];
  const boxes = shapes.map((s) => s?.box || null);
  const placed = [];
  return parts.map((p, k) => {
    const w = Math.round(measure(p.label, fontSize) + fontSize * 0.5);
    const box = boxes[k];
    let best = null;
    const consider = (x, y, cost, inside) => {
      const rect = [x, y, x + w, y + h];
      if (rect[0] < margin || rect[1] < margin || rect[2] > W - margin || rect[3] > H - margin) return;
      let score = cost + overlapFrac(rect, heading) * 300;
      // Short arrows read best: measure from the label to the nearest point of the actual outline,
      // not its bounding box (a thin part can sit deep inside another part's box).
      if (shapes[k] && !inside) {
        const [rcx, rcy] = [x + w / 2, y + h / 2];
        const [tx, ty] = arrowTarget(shapes[k], rcx, rcy);
        const [sx, sy] = rectExit(rect, rcx, rcy, tx, ty);
        score += (Math.hypot(tx - sx, ty - sy) / W) * 160;
      }
      for (const q of placed) score += overlapFrac(rect, grow(q, fontSize * 0.4)) * 2000;
      boxes.forEach((b, j) => { if (b && j !== k) score += overlapFrac(rect, b) * 70; });
      if (box && !inside) score += overlapFrac(rect, box) * 160;
      if (!best || score < best.score) best = { rect, score, inside };
    };
    if (box) {
      const [l, t, r, b] = box;
      const cx = (l + r) / 2, cy = (t + b) / 2;
      for (const gap of [W * 0.02, W * 0.05, W * 0.09, W * 0.14]) {
        for (let a = 0; a < 360; a += 15) {
          const dx = Math.cos((a * Math.PI) / 180), dy = Math.sin((a * Math.PI) / 180);
          const s = Math.min(dx ? (r - l) / 2 / Math.abs(dx) : Infinity, dy ? (b - t) / 2 / Math.abs(dy) : Infinity);
          const ex = cx + dx * (s + gap), ey = cy + dy * (s + gap);
          // Sit the label so its near side faces the part; sideways spots read best.
          consider(ex - w / 2 + (dx * w) / 2, ey - h / 2 + (dy * h) / 2, Math.abs(dy) * 4, false);
        }
      }
      const area = (r - l) * (b - t);
      const [mx, my] = shapes[k]?.center || [cx, cy];
      consider(mx - w / 2, my - h / 2, area > W * H * 0.2 ? 6 : 45, true);
    } else {
      for (let y = H - margin - h; y > H * 0.2; y -= h * 1.3) consider(margin, y, 30, true);
    }
    if (!best) best = { rect: [margin, H - margin - h, margin + w, H - margin], inside: true };
    placed.push(best.rect);
    return { rect: best.rect, inside: best.inside, fontSize };
  });
}

const measureCtx = document.createElement("canvas").getContext("2d");
function measure(text, size) {
  measureCtx.font = `${size}px "Patrick Hand", cursive`;
  return measureCtx.measureText(text).width || text.length * size * 0.46;
}

function overlapFrac(a, b) {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return (iw * ih) / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
}
const grow = (r, by) => [r[0] - by, r[1] - by, r[2] + by, r[3] + by];

// The arrow lands just inside the part, at the outline point nearest the label.
function arrowTarget(shape, cx, cy) {
  let best = null, bestD = Infinity;
  for (const c of shape.contours) {
    for (const p of c) {
      const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  const [mx, my] = shape.center;
  const dist = Math.hypot(mx - best[0], my - best[1]) || 1;
  const pull = Math.min(36, dist * 0.25);
  return [best[0] + ((mx - best[0]) / dist) * pull, best[1] + ((my - best[1]) / dist) * pull];
}

// Where the line from the label's centre toward the target leaves the label's box.
function rectExit(r, cx, cy, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  const sx = dx ? ((dx > 0 ? r[2] : r[0]) - cx) / dx : Infinity;
  const sy = dy ? ((dy > 0 ? r[3] : r[1]) - cy) / dy : Infinity;
  const s = Math.min(1, Math.max(0, Math.min(sx, sy)));
  return [cx + dx * s, cy + dy * s];
}

// A slightly bent, hand-drawn arrow. Uses rough.js when it loaded, plain curves otherwise.
function arrowPaths([x1, y1], [x2, y2], seed) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const bend = len * 0.12 * (seed % 2 ? 1 : -1);
  const mx = (x1 + x2) / 2 + (-(y2 - y1) / len) * bend;
  const my = (y1 + y2) / 2 + ((x2 - x1) / len) * bend;
  const hl = Math.hypot(x2 - mx, y2 - my) || 1;
  const ux = (x2 - mx) / hl, uy = (y2 - my) / hl;
  const size = Math.min(38, len * 0.35), a = 0.5;
  const left = [x2 - size * (ux * Math.cos(a) - uy * Math.sin(a)), y2 - size * (uy * Math.cos(a) + ux * Math.sin(a))];
  const right = [x2 - size * (ux * Math.cos(a) + uy * Math.sin(a)), y2 - size * (uy * Math.cos(a) - ux * Math.sin(a))];
  if (window.rough) {
    const gen = rough.generator();
    const opts = { roughness: 0.8, bowing: 0.5, seed: seed + 3, strokeWidth: 5 };
    return [
      ...gen.toPaths(gen.curve([[x1, y1], [mx, my], [x2, y2]], opts)),
      ...gen.toPaths(gen.linearPath([left, [x2, y2], right], opts)),
    ].map((p) => p.d);
  }
  return [`M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}`, `M${left[0]} ${left[1]}L${x2} ${y2}L${right[0]} ${right[1]}`];
}

// ---------- Shapes ----------

// Smooth closed curve through the outline points (Catmull-Rom), starting at the top.
function smoothPath(points) {
  const n = points.length;
  if (n < 3) return "";
  const top = points.reduce((best, p, i) => (p[1] < points[best][1] ? i : best), 0);
  const pts = points.slice(top).concat(points.slice(0, top));
  const r = (v) => Math.round(v * 10) / 10;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${r(p1[0] + (p2[0] - p0[0]) / 6)} ${r(p1[1] + (p2[1] - p0[1]) / 6)} ${r(p2[0] - (p3[0] - p1[0]) / 6)} ${r(p2[1] - (p3[1] - p1[1]) / 6)} ${p2[0]} ${p2[1]}`;
  }
  return d + "Z";
}

const polygonPath = (contours) => contours.map((c) => `M${c.map((p) => `${p[0]} ${p[1]}`).join("L")}Z`).join("");

function perimeter(c) {
  let sum = 0;
  for (let i = 0; i < c.length; i++) sum += Math.hypot(c[(i + 1) % c.length][0] - c[i][0], c[(i + 1) % c.length][1] - c[i][1]);
  return sum;
}

// When SAM couldn't outline a part, circle it in chalk using the box Muse Spark marked.
function ellipseShape([l, t, r, b]) {
  const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
  const contour = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2;
    return [Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))];
  });
  return { contours: [contour], box: [l, t, r, b], center: [cx, cy] };
}

function tween(ms, step, done) {
  if (ms <= 0) { step(1); done?.(); return; }
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    step(t);
    if (t < 1) requestAnimationFrame(tick); else done?.();
  };
  requestAnimationFrame(tick);
}
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;

// Erase the board between scenes.
function wipe(swap) {
  if (reduceMotion) { swap(); return Promise.resolve(); }
  els.wipe.classList.remove("go");
  void els.wipe.offsetWidth;
  els.wipe.classList.add("go");
  return new Promise((resolve) => {
    setTimeout(swap, 330);
    setTimeout(() => { els.wipe.classList.remove("go"); resolve(); }, 760);
  });
}

// ---------- Speaking ----------

// A scene's sentences, each with its audio clip when the server voiced it.
function sentencesFor(text, speech) {
  if (Array.isArray(speech) && speech.length) {
    return speech.map((s) => ({ text: text.slice(s.start, s.end), start: s.start, end: s.end, src: media(s.src), duration: s.duration }));
  }
  const out = [];
  for (const m of text.matchAll(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)) {
    if (m[0].trim()) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

async function play() {
  if (!lesson) return;
  if (!ready[sceneIndex]) {
    playing = true;
    waitingFor = sceneIndex;
    els.status.textContent = "Muse Image is still painting this scene…";
    updateButtons();
    return;
  }
  const scene = lesson.scenes[sceneIndex];
  const parts = sentencesFor(scene.narration, scene.speech);
  if (!parts[0]?.src && !synth) {
    els.status.textContent = "This browser can’t speak. Try Chrome, Edge, or Safari.";
    return;
  }
  const myRun = ++runId;
  playing = true;
  updateButtons();

  if (sentenceAt >= parts.length) renderScene(sceneIndex);

  for (let s = sentenceAt; s < parts.length; s++) {
    if (myRun !== runId) return;
    sentenceAt = s;
    const ok = await speakSentence(parts[s], myRun);
    if (ok === false) return;
  }
  if (myRun !== runId) return;

  markProgress(words.length);
  board?.finish();
  sentenceAt = parts.length;
  await wait(1800);
  if (myRun !== runId) return;

  if (sceneIndex < lesson.scenes.length - 1) {
    sceneIndex++;
    await wipe(() => renderScene(sceneIndex));
    if (myRun !== runId) return;
    play();
  } else {
    playing = false;
    updateButtons();
    startFinding();
  }
}

function speakSentence(part, myRun) {
  return part.src ? playClip(part, myRun) : speakBrowser(part, myRun);
}

// Play a narration clip, lighting each word up as it's (roughly) spoken. Kokoro doesn't
// report word timings, so they're estimated from word lengths and punctuation pauses.
function playClip(part, myRun) {
  return new Promise((resolve) => {
    const first = wordAt(part.start);
    const last = wordAt(Math.max(part.start, part.end - 1));
    const weights = [];
    for (let i = first; i <= last; i++) {
      const w = words[i].el.textContent;
      weights.push(w.replace(/[^\p{L}\p{N}]/gu, "").length + 2.5 + (/[,;:]$/.test(w) ? 3 : 0) + (/[.!?]$/.test(w) ? 2 : 0));
    }
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const speaking = part.duration * 0.92;
    const startsAt = [];
    let acc = 0.06;
    for (const wt of weights) { startsAt.push(acc); acc += (wt / total) * speaking; }

    let raf = 0;
    const done = (ok = true) => {
      cancelAnimationFrame(raf);
      player.onended = player.onerror = null;
      if (finishClip === done) finishClip = null;
      resolve(ok);
    };
    finishClip = done;
    const tick = () => {
      if (myRun !== runId) return;
      const t = player.currentTime;
      let i = 0;
      while (i + 1 < startsAt.length && startsAt[i + 1] <= t) i++;
      markProgress(first + i);
      raf = requestAnimationFrame(tick);
    };
    player.onended = () => done(true);
    player.onerror = () => done(true);
    player.src = part.src;
    player.playbackRate = Number(els.rate.value) || 1;
    markProgress(first);
    player.play().then(() => { if (myRun === runId) tick(); }, (err) => {
      if (err?.name === "NotAllowedError") {
        playing = false;
        updateButtons();
        els.status.textContent = "Press Play to start the lesson.";
        done(false);
      } else done(true);
    });
  });
}

// The browser's built-in voice, used when the server has no Kokoro voice.
function speakBrowser(part, myRun) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(part.text);
    const v = currentVoice();
    if (v) u.voice = v;
    u.rate = Number(els.rate.value) || 1;

    const first = wordAt(part.start);
    const last = wordAt(part.start + part.text.trimEnd().length - 1);
    let gotWordEvents = false;
    let timer = null;

    u.onstart = () => {
      if (myRun !== runId) return;
      markProgress(first);
      // Some voices never report word positions. If none arrive, step through words on a timer.
      const msPerWord = 60000 / (160 * u.rate);
      setTimeout(() => {
        if (gotWordEvents || myRun !== runId) return;
        let i = Math.min(first + Math.round(500 / msPerWord), last);
        markProgress(i);
        timer = setInterval(() => {
          if (myRun !== runId) return clearInterval(timer);
          i = Math.min(i + 1, last);
          markProgress(i);
        }, msPerWord);
      }, 500);
    };
    u.onboundary = (e) => {
      if (myRun !== runId || (e.name && e.name !== "word")) return;
      gotWordEvents = true;
      markProgress(wordAt(part.start + e.charIndex));
    };
    const done = () => { clearInterval(timer); resolve(true); };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  });
}

// Say a short line (quiz question, "Find it" prompt or feedback) in the lesson's voice.
// Resolves once it has been spoken, or cut off by something else.
let sayToken = 0;
async function say(text) {
  stopSound();
  const token = sayToken;
  if (serverVoice) {
    try {
      const res = await fetch("/api/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (token !== sayToken) return;
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        if (token !== sayToken) return;
        await new Promise((resolve) => {
          const done = () => {
            player.onended = player.onerror = null;
            if (finishClip === done) finishClip = null;
            URL.revokeObjectURL(url);
            resolve();
          };
          finishClip = done;
          player.onended = done;
          player.onerror = done;
          player.src = url;
          player.playbackRate = Number(els.rate.value) || 1;
          player.play().catch(done);
        });
        return;
      }
    } catch {}
  }
  if (!synth || token !== sayToken) return;
  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = currentVoice();
    if (v) u.voice = v;
    u.rate = Number(els.rate.value) || 1;
    u.onend = u.onerror = () => resolve();
    synth.speak(u);
  });
}

function stopSound() {
  sayToken++;
  if (synth) synth.cancel();
  player.pause();
  finishClip?.(true);
}

function stop() {
  runId++;
  waitingFor = -1;
  stopSound();
  playing = false;
  updateButtons();
}

let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  player.src = URL.createObjectURL(new Blob([encodeWav(new Float32Array(1600), 16000)], { type: "audio/wav" }));
  player.play().catch(() => {});
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Controls ----------

els.play.addEventListener("click", () => {
  unlockAudio();
  if (!els.handPanel.hidden) { resumeAfter = true; backToLesson(); return; }
  if (playing) { stop(); return; }
  // At the end of the lesson, Play starts it again from the top.
  if (finding || (sceneIndex === lesson.scenes.length - 1 && !els.quiz.hidden)) {
    goTo(0);
    return;
  }
  if (!board && ready[sceneIndex]) renderScene(sceneIndex);
  play();
});
els.prev.addEventListener("click", () => goTo(sceneIndex - 1));
els.next.addEventListener("click", () => (finding ? skipRound() : goTo(sceneIndex + 1)));
els.replay.addEventListener("click", () => goTo(sceneIndex));

function goTo(i) {
  if (!lesson || i < 0 || i >= lesson.scenes.length) return;
  stop();
  endFinding();
  hideQuiz();
  closeHand();
  sceneIndex = i;
  renderScene(i);
  play();
}

function renderDots() {
  els.dots.innerHTML = "";
  if (!lesson) return;
  lesson.scenes.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dot" + (i === sceneIndex ? " on" : "") + (ready[i] ? "" : " pending");
    b.setAttribute("aria-label", `Scene ${i + 1}: ${s.heading || ""}${ready[i] ? "" : " (still being made)"}`);
    if (i === sceneIndex) b.setAttribute("aria-current", "step");
    b.addEventListener("click", () => goTo(i));
    els.dots.append(b);
  });
}

function updateButtons() {
  const has = !!lesson && started;
  els.play.disabled = !has;
  els.play.textContent = playing ? "Pause" : finding ? "Start over" : "Play";
  els.prev.disabled = !has || sceneIndex === 0;
  els.next.disabled = !has || (!finding && sceneIndex >= lesson.scenes.length - 1);
  els.next.textContent = finding ? "Skip" : "Next";
  els.replay.disabled = !has;
  els.hand.disabled = !has || !ready[sceneIndex] || !!finding;
}

// Keyboard: Space plays or pauses, arrows change scene, H raises your hand.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const press = (btn) => { if (!btn.disabled) { e.preventDefault(); btn.click(); } };
  if (e.key === " " && e.target.tagName !== "BUTTON") press(els.play);
  else if (e.key === "ArrowRight") press(els.next);
  else if (e.key === "ArrowLeft") press(els.prev);
  else if (e.key === "h" || e.key === "H") press(els.hand);
});

// ---------- Find it: tap the parts on the picture ----------

// Up to three parts from different scenes: big enough to tap, small enough to be a real search.
function findRounds() {
  const options = [];
  lesson.scenes.forEach((s, i) => {
    if (!s.image || (i === 0 && lesson.scenes.length > 3)) return;
    const area = s.image.width * s.image.height;
    const fits = s.parts.map((p, k) => ({ k, a: (p.shape?.area || 0) / area })).filter((o) => o.a > 0.006 && o.a < 0.35);
    if (fits.length) options.push({ scene: i, k: fits[i % fits.length].k });
  });
  return options.length <= 3 ? options : [options[0], options[Math.floor(options.length / 2)], options[options.length - 1]];
}

const findPrompt = (label) => `Can you find the ${label}? Tap it on the picture.`;

function startFinding() {
  const rounds = findRounds();
  if (!rounds.length) { showQuiz(); return; }
  finding = { rounds, at: 0, score: 0, round: 0, locked: true };
  updateButtons();
  showRound();
}

async function showRound() {
  const f = finding;
  const r = f.rounds[f.at];
  const scene = lesson.scenes[r.scene];
  const label = scene.parts[r.k].label;
  const round = ++f.round;
  f.locked = true;
  await wipe(() => {
    clearBoard();
    board = drawPicture(scene);
    board.showAll();
    els.board.classList.add("finding");
    els.dots.hidden = true; // the round's pictures come from different scenes; the heading counts rounds instead
    els.heading.textContent = `Find it · ${f.at + 1} of ${f.rounds.length}`;
    els.status.textContent = "";
    renderCaption(findPrompt(label));
    marks = [];
  });
  if (finding !== f || f.round !== round) return;
  f.locked = false;
  say(findPrompt(label));
}

els.picture.addEventListener("click", async (e) => {
  const f = finding;
  if (!f || f.locked || !board?.hitTest) return;
  f.locked = true;
  const round = f.round;
  const r = f.rounds[f.at];
  const parts = lesson.scenes[r.scene].parts;
  const label = parts[r.k].label;
  const hit = board.hitTest(e.clientX, e.clientY, r.k);
  let line;
  if (hit.k === r.k) {
    f.score++;
    board.reveal(r.k);
    board.activate(r.k);
    line = `Yes! That’s the ${label}.`;
  } else {
    board.miss(hit.x, hit.y);
    board.answer(r.k);
    line = hit.k >= 0 ? `That’s the ${parts[hit.k].label}. The ${label} is here.` : `Not quite. The ${label} is here.`;
  }
  renderCaption(line);
  marks = [];
  await Promise.all([say(line), wait(2200)]);
  if (finding === f && f.round === round) nextRound();
});

function skipRound() {
  if (!finding) return;
  stopSound();
  nextRound();
}

function nextRound() {
  const f = finding;
  f.at++;
  if (f.at < f.rounds.length) { showRound(); return; }
  endFinding();
  const n = f.rounds.length;
  const line = f.score === n ? `You found all ${n}. Brilliant!` : `You found ${f.score} of ${n}.`;
  els.heading.textContent = line;
  renderCaption(`${line} Now one last question.`);
  marks = [];
  const myRun = runId;
  say(`${line} Now one last question.`).then(() => { if (runId === myRun && lesson) showQuiz(); });
}

function endFinding() {
  if (!finding) return;
  finding = null;
  els.board.classList.remove("finding");
  els.dots.hidden = false;
  updateButtons();
}

// ---------- Quiz ----------

function showQuiz() {
  const q = lesson.quiz;
  if (!q || !Array.isArray(q.choices)) return;
  els.quiz.innerHTML = "";
  const h = document.createElement("h3");
  h.textContent = "Check what you learned";
  const p = document.createElement("p");
  p.className = "q";
  p.textContent = q.question;
  const list = document.createElement("div");
  list.className = "choices";
  const feedback = document.createElement("p");
  feedback.className = "feedback";
  feedback.setAttribute("aria-live", "polite");

  q.choices.forEach((choice, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = choice;
    b.addEventListener("click", () => {
      list.querySelectorAll("button").forEach((x) => (x.disabled = true));
      const right = i === q.answer;
      b.classList.add(right ? "right" : "wrong");
      list.children[q.answer]?.classList.add("right");
      feedback.textContent = (right ? "That’s right. " : "Not quite. ") + (q.explain || "");
      say(feedback.textContent);
    });
    list.append(b);
  });

  els.quiz.append(h, p, list, feedback);
  els.quiz.hidden = false;
  say(q.question);
}

function hideQuiz() {
  els.quiz.hidden = true;
  els.quiz.innerHTML = "";
}

// ---------- Raise your hand ----------

let rec = null;          // the microphone recording in progress
let resumeAfter = false; // whether the lesson was playing when the hand went up

els.hand.addEventListener("click", async () => {
  if (rec) { await sendRecording(); return; }
  openHand();
  await startRecording();
});
els.handForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = els.handText.value.trim();
  if (!question) { els.handText.focus(); return; }
  cancelRecording();
  els.handText.value = "";
  askQuestion({ question });
});
els.handClose.addEventListener("click", () => backToLesson());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.handPanel.hidden) backToLesson(); });

function openHand() {
  if (els.handPanel.hidden) {
    resumeAfter = playing;
    stop();
  }
  els.handPanel.hidden = false;
}

function closeHand() {
  cancelRecording();
  els.handPanel.hidden = true;
  els.handStatus.textContent = "";
  setHandButton(false);
}

function backToLesson() {
  stop();
  closeHand();
  if (!lesson) return;
  // Restore the scene's caption and timings without redrawing the board.
  renderCaption(lesson.scenes[sceneIndex].narration);
  marks = sceneMarks(lesson.scenes[sceneIndex]);
  if (resumeAfter) { resumeAfter = false; play(); }
}

function setHandButton(listening) {
  els.hand.setAttribute("aria-pressed", String(listening));
  els.hand.classList.toggle("listening", listening);
  els.hand.innerHTML = listening ? `<span aria-hidden="true">●</span> Done asking` : `<span aria-hidden="true">✋</span> Raise hand`;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.handStatus.textContent = "This browser can’t use the microphone here. Type your question instead.";
    els.handText.focus();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(node);
    node.connect(ctx.destination);
    rec = { stream, ctx, source, node, chunks, timer: setTimeout(() => sendRecording(), 30000) };
    setHandButton(true);
    els.handStatus.textContent = "Listening… ask your question, then press Done asking.";
  } catch {
    els.handStatus.textContent = "The microphone is blocked. Type your question instead.";
    els.handText.focus();
  }
}

async function stopRecording() {
  const r = rec;
  rec = null;
  if (!r) return null;
  clearTimeout(r.timer);
  r.node.disconnect();
  r.source.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  const rate = r.ctx.sampleRate;
  await r.ctx.close().catch(() => {});
  setHandButton(false);
  const samples = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of r.chunks) { samples.set(c, o); o += c.length; }
  return samples.length > rate * 0.3 ? encodeWav(downsample(samples, rate, 16000), 16000) : null;
}

function cancelRecording() {
  if (rec) stopRecording();
}

async function sendRecording() {
  const wav = await stopRecording();
  if (!wav) {
    els.handStatus.textContent = "I didn’t hear anything. Press Raise hand to try again, or type your question.";
    return;
  }
  askQuestion({ audio: toBase64(wav) });
}

async function askQuestion(payload) {
  const scene = lesson.scenes[sceneIndex];
  els.handStatus.textContent = payload.audio ? "Muse Voice Transcribe is listening back…" : "Muse Spark is thinking…";
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        context: { title: lesson.title, level: lesson.level, heading: scene.heading, narration: scene.narration, labels: scene.parts.map((p) => p.label) },
        image: scene.image ? media(scene.image.src) : "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    if (data.heard === false) {
      els.handStatus.textContent = "I didn’t catch that. Press Raise hand to try again, or type your question.";
      return;
    }
    els.handStatus.textContent = `You asked: “${data.question}”`;
    await playAnswer(data);
  } catch (err) {
    els.handStatus.textContent = err.message;
  }
}

// Speak the answer in the caption area, pointing at the parts of the picture it mentions.
async function playAnswer(data) {
  stop();
  const myRun = runId;
  playing = false;
  renderCaption(data.answer);
  const labels = lesson.scenes[sceneIndex].parts.map((p) => p.label);
  let from = 0;
  marks = [];
  for (const pt of data.point || []) {
    const k = labels.indexOf(pt.label);
    if (k === -1) continue;
    let wi = findWord(pt.trigger, from);
    if (wi === -1) wi = findWord(pt.trigger, 0);
    if (wi === -1) wi = 0; else from = wi + 1;
    marks.push({ wordIndex: wi, done: false, fire: () => board?.pulse(k), activate: () => board?.activate(k) });
  }
  for (const part of sentencesFor(data.answer, data.speech)) {
    if (myRun !== runId) return;
    await speakSentence(part, myRun);
  }
  if (myRun !== runId) return;
  markProgress(words.length);
  els.handStatus.textContent += resumeAfter ? "  Back to the lesson…" : "";
  await wait(1500);
  if (myRun !== runId || els.handPanel.hidden) return;
  backToLesson();
}

function downsample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the source samples this output sample covers (a simple low-pass).
    const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Browser voices ----------

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^en/i.test(v.lang));
  if (!voices.length) voices = synth.getVoices();
  const saved = els.voice.value;
  els.voice.innerHTML = "";
  voices.forEach((v, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${v.name} (${v.lang})`;
    els.voice.append(o);
  });
  // Prefer a natural-sounding local voice when one exists.
  const best = voices.findIndex((v) => v.localService && /natural|neural|samantha|aria|jenny|guy|daniel/i.test(v.name));
  const fallback = voices.findIndex((v) => v.localService);
  els.voice.value = saved && voices[saved] ? saved : String(best !== -1 ? best : fallback !== -1 ? fallback : 0);
}

function currentVoice() {
  return voices[Number(els.voice.value)] || null;
}

if (synth) {
  loadVoices();
  synth.addEventListener?.("voiceschanged", loadVoices);
}
