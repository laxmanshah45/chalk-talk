// Builds a lesson from a topic:
//   1. Muse Spark writes the script: scenes, narration, a picture plan, and the parts to point at.
//   2. For every scene at once: Muse Image paints the chalk picture, Muse Spark looks at it and
//      marks where each part is, SAM 3.1 traces each part's exact outline, and Kokoro voices
//      the narration.
// Progress is reported through `emit` so the page can show each step as it happens.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const meta = require("./meta");
const voice = require("./voice");
const { maskToShape } = require("./outline");

// The instructions Muse Spark gets for every lesson.
// Tweak this to change the tutor's style, length, or age group.
const LESSON_PROMPT = `You are a warm, clear tutor who writes short illustrated lessons for students.
Each scene is read aloud while a chalk picture appears on a chalkboard, and each part of the picture is outlined and labelled at the moment the narration mentions it.
Return ONLY a JSON object. No markdown fences, no text before or after it. Use exactly this shape:
{
  "title": "short lesson title",
  "scenes": [
    {
      "heading": "3 to 6 word scene heading",
      "narration": "2 or 3 short spoken sentences, about 40 words in total",
      "picture": "one or two sentences describing a single chalk drawing for this scene: the subject, the view (for example side view or cross-section), and where each part sits",
      "parts": [
        { "label": "1 to 3 words written on the board", "find": "what that part looks like in the drawing, under 12 words", "trigger": "one word copied from this scene's narration" }
      ]
    }
  ],
  "quiz": {
    "question": "one question that checks understanding",
    "choices": ["choice", "choice", "choice"],
    "answer": 0,
    "explain": "one sentence explaining the right answer"
  }
}
Rules:
- Write 6 to 8 scenes. Scene 1 hooks curiosity with an everyday example. Build the idea up one step per scene, so each scene teaches one thing. The last scene recaps why it matters.
- Each picture is one clear drawing a teacher could make, showing the real thing the way a simple textbook diagram would: real, recognizable shapes, never abstract stand-ins (no cloud standing in for lungs, no box standing in for the body). Keep it to one subject with large parts that are easy to tell apart. Never ask for words, letters, numbers, labels, or arrows in the drawing; the board adds its own labels.
- Give each scene 2 to 4 parts. Every part must be a separate, clearly visible area of that scene's drawing, big enough to colour in (never a thin line, an edge, or a gap), and must be named in the picture description. Parts must not overlap or contain one another, so never list a whole object together with a piece of it.
- Each trigger must be a single word that appears in that scene's narration, at the moment that part is first mentioned. List parts in the order their trigger words are spoken.
- The narration is read aloud by a computer voice: use plain words, no symbols, no lists, no emoji, no abbreviations.
- "answer" is the index of the correct choice, starting at 0.
- Match the vocabulary to the student's level.`;

const PICTURE_STYLE = "A hand-drawn chalk illustration on a dark green school chalkboard, made with white and colored chalk with visible chalk texture, like a clear, accurate textbook diagram a teacher draws for a class. Recognizable, true-to-life shapes with large, clearly separated parts, centered, with some empty chalkboard around it. No text, letters, numbers, labels, or arrows anywhere in the picture.";

// Extra instructions when the student shares a photo, such as a textbook diagram.
const PHOTO_PROMPT = `
The student has shared a photo (attached). It might be a diagram from a textbook, a worksheet, or something they saw. Teach a lesson that explains what the photo shows, at the student's level, and answer the student's question if they asked one.
Add "use_photo" to every scene: true to show the student's photo in that scene, or false to have a new chalk drawing made from "picture".
- Scene 1 must use the photo. Use the photo for every scene whose parts can be seen in it; use a new drawing only to explain something the photo doesn't show.
- In a scene that uses the photo, every part must be something clearly visible in the photo, and "picture" says where each part is in the photo.`;

async function writeScript(topic, level, meter, photo) {
  const ask = photo
    ? [
      { type: "text", text: `Student level: ${level}\nThe student's question: ${topic || "(none: explain what the photo shows)"}` },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}` } },
    ]
    : `Student level: ${level}\nTopic: ${topic}`;
  const text = await meta.chat([
    { role: "system", content: photo ? LESSON_PROMPT + PHOTO_PROMPT : LESSON_PROMPT },
    { role: "user", content: ask },
  ], { meter, step: "script" });
  return cleanScript(parseJson(text));
}

// Build a whole lesson into `dir`, reporting progress through `emit(event)`.
// `photo` is an optional JPEG buffer: the student's own picture to build the lesson around.
async function buildLesson({ topic, level, photo, lessonsDir, emit }) {
  const started = Date.now();
  const meter = meta.createMeter();
  emit({ type: "stage", stage: "writing" });
  const script = await writeScript(topic, level, meter, photo);
  const id = `${slug(script.title || topic)}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(lessonsDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const lesson = { id, topic, level, createdAt: new Date().toISOString(), ...script, voice: (await voice.available()) ? voice.VOICE : null };
  const photoUrl = photo ? `data:image/jpeg;base64,${photo.toString("base64")}` : null;
  if (photo) {
    fs.writeFileSync(path.join(dir, "photo.jpg"), photo);
    lesson.photo = { src: "photo.jpg", ...jpegSize(photo) };
    // Scene 1 always tries the photo; if its parts aren't in it, buildScene paints instead.
    if (!lesson.scenes.some((s) => s.usePhoto)) lesson.scenes[0].usePhoto = true;
  } else {
    lesson.scenes.forEach((s) => delete s.usePhoto);
  }
  save(dir, lesson);
  emit({ type: "script", base: `/lessons/${id}/`, lesson });
  console.log(`Script ready: "${lesson.title}" (${lesson.scenes.length} scenes)`);

  await Promise.all(lesson.scenes.map((_, i) => buildScene(lesson, i, dir, emit, meter, photoUrl)));
  lesson.cost = meter.summary();
  lesson.seconds = Math.round((Date.now() - started) / 1000);
  save(dir, lesson);
  emit({ type: "done", id, cost: lesson.cost, seconds: lesson.seconds });
  return lesson;
}

async function buildScene(lesson, i, dir, emit, meter, photoUrl) {
  const scene = lesson.scenes[i];
  const n = i + 1;
  const step = (name, extra) => emit({ type: "progress", index: i, step: name, ...extra });

  const narration = lesson.voice ? narrate(scene, n, dir) : Promise.resolve();

  try {
    let usedPhoto = false;
    if (scene.usePhoto && photoUrl) {
      // The student's own photo: nothing to paint; find and trace its parts.
      step("painted", { src: lesson.photo.src });
      step("looking");
      const review = await locateParts(photoUrl, scene, meter, { photo: true });
      if (review.missing < scene.parts.length) {
        const size = { width: lesson.photo.width, height: lesson.photo.height };
        scene.image = { src: lesson.photo.src, ...size };
        step("tracing");
        await traceParts(photoUrl, size, scene, review.spots, meter);
        usedPhoto = true;
      } else {
        // None of this scene's parts are in the photo: paint a picture for it instead.
        console.log(`Scene ${n}: its parts aren't in the photo, so painting one instead`);
        scene.usePhoto = false;
      }
    }
    if (!usedPhoto) {
      const file = `scene-${n}.jpg`;
      const prompt = `${PICTURE_STYLE}\n\nThe drawing: ${scene.picture}\nMake sure each of these is clearly drawn and easy to tell apart: ${scene.parts.map((p) => p.find).join("; ")}.`;
      // Paint, then have Muse Spark review the picture while it finds the parts.
      // If the picture is unclear or a part is missing, repaint once and keep the better one.
      let best = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const fix = attempt ? `\nA previous attempt had this problem, so avoid it: ${best.review.problem || "some parts were missing or hard to recognize"}.` : "";
        step(attempt ? "repainting" : "painting", attempt ? { problem: best.review.problem } : undefined);
        const jpg = await meta.paint(prompt + fix, { meter });
        fs.writeFileSync(path.join(dir, file), jpg);
        step("painted", { src: `${file}?v=${attempt}` });

        step("looking");
        const dataUrl = `data:image/jpeg;base64,${jpg.toString("base64")}`;
        const review = await locateParts(dataUrl, scene, meter);
        if (!best || review.score > best.review.score) best = { jpg, dataUrl, review };
        if (review.clear && review.missing === 0) break;
        if (attempt === 0) console.log(`Scene ${n}: repainting (${review.problem || `${review.missing} part(s) not found`})`);
      }
      fs.writeFileSync(path.join(dir, file), best.jpg);
      const size = jpegSize(best.jpg);
      scene.image = { src: file, width: size.width, height: size.height };
      step("painted", { src: `${file}?v=best` });

      step("tracing");
      await traceParts(best.dataUrl, size, scene, best.review.spots, meter);
    }
  } catch (err) {
    console.error(`Scene ${n} picture:`, err.message);
    scene.imageError = err.message;
  }

  await narration;
  step("ready");
  emit({ type: "scene", index: i, scene });
}

// Muse Spark looks at the finished picture, marks where each part is drawn, and reviews
// whether the picture is clear enough to teach with.
// Resolves to { spots, clear, problem, missing, score }.
async function locateParts(dataUrl, scene, meter, { photo = false } = {}) {
  const list = scene.parts.map((p, k) => `${k + 1}. ${p.label}: ${p.find}`).join("\n");
  const prompt = `${photo ? "This photo was described like this" : "This chalk drawing was made from this description"}: "${scene.picture}"
Find each of these parts in it:
${list}
Coordinates are normalized from 0 to 1000 on both axes, with 0,0 at the top-left corner of the picture.
Return ONLY JSON: {"clear":true,"problem":"","parts":[{"n":1,"found":true,"places":[{"box":[left,top,right,bottom],"points":[[x,y],[x,y]]}]}]}
- Give one entry in "places" for each separate place that part is drawn. Usually that's one, but give two or more when it appears in several places, for example rock on both sides of a vent, or two lungs.
- Each "box" tightly encloses that one place of that part and nothing else.
- "points" are 1 to 3 points clearly inside that place, away from its edges, and not on any other part.
- If a part is not in the ${photo ? "photo" : "drawing"}, give "found": false.${photo ? "" : `
- Also review the drawing for a student. Set "clear" to false if it contains any writing, letters or numbers, if it looks abstract or confusing instead of like the real thing, or if a part above is missing or hard to recognize. Otherwise set "clear" to true. When "clear" is false, say what's wrong in "problem", in under 20 words.`}`;
  const ask = () => meta.chat([{ role: "user", content: [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: dataUrl } },
  ] }], { reasoningEffort: process.env.LOCATE_EFFORT || undefined, meter, step: "finding" }).then(parseJson);
  // One retry if the reply isn't valid JSON.
  const parsed = await ask().catch((err) => (err instanceof meta.MetaError ? Promise.reject(err) : ask()));
  const found = Array.isArray(parsed.parts) ? parsed.parts : [];
  // Each spot is a list of places: [{ box, points }], or null when the part wasn't found.
  const place = (p) => (Array.isArray(p?.box) && p.box.length === 4
    ? { box: p.box.map(Number), points: (Array.isArray(p.points) ? p.points : []).filter((q) => Array.isArray(q) && q.length === 2).map((q) => q.map(Number)) }
    : null);
  const spots = scene.parts.map((_, k) => {
    const hit = found.find((f) => Number(f.n) === k + 1);
    if (!hit || hit.found === false) return null;
    const places = (Array.isArray(hit.places) ? hit.places : [hit]).map(place).filter(Boolean).slice(0, 4);
    return places.length ? places : null;
  });
  const missing = spots.filter((s) => !s).length;
  const clear = parsed.clear !== false;
  return { spots, clear, problem: String(parsed.problem || "").slice(0, 200), missing, score: spots.length - missing + (clear ? 0.5 : 0) };
}

// SAM 3.1 turns each marked place into an exact outline. One request covers every part;
// a part drawn in several places gets one SAM object per place, merged back together.
async function traceParts(dataUrl, size, scene, spots, meter) {
  const { width: W, height: H } = size;
  const px = (v, max) => Math.max(0, Math.min(max - 1, Math.round((v * max) / 1000)));
  const objects = [];
  const regions = []; // regions[id] = { k, box }
  spots.forEach((places, k) => {
    for (const { box: [l, t, r, b], points } of places || []) {
      const box = { left: px(Math.min(l, r), W), top: px(Math.min(t, b), H), right: px(Math.max(l, r), W) + 1, bottom: px(Math.max(t, b), H) + 1 };
      if (box.right - box.left < 4 || box.bottom - box.top < 4) continue;
      const pts = points.map(([x, y]) => ({ x: px(x, W), y: px(y, H) }));
      const id = regions.length;
      regions.push({ k, box: [box.left, box.top, box.right, box.bottom] });
      objects.push({ id, prompts: [pts.length ? { box, points: pts } : { box }] });
    }
  });
  if (!objects.length) return;
  scene.parts.forEach((part, k) => {
    const boxes = regions.filter((r) => r.k === k).map((r) => r.box);
    if (boxes.length) part.hint = unionBox(boxes);
  });

  const masks = await meta.segment(dataUrl, size, objects, { meter });
  const shapes = scene.parts.map(() => []);
  for (const mask of masks) {
    const region = regions[Number(mask.id)];
    const shape = region && maskToShape(mask);
    // If SAM's outline wandered far outside where Muse Spark said this place is, skip it.
    if (shape && overlap(shape.box, region.box) >= 0.25) shapes[region.k].push(shape);
  }
  shapes.forEach((list, k) => {
    if (!list.length) return;
    list.sort((a, b) => b.area - a.area);
    scene.parts[k].shape = {
      contours: list.flatMap((s) => s.contours),
      box: unionBox(list.map((s) => s.box)),
      center: list[0].center,
      area: list.reduce((sum, s) => sum + s.area, 0),
    };
  });
}

const unionBox = (boxes) => [
  Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])),
];

// Voice each sentence of a scene with Kokoro and save it as a WAV file.
// All of a scene's sentences join the voice queue together, so scenes finish in order.
async function narrate(scene, n, dir) {
  try {
    scene.speech = await speakAll(scene.narration, dir, `scene-${n}`);
  } catch (err) {
    console.error(`Scene ${n} narration:`, err.message);
  }
}

async function speakAll(text, dir, prefix) {
  const parts = voice.sentences(text);
  const audio = await Promise.all(parts.map((s) => voice.speak(s.text)));
  return parts.map((s, k) => {
    const file = `${prefix}-${k + 1}.wav`;
    fs.writeFileSync(path.join(dir, file), audio[k].wav);
    return { start: s.start, end: s.end, src: file, duration: Math.round(audio[k].duration * 1000) / 1000 };
  });
}

// ---------- Helpers ----------

// Intersection over union of two [l, t, r, b] boxes.
function overlap(a, b) {
  if (!a || !b) return 1;
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

// Read width and height from a JPEG's start-of-frame marker.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("Couldn't read the picture size");
}

// Models sometimes wrap JSON in ``` fences or add a sentence around it.
function parseJson(text) {
  const stripped = text.replace(/```json|```/g, "").trim();
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("No JSON object found");
  return JSON.parse(stripped.slice(first, last + 1));
}

// Make sure the script has the fields the player expects, and drop anything broken.
function cleanScript(raw) {
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  const scenes = (Array.isArray(raw?.scenes) ? raw.scenes : [])
    .map((s) => ({
      heading: str(s?.heading, 80),
      narration: str(s?.narration, 600),
      picture: str(s?.picture, 600),
      usePhoto: s?.use_photo === true,
      parts: (Array.isArray(s?.parts) ? s.parts : [])
        .slice(0, 5)
        .map((p) => ({ label: str(p?.label, 40), find: str(p?.find || p?.label, 120), trigger: str(p?.trigger, 40) }))
        .filter((p) => p.label),
    }))
    .filter((s) => s.narration)
    .slice(0, 8);
  if (!scenes.length) throw new Error("Lesson has no scenes");

  const lesson = { title: str(raw?.title, 100) || "Your lesson", scenes };
  const q = raw?.quiz;
  if (q && Array.isArray(q.choices) && q.choices.length >= 2) {
    const choices = q.choices.slice(0, 4).map((c) => str(c, 120));
    const answer = Number.isInteger(q.answer) && q.answer >= 0 && q.answer < choices.length ? q.answer : 0;
    lesson.quiz = { question: str(q.question, 200), choices, answer, explain: str(q.explain, 300) };
  }
  return lesson;
}

function save(dir, lesson) {
  fs.writeFileSync(path.join(dir, "lesson.json"), JSON.stringify(lesson));
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "lesson";
}

// What the lesson gallery shows about a lesson.
function lessonSummary(l) {
  const seconds = l.scenes.reduce((sum, s) => sum + (s.speech || []).reduce((a, c) => a + (c.duration || 0), 0), 0);
  return {
    title: l.title,
    topic: l.topic || "",
    level: l.level || "",
    createdAt: l.createdAt,
    scenes: l.scenes.length,
    listenMinutes: seconds ? Math.max(1, Math.round(seconds / 60)) : null,
    costUsd: l.cost?.usd ?? null,
    fromPhoto: !!l.photo,
  };
}

// Saved lessons, newest first, for the lesson gallery.
function listLessons(lessonsDir) {
  if (!fs.existsSync(lessonsDir)) return [];
  return fs.readdirSync(lessonsDir)
    .map((id) => {
      try {
        const l = JSON.parse(fs.readFileSync(path.join(lessonsDir, id, "lesson.json"), "utf8"));
        const thumb = l.scenes.find((s) => s.image)?.image.src;
        return { id, ...lessonSummary(l), thumb: thumb ? `/lessons/${id}/${thumb}` : null };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = { buildLesson, listLessons, locateParts, traceParts, parseJson, speakAll, jpegSize };
