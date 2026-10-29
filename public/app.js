// Chalk Talk lesson player
// Speaks each scene with the browser's built-in voice and reveals each chalk visual
// the moment its trigger word is spoken.

const $ = (sel) => document.querySelector(sel);
const els = {
  form: $("#topic-form"), topic: $("#topic"), level: $("#level"), make: $("#make"),
  sample: $("#sample"), askError: $("#ask-error"), title: $("#lesson-title"),
  heading: $("#scene-heading"), visuals: $("#visuals"), status: $("#board-status"),
  caption: $("#caption"), play: $("#play"), prev: $("#prev"), next: $("#next"),
  replay: $("#replay"), dots: $("#dots"), quiz: $("#quiz"), voice: $("#voice"), rate: $("#rate"),
};

// A built-in lesson so you can test the player without an API key.
const SAMPLE_LESSON = {
  title: "How plants make their own food",
  scenes: [
    {
      heading: "A tree that eats sunlight",
      narration: "Have you ever wondered how a giant tree grows from a tiny seed? It never eats a single snack. Instead, it makes its own food, using sunlight, water, and air.",
      visuals: [
        { label: "Seed", note: "Starts out tiny", trigger: "seed" },
        { label: "Sunlight", note: "The energy source", trigger: "sunlight" },
        { label: "Water", note: "Pulled up by the roots", trigger: "water" },
        { label: "Air", note: "Carbon dioxide gas", trigger: "air" },
      ],
    },
    {
      heading: "Every leaf is a kitchen",
      narration: "Inside every leaf are tiny green parts called chloroplasts. They hold a green pigment named chlorophyll, which catches energy from light, a bit like a solar panel.",
      visuals: [
        { label: "Chloroplast", note: "A tiny food factory", trigger: "chloroplasts" },
        { label: "Chlorophyll", note: "Green, and catches light", trigger: "chlorophyll" },
        { label: "Solar panel", note: "Same idea, made by nature", trigger: "solar" },
      ],
    },
    {
      heading: "The recipe",
      narration: "The plant mixes water and carbon dioxide, powered by that light energy. The result is sugar, which feeds the plant, and oxygen, which floats out into the air.",
      visuals: [
        { label: "Water + CO\u2082", note: "The ingredients", trigger: "water" },
        { label: "Sugar", note: "Food for the plant", trigger: "sugar" },
        { label: "Oxygen", note: "What we breathe", trigger: "oxygen" },
      ],
    },
    {
      heading: "Why it matters to you",
      narration: "Every breath you take has oxygen made by plants. And almost every meal you eat started as sunlight caught by a leaf. That is why photosynthesis feeds the whole planet.",
      visuals: [
        { label: "Your breath", note: "Oxygen from plants", trigger: "breath" },
        { label: "Your meals", note: "Started as sunlight", trigger: "meal" },
        { label: "Photosynthesis", note: "Light turned into food", trigger: "photosynthesis" },
      ],
    },
  ],
  quiz: {
    question: "What does a plant need to make its own food?",
    choices: ["Sunlight, water, and carbon dioxide", "Soil, sugar, and oxygen", "Only water from its roots"],
    answer: 0,
    explain: "Plants use light energy to turn water and carbon dioxide into sugar, and they release oxygen.",
  },
};

const synth = window.speechSynthesis;
let voices = [];
let lesson = null;
let sceneIndex = 0;
let playing = false;
let runId = 0;          // bumps on every stop, so events from old speech are ignored
let sentenceAt = 0;     // sentence to resume from after a pause
let words = [];         // { el, start, end, norm } for each word in the caption
let marks = [];         // { el, wordIndex } for each visual

// ---------- Loading lessons ----------

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const topic = els.topic.value.trim();
  if (!topic) {
    els.askError.textContent = "Type a topic first, like \u201cHow do volcanoes erupt?\u201d";
    els.topic.focus();
    return;
  }
  els.askError.textContent = "";
  stop();
  els.make.disabled = true;
  showMessage("Muse Spark is writing your lesson\u2026");
  try {
    const res = await fetch("/api/lesson", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, level: els.level.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    loadLesson(data);
  } catch (err) {
    const msg = location.protocol === "file:"
      ? "Open this page through the server: run npm start, then go to http://localhost:3000"
      : err.message;
    showMessage("That didn\u2019t work.");
    els.askError.textContent = msg;
  } finally {
    els.make.disabled = false;
  }
});

els.topic.addEventListener("input", () => { els.askError.textContent = ""; });
els.sample.addEventListener("click", () => { els.askError.textContent = ""; loadLesson(SAMPLE_LESSON); });

function loadLesson(data) {
  stop();
  lesson = data;
  sceneIndex = 0;
  hideQuiz();
  els.title.textContent = data.title || "";
  renderScene(0);
  play();
}

function showMessage(text) {
  els.heading.textContent = "";
  els.visuals.innerHTML = "";
  els.caption.textContent = "";
  els.status.textContent = text;
}

// ---------- Drawing a scene ----------

const norm = (w) => (w || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function renderScene(i) {
  const scene = lesson.scenes[i];
  els.heading.textContent = scene.heading || "";
  els.status.textContent = "";

  els.caption.innerHTML = "";
  words = [];
  for (const m of scene.narration.matchAll(/\S+/g)) {
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = m[0];
    els.caption.append(span, " ");
    words.push({ el: span, start: m.index, end: m.index + m[0].length, norm: norm(m[0]) });
  }

  els.visuals.innerHTML = "";
  marks = [];
  let searchFrom = 0;
  (scene.visuals || []).forEach((v, k) => {
    const card = document.createElement("div");
    card.className = "visual";
    card.dataset.visual = k;
    const label = document.createElement("span");
    label.className = "v-label";
    label.textContent = v.label;
    const note = document.createElement("span");
    note.className = "v-note";
    note.textContent = v.note || "";
    card.append(label, note);
    els.visuals.append(card);

    // Find when this visual's trigger word is spoken. If it's missing, show it at the start.
    let wi = findWord(v.trigger, searchFrom);
    if (wi === -1) wi = findWord(v.trigger, 0);
    if (wi === -1) wi = 0; else searchFrom = wi + 1;
    marks.push({ el: card, wordIndex: wi });
  });

  sentenceAt = 0;
  renderDots();
  updateButtons();
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

// Light up spoken words and reveal every visual whose trigger has been reached.
function markProgress(idx) {
  words.forEach((w, i) => {
    w.el.classList.toggle("spoken", i < idx);
    w.el.classList.toggle("current", i === idx);
  });
  let latest = null;
  for (const m of marks) {
    if (m.wordIndex <= idx) { m.el.classList.add("shown"); latest = m; }
  }
  for (const m of marks) m.el.classList.toggle("active", m === latest);
}

function wordAt(charIndex) {
  let found = 0;
  for (let i = 0; i < words.length; i++) if (words[i].start <= charIndex) found = i;
  return found;
}

function sentences(text) {
  const out = [];
  for (const m of text.matchAll(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)) {
    if (m[0].trim()) out.push({ text: m[0], start: m.index });
  }
  return out;
}

// ---------- Speaking ----------

async function play() {
  if (!lesson) return;
  if (!synth) {
    els.status.textContent = "This browser can\u2019t speak. Try Chrome, Edge, or Safari.";
    return;
  }
  const myRun = ++runId;
  playing = true;
  updateButtons();

  const parts = sentences(lesson.scenes[sceneIndex].narration);
  if (sentenceAt >= parts.length) { renderScene(sceneIndex); }

  for (let s = sentenceAt; s < parts.length; s++) {
    if (myRun !== runId) return;
    sentenceAt = s;
    await speakSentence(parts[s], myRun);
  }
  if (myRun !== runId) return;

  markProgress(words.length);
  sentenceAt = parts.length;
  await wait(800);
  if (myRun !== runId) return;

  if (sceneIndex < lesson.scenes.length - 1) {
    sceneIndex++;
    renderScene(sceneIndex);
    play();
  } else {
    playing = false;
    updateButtons();
    showQuiz();
  }
}

// Speaking one sentence at a time avoids Chrome cutting off long speech,
// and makes pause and resume reliable.
function speakSentence(part, myRun) {
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
    const done = () => { clearInterval(timer); resolve(); };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  });
}

function say(text) {
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = currentVoice();
  if (v) u.voice = v;
  u.rate = Number(els.rate.value) || 1;
  synth.speak(u);
}

function stop() {
  runId++;
  if (synth) synth.cancel();
  playing = false;
  updateButtons();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Controls ----------

els.play.addEventListener("click", () => {
  if (playing) { stop(); return; }
  if (sceneIndex === lesson.scenes.length - 1 && !els.quiz.hidden) {
    hideQuiz();
    sceneIndex = 0;
    renderScene(0);
  }
  play();
});
els.prev.addEventListener("click", () => goTo(sceneIndex - 1));
els.next.addEventListener("click", () => goTo(sceneIndex + 1));
els.replay.addEventListener("click", () => goTo(sceneIndex));

function goTo(i) {
  if (!lesson || i < 0 || i >= lesson.scenes.length) return;
  stop();
  hideQuiz();
  sceneIndex = i;
  renderScene(i);
  play();
}

function renderDots() {
  els.dots.innerHTML = "";
  lesson.scenes.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dot" + (i === sceneIndex ? " on" : "");
    b.setAttribute("aria-label", `Scene ${i + 1}: ${s.heading || ""}`);
    if (i === sceneIndex) b.setAttribute("aria-current", "step");
    b.addEventListener("click", () => goTo(i));
    els.dots.append(b);
  });
}

function updateButtons() {
  const has = !!lesson;
  els.play.disabled = !has;
  els.play.textContent = playing ? "Pause" : "Play";
  els.prev.disabled = !has || sceneIndex === 0;
  els.next.disabled = !has || sceneIndex >= lesson.scenes.length - 1;
  els.replay.disabled = !has;
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
      feedback.textContent = (right ? "That\u2019s right. " : "Not quite. ") + (q.explain || "");
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

// ---------- Voices ----------

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
