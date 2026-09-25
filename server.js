const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const crypto = require("crypto");

// Fallback questions keep the game playable if the external question service
// is temporarily unavailable. Normal games use the 5,000+ question bank.
const FALLBACK_QUESTIONS = [
  { q: "What is the capital of Australia?", opts: ["Sydney", "Canberra", "Melbourne", "Perth"], correct: 1 },
  { q: "Which planet is known as the Red Planet?", opts: ["Venus", "Jupiter", "Mars", "Saturn"], correct: 2 },
  { q: "Who wrote 'Romeo and Juliet'?", opts: ["Dickens", "Shakespeare", "Austen", "Hemingway"], correct: 1 },
  { q: "What is the largest ocean on Earth?", opts: ["Atlantic", "Indian", "Arctic", "Pacific"], correct: 3 },
  { q: "How many continents are there?", opts: ["5", "6", "7", "8"], correct: 2 },
  { q: "What gas do plants primarily absorb?", opts: ["Oxygen", "Carbon Dioxide", "Nitrogen", "Hydrogen"], correct: 1 },
  { q: "What is the chemical symbol for gold?", opts: ["Go", "Gd", "Au", "Ag"], correct: 2 },
  { q: "Which country hosted the 2016 Summer Olympics?", opts: ["China", "UK", "Brazil", "Japan"], correct: 2 },
  { q: "What is the smallest prime number?", opts: ["0", "1", "2", "3"], correct: 2 },
  { q: "Which artist painted the Mona Lisa?", opts: ["Van Gogh", "Da Vinci", "Picasso", "Monet"], correct: 1 },
];

const QUESTION_MS = 15000;
const REVEAL_MS = 5000;
const LEADERBOARD_MS = 5000;
const QUESTIONS_PER_GAME = 10;
const QUESTION_API = "https://beta-trivia.bongobot.io/?type=multiple&limit=10";

const rooms = new Map(); // code -> room
const recentQuestionIds = new Set();
const recentQuestionQueue = [];
const MAX_RECENT_QUESTION_IDS = 250;

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rememberQuestionId(id) {
  if (!id || recentQuestionIds.has(id)) return;
  recentQuestionIds.add(id);
  recentQuestionQueue.push(id);
  while (recentQuestionQueue.length > MAX_RECENT_QUESTION_IDS) {
    recentQuestionIds.delete(recentQuestionQueue.shift());
  }
}

function decodeHtmlEntities(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;|&#x22;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function normalizeApiQuestion(item) {
  const q = decodeHtmlEntities(item.question);
  const correct = decodeHtmlEntities(item.correct_answer);
  const incorrect = (item.incorrect_answers || []).map(decodeHtmlEntities);
  const opts = shuffle([correct, ...incorrect]).slice(0, 4);
  const correctIndex = opts.indexOf(correct);
  if (!q || opts.length !== 4 || correctIndex < 0) return null;
  return {
    q,
    opts,
    correct: correctIndex,
    id: String(item.id || q),
    category: item.category || "General Trivia",
    difficulty: item.difficulty || "mixed",
  };
}

async function fetchQuestionBatch() {
  const response = await fetch(QUESTION_API, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Question API returned ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Unexpected question API response");
  return data.map(normalizeApiQuestion).filter(Boolean);
}

async function getQuestionsForGame() {
  const selected = [];
  const selectedIds = new Set();

  // The public trivia service has 5,000+ multiple-choice questions. Fetch
  // several random batches and avoid questions used by recent games.
  for (let attempt = 0; attempt < 6 && selected.length < QUESTIONS_PER_GAME; attempt += 1) {
    try {
      const batch = await fetchQuestionBatch();
      for (const q of shuffle(batch)) {
        if (selected.length >= QUESTIONS_PER_GAME) break;
        if (selectedIds.has(q.id)) continue;
        if (recentQuestionIds.has(q.id)) continue;
        selected.push(q);
        selectedIds.add(q.id);
        rememberQuestionId(q.id);
      }
    } catch (err) {
      console.warn("Question service unavailable:", err.message);
      break;
    }
  }

  // If the API is unavailable or cannot provide a completely fresh batch,
  // fill the remaining slots from the built-in fallback bank.
  if (selected.length < QUESTIONS_PER_GAME) {
    const fallback = shuffle(FALLBACK_QUESTIONS).map((q, index) => ({
      ...q,
      id: `fallback-${index}-${q.q}`,
      category: "General Trivia",
      difficulty: "mixed",
    }));
    for (const q of fallback) {
      if (selected.length >= QUESTIONS_PER_GAME) break;
      if (!selectedIds.has(q.id)) {
        selected.push(q);
        selectedIds.add(q.id);
      }
    }
  }

  return shuffle(selected).slice(0, QUESTIONS_PER_GAME);
}

function newRoom(code, hostId, hostName) {
  return {
    code,
    hostId,
    status: "lobby", // lobby | countdown | question | reveal | leaderboard | final
    players: { [hostId]: { name: hostName, score: 0, connected: true, ws: null, lastGain: 0 } },
    questions: [],
    questionIndex: -1,
    questionStartAt: null,
    answers: {},
    timer: null,
  };
}

function publicState(room, forId) {
  const players = {};
  for (const [id, p] of Object.entries(room.players)) {
    players[id] = { name: p.name, score: p.score, connected: p.connected, lastGain: p.lastGain };
  }
  const answeredIds = Object.keys(room.answers);
  const currentQuestion = room.questions[room.questionIndex];
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    players,
    questionIndex: room.questionIndex,
    questionStartAt: room.questionStartAt,
    questionMs: QUESTION_MS,
    totalQuestions: room.questions.length || QUESTIONS_PER_GAME,
    question: (room.status === "question" || room.status === "reveal") && currentQuestion
      ? {
          q: currentQuestion.q,
          opts: currentQuestion.opts,
          correct: room.status === "reveal" ? currentQuestion.correct : undefined,
        }
      : null,
    answeredIds,
    myAnswer: room.answers[forId] || null,
  };
}

function broadcast(room) {
  for (const [id, p] of Object.entries(room.players)) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type: "state", state: publicState(room, id), you: id }));
    }
  }
}

function connectedIds(room) {
  return Object.entries(room.players).filter(([, p]) => p.connected).map(([id]) => id);
}

function clearRoomTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function startQuestion(room) {
  room.questionIndex += 1;
  room.status = "question";
  room.questionStartAt = Date.now();
  room.answers = {};
  broadcast(room);
  clearRoomTimer(room);
  room.timer = setTimeout(() => endQuestion(room), QUESTION_MS);
}

function endQuestion(room) {
  clearRoomTimer(room);
  const q = room.questions[room.questionIndex];
  if (!q) return;

  for (const [id, p] of Object.entries(room.players)) {
    const ans = room.answers[id];
    let gained = 0;
    if (ans && ans.choice === q.correct) {
      const elapsed = ans.answeredAt - room.questionStartAt;
      const speedBonus = Math.max(0, Math.round(100 * (1 - elapsed / QUESTION_MS)));
      gained = 100 + speedBonus;
    }
    p.score += gained;
    p.lastGain = gained;
  }

  room.status = "reveal";
  broadcast(room);
  room.timer = setTimeout(() => {
    room.status = "leaderboard";
    broadcast(room);
    room.timer = setTimeout(() => {
      if (room.questionIndex + 1 >= room.questions.length) {
        room.status = "final";
        broadcast(room);
      } else {
        startQuestion(room);
      }
    }, LEADERBOARD_MS);
  }, REVEAL_MS);
}

function maybeEndEarly(room) {
  const ids = connectedIds(room);
  if (ids.length > 0 && ids.every((id) => room.answers[id])) endQuestion(room);
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let room = null;
  let selfId = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "host") {
      const code = genRoomCode();
      selfId = crypto.randomUUID();
      room = newRoom(code, selfId, (msg.name || "Host").slice(0, 20));
      room.players[selfId].ws = ws;
      ws._selfId = selfId;
      rooms.set(code, room);
      ws.send(JSON.stringify({ type: "joined", roomCode: code, playerId: selfId }));
      broadcast(room);
    }

    else if (msg.type === "join") {
      const code = (msg.roomCode || "").toUpperCase();
      const target = rooms.get(code);
      if (!target) { ws.send(JSON.stringify({ type: "error", message: "Room not found." })); return; }
      room = target;
      const existingId = msg.playerId && room.players[msg.playerId] ? msg.playerId : null;
      if (existingId) {
        selfId = existingId;
        room.players[selfId].connected = true;
        room.players[selfId].ws = ws;
      } else {
        if (room.status !== "lobby") {
          ws.send(JSON.stringify({ type: "error", message: "This game has already started." }));
          return;
        }
        if (Object.keys(room.players).length >= 8) {
          ws.send(JSON.stringify({ type: "error", message: "Room is full." }));
          return;
        }
        selfId = crypto.randomUUID();
        room.players[selfId] = { name: (msg.name || "Player").slice(0, 20), score: 0, connected: true, ws, lastGain: 0 };
      }
      ws.send(JSON.stringify({ type: "joined", roomCode: code, playerId: selfId }));
      broadcast(room);
    }

    else if (msg.type === "start") {
      if (!room || room.hostId !== selfId || room.status !== "lobby") return;
      if (Object.keys(room.players).length < 2) return;

      try {
        room.questions = await getQuestionsForGame();
      } catch (err) {
        console.error("Could not prepare questions:", err);
        room.questions = shuffle(FALLBACK_QUESTIONS);
      }
      if (room.questions.length < QUESTIONS_PER_GAME) {
        ws.send(JSON.stringify({ type: "error", message: "Could not prepare enough questions. Please try again." }));
        return;
      }

      room.questionIndex = -1;
      room.status = "countdown";
      broadcast(room);
      clearRoomTimer(room);
      room.timer = setTimeout(() => startQuestion(room), 3000);
    }

    else if (msg.type === "answer") {
      if (!room || room.status !== "question") return;
      if (room.answers[selfId]) return;
      if (typeof msg.choice !== "number" || msg.choice < 0 || msg.choice > 3) return;
      room.answers[selfId] = { choice: msg.choice, answeredAt: Date.now() };
      broadcast(room);
      maybeEndEarly(room);
    }

    else if (msg.type === "playAgain") {
      if (!room || room.hostId !== selfId || room.status !== "final") return;
      for (const p of Object.values(room.players)) { p.score = 0; p.lastGain = 0; }
      room.questions = [];
      room.status = "lobby";
      room.questionIndex = -1;
      room.questionStartAt = null;
      room.answers = {};
      broadcast(room);
    }
  });

  ws.on("close", () => {
    if (room && selfId && room.players[selfId]) {
      room.players[selfId].connected = false;
      room.players[selfId].ws = null;
      broadcast(room);
      maybeEndEarly(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Quiz Dash running on port ${PORT}`));
