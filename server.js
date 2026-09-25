const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const crypto = require("crypto");

// ============================================================
// QUIZ QUESTIONS
// ============================================================

// Load the local 5,000-question bank.
// The file must be in the project root beside server.js.
const QUESTION_BANK = require("./questions.json");

const QUESTION_MS = 15000;
const REVEAL_MS = 5000;
const LEADERBOARD_MS = 5000;
const QUESTIONS_PER_GAME = 10;
const MAX_PLAYERS = 8;

// Validate the question bank when the server starts.
function validateQuestionBank() {
  if (!Array.isArray(QUESTION_BANK)) {
    throw new Error("questions.json must contain an array.");
  }

  if (QUESTION_BANK.length < QUESTIONS_PER_GAME) {
    throw new Error(
      `Question bank contains only ${QUESTION_BANK.length} questions.`
    );
  }

  for (const [index, q] of QUESTION_BANK.entries()) {
    if (
      !q ||
      typeof q.q !== "string" ||
      !Array.isArray(q.opts) ||
      q.opts.length !== 4 ||
      typeof q.correct !== "number" ||
      q.correct < 0 ||
      q.correct > 3
    ) {
      throw new Error(
        `Invalid question format at questions.json index ${index}.`
      );
    }
  }

  console.log(
    `Loaded ${QUESTION_BANK.length} questions from questions.json`
  );
}

validateQuestionBank();

// ============================================================
// ROOM MANAGEMENT
// ============================================================

const rooms = new Map();

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code;

  do {
    code = Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

// ============================================================
// RANDOMIZATION
// ============================================================

function shuffle(array) {
  const a = [...array];

  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));

    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

// ============================================================
// QUESTION SELECTION
// ============================================================

// Select 10 unique questions from the local 5,000-question bank.
//
// Every player in the same room receives the same selected questions,
// because the selection happens once when the host starts the game.
function getQuestionsForGame() {
  const shuffled = shuffle(QUESTION_BANK);

  const selected = shuffled
    .slice(0, QUESTIONS_PER_GAME)
    .map((question) => ({
      q: question.q,
      opts: [...question.opts],
      correct: question.correct,
      id: question.id,
      category: question.category || "General",
      difficulty: question.difficulty || "mixed",
    }));

  return selected;
}

// ============================================================
// ROOM CREATION
// ============================================================

function newRoom(code, hostId, hostName) {
  return {
    code,

    hostId,

    status: "lobby",
    // lobby
    // countdown
    // question
    // reveal
    // leaderboard
    // final

    players: {
      [hostId]: {
        name: hostName,
        score: 0,
        connected: true,
        ws: null,
        lastGain: 0,
      },
    },

    questions: [],

    questionIndex: -1,

    questionStartAt: null,

    answers: {},

    timer: null,
  };
}

// ============================================================
// PUBLIC GAME STATE
// ============================================================

function publicState(room, forId) {
  const players = {};

  for (const [id, p] of Object.entries(room.players)) {
    players[id] = {
      name: p.name,
      score: p.score,
      connected: p.connected,
      lastGain: p.lastGain,
    };
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

    totalQuestions:
      room.questions.length || QUESTIONS_PER_GAME,

    question:
      (room.status === "question" ||
        room.status === "reveal") &&
      currentQuestion
        ? {
            q: currentQuestion.q,

            opts: currentQuestion.opts,

            // Only reveal the correct answer during reveal.
            correct:
              room.status === "reveal"
                ? currentQuestion.correct
                : undefined,
          }
        : null,

    answeredIds,

    myAnswer: room.answers[forId] || null,
  };
}

// ============================================================
// BROADCAST
// ============================================================

function broadcast(room) {
  for (const [id, p] of Object.entries(room.players)) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(
        JSON.stringify({
          type: "state",
          state: publicState(room, id),
          you: id,
        })
      );
    }
  }
}

// ============================================================
// PLAYER HELPERS
// ============================================================

function connectedIds(room) {
  return Object.entries(room.players)
    .filter(([, p]) => p.connected)
    .map(([id]) => id);
}

// ============================================================
// TIMERS
// ============================================================

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

// ============================================================
// START QUESTION
// ============================================================

function startQuestion(room) {
  room.questionIndex += 1;

  room.status = "question";

  room.questionStartAt = Date.now();

  room.answers = {};

  broadcast(room);

  clearRoomTimer(room);

  room.timer = setTimeout(
    () => endQuestion(room),
    QUESTION_MS
  );
}

// ============================================================
// END QUESTION
// ============================================================

function endQuestion(room) {
  clearRoomTimer(room);

  const q = room.questions[room.questionIndex];

  if (!q) {
    return;
  }

  for (const [id, p] of Object.entries(room.players)) {
    const ans = room.answers[id];

    let gained = 0;

    if (ans && ans.choice === q.correct) {
      const elapsed =
        ans.answeredAt - room.questionStartAt;

      const speedBonus = Math.max(
        0,
        Math.round(
          100 * (1 - elapsed / QUESTION_MS)
        )
      );

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
      if (
        room.questionIndex + 1 >=
        room.questions.length
      ) {
        room.status = "final";

        broadcast(room);
      } else {
        startQuestion(room);
      }
    }, LEADERBOARD_MS);
  }, REVEAL_MS);
}

// ============================================================
// END QUESTION EARLY
// ============================================================

function maybeEndEarly(room) {
  const ids = connectedIds(room);

  if (
    ids.length > 0 &&
    ids.every((id) => room.answers[id])
  ) {
    endQuestion(room);
  }
}

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(
  express.static(path.join(__dirname, "public"))
);

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(app);

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocketServer({
  server,
});

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on("connection", (ws) => {
  let room = null;

  let selfId = null;

  ws.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // ========================================================
    // HOST CREATES ROOM
    // ========================================================

    if (msg.type === "host") {
      const code = genRoomCode();

      selfId = crypto.randomUUID();

      room = newRoom(
        code,
        selfId,
        (msg.name || "Host").slice(0, 20)
      );

      room.players[selfId].ws = ws;

      ws._selfId = selfId;

      rooms.set(code, room);

      ws.send(
        JSON.stringify({
          type: "joined",
          roomCode: code,
          playerId: selfId,
        })
      );

      broadcast(room);

      return;
    }

    // ========================================================
    // PLAYER JOINS ROOM
    // ========================================================

    if (msg.type === "join") {
      const code = (msg.roomCode || "")
        .toUpperCase()
        .trim();

      const target = rooms.get(code);

      if (!target) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Room not found.",
          })
        );

        return;
      }

      room = target;

      // ------------------------------------------------------
      // RECONNECT EXISTING PLAYER
      // ------------------------------------------------------

      const existingId =
        msg.playerId &&
        room.players[msg.playerId]
          ? msg.playerId
          : null;

      if (existingId) {
        selfId = existingId;

        room.players[selfId].connected = true;

        room.players[selfId].ws = ws;
      }

      // ------------------------------------------------------
      // NEW PLAYER
      // ------------------------------------------------------

      else {
        if (room.status !== "lobby") {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "This game has already started.",
            })
          );

          return;
        }

        if (
          Object.keys(room.players).length >=
          MAX_PLAYERS
        ) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Room is full.",
            })
          );

          return;
        }

        selfId = crypto.randomUUID();

        room.players[selfId] = {
          name: (msg.name || "Player").slice(0, 20),

          score: 0,

          connected: true,

          ws,

          lastGain: 0,
        };
      }

      ws.send(
        JSON.stringify({
          type: "joined",
          roomCode: code,
          playerId: selfId,
        })
      );

      broadcast(room);

      return;
    }

    // ========================================================
    // HOST STARTS GAME
    // ========================================================

    if (msg.type === "start") {
      if (
        !room ||
        room.hostId !== selfId ||
        room.status !== "lobby"
      ) {
        return;
      }

      if (
        Object.keys(room.players).length < 2
      ) {
        return;
      }

      // ------------------------------------------------------
      // GET 10 QUESTIONS FROM LOCAL 5,000 BANK
      // ------------------------------------------------------

      try {
        room.questions =
          getQuestionsForGame();
      } catch (err) {
        console.error(
          "Could not prepare questions:",
          err
        );

        ws.send(
          JSON.stringify({
            type: "error",
            message:
              "Could not prepare questions.",
          })
        );

        return;
      }

      if (
        room.questions.length <
        QUESTIONS_PER_GAME
      ) {
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              "Could not prepare enough questions.",
          })
        );

        return;
      }

      room.questionIndex = -1;

      room.status = "countdown";

      broadcast(room);

      clearRoomTimer(room);

      // 3-second countdown
      room.timer = setTimeout(
        () => startQuestion(room),
        3000
      );

      return;
    }

    // ========================================================
    // PLAYER ANSWERS
    // ========================================================

    if (msg.type === "answer") {
      if (
        !room ||
        room.status !== "question"
      ) {
        return;
      }

      // One answer per player.
      if (room.answers[selfId]) {
        return;
      }

      if (
        typeof msg.choice !== "number" ||
        msg.choice < 0 ||
        msg.choice > 3
      ) {
        return;
      }

      room.answers[selfId] = {
        choice: msg.choice,

        answeredAt: Date.now(),
      };

      broadcast(room);

      maybeEndEarly(room);

      return;
    }

    // ========================================================
    // PLAY AGAIN
    // ========================================================

    if (msg.type === "playAgain") {
      if (
        !room ||
        room.hostId !== selfId ||
        room.status !== "final"
      ) {
        return;
      }

      for (const p of Object.values(
        room.players
      )) {
        p.score = 0;

        p.lastGain = 0;
      }

      room.questions = [];

      room.status = "lobby";

      room.questionIndex = -1;

      room.questionStartAt = null;

      room.answers = {};

      broadcast(room);

      return;
    }
  });

  // ==========================================================
  // PLAYER DISCONNECT
  // ==========================================================

  ws.on("close", () => {
    if (
      room &&
      selfId &&
      room.players[selfId]
    ) {
      room.players[selfId].connected = false;

      room.players[selfId].ws = null;

      broadcast(room);

      maybeEndEarly(room);
    }
  });
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Quiz Dash running on port ${PORT}`
  );

  console.log(
    `Question bank: ${QUESTION_BANK.length} questions`
  );
});
