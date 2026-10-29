// Chalk Talk lesson player
// Plays a lesson scene by scene. Each scene's chalk picture starts as a faint sketch; the moment
// the narration mentions a part, the player traces that part's outline in chalk, colours it in,
// and writes its label with an arrow. Students can raise their hand to ask a question at any time.

const $ = (sel) => document.querySelector(sel);
const els = {
  form: $("#topic-form"), topic: $("#topic"), make: $("#make"),
  sample: $("#sample"), saved: $("#saved"), askError: $("#ask-error"), title: $("#lesson-title"),
  board: $("#board"), picture: $("#picture"), heading: $("#scene-heading"), visuals: $("#visuals"),
  status: $("#board-status"), wipe: $("#wipe"), preview: $("#preview"), demoCaption: $("#demo-caption"), homeBuilding: $("#home-building"),
  makingTitle: $("#making-title"), makingStage: $("#making-stage"), makingBar: $("#making-bar"), makingTime: $("#making-time"),
  makingBg: $("#making-bg"), pipeline: $("#pipeline"), film: $("#film"), makingReady: $("#making-ready"),
  startLesson: $("#start-lesson"), startCount: $("#start-count"), makingError: $("#making-error"), makingErrorText: $("#making-error-text"),
  caption: $("#caption"), play: $("#play"), prev: $("#prev"), next: $("#next"),
  replay: $("#replay"), hand: $("#hand"), quiz: $("#quiz"),
  handPanel: $("#hand-panel"), handStatus: $("#hand-status"), handForm: $("#hand-form"),
  handText: $("#hand-text"), handClose: $("#hand-close"), bubble: $("#ask-bubble"), bubbleText: $("#ask-bubble-text"),
  askDone: $("#ask-done"), askCancel: $("#ask-cancel"),
  speed: $("#speed"), cc: $("#cc"), transcriptBtn: $("#transcript-btn"), transcript: $("#transcript"), sceneCount: $("#scene-count"),
  player: $("#player"), fullscreen: $("#fullscreen"), buildNote: $("#build-note"), lessonNote: $("#lesson-note"),
  photoBtn: $("#photo-btn"), photoInput: $("#photo-input"), photoChip: $("#photo-chip"), photoThumb: $("#photo-thumb"),
  photoRemove: $("#photo-remove"), snap: $("#snap"), dropZone: $("#drop-zone"),
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
let makingState = null; // the lesson being made: { topic, started (ms), timer, countdown } while the making screen has something to show
const GALLERY_SLOTS = 3; // saved lessons shown beside the sample before "See all"
let galleryOpen = false;
let sampleSummary = null;
let attachedPhoto = null; // a picture to build the next lesson around: { dataUrl, name }
let sentPhoto = null;     // the picture sent with the lesson being made, cleared once its script arrives

// ---------- Startup ----------

fetch("/api/config").then((r) => r.json()).then((cfg) => {
  serverVoice = cfg.voice;
  els.voiceNote.textContent = serverVoice
    ? `Narration uses Kokoro (${serverVoice}), an open-weight voice running on your computer. Lessons made without it use the browser voice below.`
    : "Narration uses your browser's voice. Run npm install to add the natural Kokoro voice.";
  if (!cfg.hasKey) els.askError.textContent = "Add your Meta Model API key to .env to make new lessons. The sample lesson works without one.";
}).catch(() => {});
document.fonts?.load('64px "Patrick Hand"').then(startDemo, startDemo);
refreshSaved();
$("#how-link").addEventListener("click", () => $("#how").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }));

// ---------- Screens: home, making a lesson, the lesson ----------
// Each screen has its own address (#/, #/making, #/lesson), so the browser's back button works.

const currentView = () => document.body.dataset.view;

// `replace` swaps the current history entry, so Back from a lesson skips the finished making screen.
function go(name, { replace = false } = {}) {
  const hash = name === "home" ? "#/" : `#/${name}`;
  if (location.hash === hash) route();
  else if (replace) { history.replaceState(null, "", hash); route(); }
  else location.hash = hash;
}

function route() {
  let name = location.hash.replace(/^#\/?/, "") || "home";
  if (!["home", "making", "lesson"].includes(name)) name = "home";
  // Nothing to show on these screens after a reload: start at home.
  if (name === "lesson" && !(lesson && started)) name = "home";
  if (name === "making" && !makingState) name = lesson && started ? "lesson" : "home";
  if (name !== "lesson" && currentView() === "lesson") {
    // Leaving the lesson: stop talking, put the hand down, leave full screen.
    exitFullscreen();
    stop();
    endFinding();
    closeHand();
  }
  if (name !== "making") stopCountdown();
  if (name === "home") { refreshSaved(); updateHomeBuilding(); }
  for (const v of document.querySelectorAll(".view")) v.hidden = v.dataset.view !== name;
  document.body.dataset.view = name;
  window.scrollTo(0, 0);
  // Back on the making screen with scene 1 already done: offer to start again.
  if (name === "making" && ready[0] && !started) showReady();
}
window.addEventListener("hashchange", route);
route();

// ---------- Home: real lesson scenes drawing themselves on the hero board ----------

let demo = null; // { scenes: [{ scene, n }], at, timers }

async function startDemo() {
  try {
    const data = await fetch(`${SAMPLE}lesson.json`).then((r) => r.json());
    // The eruption first, then the rest; skip any scene without outlines.
    const scenes = [3, 0, 1, 4, 2]
      .map((i) => ({ scene: data.scenes[i], n: i + 1 }))
      .filter(({ scene }) => scene?.image && scene.parts.some((p) => p.shape));
    if (!scenes.length) return;
    demo = { scenes, at: 0, timers: [] };
    showDemo();
  } catch {
    // The demo is decoration; the sample still plays if it fails.
  }
}

// One scene: fade in a faint sketch, then light up, trace and label each part in turn,
// show the finished picture, and fade to the next scene.
function showDemo() {
  demo.timers.forEach(clearTimeout);
  demo.timers = [];
  const later = (ms, fn) => demo.timers.push(setTimeout(fn, ms));
  // Only animate while the home screen is on show.
  if (currentView() !== "home" || document.hidden) { later(1000, showDemo); return; }
  const { scene, n } = demo.scenes[demo.at % demo.scenes.length];
  els.preview.classList.add("out");
  els.demoCaption.style.opacity = "0";
  later(demo.started ? 700 : 0, () => {
    demo.started = true;
    const parts = drawDemoScene(els.preview, scene);
    els.demoCaption.textContent = `Scene ${n} · ${scene.heading}`;
    els.demoCaption.style.opacity = "1";
    els.preview.classList.remove("out");
    const reveal = (part, on) => { part.lit.classList.toggle("on", on); part.g.classList.toggle("on", on); };
    if (reduceMotion) { parts.forEach((p) => reveal(p, true)); return; }
    const step = 1700;
    parts.forEach((part, k) => later(900 + k * step, () => {
      parts.forEach((o) => { if (o !== part && o.g.classList.contains("on")) o.g.classList.add("rest"); });
      reveal(part, true);
    }));
    const end = 900 + parts.length * step + 700;
    later(end, () => {
      parts.forEach((o) => o.g.classList.add("rest"));
      els.preview.querySelector(".dm-full")?.classList.add("on");
    });
    later(end + 2800, () => { demo.at++; showDemo(); });
  });
}

// The lesson board in miniature. The pictures sit in a mask that fades their edges into
// the hero's chalkboard; the chalk outlines and labels stay crisp on top.
function drawDemoScene(root, scene) {
  const { width: W, height: H, src } = scene.image;
  const href = `${SAMPLE}${src}`;
  const id = `dm${++uid}`;
  root.setAttribute("viewBox", `0 0 ${W} ${H}`);
  root.innerHTML = "";
  const defs = svg("defs", {}, root);
  defs.innerHTML = `
    <filter id="${id}-sketch"><feColorMatrix type="saturate" values="0.15"/></filter>
    <radialGradient id="${id}-fade" cx="50%" cy="52%" r="60%"><stop offset="62%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></radialGradient>
    <mask id="${id}-mask"><rect width="${W}" height="${H}" fill="url(#${id}-fade)"/></mask>`;
  const pictures = svg("g", { mask: `url(#${id}-mask)` }, root);
  svg("image", { href, width: W, height: H, class: "dm-sketch", filter: `url(#${id}-sketch)` }, pictures);
  svg("image", { href, width: W, height: H, class: "dm-full" }, pictures);

  const shapes = scene.parts.map((p) => p.shape || null);
  const layout = layoutLabels(scene.parts, shapes, W, H, 1.7);
  const parts = [];
  scene.parts.forEach((p, k) => {
    if (!shapes[k]) return;
    const clip = svg("clipPath", { id: `${id}-c${k}` }, defs);
    svg("path", { d: polygonPath(shapes[k].contours), "clip-rule": "evenodd" }, clip);
    const lit = svg("image", { href, width: W, height: H, class: "dm-lit", "clip-path": `url(#${id}-c${k})` }, pictures);
    const g = svg("g", { class: "dm-part" }, root);
    for (const c of shapes[k].contours) svg("path", { d: smoothPath(c), pathLength: 1, class: "dm-trace" }, g);
    const [x1, y1, x2, y2] = layout[k].rect;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (!layout[k].inside) {
      const target = arrowTarget(shapes[k], cx, cy);
      const start = rectExit([x1 - 10, y1 - 6, x2 + 10, y2 + 6], cx, cy, target[0], target[1]);
      for (const d of arrowPaths(start, target, k)) svg("path", { d, pathLength: 1, class: "dm-arrow" }, g);
    }
    const t = svg("text", { x: cx, y: cy, "font-size": layout[k].fontSize, "text-anchor": "middle", "dominant-baseline": "central", class: "dm-label" }, g);
    t.textContent = p.label;
    parts.push({ lit, g });
  });
  return parts;
}

const PHOTO_PLACEHOLDER = "Ask about it (optional)";

// The topic box's placeholder writes out example questions, one after another,
// whenever the box is empty and not being typed in.
(function typePlaceholders() {
  if (reduceMotion) return;
  const base = "What do you want to learn?";
  const examples = ["How do volcanoes erupt?", "Why is the sky blue?", "How do plants make food from sunlight?", "Why do we have seasons?", "What is inside an atom?", "How does the heart pump blood?"];
  let i = 0, text = "", deleting = false, hold = 40;
  setInterval(() => {
    if (attachedPhoto) return;
    if (document.activeElement === els.topic || els.topic.value || currentView() !== "home") {
      els.topic.placeholder = base;
      text = "";
      deleting = false;
      hold = 30;
      return;
    }
    if (hold > 0) { hold--; return; }
    const target = examples[i % examples.length];
    if (!deleting) {
      text = target.slice(0, text.length + 1);
      if (text === target) { deleting = true; hold = 32; }
    } else {
      text = text.slice(0, -1);
      if (!text) { deleting = false; i++; hold = 5; }
    }
    els.topic.placeholder = text;
  }, 55);
})();

// ---------- Making a new lesson ----------

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const topic = els.topic.value.trim();
  const photo = attachedPhoto;
  if (!topic && !photo) {
    els.askError.textContent = "Type a topic first, like “How do volcanoes erupt?”, or add a picture.";
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
  showBuild(topic || "Your picture");
  if (photo) paintBackground(photo.dataUrl);
  sentPhoto = photo;
  go("making");
  try {
    const res = await fetch("/api/lesson", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, level: document.querySelector('input[name="level"]:checked')?.value || "middle school", photo: photo?.dataUrl }),
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
    const message = location.protocol === "file:"
      ? "Open this page through the server: run npm start, then go to http://localhost:3000"
      : err.message;
    if (!started) buildFailed(message);
    else els.status.textContent = message;
  } finally {
    building = false;
    els.make.disabled = false;
    if (token === buildToken) {
      // Stop the clock but leave any "Starting in…" countdown running.
      tickMaking();
      clearInterval(makingState?.timer);
      updateTitle();
      updateHomeBuilding();
    }
    refreshSaved();
  }
});

els.topic.addEventListener("input", () => { els.askError.textContent = ""; });
els.sample.addEventListener("click", () => openLesson(SAMPLE));

function onBuildEvent(ev) {
  if (ev.type === "error") throw new Error(ev.error);
  if (ev.type === "script") {
    if (sentPhoto && attachedPhoto === sentPhoto) clearPhoto();
    sentPhoto = null;
    lesson = normalize(ev.lesson);
    base = ev.base;
    ready = lesson.scenes.map(() => false);
    sceneIndex = 0;
    buildScript();
    updateSceneCount();
    updateButtons();
    updateTitle();
  } else if (ev.type === "progress") {
    buildStep(ev.index, ev.step, ev.src);
  } else if (ev.type === "scene") {
    lesson.scenes[ev.index] = normalizeScene(ev.scene);
    ready[ev.index] = true;
    preload(ev.index);
    buildStep(ev.index, "ready");
    updateSceneCount();
    updateTitle();
    if (!started && ev.index === 0) showReady();
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
  stopCountdown();
  started = true;
  updateHomeBuilding();
  go("lesson", { replace: currentView() === "making" });
  updateTitle();
  renderScene(0);
  play();
}
els.startLesson.addEventListener("click", () => { unlockAudio(); startLesson(); });

// ---------- Saved lessons ----------

// The lesson gallery: one row of four, the sample first, then your newest lessons.
// "See all" opens the rest. With fewer than three lessons, topic ideas fill the row.
async function refreshSaved() {
  const [data, sample] = await Promise.all([
    fetch("/api/lessons").then((r) => r.json()).catch(() => null),
    sampleSummary || fetch(`${SAMPLE}lesson.json`).then((r) => r.json()).then(summarize).catch(() => null),
  ]);
  sampleSummary = sample;
  const lessons = data?.lessons || [];
  els.saved.innerHTML = "";
  els.saved.append(lessonCard({
    ...(sample || { title: "How Volcanoes Erupt" }),
    thumb: `${SAMPLE}scene-4.jpg`, folder: SAMPLE, sample: true,
  }));
  for (const item of galleryOpen ? lessons : lessons.slice(0, GALLERY_SLOTS)) {
    els.saved.append(lessonCard({ ...item, folder: `/lessons/${item.id}/` }));
  }
  const ideas = [...document.querySelectorAll(".idea")].map((b) => b.textContent);
  for (const idea of ideas.slice(0, Math.max(0, GALLERY_SLOTS - lessons.length))) els.saved.append(ideaCard(idea));

  const seeAll = $("#see-all");
  seeAll.hidden = lessons.length <= GALLERY_SLOTS;
  seeAll.textContent = galleryOpen ? "Show fewer" : `See all ${lessons.length + 1} lessons →`;
  seeAll.setAttribute("aria-expanded", String(galleryOpen));
}
$("#see-all").addEventListener("click", () => { galleryOpen = !galleryOpen; refreshSaved(); });

// The same summary the server sends for saved lessons, worked out from a lesson file.
function summarize(l) {
  const seconds = l.scenes.reduce((sum, s) => sum + (s.speech || []).reduce((a, c) => a + (c.duration || 0), 0), 0);
  return { title: l.title, topic: l.topic || "", level: l.level || "", scenes: l.scenes.length, listenMinutes: seconds ? Math.max(1, Math.round(seconds / 60)) : null, costUsd: l.cost?.usd ?? null, fromPhoto: !!l.photo };
}

const LEVEL_NAMES = { "elementary school": "Elementary", "middle school": "Middle school", "high school": "High school", college: "College" };

function lessonCard({ title, topic, level, scenes, listenMinutes, createdAt, costUsd, fromPhoto, thumb, folder, sample }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lesson-card" + (sample ? " sample" : "");
  b.setAttribute("aria-label", `Play ${title}`);
  b.innerHTML = `
    <span class="lesson-card-pic">${thumb ? `<img alt="" loading="lazy">` : ""}${sample ? `<span class="badge">Sample</span>` : ""}<span class="card-play" aria-hidden="true">&#9654;</span></span>
    <span class="lesson-card-body">
      <span class="lesson-card-title"></span>
      <span class="lesson-card-topic"></span>
      <span class="lesson-card-tags"></span>
      <span class="lesson-card-meta"></span>
    </span>`;
  if (thumb) b.querySelector("img").src = thumb;
  b.querySelector(".lesson-card-title").textContent = title;
  const t = b.querySelector(".lesson-card-topic");
  if (topic) t.textContent = `“${topic}”`; else t.remove();
  const tags = [fromPhoto ? "From a photo" : "", LEVEL_NAMES[level] || "", scenes ? `${scenes} scenes` : "", listenMinutes ? `${listenMinutes} min` : ""].filter(Boolean);
  b.querySelector(".lesson-card-tags").append(...tags.map((x) => Object.assign(document.createElement("span"), { textContent: x })));
  const when = createdAt ? new Date(createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const cost = costUsd ? `${Math.max(1, Math.round(costUsd * 100))}¢ of API credit` : "";
  b.querySelector(".lesson-card-meta").textContent = sample ? "Works without an API key" : [when, cost].filter(Boolean).join(" · ");
  b.addEventListener("click", () => openLesson(folder));
  return b;
}

// A topic you haven't made yet: one click puts it in the topic box.
function ideaCard(topic) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lesson-card idea-card";
  b.innerHTML = `<span class="idea-plus" aria-hidden="true">+</span><span class="lesson-card-title"></span><span class="lesson-card-meta">Make this lesson</span>`;
  b.querySelector(".lesson-card-title").textContent = topic;
  b.addEventListener("click", () => {
    els.topic.value = topic;
    els.askError.textContent = "";
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    els.make.focus({ preventScroll: true });
  });
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

// ---------- A picture to learn from: pick, drop or paste one ----------

els.photoBtn.addEventListener("click", () => els.photoInput.click());
els.snap.addEventListener("click", () => els.photoInput.click());
els.photoRemove.addEventListener("click", () => { clearPhoto(); els.topic.focus(); });
els.photoInput.addEventListener("change", () => {
  const file = els.photoInput.files?.[0];
  els.photoInput.value = "";
  if (file) usePhotoFile(file);
});

// Drag a picture anywhere over the home screen; the board shows where to drop it.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
const draggingFiles = (e) => currentView() === "home" && hasFiles(e);
// On the other screens, a dropped file would otherwise replace the app in the browser tab.
for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, (e) => { if (hasFiles(e) && currentView() !== "home") e.preventDefault(); });
}
document.addEventListener("dragenter", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.dropZone.hidden = false;
});
document.addEventListener("dragover", (e) => { if (draggingFiles(e)) e.preventDefault(); });
document.addEventListener("dragleave", (e) => {
  if (!draggingFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropZone.hidden = true;
});
document.addEventListener("drop", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropZone.hidden = true;
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (file) usePhotoFile(file);
  else els.askError.textContent = "That isn’t a picture. Try a JPG or PNG.";
});
// Paste a picture (a screenshot, say) while on the home screen.
document.addEventListener("paste", (e) => {
  if (currentView() !== "home") return;
  const types = [...(e.clipboardData?.types || [])];
  if (types.includes("text/plain") || types.includes("text/html")) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  usePhotoFile(item.getAsFile());
});

async function usePhotoFile(file) {
  els.askError.textContent = "";
  try {
    attachedPhoto = await shrinkPhoto(file);
    els.photoThumb.src = attachedPhoto.dataUrl;
    els.photoChip.hidden = false;
    els.photoBtn.hidden = true;
    els.topic.placeholder = PHOTO_PLACEHOLDER;
    els.topic.focus();
  } catch (err) {
    els.askError.textContent = err.message;
  }
}

function clearPhoto() {
  attachedPhoto = null;
  els.photoChip.hidden = true;
  els.photoBtn.hidden = false;
  els.photoThumb.removeAttribute("src");
  els.topic.placeholder = "What do you want to learn?";
}

// Big phone photos are shrunk to at most 1600 pixels on their long side and sent as JPEG.
async function shrinkPhoto(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("That isn’t a picture. Try a JPG or PNG.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That picture couldn’t be opened. Try a JPG or PNG."));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.88), name: file.name || "Pasted picture" };
  } finally {
    URL.revokeObjectURL(url);
  }
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
    hideBuild();
    makingState = null;
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
  updateSceneCount();
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

// The lesson's title in the control bar, a "still making" note beside the scene count while
// scenes are being made, and what the lesson cost under the player.
function updateTitle() {
  els.title.textContent = lesson?.title || "";
  const left = ready.filter((r) => !r).length;
  els.buildNote.textContent = lesson && building && left && started ? ` \u00b7 still making ${left} scene${left > 1 ? "s" : ""}\u2026` : "";
  let note = "";
  if (lesson?.cost && lesson.seconds) {
    const cents = lesson.cost.usd * 100;
    note = `Made in ${Math.floor(lesson.seconds / 60)}:${String(lesson.seconds % 60).padStart(2, "0")} for about ${cents < 1 ? cents.toFixed(1) : Math.round(cents)}\u00a2 of API credit.`;
  }
  els.lessonNote.textContent = note;
}

// ---------- Making a lesson: each Meta model's step, live ----------

// Short, because the scene cards are narrow; the stations above say which model is working.
const STEP_TEXT = {
  waiting: "Waiting",
  painting: "Painting",
  repainting: "Repainting",
  painted: "Finding parts",
  looking: "Finding parts",
  tracing: "Tracing",
  ready: "Ready",
};
const STEP_ORDER = ["waiting", "painting", "painted", "looking", "tracing", "ready"];
const ICONS = {
  script: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>',
  paint: '<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12c-3 0-5 2-5 5 0 1-1 2-2 2 2 2 7 2 9-1 1-2 1-4-2-6z"/>',
  find: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  trace: '<path d="M5 9c0-3 3-5 7-5s7 2 7 5-3 5-7 5c-2 0-3 1-3 2" stroke-dasharray="3 2.5"/><circle cx="9" cy="18.5" r="2"/>',
  voice: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
};
const PIPELINE = [
  ["script", "Muse Spark", "writes the lesson"],
  ["paint", "Muse Image", "paints every scene"],
  ["find", "Muse Spark", "finds each part"],
  ["trace", "SAM 3.1", "traces the outlines"],
  ["voice", "Kokoro", "records the narration"],
];

function showBuild(topic) {
  stopCountdown();
  clearInterval(makingState?.timer);
  makingState = { topic, started: Date.now(), timer: 0, countdown: 0 };
  els.makingTitle.textContent = topic;
  els.makingStage.textContent = "Muse Spark is writing the script, a picture plan for every scene, and a quiz…";
  els.makingReady.hidden = true;
  els.makingError.hidden = true;
  els.makingBg.innerHTML = "";
  const steps = PIPELINE.filter(([k]) => k !== "voice" || serverVoice);
  els.pipeline.innerHTML = steps.map(([k, who, what]) => `<li data-k="${k}"><span class="station"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg></span><b>${who}</b><small>${what}</small></li>`).join("");
  els.film.innerHTML = Array.from({ length: 6 }, (_, i) => `<li class="shot"><div class="shot-img"><span class="shot-num">${i + 1}</span></div><p class="shot-head"></p><p class="shot-step"></p></li>`).join("");
  updatePipeline();
  tickMaking();
  makingState.timer = setInterval(tickMaking, 1000);
}

// Once a second: the clock, and a progress bar that keeps creeping while the script is written.
function tickMaking() {
  if (!makingState) return;
  const s = Math.round((Date.now() - makingState.started) / 1000);
  els.makingTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const shots = [...els.film.querySelectorAll(".shot[data-step]")].map((li) => STEP_ORDER.indexOf(li.dataset.step === "repainting" ? "painting" : li.dataset.step));
  const progress = !lesson || !shots.length
    ? 0.16 * (1 - Math.exp(-s / 18))
    : 0.18 + 0.82 * (shots.reduce((a, r) => a + Math.max(0, r), 0) / (shots.length * 5));
  els.makingBar.style.width = `${Math.max(2, Math.round(progress * 100))}%`;
  els.makingBar.parentElement.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
}

function buildScript() {
  els.makingTitle.textContent = lesson.title;
  els.makingStage.textContent = `All ${lesson.scenes.length} scenes are being painted, checked and traced at the same time.`;
  els.film.innerHTML = "";
  lesson.scenes.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "shot";
    li.dataset.step = "waiting";
    li.innerHTML = `<div class="shot-img"><span class="shot-num">${i + 1}</span></div><p class="shot-head"></p><p class="shot-step"></p>`;
    li.querySelector(".shot-head").textContent = s.heading;
    li.querySelector(".shot-step").textContent = STEP_TEXT.waiting;
    els.film.append(li);
  });
  updatePipeline();
  tickMaking();
}

// Light up whichever models are working right now, and tick off the ones that are done.
function updatePipeline() {
  const steps = [...els.film.querySelectorAll(".shot[data-step]")].map((s) => STEP_ORDER.indexOf(s.dataset.step === "repainting" ? "painting" : s.dataset.step));
  const all = (min) => steps.length > 0 && steps.every((r) => r >= min);
  const any = (lo, hi) => steps.some((r) => r >= lo && r <= hi);
  const state = {
    script: lesson ? "done" : "now",
    paint: !lesson ? "" : all(2) ? "done" : "now",
    find: all(4) ? "done" : any(2, 3) ? "now" : "",
    trace: all(5) ? "done" : any(4, 4) ? "now" : "",
    voice: !lesson ? "" : all(5) ? "done" : "now",
  };
  for (const li of els.pipeline.querySelectorAll("li")) li.className = state[li.dataset.k];
}

function buildStep(i, step, src) {
  const li = els.film.querySelectorAll(".shot")[i];
  if (!li) return;
  li.dataset.step = step;
  li.querySelector(".shot-step").textContent = STEP_TEXT[step] || step;
  updatePipeline();
  tickMaking();
  updateHomeBuilding();
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
    paintBackground(media(src));
  }
}

// The newest painting glows softly behind the making screen.
function paintBackground(src) {
  const img = new Image();
  img.alt = "";
  img.onload = () => {
    els.makingBg.append(img);
    requestAnimationFrame(() => img.classList.add("on"));
    const old = [...els.makingBg.querySelectorAll("img")].slice(0, -2);
    old.forEach((o) => o.remove());
  };
  img.src = src;
}

// Scene 1 is ready: offer to start, and start by itself after a short countdown.
function showReady() {
  if (!makingState || started) return;
  els.makingReady.hidden = false;
  els.makingStage.textContent = "Scene 1 is ready. The rest will keep being made while you watch.";
  if (currentView() !== "making") return;
  let n = 3;
  const tick = () => {
    if (n <= 0) { stopCountdown(); startLesson(); return; }
    els.startCount.textContent = `Starting in ${n}…`;
    n--;
  };
  stopCountdown();
  tick();
  makingState.countdown = setInterval(tick, 1000);
}

function stopCountdown() {
  if (!makingState) return;
  clearInterval(makingState.countdown);
  makingState.countdown = 0;
  els.startCount.textContent = "Or keep watching the rest being made.";
}

function buildFailed(message) {
  stopCountdown();
  clearInterval(makingState?.timer);
  els.makingReady.hidden = true;
  els.makingError.hidden = false;
  els.makingErrorText.textContent = message;
  els.makingStage.textContent = "Something went wrong while making this lesson.";
}

function hideBuild() {
  clearInterval(makingState?.timer);
  stopCountdown();
}

// While a lesson is being made and you're back on the home screen, show how it's going.
function updateHomeBuilding() {
  const el = els.homeBuilding;
  if (!building || !makingState || started) { el.hidden = true; return; }
  const done = ready.filter(Boolean).length;
  el.hidden = false;
  el.innerHTML = `<span><span class="pulse-dot live"></span><span>Making <b></b> &middot; ${lesson ? `${done} of ${lesson.scenes.length} scenes ready` : "writing the script"}</span><span class="go">${done ? "Start it" : "Watch"} &rarr;</span></span>`;
  el.querySelector("b").textContent = `“${lesson?.title || makingState.topic}”`;
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
  els.transcript.textContent = scene.narration;
  renderCaption(scene.narration);
  clearBoard();

  if (!ready[i]) {
    els.status.textContent = "Muse Image is still painting this scene…";
  } else {
    board = scene.image ? drawPicture(scene) : drawCards(scene);
  }
  marks = sceneMarks(scene);
  sentenceAt = 0;
  updateSceneCount();
  updateButtons();
}

// The caption under the board works like subtitles: only the sentence being spoken is shown.
let shownSentence = -1;

function renderCaption(text) {
  els.caption.innerHTML = "";
  words = [];
  shownSentence = -1;
  let sentence = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = m[0];
    els.caption.append(span, " ");
    words.push({ el: span, start: m.index, end: m.index + m[0].length, norm: norm(m[0]), sentence });
    if (/[.!?]["')\]]*$/.test(m[0])) sentence++;
  }
  activeMark = null;
  showSentence(0);
}

function showSentence(idx) {
  const n = words[Math.min(Math.max(idx, 0), words.length - 1)]?.sentence ?? 0;
  if (n === shownSentence) return;
  shownSentence = n;
  for (const w of words) w.el.classList.toggle("off", w.sentence !== n);
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
  showSentence(idx);
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
    reset: () => cards.forEach((c) => c.classList.remove("active")),
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

  const self = {
    isRevealed: (k) => !!parts[k]?.revealed,
    reveal: (k) => revealPart(self, parts[k], tip),
    activate: (k) => parts.forEach((p) => {
      p.outline?.classList.toggle("active", p.k === k);
      p.label?.group.classList.toggle("active", p.k === k);
    }),
    // After a raised-hand answer: nothing highlighted.
    reset: () => parts.forEach((p) => {
      p.outline?.classList.remove("active", "pulse");
      p.label?.group.classList.remove("active", "pulse");
    }),
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
function layoutLabels(parts, shapes, W, H, scale = 1) {
  const fontSize = Math.round(W * 0.03 * scale);
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

// Speed, subtitles and transcript.
const SPEEDS = [[1, "1×", "normal"], [1.15, "1.15×", "faster"], [0.85, "0.85×", "slower"]];
els.speed.addEventListener("click", () => {
  const at = SPEEDS.findIndex(([r]) => r === Number(els.rate.value));
  const [rate, , name] = SPEEDS[(at + 1) % SPEEDS.length];
  setRate(rate);
  els.speed.setAttribute("aria-label", `Speed: ${name}`);
});
els.rate.addEventListener("input", () => setRate(Number(els.rate.value)));
function setRate(rate) {
  els.rate.value = String(rate);
  player.playbackRate = rate;
  const match = SPEEDS.find(([r]) => r === rate);
  els.speed.textContent = match ? match[1] : `${rate}×`;
}
els.cc.addEventListener("click", () => {
  const on = els.cc.getAttribute("aria-pressed") !== "true";
  els.cc.setAttribute("aria-pressed", String(on));
  els.caption.hidden = !on;
});
// Full screen shows just the player: board, subtitles and controls, like a video.
els.fullscreen.addEventListener("click", toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) exitFullscreen();
  else (els.player.requestFullscreen || els.player.webkitRequestFullscreen)?.call(els.player)?.catch?.(() => {});
}
function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
}
for (const event of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(event, () => {
    const on = (document.fullscreenElement || document.webkitFullscreenElement) === els.player;
    els.fullscreen.setAttribute("aria-pressed", String(on));
    els.fullscreen.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
  });
}
els.transcriptBtn.addEventListener("click", () => {
  const on = els.transcript.hidden;
  els.transcript.hidden = !on;
  els.transcriptBtn.setAttribute("aria-pressed", String(on));
});
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

// "Scene 2 of 5" beside the controls.
function updateSceneCount() {
  if (finding) return;
  const scene = lesson?.scenes[sceneIndex];
  els.sceneCount.textContent = scene && started ? `Scene ${sceneIndex + 1} of ${lesson.scenes.length}` : "";
  els.sceneCount.title = scene?.heading || "";
}

function updateButtons() {
  const has = !!lesson && started;
  els.play.disabled = !has;
  els.play.classList.toggle("is-playing", playing);
  els.play.setAttribute("aria-label", playing ? "Pause" : finding ? "Start over" : "Play");
  els.prev.disabled = !has || sceneIndex === 0;
  els.next.disabled = !has || (!finding && sceneIndex >= lesson.scenes.length - 1);
  els.next.setAttribute("aria-label", finding ? "Skip" : "Next scene");
  els.next.title = finding ? "Skip" : "Next scene (→)";
  els.replay.disabled = !has;
  els.hand.disabled = !has || !ready[sceneIndex] || !!finding;
}

// Keyboard: Space plays or pauses, arrows change scene, H raises your hand.
document.addEventListener("keydown", (e) => {
  if (currentView() !== "lesson") return;
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  // While listening, Space or Enter means "I'm done asking".
  if (rec && (e.key === " " || e.key === "Enter")) {
    e.preventDefault();
    sendRecording();
    return;
  }
  const press = (btn) => { if (!btn.disabled) { e.preventDefault(); btn.click(); } };
  if (e.key === " " && e.target.tagName !== "BUTTON") press(els.play);
  else if (e.key === "ArrowRight") press(els.next);
  else if (e.key === "ArrowLeft") press(els.prev);
  else if (e.key === "h" || e.key === "H") press(els.hand);
  else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
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
    els.heading.textContent = `Find it · ${f.at + 1} of ${f.rounds.length}`;
    els.sceneCount.textContent = `Find it · ${f.at + 1} of ${f.rounds.length}`;
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
  updateSceneCount();
  updateButtons();
}

// ---------- Quiz ----------

function showQuiz() {
  const q = lesson.quiz;
  if (!q || !Array.isArray(q.choices)) return;
  exitFullscreen(); // the quiz sits below the player
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
let askRun = 0;          // bumps for every new question, so an older answer stream is ignored
let askAbort = null;     // cancels the answer request in flight

els.hand.addEventListener("click", async () => {
  if (rec) { await sendRecording(); return; }
  openHand();
  // Hush anything still talking (an earlier answer) so the microphone only hears the student.
  cancelAsk();
  stop();
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
els.askDone.addEventListener("click", () => { if (rec) sendRecording(); });
els.askCancel.addEventListener("click", () => backToLesson());
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
  setBubble(null);
  setHandButton(false);
}

function cancelAsk() {
  askRun++;
  askAbort?.abort();
  askAbort = null;
}

function backToLesson() {
  cancelAsk();
  stop();
  closeHand();
  if (!lesson) return;
  // Restore the scene's caption and timings without redrawing the board.
  board?.reset?.();
  renderCaption(lesson.scenes[sceneIndex].narration);
  marks = sceneMarks(lesson.scenes[sceneIndex]);
  if (resumeAfter) { resumeAfter = false; continueLesson(); }
}

// Pick up where the lesson left off. If the hand went up after the scene had finished,
// move on to the next scene instead of replaying this one.
async function continueLesson() {
  const scene = lesson.scenes[sceneIndex];
  if (sentenceAt < sentencesFor(scene.narration, scene.speech).length) { play(); return; }
  if (sceneIndex >= lesson.scenes.length - 1) { startFinding(); return; }
  sceneIndex++;
  await wipe(() => renderScene(sceneIndex));
  play();
}

function setHandButton(listening) {
  els.hand.setAttribute("aria-pressed", String(listening));
  els.hand.classList.toggle("listening", listening);
  els.hand.innerHTML = listening ? `<span aria-hidden="true">●</span> Done asking` : `<span aria-hidden="true">✋</span> Ask a question <kbd>H</kbd>`;
}

// The chalk bubble on the board shows what the raised hand is doing:
// listening (with a live microphone level), thinking, or answering.
function setBubble(state, text) {
  els.bubble.hidden = !state;
  if (!state) return;
  els.bubble.dataset.state = state;
  els.bubbleText.textContent = text;
  setLevel(0);
}

const LEVEL_SHAPE = [0.55, 0.85, 1, 0.85, 0.55];
function setLevel(level) {
  els.bubble.querySelectorAll(".ask-meter i").forEach((bar, i) => {
    bar.style.transform = `scaleY(${(0.18 + level * LEVEL_SHAPE[i] * 0.82).toFixed(3)})`;
  });
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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const chunks = [];
    node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(node);
    source.connect(analyser);
    node.connect(ctx.destination);
    rec = { stream, ctx, source, node, chunks, tick: 0, timer: setTimeout(() => sendRecording(), 30000) };
    setHandButton(true);
    els.handStatus.textContent = "Listening… ask your question. I'll know you're done when you pause.";
    setBubble("listening", "Listening… ask your question");
    els.askDone.focus({ preventScroll: true });

    // Every 50 ms: move the level meter, and listen for the end of the question.
    // Once you've spoken, a pause of about 1.4 seconds sends it; there's no button to hunt for.
    // The speech threshold follows the room's background noise, so a noisy room doesn't count as talking.
    const buf = new Float32Array(analyser.fftSize);
    const started = performance.now();
    let noise = 0.01, voiced = 0, speaking = false, quietSince = 0, last = started;
    rec.tick = setInterval(() => {
      if (rec?.ctx !== ctx) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.sqrt(sum / buf.length);
      const now = performance.now();
      const dt = now - last;
      last = now;
      setLevel(Math.min(1, level * 7));
      noise = level < noise ? Math.max(0.002, level) : noise + (level - noise) * 0.004;
      const loud = level > Math.max(0.015, noise * 3);
      if (loud) {
        quietSince = 0;
        voiced += dt;
        if (!speaking && voiced > 250) {
          speaking = true;
          els.bubbleText.textContent = "Listening… pause when you're done";
        }
      } else if (speaking) {
        quietSince ||= now;
        if (now - quietSince > 1400) sendRecording();
      } else if (now - started > 10000) {
        // Ten seconds without a word: stop listening rather than send silence.
        stopRecording();
        els.handStatus.textContent = "I didn’t hear anything. Press Raise hand to try again, or type your question.";
        setBubble(null);
      }
    }, 50);
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
  clearInterval(r.tick);
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
  if (!rec) return; // already sent (Done, Space and a pause can all arrive together)
  const wav = await stopRecording();
  if (!wav) {
    els.handStatus.textContent = "I didn’t hear anything. Press Raise hand to try again, or type your question.";
    setBubble(null);
    return;
  }
  askQuestion({ audio: toBase64(wav) });
}

// Ask the server and follow its steps as they stream in: the question as heard, Muse Spark's
// answer, then one audio clip per sentence. The answer starts speaking with the first clip.
async function askQuestion(payload) {
  const scene = lesson.scenes[sceneIndex];
  cancelAsk();
  stop();
  const myAsk = askRun;
  askAbort = new AbortController();
  let question = payload.question || "";
  const thinking = () => {
    els.handStatus.textContent = `You asked: “${question}”  Muse Spark is thinking…`;
    setBubble("thinking", `You asked: “${question}”`);
  };
  if (question) thinking();
  else {
    els.handStatus.textContent = "Muse Voice Transcribe is writing down your question…";
    setBubble("thinking", "Writing down your question");
  }
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      signal: askAbort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        context: { title: lesson.title, level: lesson.level, heading: scene.heading, narration: scene.narration, labels: scene.parts.map((p) => p.label) },
        image: scene.image ? media(scene.image.src) : "",
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server returned ${res.status}`);
    }
    const clips = clipQueue();
    let speaking = null;
    try {
      for await (const ev of readLines(res.body)) {
        if (myAsk !== askRun) return;
        if (ev.type === "error") throw new Error(ev.error);
        if (ev.type === "heard") {
          if (!ev.question) {
            els.handStatus.textContent = "I didn’t catch that. Press Raise hand to try again, or type your question.";
            setBubble(null);
            return;
          }
          question = ev.question;
          thinking();
        } else if (ev.type === "answer") {
          els.handStatus.textContent = `You asked: “${question}”`;
          setBubble("answering", `You asked: “${question}”`);
          speaking = playAnswer(ev, clips, myAsk);
        } else if (ev.type === "clip") {
          clips.add(ev);
        }
      }
    } finally {
      clips.end();
    }
    await speaking;
  } catch (err) {
    if (myAsk !== askRun || err.name === "AbortError") return;
    els.handStatus.textContent = err.message;
    setBubble(null);
  }
}

// Answer clips arrive one at a time while earlier ones are already playing.
function clipQueue() {
  const items = [];
  let ended = false;
  let wake = null;
  return {
    add(clip) { items[clip.index] = clip; wake?.(); },
    end() { ended = true; wake?.(); },
    async get(k) {
      while (!items[k] && !ended) await new Promise((r) => { wake = r; });
      return items[k] || null;
    },
  };
}

// Speak the answer in the caption area, pointing at the parts of the picture it mentions.
async function playAnswer(ev, clips, myAsk) {
  stop();
  const myRun = runId;
  const live = () => myRun === runId && myAsk === askRun;
  renderCaption(ev.answer);
  const labels = lesson.scenes[sceneIndex].parts.map((p) => p.label);
  let from = 0;
  marks = [];
  for (const pt of ev.point || []) {
    const k = labels.indexOf(pt.label);
    if (k === -1) continue;
    let wi = findWord(pt.trigger, from);
    if (wi === -1) wi = findWord(pt.trigger, 0);
    if (wi === -1) wi = 0; else from = wi + 1;
    marks.push({ wordIndex: wi, done: false, fire: () => board?.pulse(k), activate: () => board?.activate(k) });
  }
  const parts = sentencesFor(ev.answer, null);
  for (let k = 0; k < parts.length; k++) {
    const clip = ev.voice ? await clips.get(k) : null;
    if (!live()) return;
    await speakSentence(clip
      ? { text: ev.answer.slice(clip.start, clip.end), start: clip.start, end: clip.end, src: media(clip.src), duration: clip.duration }
      : parts[k], myRun);
  }
  if (!live()) return;
  markProgress(words.length);
  if (resumeAfter) els.handStatus.textContent += "  Back to the lesson…";
  await wait(1500);
  if (!live() || els.handPanel.hidden) return;
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
