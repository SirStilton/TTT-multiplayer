const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── HTTP ──────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const routes = {
    '/':              'index.html',
    '/index.html':    'index.html',
    '/ultimate':      'ultimate.html',
    '/ultimate.html': 'ultimate.html',
    '/triple':        'triple.html',
    '/triple.html':   'triple.html',
  };
  const filename = routes[req.url];
  if (filename) {
    fs.readFile(path.join(__dirname, filename), (err, data) => {
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
const rooms = {};

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function check9(cells) {
  for (const [a,b,c] of LINES)
    if (cells[a] && cells[a]===cells[b] && cells[a]===cells[c])
      return cells[a];
  if (cells.every(v => v !== null)) return 'draw';
  return null;
}

// ── HELPERS ───────────────────────────────────────────────────────
function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  room.players.forEach(ws => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(s); });
}
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function clearTimers(room) {
  if (room.timers) Object.values(room.timers).forEach(t => clearTimeout(t));
  room.timers = {};
}

// ══════════════════════════════════════════════════════════════════
// NORMAL TTT
// ══════════════════════════════════════════════════════════════════
function makeNormal() {
  return { mode:'normal', players:[], cells:Array(9).fill(null),
    currentPlayer:'X', scores:{X:0,O:0,D:0}, over:false, rematchVotes:new Set() };
}

function handleNormalMove(room, ws, msg) {
  if (room.over || ws.symbol !== room.currentPlayer) return;
  const i = msg.index;
  if (i<0||i>8||room.cells[i]) return;
  room.cells[i] = room.currentPlayer;
  const w = check9(room.cells);
  if (w) {
    room.over = true;
    if (w==='draw') room.scores.D++; else room.scores[w]++;
    broadcast(room, { type:'update', cells:room.cells, currentPlayer:room.currentPlayer,
      scores:room.scores, result:{ winner:w, line:getLine(room.cells) } });
  } else {
    room.currentPlayer = room.currentPlayer==='X'?'O':'X';
    broadcast(room, { type:'update', cells:room.cells, currentPlayer:room.currentPlayer,
      scores:room.scores, result:null });
  }
}

function getLine(cells) {
  for (const ln of LINES)
    if (cells[ln[0]] && cells[ln[0]]===cells[ln[1]] && cells[ln[0]]===cells[ln[2]]) return ln;
  return null;
}

function rematchNormal(room) {
  room.currentPlayer = room.currentPlayer==='X'?'O':'X';
  room.cells = Array(9).fill(null);
  room.over = false; room.rematchVotes = new Set();
  broadcast(room, { type:'start', cells:room.cells, currentPlayer:room.currentPlayer, scores:room.scores });
}

// ══════════════════════════════════════════════════════════════════
// ULTIMATE TTT (2-level)
// ══════════════════════════════════════════════════════════════════
function makeUltimate() {
  return {
    mode:'ultimate', players:[],
    cells: Array(9).fill(null).map(()=>Array(9).fill(null)),
    boardWon: Array(9).fill(null),
    boardReplaying: Array(9).fill(false),
    startedBoard: null,
    currentPlayer:'X', megaWinner:null,
    scores:{X:0,O:0}, over:false,
    rematchVotes:new Set(), timers:{},
  };
}

function snapUltimate(r) {
  return { cells:r.cells, boardWon:r.boardWon, boardReplaying:r.boardReplaying,
    startedBoard:r.startedBoard, currentPlayer:r.currentPlayer,
    megaWinner:r.megaWinner, scores:r.scores };
}

function handleUltimateMove(room, ws, msg) {
  if (room.over || ws.symbol !== room.currentPlayer) return;
  const { boardIdx, cellIdx } = msg;
  const bw = room.boardWon[boardIdx];
  if (bw==='X'||bw==='O') return;
  if (room.cells[boardIdx][cellIdx]!==null) return;
  if (room.startedBoard!==null && boardIdx!==room.startedBoard) return;

  room.cells[boardIdx][cellIdx] = room.currentPlayer;
  const res = check9(room.cells[boardIdx]);

  let replayBoard = null;
  if (res==='X'||res==='O') {
    room.boardWon[boardIdx] = res;
    room.boardReplaying[boardIdx] = false;
    room.startedBoard = null;
    const mega = check9(room.boardWon);
    if (mega==='X'||mega==='O') {
      room.megaWinner=mega; room.scores[mega]++; room.over=true;
    } else {
      const allWon = room.boardWon.every(r=>r==='X'||r==='O');
      if (allWon) {
        const xs=room.boardWon.filter(r=>r==='X').length, os=room.boardWon.filter(r=>r==='O').length;
        room.megaWinner = xs>os?'X':os>xs?'O':'draw';
        if (room.megaWinner!=='draw') room.scores[room.megaWinner]++;
        room.over=true;
      }
    }
  } else if (res==='draw') {
    room.boardReplaying[boardIdx]=true; room.startedBoard=boardIdx; replayBoard=boardIdx;
  } else {
    room.startedBoard=boardIdx;
  }

  if (!room.over) room.currentPlayer = room.currentPlayer==='X'?'O':'X';

  broadcast(room, { type:'ultimate_update', ...snapUltimate(room), lastMove:{boardIdx,cellIdx} });

  if (replayBoard!==null) {
    const b = replayBoard;
    if (room.timers[b]) clearTimeout(room.timers[b]);
    room.timers[b] = setTimeout(()=>{
      if (!rooms[ws.roomCode]) return;
      room.cells[b]=Array(9).fill(null);
      room.boardReplaying[b]=true;
      delete room.timers[b];
      broadcast(room, { type:'ultimate_replay_wipe', boardIdx:b, ...snapUltimate(room) });
    }, 900);
  }
}

function resetUltimate(room) {
  clearTimers(room);
  room.cells=Array(9).fill(null).map(()=>Array(9).fill(null));
  room.boardWon=Array(9).fill(null); room.boardReplaying=Array(9).fill(false);
  room.startedBoard=null; room.currentPlayer=room.currentPlayer==='X'?'O':'X';
  room.megaWinner=null; room.over=false; room.rematchVotes=new Set();
}

// ══════════════════════════════════════════════════════════════════
// TRIPLE TTT (3-level)
//   cells[mg][md][mn]   = null|'X'|'O'
//   l2won[mg][md]       = null|'X'|'O'   (mini board winner)
//   l2rep[mg][md]       = bool
//   l1won[mg]           = null|'X'|'O'   (mid board winner)
//   l1rep[mg]           = bool
//   lock                = null | { mg, md }  (md=-1 = free within mg)
//   winner              = null|'X'|'O'|'draw'
// ══════════════════════════════════════════════════════════════════
function makeTriple() {
  return {
    mode:'triple', players:[],
    cells: Array(9).fill(null).map(()=>Array(9).fill(null).map(()=>Array(9).fill(null))),
    l2won: Array(9).fill(null).map(()=>Array(9).fill(null)),
    l2rep: Array(9).fill(null).map(()=>Array(9).fill(false)),
    l1won: Array(9).fill(null),
    l1rep: Array(9).fill(false),
    lock: null,
    currentPlayer:'X', winner:null,
    scores:{X:0,O:0}, over:false,
    rematchVotes:new Set(), timers:{},
  };
}

function snapTriple(r) {
  return { cells:r.cells, l2won:r.l2won, l2rep:r.l2rep,
    l1won:r.l1won, l1rep:r.l1rep, lock:r.lock,
    currentPlayer:r.currentPlayer, winner:r.winner, scores:r.scores };
}

function handleTripleMove(room, ws, msg) {
  if (room.over || ws.symbol !== room.currentPlayer) return;
  const { mg, md, mn } = msg;

  if (room.l1won[mg]!==null) return;
  if (room.l2won[mg][md]!==null) return;
  if (room.cells[mg][md][mn]!==null) return;
  if (room.lock!==null) {
    if (room.lock.mg!==mg) return;
    if (room.lock.md!==-1 && room.lock.md!==md) return;
  }

  room.cells[mg][md][mn] = room.currentPlayer;

  const l2res = check9(room.cells[mg][md]);
  let replayKey = null;

  if (l2res==='X'||l2res==='O') {
    room.l2won[mg][md] = l2res;
    room.l2rep[mg][md] = false;

    const l1res = check9(room.l2won[mg]);
    if (l1res==='X'||l1res==='O') {
      room.l1won[mg]=l1res; room.l1rep[mg]=false; room.lock=null;
      const megaRes = check9(room.l1won);
      if (megaRes==='X'||megaRes==='O') {
        room.winner=megaRes; room.scores[megaRes]++; room.over=true;
      } else if (room.l1won.every(r=>r!==null)) {
        const xs=room.l1won.filter(r=>r==='X').length, os=room.l1won.filter(r=>r==='O').length;
        room.winner=xs>os?'X':os>xs?'O':'draw';
        if (room.winner!=='draw') room.scores[room.winner]++;
        room.over=true;
      }
    } else if (l1res==='draw') {
      room.l1rep[mg]=true; room.lock={mg,md:-1}; replayKey=`l1:${mg}`;
    } else {
      room.lock={mg,md:-1};
    }
  } else if (l2res==='draw') {
    room.l2rep[mg][md]=true; room.lock={mg,md}; replayKey=`l2:${mg}:${md}`;
  } else {
    room.lock={mg,md};
  }

  if (!room.over) room.currentPlayer=room.currentPlayer==='X'?'O':'X';

  broadcast(room, { type:'triple_update', ...snapTriple(room), lastMove:{mg,md,mn} });

  if (replayKey!==null) {
    if (room.timers[replayKey]) clearTimeout(room.timers[replayKey]);
    room.timers[replayKey] = setTimeout(()=>{
      if (!rooms[ws.roomCode]) return;
      const [level,...parts] = replayKey.split(':');
      if (level==='l2') {
        const [bmg,bmd] = parts.map(Number);
        room.cells[bmg][bmd]=Array(9).fill(null);
        room.l2rep[bmg][bmd]=true;
        room.lock={mg:bmg,md:bmd};
        broadcast(room, { type:'triple_replay_wipe', level:'l2', mg:bmg, md:bmd, ...snapTriple(room) });
      } else {
        const bmg = Number(parts[0]);
        for (let d=0;d<9;d++) { room.cells[bmg][d]=Array(9).fill(null); room.l2won[bmg][d]=null; room.l2rep[bmg][d]=false; }
        room.l1rep[bmg]=true; room.lock={mg:bmg,md:-1};
        broadcast(room, { type:'triple_replay_wipe', level:'l1', mg:bmg, ...snapTriple(room) });
      }
      delete room.timers[replayKey];
    }, 900);
  }
}

function resetTriple(room) {
  clearTimers(room);
  room.cells=Array(9).fill(null).map(()=>Array(9).fill(null).map(()=>Array(9).fill(null)));
  room.l2won=Array(9).fill(null).map(()=>Array(9).fill(null));
  room.l2rep=Array(9).fill(null).map(()=>Array(9).fill(false));
  room.l1won=Array(9).fill(null); room.l1rep=Array(9).fill(false);
  room.lock=null; room.currentPlayer=room.currentPlayer==='X'?'O':'X';
  room.winner=null; room.over=false; room.rematchVotes=new Set();
}

// ══════════════════════════════════════════════════════════════════
// CONNECTION HANDLER
// ══════════════════════════════════════════════════════════════════
wss.on('connection', ws => {
  ws.roomCode = null;
  ws.symbol   = null;

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const code = (msg.code||'').toUpperCase().trim();
      const mode = ['normal','ultimate','triple'].includes(msg.mode) ? msg.mode : 'normal';

      if (!rooms[code]) {
        if (mode==='triple')   rooms[code]=makeTriple();
        else if (mode==='ultimate') rooms[code]=makeUltimate();
        else rooms[code]=makeNormal();
      }
      const room = rooms[code];
      if (room.mode !== mode) { send(ws,{type:'error',text:'Falscher Spielmodus.'}); return; }
      if (room.players.length >= 2) { send(ws,{type:'error',text:'Raum ist voll!'}); return; }

      ws.roomCode = code;
      ws.symbol   = room.players.length===0 ? 'X' : 'O';
      room.players.push(ws);
      send(ws, { type:'joined', symbol:ws.symbol, code, mode });

      if (room.players.length===2) {
        if (mode==='triple')        broadcast(room,{type:'start',...snapTriple(room)});
        else if (mode==='ultimate') broadcast(room,{type:'start',...snapUltimate(room)});
        else broadcast(room,{type:'start',cells:room.cells,currentPlayer:room.currentPlayer,scores:room.scores});
      } else {
        send(ws,{type:'waiting'});
      }
    }

    // ── MOVES ─────────────────────────────────────────────────────
    else if (msg.type==='move') {
      const room=rooms[ws.roomCode];
      if (!room||room.mode!=='normal') return;
      handleNormalMove(room,ws,msg);
    }
    else if (msg.type==='ultimate_move') {
      const room=rooms[ws.roomCode];
      if (!room||room.mode!=='ultimate') return;
      handleUltimateMove(room,ws,msg);
    }
    else if (msg.type==='triple_move') {
      const room=rooms[ws.roomCode];
      if (!room||room.mode!=='triple') return;
      handleTripleMove(room,ws,msg);
    }

    // ── REMATCH ───────────────────────────────────────────────────
    else if (msg.type==='rematch') {
      const room=rooms[ws.roomCode];
      if (!room) return;
      room.rematchVotes.add(ws.symbol);
      if (room.rematchVotes.size===2) {
        if (room.mode==='triple')        { resetTriple(room);   broadcast(room,{type:'start',...snapTriple(room)}); }
        else if (room.mode==='ultimate') { resetUltimate(room); broadcast(room,{type:'start',...snapUltimate(room)}); }
        else rematchNormal(room);
      } else {
        broadcast(room,{type:'rematch_vote',from:ws.symbol});
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode||!rooms[ws.roomCode]) return;
    broadcast(rooms[ws.roomCode],{type:'opponent_left'});
    setTimeout(()=>{
      const r=rooms[ws.roomCode];
      if (r && r.players.every(p=>!p||p.readyState!==WebSocket.OPEN)) {
        clearTimers(r);
        delete rooms[ws.roomCode];
      }
    }, 30000);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`  Normal TTT:  http://localhost:${PORT}/`);
  console.log(`  Ultimate TTT: http://localhost:${PORT}/ultimate`);
  console.log(`  Triple TTT:   http://localhost:${PORT}/triple`);
});
