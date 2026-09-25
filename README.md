# Quiz Dash

Real-time multiplayer trivia. Node.js + Express + WebSocket server; room
state lives in server memory (no database needed for this scale).

## Run locally
```
npm install
npm start
```
Open http://localhost:3000 in two browser tabs to test.

## Get a public URL (free, ~2 minutes, no CLI)
**Render.com** is the simplest path:
1. Go to render.com, sign up free, click **New > Web Service**.
2. Choose **"Deploy from a public Git repo"** if you push this folder to
   GitHub first — OR use **"Deploy without Git"** if your plan offers it,
   by uploading this folder directly.
3. Build command: `npm install` — Start command: `npm start`.
4. Deploy. Render gives you a URL like `https://quiz-dash-xxxx.onrender.com`
   — that's your public, no-login, anyone-can-join link.

Alternatives that work the same way: Railway.app, Fly.io, or Glitch.com
(Glitch lets you paste/import the code directly in the browser with no
account setup beyond Glitch's own, and gives an instant public URL).

Once deployed, anyone with the URL can open it on any device, no Claude
account and no sign-in of any kind required — they just need a name and,
to join an existing game, the 4-character room code shown in the host's
lobby.
