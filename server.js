const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── HTTP: serve index.html and ultimate.html ──────────────────────
const httpServer = http.createServer((req, res) => {
  const routes = {
    '/':              'index.html',
    '/index.html':    'index.html',
    '/ultimate':      'ultimate.html',
    '/ultimate.html': 'ultimate.html',
  };
  const filename = routes[req.url];
  if (filename) {
    const file = path.join(__dirname, filename);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

const rooms = {};  // { [code]: room }

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function checkWinner9(cells) {
  for (const [a,b,c] of LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c])
      return { winner: cells[a], line: [a,b,c] };
  }
  if (cells.every(v => v !== null)) return { winner: 'draw', line: null };
  return null;
}

// ── Normal TTT room ───────────────────────────────────────────────
function makeNormalRoom() {
  return {
    mode: 'normal',
    players: [],
    cells: Array(9).fill(null),
    currentPlayer: 'X',
    scores: { X:0, O:0, D:0 },
    over: false,
    rematchVotes: new Set(),
  };
}

// ── Ultimate TTT room ─────────────────────────────────────────────
// State mirrors the local game:
//   cells[board][cell]  = null | 'X' | 'O'
//   boardWon[board]     = null | 'X' | 'O'
//   boardReplaying[b]   = bool
//   startedBoard        = null | index
//   megaWinner          = null | 'X' | 'O' | 'draw'
function makeUltimateRoom() {
  return {
    mode: 'ultimate',
    players: [],
    cells: Array(9).fill(null).map(() => Array(9).fill(null)),
    boardWon: Array(9).fill(null),
    boardReplaying: Array(9).fill(false),
    startedBoard: null,
    currentPlayer: 'X',
    megaWinner: null,
    scores: { X:0, O:0 },
    over: false,
    rematchVotes: new Set(),
    // pending replay boards: board index waiting to be wiped after delay
    replayTimers: {},
  };
}

function ultimateStateSnapshot(room) {
  return {
    cells:          room.cells,
    boardWon:       room.boardWon,
    boardReplaying: room.boardReplaying,
    startedBoard:   room.startedBoard,
    currentPlayer:  room.currentPlayer,
    megaWinner:     room.megaWinner,
    scores:         room.scores,
  };
}

// ── Ultimate move logic (mirrors client handleClick / doPlace) ────
function ultimateMove(room, boardIdx, cellIdx) {
  // Validate
  if (room.over) return null;
  if (room.boardWon[boardIdx] === 'X' || room.boardWon[boardIdx] === 'O') return null;
  if (room.cells[boardIdx][cellIdx] !== null) return null;
  if (room.startedBoard !== null && boardIdx !== room.startedBoard) return null;

  // Place
  room.cells[boardIdx][cellIdx] = room.currentPlayer;

  const boardCells = room.cells[boardIdx];
  const boardResult = checkWinner9(boardCells);
  let replayBoard = null;

  if (boardResult && (boardResult.winner === 'X' || boardResult.winner === 'O')) {
    room.boardWon[boardIdx] = boardResult.winner;
    room.boardReplaying[boardIdx] = false;
    room.startedBoard = null;

    // Check mega winner
    const megaCheck = checkWinner9(room.boardWon);
    if (megaCheck && (megaCheck.winner === 'X' || megaCheck.winner === 'O')) {
      room.megaWinner = megaCheck.winner;
      room.scores[megaCheck.winner]++;
      room.over = true;
    } else {
      const allWon = room.boardWon.every(r => r === 'X' || r === 'O');
      if (allWon) {
        const xs = room.boardWon.filter(r => r === 'X').length;
        const os = room.boardWon.filter(r => r === 'O').length;
        room.megaWinner = xs > os ? 'X' : os > xs ? 'O' : 'draw';
        if (room.megaWinner !== 'draw') room.scores[room.megaWinner]++;
        room.over = true;
      }
    }

  } else if (boardResult && boardResult.winner === 'draw') {
    // Draw → board replays after 800ms (server schedules wipe)
    room.boardReplaying[boardIdx] = true;
    room.startedBoard = boardIdx;
    replayBoard = boardIdx;

  } else {
    // Board in progress
    room.startedBoard = boardIdx;
  }

  if (!room.over) {
    room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
  }

  return { replayBoard };
}

function resetUltimateRoom(room) {
  // Cancel pending timers
  Object.values(room.replayTimers).forEach(t => clearTimeout(t));
  room.replayTimers = {};

  room.cells = Array(9).fill(null).map(() => Array(9).fill(null));
  room.boardWon = Array(9).fill(null);
  room.boardReplaying = Array(9).fill(false);
  room.startedBoard = null;
  room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X'; // swap start
  room.megaWinner = null;
  room.over = false;
  room.rematchVotes = new Set();
}

// ── Helpers ───────────────────────────────────────────────────────
function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  room.players.forEach(ws => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Connection handler ────────────────────────────────────────────
wss.on('connection', ws => {
  ws.roomCode = null;
  ws.symbol = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const mode = msg.mode === 'ultimate' ? 'ultimate' : 'normal';

      if (!rooms[code]) {
        rooms[code] = mode === 'ultimate' ? makeUltimateRoom() : makeNormalRoom();
      }
      const room = rooms[code];

      // Mode mismatch — prevent normal client joining ultimate room
      if (room.mode !== mode) {
        send(ws, { type: 'error', text: 'Falscher Spielmodus für diesen Raum.' });
        return;
      }

      if (room.players.length >= 2) {
        send(ws, { type: 'error', text: 'Raum ist voll!' });
        return;
      }

      ws.roomCode = code;
      ws.symbol = room.players.length === 0 ? 'X' : 'O';
      room.players.push(ws);

      send(ws, { type: 'joined', symbol: ws.symbol, code, mode });

      if (room.players.length === 2) {
        if (mode === 'ultimate') {
          broadcast(room, {
            type: 'start',
            ...ultimateStateSnapshot(room),
          });
        } else {
          broadcast(room, {
            type: 'start',
            cells: room.cells,
            currentPlayer: room.currentPlayer,
            scores: room.scores,
          });
        }
      } else {
        send(ws, { type: 'waiting' });
      }
    }

    // ── NORMAL MOVE ───────────────────────────────────────────────
    else if (msg.type === 'move') {
      const room = rooms[ws.roomCode];
      if (!room || room.mode !== 'normal' || room.over) return;
      if (ws.symbol !== room.currentPlayer) return;
      const i = msg.index;
      if (i < 0 || i > 8 || room.cells[i]) return;

      room.cells[i] = room.currentPlayer;
      const result = checkWinner9(room.cells);

      if (result) {
        room.over = true;
        if (result.winner === 'draw') room.scores.D++;
        else room.scores[result.winner]++;
        broadcast(room, {
          type: 'update',
          cells: room.cells,
          currentPlayer: room.currentPlayer,
          scores: room.scores,
          result,
        });
      } else {
        room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
        broadcast(room, {
          type: 'update',
          cells: room.cells,
          currentPlayer: room.currentPlayer,
          scores: room.scores,
          result: null,
        });
      }
    }

    // ── ULTIMATE MOVE ─────────────────────────────────────────────
    else if (msg.type === 'ultimate_move') {
      const room = rooms[ws.roomCode];
      if (!room || room.mode !== 'ultimate') return;
      if (ws.symbol !== room.currentPlayer) return;

      const { boardIdx, cellIdx } = msg;
      const outcome = ultimateMove(room, boardIdx, cellIdx);
      if (!outcome) return; // invalid move

      // Send state update immediately
      broadcast(room, {
        type: 'ultimate_update',
        ...ultimateStateSnapshot(room),
        lastMove: { boardIdx, cellIdx },
      });

      // If a board needs replay, wipe it server-side after 800ms
      // and send a replay_wipe message so clients can animate
      if (outcome.replayBoard !== null) {
        const b = outcome.replayBoard;
        // Cancel any existing timer for this board
        if (room.replayTimers[b]) clearTimeout(room.replayTimers[b]);

        room.replayTimers[b] = setTimeout(() => {
          if (!rooms[ws.roomCode]) return;
          room.cells[b] = Array(9).fill(null);
          room.boardReplaying[b] = true;
          // startedBoard stays as b
          delete room.replayTimers[b];

          broadcast(room, {
            type: 'ultimate_replay_wipe',
            boardIdx: b,
            ...ultimateStateSnapshot(room),
          });
        }, 900);
      }
    }

    // ── REMATCH ───────────────────────────────────────────────────
    else if (msg.type === 'rematch') {
      const room = rooms[ws.roomCode];
      if (!room) return;

      room.rematchVotes.add(ws.symbol);

      if (room.rematchVotes.size === 2) {
        if (room.mode === 'ultimate') {
          resetUltimateRoom(room);
          broadcast(room, {
            type: 'start',
            ...ultimateStateSnapshot(room),
          });
        } else {
          room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
          room.cells = Array(9).fill(null);
          room.over = false;
          room.rematchVotes = new Set();
          broadcast(room, {
            type: 'start',
            cells: room.cells,
            currentPlayer: room.currentPlayer,
            scores: room.scores,
          });
        }
      } else {
        broadcast(room, { type: 'rematch_vote', from: ws.symbol });
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode || !rooms[ws.roomCode]) return;
    const room = rooms[ws.roomCode];
    broadcast(room, { type: 'opponent_left' });
    setTimeout(() => {
      if (rooms[ws.roomCode]) {
        const r = rooms[ws.roomCode];
        if (r.players.every(p => !p || p.readyState !== WebSocket.OPEN)) {
          // Clean up timers before deleting
          if (r.replayTimers) Object.values(r.replayTimers).forEach(t => clearTimeout(t));
          delete rooms[ws.roomCode];
        }
      }
    }, 30000);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`  Normal TTT:  http://localhost:${PORT}/`);
  console.log(`  Ultimate TTT: http://localhost:${PORT}/ultimate`);
});
