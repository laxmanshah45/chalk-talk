// Natural narration with Kokoro, an open-weight text-to-speech model that runs on this computer.
// Meta Model API has no text-to-speech, so this fills that gap. Kokoro is an optional
// dependency: if it isn't installed, the lesson player falls back to the browser's voice.

const VOICE = process.env.VOICE || "af_heart";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let ttsPromise = null;
let queue = Promise.resolve();
let failed = null;

function load() {
  if (process.env.VOICE === "browser") return Promise.reject(new Error("Server voice turned off with VOICE=browser"));
  if (!ttsPromise) {
    ttsPromise = import("kokoro-js")
      .then(({ KokoroTTS }) => KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" }))
      .catch((err) => {
        failed = err;
        throw err;
      });
  }
  return ttsPromise;
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

// Speak one sentence. Calls run one at a time, in the order they were asked for,
// so scene 1 is voiced before scene 5. Resolves to { wav: Buffer, duration: seconds }.
function speak(text) {
  const job = queue.then(async () => {
    const tts = await load();
    const audio = await tts.generate(text, { voice: VOICE });
    return { wav: toWav16(audio.audio, audio.sampling_rate), duration: audio.audio.length / audio.sampling_rate };
  });
  queue = job.catch(() => {});
  return job;
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
