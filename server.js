const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── HTTP server (serves the HTML file) ───────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket server ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

// rooms: { [code]: { players: [ws, ws], cells: [], currentPlayer: 'X', scores: {} } }
const rooms = {};

function makeRoom() {
  return {
    players: [],      // [wsX, wsO]
    cells: Array(9).fill(null),
    currentPlayer: 'X',
    scores: { X: 0, O: 0, D: 0 },
    over: false,
  };
}

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  room.players.forEach(ws => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function checkWinner(cells) {
  for (const [a,b,c] of LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c])
      return { winner: cells[a], line: [a,b,c] };
  }
  if (cells.every(c => c !== null)) return { winner: 'draw', line: null };
  return null;
}

wss.on('connection', ws => {
  ws.roomCode = null;
  ws.symbol = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const code = msg.code.toUpperCase().trim();

      if (!rooms[code]) rooms[code] = makeRoom();
      const room = rooms[code];

      if (room.players.length >= 2) {
        send(ws, { type: 'error', text: 'Raum ist voll!' });
        return;
      }

      ws.roomCode = code;
      ws.symbol = room.players.length === 0 ? 'X' : 'O';
      room.players.push(ws);

      send(ws, { type: 'joined', symbol: ws.symbol, code });

      if (room.players.length === 2) {
        broadcast(room, {
          type: 'start',
          cells: room.cells,
          currentPlayer: room.currentPlayer,
          scores: room.scores,
        });
      } else {
        send(ws, { type: 'waiting' });
      }
    }

    // ── MOVE ──────────────────────────────────────────────────────
    else if (msg.type === 'move') {
      const room = rooms[ws.roomCode];
      if (!room || room.over) return;
      if (ws.symbol !== room.currentPlayer) return;
      const i = msg.index;
      if (i < 0 || i > 8 || room.cells[i]) return;

      room.cells[i] = room.currentPlayer;

      const result = checkWinner(room.cells);
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

    // ── REMATCH ───────────────────────────────────────────────────
    else if (msg.type === 'rematch') {
      const room = rooms[ws.roomCode];
      if (!room) return;

      if (!room.rematchVotes) room.rematchVotes = new Set();
      room.rematchVotes.add(ws.symbol);

      if (room.rematchVotes.size === 2) {
        // swap starting player
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
      } else {
        broadcast(room, { type: 'rematch_vote', from: ws.symbol });
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode || !rooms[ws.roomCode]) return;
    const room = rooms[ws.roomCode];
    broadcast(room, { type: 'opponent_left' });
    // clean up after a delay
    setTimeout(() => {
      if (rooms[ws.roomCode]) {
        const r = rooms[ws.roomCode];
        if (r.players.every(p => p.readyState !== WebSocket.OPEN)) {
          delete rooms[ws.roomCode];
        }
      }
    }, 30000);
  });
});

httpServer.listen(PORT, () => {
  console.log(`TTT Multiplayer Server läuft auf Port ${PORT}`);
});
