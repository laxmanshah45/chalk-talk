# Chalk Talk

An animated tutor built on Meta Model API for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026). Every line in this repository was written during the hackathon.

You type a topic. Chalk Talk paints a chalk picture for every scene of the lesson, then talks you through it: each part of the picture is traced in chalk, coloured in, and labelled at the moment the narration mentions it. Raise your hand at any time to ask a question out loud, and the tutor answers while pointing at the picture. A quick quiz checks understanding at the end.

## How it works

Four Meta models work together on every lesson:

1. **Muse Spark** writes the script: scenes, narration, a picture plan for each scene, the parts to point at, and a quiz.
2. **Muse Image** paints every scene's chalk picture, all at the same time.
3. **Muse Spark** looks at each finished picture and marks where each part is drawn.
4. **SAM 3.1** turns each mark into the part's exact outline, which the board traces in chalk and uses to colour the part in.

When a student raises their hand, **Muse Voice Transcribe** turns the spoken question into text, and **Muse Spark** answers it while looking at the picture on the board, choosing which parts to point at as it explains.

Meta Model API has no text-to-speech, so narration uses **Kokoro**, an open-weight voice model that runs on your own computer. Without it, the browser's built-in voice is used instead.

The board shows each model's step live while a lesson is made, and scene 1 starts playing as soon as it's ready.

## Run it

1. Install Node.js 20.17 or newer from nodejs.org.
2. In this folder, run `npm install`. This also installs the Kokoro voice, about 400 MB. If you'd rather skip it, run `npm install --omit=optional` and the browser's voice is used.
3. Copy `.env.example` to a new file named `.env`.
4. Paste your key from dev.meta.ai (API Keys) after `MODEL_API_KEY=`.
5. Run `npm start`.
6. Open http://localhost:3000 in Chrome, Edge, or Safari.

Click "Play the sample lesson" first. It works without an API key, so you can see and hear the whole experience on its own. Asking questions and making new lessons need the key.

Every lesson you make is saved in the `lessons/` folder and listed under the topic box, so you can replay it instantly.

## What a lesson costs

About 10 to 20 cents of API credit for a five-scene lesson: five Muse Image pictures ($0.05), five SAM 3.1 segmentations ($0.0125), and Muse Spark for the script and for finding parts. Each raised-hand question is about 1 cent. Narration with Kokoro is free because it runs locally.

## Before you push to GitHub

The hackathon requires a public repository, so anything you commit is visible to everyone.

- `.env` holds your API key and is listed in `.gitignore`. Never commit it, and never paste your key into `server.js` or the files in `lib/` or `public/`.
- Generated lessons in `lessons/` are ignored too. The sample lesson lives in `public/samples/`.
- If a key ever gets committed, delete it at dev.meta.ai right away and create a new one.

## If something goes wrong

- **"No API key found"**: you're missing `.env`, or the server was started before you made it. Stop it with Ctrl+C and run `npm start` again.
- **"model not found"**: change `MODEL` in `.env` to `muse-spark-1.1`.
- **No sound**: click somewhere on the page first, then press Play.
- **The browser's robotic voice plays instead of Kokoro**: the terminal says why when the server starts. Run `npm install` again, or check you have enough disk space.
- **Raise hand doesn't hear you**: allow microphone access for localhost in your browser, or type your question in the box instead.
- **A part isn't outlined**: when SAM can't find a clean outline, the board circles the area Muse Spark marked instead.

## Code map

- `server.js`: serves the page, streams lesson progress, and keeps your key on the server.
- `lib/lesson.js`: the lesson pipeline and `LESSON_PROMPT`. Edit the prompt to change the tutor's style, length, or picture style.
- `lib/meta.js`: calls to Muse Spark, Muse Image, SAM 3.1 and Muse Voice Transcribe.
- `lib/outline.js`: simplifies SAM's pixel outlines into smooth shapes the board can trace.
- `lib/voice.js`: Kokoro narration.
- `lib/ask.js`: raise-your-hand answers.
- `public/app.js`: the lesson player: chalk tracing, labels, narration sync, quiz, and the microphone.
