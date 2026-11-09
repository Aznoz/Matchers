// Lane Brawl 1v1 server: matchmaking + relé tahů (lockstep). Pravidla počítají oba klienti stejným kódem;
// server přiděluje místa (seat), společný seed, hlídá, kdo je na tahu, a ukončuje tahy po nečinnosti.
// Spuštění: npm install && npm start
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const TURN_MS = 60000;           // když hráč 60 s nic neudělá, tah se mu automaticky ukončí
const QUEUE_TIMEOUT_MS = 20000;  // po 20 s bez soupeře pošleme "nomatch" -> klient spustí bota
const CARD_COUNT = 14, DECK = 8, MAX_LEVEL = 10, LANES = 3, LEN = 7, HAND = 4;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(req.url === '/health' ? 'ok' : 'Lane Brawl server running');
});
const wss = new WebSocketServer({ server });

let queue = [];
let nextId = 1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const opp = (p) => (p.room.a === p ? p.room.b : p.room.a);
const seatOf = (p) => (p.room.a === p ? 0 : 1);

wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, joined: false, room: null, timer: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    if (raw.length > 2048) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    handle(p, m);
  });
  ws.on('close', () => leave(p));
  ws.on('error', () => {});
});

function handle(p, m) {
  switch (m.t) {
    case 'join': return join(p, m);
    case 'play': {
      const r = p.room;
      if (!r || r.over || seatOf(p) !== r.turn) return;      // jen hráč na tahu
      const h = clamp(m.h, 0, HAND - 1) | 0, lane = clamp(m.lane, 0, LANES - 1) | 0, pos = clamp(m.pos, 0, LEN - 1) | 0;
      armTimer(r);
      return send(opp(p), { t: 'play', h, lane, pos });
    }
    case 'endturn': {
      const r = p.room;
      if (!r || r.over || seatOf(p) !== r.turn) return;
      send(opp(p), { t: 'endturn', forced: 0, seat: seatOf(p) });
      return advance(r);
    }
    case 'done': return done(p);
    case 'leave': return leave(p);
  }
}

function join(p, m) {
  if (p.joined) return;
  const deck = Array.isArray(m.deck) ? m.deck.map(Number) : [];
  const levels = Array.isArray(m.levels) ? m.levels.map(Number) : [];
  const ok = deck.length === DECK && levels.length === DECK &&
    deck.every((d, i) => Number.isInteger(d) && d >= 0 && d < CARD_COUNT && deck.indexOf(d) === i) &&
    levels.every((l) => Number.isInteger(l) && l >= 1 && l <= MAX_LEVEL);
  if (!ok) return send(p, { t: 'error', reason: 'bad_join' });

  p.joined = true;
  p.name = String(m.name || 'Hráč').slice(0, 14);
  p.maxHp = clamp(m.maxHp, 10, 200);
  p.trophies = clamp(m.trophies, 0, 100000);
  p.deck = deck; p.levels = levels;

  const other = queue.find((q) => q !== p);
  if (other) {
    queue = queue.filter((q) => q !== other);
    clearTimeout(other.timer);
    startRoom(other, p);
  } else {
    queue.push(p);
    send(p, { t: 'queued' });
    p.timer = setTimeout(() => {
      queue = queue.filter((q) => q !== p);
      send(p, { t: 'nomatch' });
    }, QUEUE_TIMEOUT_MS);
  }
}

function startRoom(a, b) {
  // a = seat 0, b = seat 1; kolo 1 začíná seat 0, další kolo seat 1, ... (stejně jako Game.StartRound)
  const room = { a, b, over: false, turnTimer: null, round: 1, turn: 0, second: false };
  a.room = b.room = room;
  const seed = 1 + Math.floor(Math.random() * 2e9);
  const startFor = (me, other, seat) => send(me, {
    t: 'start', seat, seed, oppName: other.name, oppMaxHp: other.maxHp,
    oppDeck: other.deck, oppLevels: other.levels,
  });
  startFor(a, b, 0);
  startFor(b, a, 1);
  armTimer(room);
}

// posun podle stejného řádu jako Game.EndTurn: první hráč -> druhý hráč -> souboj -> další kolo
function advance(room) {
  if (room.over) return;
  if (!room.second) { room.second = true; room.turn = 1 - room.turn; }
  else { room.second = false; room.round++; room.turn = room.round % 2 === 1 ? 0 : 1; }
  armTimer(room);
}

function armTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    if (room.over) return;
    const msg = { t: 'endturn', forced: 1, seat: room.turn };
    send(room.a, msg); send(room.b, msg);
    advance(room);
  }, TURN_MS);
}

function done(p) {
  const r = p.room;
  if (!r) return;
  r.over = true;
  clearTimeout(r.turnTimer);
  r.a.room = r.b.room = null;
}

function leave(p) {
  queue = queue.filter((q) => q !== p);
  clearTimeout(p.timer);
  const r = p.room;
  if (r && !r.over) {
    const o = opp(p);
    r.over = true; clearTimeout(r.turnTimer);
    send(o, { t: 'end', win: 1, reason: 'disconnect' });
    r.a.room = r.b.room = null;
  }
}

// Heartbeat (Render proxy zavírá nečinná spojení)
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

server.listen(PORT, () => console.log('Server listening on ' + PORT));
