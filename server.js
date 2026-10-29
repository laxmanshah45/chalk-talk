// Chalk Talk server
// Serves the lesson player and talks to Meta Model API for you,
// so your API key stays on your computer and never reaches the browser.
// Needs Node.js 20.17 or newer. Run npm install once, then npm start.

const http = require("http");
const fs = require("fs");
const path = require("path");

loadEnv(path.join(__dirname, ".env"));

const meta = require("./lib/meta");
const voice = require("./lib/voice");
const { buildLesson, listLessons } = require("./lib/lesson");
const ask = require("./lib/ask");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const LESSONS_DIR = path.join(__dirname, "lessons");
const ANSWERS_DIR = path.join(LESSONS_DIR, "_answers");
const ROUGH_JS = path.join(__dirname, "node_modules", "roughjs", "bundled", "rough.js");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/lesson") return await handleLesson(req, res);
    if (req.method === "POST" && url.pathname === "/api/ask") return await handleAsk(req, res);
    if (req.method === "POST" && url.pathname === "/api/say") return await handleSay(req, res);
    if (req.method === "GET" && url.pathname === "/api/lessons") return sendJson(res, 200, { lessons: listLessons(LESSONS_DIR) });
    if (req.method === "GET" && url.pathname === "/api/config") return await handleConfig(res);
    if (req.method === "GET" && url.pathname === "/vendor/rough.js") return sendFile(res, ROUGH_JS);
    if (req.method === "GET" && url.pathname.startsWith("/lessons/")) return serveFrom(LESSONS_DIR, url.pathname.slice("/lessons".length), res);
    if (req.method === "GET") return serveFrom(PUBLIC_DIR, url.pathname === "/" ? "/index.html" : url.pathname, res);
    sendJson(res, 405, { error: "Method not allowed." });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Something broke on the server. Check the terminal for details." });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Chalk Talk is running at http://localhost:${PORT}`);
  console.log(meta.hasKey() ? `Using ${meta.MODEL}, ${meta.IMAGE_MODEL}, ${meta.SAM_MODEL} and ${meta.TRANSCRIBE_MODEL}` : "No API key yet: the sample lesson works, but Make lesson needs MODEL_API_KEY in .env");
  voice.warmUp();
  ask.tidyAnswers(ANSWERS_DIR);
});

const NO_KEY = "No API key found. Copy .env.example to .env, paste your Meta Model API key after MODEL_API_KEY=, then restart with npm start.";

// Streams the lesson as it's built, one JSON object per line, so the page can
// show each step and start playing scene 1 before the last scene is ready.
async function handleLesson(req, res) {
  if (!meta.hasKey()) return sendJson(res, 500, { error: NO_KEY });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "The request wasn't valid JSON." });
  }
  const topic = String(body.topic || "").trim().slice(0, 300);
  const level = String(body.level || "middle school").trim().slice(0, 60);
  if (!topic) return sendJson(res, 400, { error: "Type a topic first." });

  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
  const emit = (event) => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); };
  try {
    const lesson = await buildLesson({ topic, level, lessonsDir: LESSONS_DIR, emit });
    const steps = Object.entries(lesson.cost.steps).map(([k, v]) => `${k} ${usd(v)}`).join(", ");
    console.log(`Lesson ready: "${lesson.title}" (${lesson.scenes.length} scenes) in ${lesson.seconds}s, about ${usd(lesson.cost.usd)} of API credit (${steps}). Saved in lessons/${lesson.id}`);
  } catch (err) {
    console.error("Couldn't build the lesson:", err.message);
    emit({ type: "error", error: err instanceof meta.MetaError ? err.message : "Muse Spark answered, but not in the lesson format. Try again or reword the topic." });
  }
  res.end();
}

// A raised hand: { audio: base64 WAV } or { question: text }, plus the lesson context.
// Streams one JSON object per line: "heard" as soon as the question is known, "answer" once
// Muse Spark replies, a "clip" per spoken sentence as each is voiced, then "done".
async function handleAsk(req, res) {
  if (!meta.hasKey()) return sendJson(res, 500, { error: NO_KEY });

  let body;
  try {
    body = JSON.parse(await readBody(req, 8e6));
  } catch {
    return sendJson(res, 400, { error: "The request wasn't valid JSON." });
  }
  const typed = String(body.question || "").trim().slice(0, 500);
  if (!typed && !body.audio) return sendJson(res, 400, { error: "Ask a question first." });

  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
  const emit = (event) => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); };
  const meter = meta.createMeter();
  const started = Date.now();
  let question = typed;
  try {
    if (!question) {
      try {
        question = (await ask.transcribe(Buffer.from(String(body.audio), "base64"), { meter })).slice(0, 500);
      } catch (err) {
        console.error("Transcribe:", err.message);
        emit({ type: "error", error: `Couldn't hear that: ${err.message}` });
        return res.end();
      }
    }
    emit({ type: "heard", question });
    if (!question) return res.end();

    const c = body.context || {};
    const context = {
      title: String(c.title || "").slice(0, 120),
      level: String(c.level || "").slice(0, 60),
      heading: String(c.heading || "").slice(0, 120),
      narration: String(c.narration || "").slice(0, 800),
      labels: (Array.isArray(c.labels) ? c.labels : []).map((l) => String(l).slice(0, 40)).slice(0, 6),
    };
    const image = localMedia(String(body.image || ""));
    await ask.answer({ question, context, image, answersDir: ANSWERS_DIR, meter, emit });
    emit({ type: "done", cost: meter.summary() });
    console.log(`Answered: "${question}" in ${((Date.now() - started) / 1000).toFixed(1)}s (about ${usd(meter.usd)} of API credit)`);
  } catch (err) {
    console.error("Couldn't answer:", err.message);
    emit({ type: "error", error: err instanceof meta.MetaError ? err.message : "Muse Spark couldn't answer that one. Try asking another way." });
  }
  res.end();
}

// Speak a short line (quiz question or feedback) in the narration voice. Works without an API key.
const sayCache = new Map();
async function handleSay(req, res) {
  let text;
  try {
    text = String(JSON.parse(await readBody(req)).text || "").trim().slice(0, 400);
  } catch {
    return sendJson(res, 400, { error: "The request wasn't valid JSON." });
  }
  if (!text) return sendJson(res, 400, { error: "Nothing to say." });
  if (!(await voice.available())) return sendJson(res, 503, { error: "The server voice isn't available." });
  try {
    if (!sayCache.has(text)) {
      if (sayCache.size >= 40) sayCache.delete(sayCache.keys().next().value);
      sayCache.set(text, (await voice.speak(text)).wav);
    }
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(sayCache.get(text));
  } catch (err) {
    console.error("Say:", err.message);
    sendJson(res, 500, { error: "Couldn't speak that." });
  }
}

async function handleConfig(res) {
  sendJson(res, 200, { hasKey: meta.hasKey(), voice: (await voice.available()) ? voice.VOICE : null });
}

// Map a page URL like /lessons/x/scene-1.jpg or /samples/x/scene-1.jpg to a file on disk.
function localMedia(urlPath) {
  const p = urlPath.split("?")[0];
  const base = p.startsWith("/lessons/") ? LESSONS_DIR : PUBLIC_DIR;
  const rel = p.startsWith("/lessons/") ? p.slice("/lessons".length) : p;
  const file = path.normalize(path.join(base, decodeURIComponent(rel)));
  return file.startsWith(base + path.sep) && /\.(jpe?g|png)$/i.test(file) ? file : null;
}

function serveFrom(root, urlPath, res) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return sendJson(res, 400, { error: "Bad path" }); }
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  sendFile(res, file);
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    // Ask browsers to check for a newer copy every time, so a plain refresh always shows the latest page.
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const usd = (v) => (v < 0.01 ? `${(v * 100).toFixed(2)}¢` : `$${v.toFixed(3)}`);

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// Minimal .env reader so the key never needs to be pasted into code.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
