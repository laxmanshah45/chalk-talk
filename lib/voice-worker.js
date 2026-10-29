// Runs Kokoro on its own thread. Generating speech keeps a thread busy for seconds at a time,
// so doing it here lets the server keep answering requests (pictures, audio, answers) meanwhile.

const { parentPort } = require("worker_threads");

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
let ttsPromise = null;
let queue = Promise.resolve();

function load() {
  if (!ttsPromise) {
    ttsPromise = import("kokoro-js").then(({ KokoroTTS }) => KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" }));
  }
  return ttsPromise;
}

parentPort.on("message", (msg) => {
  if (msg.type === "load") {
    load().then(
      () => parentPort.postMessage({ type: "ready" }),
      (err) => parentPort.postMessage({ type: "failed", error: err.message }),
    );
  } else if (msg.type === "speak") {
    // One sentence at a time, in the order they were asked for.
    queue = queue.then(async () => {
      try {
        const tts = await load();
        const audio = await tts.generate(msg.text, { voice: msg.voice });
        const samples = new Float32Array(audio.audio);
        parentPort.postMessage({ type: "spoken", id: msg.id, samples, rate: audio.sampling_rate }, [samples.buffer]);
      } catch (err) {
        parentPort.postMessage({ type: "spoken", id: msg.id, error: err.message });
      }
    });
  }
});
