# Chalk Talk

An animated tutor built on Meta Model API for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026). Every line in this repository was written during the hackathon.

You type a topic. Muse Spark writes a short lesson as scenes, and the player reads each scene aloud while drawing each idea onto a chalkboard at the moment it is spoken. A quick quiz checks understanding at the end.

## Run it

1. Install Node.js 18 or newer from nodejs.org. Nothing else needs installing.
2. In this folder, copy `.env.example` to a new file named `.env`.
3. Paste your key from dev.meta.ai (API Keys) after `MODEL_API_KEY=`.
4. Run `npm start`.
5. Open http://localhost:3000 in Chrome, Edge, or Safari.

Click "Play the sample lesson instead" first. It works without an API key, so you can check the voice and animation on their own.

## Before you push to GitHub

The hackathon requires a public repository, so anything you commit is visible to everyone.

- `.env` holds your API key and is listed in `.gitignore`. Never commit it, and never paste your key into `server.js` or `app.js`.
- If a key ever gets committed, delete it at dev.meta.ai right away and create a new one.
- Commit often. Your commit history shows judges what you built during the event.

## If something goes wrong

- **"No API key found"**: you're missing `.env`, or the server was started before you made it. Stop it with Ctrl+C and run `npm start` again.
- **"model not found"**: change `MODEL` in `.env` to `muse-spark-1.1`.
- **No sound**: click somewhere on the page first, check the Voice settings dropdown, and try Chrome.
- **Words highlight out of step with the voice**: some voices don't report word timing, so the player estimates it. Pick a different voice in Voice settings.

## How it works

- `server.js` keeps your key private and sends the topic to Muse Spark through the Chat Completions endpoint, with instructions to answer in a fixed JSON format. It checks and tidies the result before passing it to the page.
- `public/app.js` speaks one sentence at a time with the browser's built-in voice. As each word is spoken, it reveals every visual whose trigger word has been reached.
- The lesson prompt lives at the top of `server.js` as `LESSON_PROMPT`. Edit it to change the tutor's style or length.
