// "Raise your hand": a student asks a question mid-lesson, by voice or by typing.
// Muse Voice Transcribe turns speech into text, then Muse Spark answers while looking at
// the picture on the board, and picks which parts of it to point at as it explains.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const meta = require("./meta");
const voice = require("./voice");
const { parseJson, speakAll } = require("./lesson");

const ASK_PROMPT = `You are the same warm tutor who is teaching this lesson. A student just raised their hand and asked a question.
Answer it in 2 to 4 short spoken sentences, about 50 words at most, in plain words for a computer voice: no symbols, lists, emoji, or abbreviations.
If the question is unrelated to the lesson, answer kindly in one sentence and steer back to the lesson.
When the picture on the board helps, point at its parts while you explain.
Return ONLY JSON: {"answer":"...","point":[{"label":"exact label from the list","trigger":"one word copied from your answer"}]}
"point" may be empty. Use only labels from the list, in the order your trigger words are spoken.`;

// `context`: { title, level, heading, narration, labels: [...] }; `image`: a local file path or null.
async function answer({ question, context, image, answersDir }) {
  const lines = [
    `Lesson: ${context.title}`,
    `Student level: ${context.level || "middle school"}`,
    `Current scene: ${context.heading}`,
    `What the tutor just said: ${context.narration}`,
    `Labelled parts of the picture on the board: ${(context.labels || []).join(", ") || "none"}`,
    `Student's question: ${question}`,
  ];
  const content = [{ type: "text", text: lines.join("\n") }];
  if (image && fs.existsSync(image)) {
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(image).toString("base64")}` } });
  }

  const raw = parseJson(await meta.chat([
    { role: "system", content: ASK_PROMPT },
    { role: "user", content },
  ]));
  const text = String(raw.answer || "").trim().slice(0, 600);
  if (!text) throw new Error("Muse Spark sent an empty answer");
  const labels = new Set(context.labels || []);
  const point = (Array.isArray(raw.point) ? raw.point : [])
    .map((p) => ({ label: String(p?.label || "").trim(), trigger: String(p?.trigger || "").trim() }))
    .filter((p) => labels.has(p.label))
    .slice(0, 4);

  let speech = null;
  if (await voice.available()) {
    const id = crypto.randomBytes(4).toString("hex");
    fs.mkdirSync(answersDir, { recursive: true });
    try {
      speech = (await speakAll(text, answersDir, `answer-${id}`)).map((s) => ({ ...s, src: `/lessons/_answers/${s.src}` }));
    } catch (err) {
      console.error("Answer narration:", err.message);
    }
  }
  return { question, answer: text, point, speech };
}

// Delete answer audio older than a day so the folder doesn't grow forever.
function tidyAnswers(answersDir) {
  if (!fs.existsSync(answersDir)) return;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(answersDir)) {
    const p = path.join(answersDir, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
  }
}

module.exports = { answer, transcribe: meta.transcribe, tidyAnswers };
