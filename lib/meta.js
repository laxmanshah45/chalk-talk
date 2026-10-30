// Thin client for the Meta Model API endpoints Chalk Talk uses.
// Every call runs on the server, so the API key never reaches the browser.

const API_KEY = process.env.MODEL_API_KEY;
const BASE_URL = (process.env.META_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
const MODEL = process.env.MODEL || "muse-spark-1.3";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "muse-image-1.0";
const SAM_MODEL = process.env.SAM_MODEL || "sam-3.1";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "muse-voice-transcribe-1.0";

// US dollar prices from dev.meta.ai/docs/pricing-rate-limits (October 2026).
// Muse Spark's completion tokens include its reasoning tokens.
const PRICES = {
  sparkInput: MODEL.includes("contributor") ? 0.1e-6 : 1.25e-6,
  sparkCachedInput: MODEL.includes("contributor") ? 0.002e-6 : 0.15e-6,
  sparkOutput: MODEL.includes("contributor") ? 0.2e-6 : 4.25e-6,
  image: 0.01,
  samImage: 0.0025,
  transcribeSecond: 0.18 / 3600,
};

// Adds up what a lesson or answer cost, by step. Pass one to any call below as `meter`.
function createMeter() {
  const meter = { usd: 0, steps: {} };
  meter.add = (step, usd) => {
    meter.usd += usd;
    meter.steps[step] = (meter.steps[step] || 0) + usd;
  };
  meter.summary = () => ({
    usd: Math.round(meter.usd * 10000) / 10000,
    steps: Object.fromEntries(Object.entries(meter.steps).map(([k, v]) => [k, Math.round(v * 10000) / 10000])),
  });
  return meter;
}

class MetaError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// POST with retries for rate limits and server hiccups. Returns the fetch Response.
// Meta also answers "The requested model was not found" for a moment when a model is busy,
// so that 404 is retried too; a real typo in the model name still fails after the retries.
async function post(pathname, init, label) {
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE_URL}${pathname}`, {
        method: "POST",
        ...init,
        headers: { Authorization: `Bearer ${API_KEY}`, ...init.headers },
      });
    } catch (err) {
      if (attempt < delays.length) { await wait(delays[attempt]); continue; }
      throw new MetaError(`Couldn't reach Meta Model API (${label}): ${err.message}`, 502);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const busy = res.status === 404 && /model was not found|model_not_found/i.test(text);
    const retryable = res.status === 429 || res.status >= 500 || busy;
    if (retryable && attempt < delays.length) {
      // Use Meta's own "Retry-After" hint when it gives one, up to 20 seconds.
      const after = Number(res.headers.get("retry-after"));
      await wait(after > 0 ? Math.min(after * 1000, 20000) : delays[attempt]);
      continue;
    }
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text)?.error?.message || detail; } catch {}
    throw new MetaError(`Meta Model API ${label} returned ${res.status}: ${detail}`, res.status);
  }
}

// Muse Spark chat completion. `content` may be a string or a list of text/image parts.
async function chat(messages, { reasoningEffort, meter, step = "spark" } = {}) {
  const payload = { model: MODEL, messages };
  const effort = reasoningEffort || process.env.REASONING_EFFORT;
  if (effort) payload.reasoning_effort = effort;
  const res = await post("/chat/completions", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, MODEL);
  const data = await res.json();
  const u = data?.usage;
  if (meter && u) {
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    meter.add(step, (u.prompt_tokens - cached) * PRICES.sparkInput + cached * PRICES.sparkCachedInput + u.completion_tokens * PRICES.sparkOutput);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text || "").join("");
  throw new MetaError("Muse Spark sent no message content", 502);
}

// Muse Image: returns the picture as a JPEG buffer.
async function paint(prompt, { meter } = {}) {
  const res = await post("/images/generations", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      size: "1600x900",
      output_format: "jpeg",
      response_format: "b64_json",
    }),
  }, IMAGE_MODEL);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new MetaError("Muse Image sent no picture", 502);
  meter?.add("pictures", PRICES.image);
  return Buffer.from(b64, "base64");
}

// SAM 3.1 with box and point prompts: one request outlines every object.
// `objects` is [{ id, prompts: [{ box, points }] }] in image pixels.
// Resolves to the parsed mask records.
async function segment(imageDataUrl, size, objects, { meter } = {}) {
  const sam = await import("@meta-sam/parser");
  const res = await post("/responses", {
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: SAM_MODEL,
      stream: true,
      metadata: { include_confidence: "true" },
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: sam.buildObjectPrompt({ size, objects }) },
          { type: "input_image", image_url: imageDataUrl },
        ],
      }],
    }),
  }, SAM_MODEL);
  const result = await sam.parseImageStream(sseEvents(res.body)).finalResult;
  meter?.add("tracing", PRICES.samImage);
  return sam.recordsOfKind(result.records, "mask").map((m) => ({
    id: m.objectId,
    bounds: m.bounds,
    confidence: m.confidence,
    path: sam.decodeMaskToSVGPath(m.mask),
    rasterWidth: m.mask.width,
    rasterHeight: m.mask.height,
  }));
}

// Muse Voice Transcribe: WAV buffer in, transcript text out.
async function transcribe(wav, { meter } = {}) {
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({
    model: TRANSCRIBE_MODEL,
    audioEncoding: "WAV",
    mode: "PUSH_TO_TALK",
  })], { type: "application/json" }));
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "question.wav");
  const res = await post("/asr/transcribe", { headers: { Accept: "application/json" }, body: form }, TRANSCRIBE_MODEL);
  // Billed per whole second of audio: data bytes / (sample rate * 2 bytes per 16-bit mono sample).
  if (meter && wav.length > 44) meter.add("listening", Math.floor((wav.length - 44) / (wav.readUInt32LE(24) * 2)) * PRICES.transcribeSecond);
  const data = await res.json().catch(() => ({}));
  return undouble(String(data.transcript || "").replace(/\s+/g, " ").trim());
}

// The speech model now and then repeats a word: "doesn't doesn't", or glued as "WhyWhy".
// A spoken question almost never means that, so collapse each repeat to one word.
function undouble(text) {
  // A glued repeat restarts with a capital ("WhyWhy"); real words like "couscous" don't.
  const words = text.split(" ").map((w) => {
    const m = w.match(/^(\p{Lu}[\p{L}']+)(\p{Lu}[\p{L}']+)(\W*)$/u);
    return m && m[1].toLowerCase() === m[2].toLowerCase() ? m[1] + m[3] : w;
  });
  return words.filter((w, i) => i === 0 || w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "") !== words[i - 1].toLowerCase().replace(/[^\p{L}\p{N}']/gu, "")).join(" ");
}

// Turn a server-sent event body into parsed event objects.
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { hasKey: () => !!API_KEY, MODEL, IMAGE_MODEL, SAM_MODEL, TRANSCRIBE_MODEL, MetaError, createMeter, chat, paint, segment, transcribe };
