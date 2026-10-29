// Chalk Talk server
// Serves the lesson player and talks to Meta Model API for you,
// so your API key stays on your computer and never reaches the browser.
// Needs Node.js 18 or newer. No npm install required.

const http = require("http");
const fs = require("fs");
const path = require("path");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.MODEL_API_KEY;
const BASE_URL = (process.env.META_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
const MODEL = process.env.MODEL || "muse-spark-1.3";
const PUBLIC_DIR = path.join(__dirname, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// The instructions Muse Spark gets for every lesson.
// Tweak this to change the tutor's style, length, or age group.
const LESSON_PROMPT = `You are a warm, clear tutor who writes short animated lessons for students.
Return ONLY a JSON object. No markdown fences, no text before or after it. Use exactly this shape:
{
  "title": "short lesson title",
  "scenes": [
    {
      "heading": "3 to 6 word scene heading",
      "narration": "2 or 3 short spoken sentences, about 40 words in total",
      "visuals": [
        { "label": "1 to 3 words", "note": "under 8 words", "trigger": "one word copied from this scene's narration" }
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
- Write 4 to 6 scenes. Scene 1 hooks curiosity with an everyday example. The last scene recaps why it matters.
- Give each scene 2 to 4 visuals. Each trigger must be a single word that appears in that scene's narration, and the visuals must be listed in the order their trigger words are spoken.
- The narration is read aloud by a computer voice: use plain words, no symbols, no lists, no emoji, no abbreviations.
- "answer" is the index of the correct choice, starting at 0.
- Match the vocabulary to the student's level.`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/lesson") return await handleLesson(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed." });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Something broke on the server. Check the terminal for details." });
  }
});

server.listen(PORT, () => {
  console.log(`Chalk Talk is running at http://localhost:${PORT}`);
  console.log(API_KEY ? `Using model ${MODEL}` : "No API key yet: the sample lesson works, but Make lesson needs MODEL_API_KEY in .env");
});

async function handleLesson(req, res) {
  if (!API_KEY) {
    return sendJson(res, 500, {
      error: "No API key found. Copy .env.example to .env, paste your Meta Model API key after MODEL_API_KEY=, then restart with npm start.",
    });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "The request wasn't valid JSON." });
  }

  const topic = String(body.topic || "").trim().slice(0, 300);
  const level = String(body.level || "middle school").trim().slice(0, 60);
  if (!topic) return sendJson(res, 400, { error: "Type a topic first." });

  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: LESSON_PROMPT },
      { role: "user", content: `Student level: ${level}\nTopic: ${topic}` },
    ],
  };
  if (process.env.REASONING_EFFORT) payload.reasoning_effort = process.env.REASONING_EFFORT;

  let apiRes;
  try {
    apiRes = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return sendJson(res, 502, { error: `Couldn't reach Meta Model API: ${err.message}` });
  }

  const data = await apiRes.json().catch(() => ({}));
  if (!apiRes.ok) {
    const detail = data?.error?.message || JSON.stringify(data).slice(0, 300);
    console.error("Meta API error", apiRes.status, detail);
    return sendJson(res, 502, { error: `Meta Model API returned ${apiRes.status}: ${detail}` });
  }

  try {
    const lesson = cleanLesson(parseJson(messageText(data)));
    console.log(`Lesson ready: "${lesson.title}" (${lesson.scenes.length} scenes)`);
    sendJson(res, 200, lesson);
  } catch (err) {
    console.error("Couldn't read the lesson:", err.message);
    sendJson(res, 502, { error: "Muse Spark answered, but not in the lesson format. Try again or reword the topic." });
  }
}

// Pull the text out of a chat completion, whether content is a string or a list of parts.
function messageText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text || "").join("");
  throw new Error("No message content in the response");
}

// Models sometimes wrap JSON in ``` fences or add a sentence around it.
function parseJson(text) {
  const stripped = text.replace(/```json|```/g, "").trim();
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("No JSON object found");
  return JSON.parse(stripped.slice(first, last + 1));
}

// Make sure the lesson has the fields the player expects, and drop anything broken.
function cleanLesson(raw) {
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  const scenes = (Array.isArray(raw?.scenes) ? raw.scenes : [])
    .map((s) => ({
      heading: str(s?.heading, 80),
      narration: str(s?.narration, 600),
      visuals: (Array.isArray(s?.visuals) ? s.visuals : [])
        .slice(0, 5)
        .map((v) => ({ label: str(v?.label, 40), note: str(v?.note, 80), trigger: str(v?.trigger, 40) }))
        .filter((v) => v.label),
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

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// Minimal .env reader so the project needs no packages.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
