// Natural narration with Kokoro, an open-weight text-to-speech model that runs on this computer.
// Meta Model API has no text-to-speech, so this fills that gap. Kokoro is an optional
// dependency: if it isn't installed, the lesson player falls back to the browser's voice.
// Kokoro runs in a worker thread (voice-worker.js); on the main thread it would stall
// every other request for as long as it's speaking.

const path = require("path");
const { Worker } = require("worker_threads");

const VOICE = process.env.VOICE || "af_heart";

let worker = null;
let ready = null;
let failed = null;
let nextId = 0;
const pending = new Map();

function load() {
  if (process.env.VOICE === "browser") return Promise.reject(new Error("Server voice turned off with VOICE=browser"));
  if (!ready) {
    ready = new Promise((resolve, reject) => {
      require.resolve("kokoro-js");
      worker = new Worker(path.join(__dirname, "voice-worker.js"));
      worker.unref(); // an idle voice shouldn't keep the process alive on its own
      worker.on("message", (msg) => {
        if (msg.type === "ready") resolve();
        else if (msg.type === "failed") reject(new Error(msg.error));
        else if (msg.type === "spoken") {
          const job = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) job?.reject(new Error(msg.error));
          else job?.resolve(msg);
        }
      });
      worker.on("error", (err) => {
        reject(err);
        for (const job of pending.values()) job.reject(err);
        pending.clear();
      });
      worker.postMessage({ type: "load" });
    }).catch((err) => {
      failed = err;
      throw err;
    });
  }
  return ready;
}

// Start loading in the background so the first lesson doesn't wait for it.
function warmUp() {
  load().then(
    () => console.log(`Narration voice ready (Kokoro, ${VOICE})`),
    (err) => console.log(`Using the browser's voice instead of Kokoro: ${err.message.split("\n")[0]}`),
  );
}

async function available() {
  try { await load(); return true; } catch { return false; }
}

// Speak one sentence. The worker voices sentences one at a time, in the order they were
// asked for, so scene 1 is voiced before scene 5. Resolves to { wav: Buffer, duration: seconds }.
function speak(text) {
  const id = ++nextId;
  const job = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  load().then(() => worker.postMessage({ type: "speak", id, text, voice: VOICE }), (err) => { pending.get(id)?.reject(err); pending.delete(id); });
  return job.then(({ samples, rate }) => ({ wav: toWav16(samples, rate), duration: samples.length / rate }));
}

// Split narration into sentences, keeping each one's character offsets so the
// player can match spoken words to the caption.
function sentences(text) {
  const out = [];
  for (const m of text.matchAll(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index + raw.indexOf(trimmed);
    out.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return out;
}

// Float32 samples to a 16-bit mono WAV file.
function toWav16(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

module.exports = { VOICE, warmUp, available, speak, sentences, lastError: () => failed };
