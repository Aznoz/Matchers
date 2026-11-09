// 1v1 match-3 server (TAHOVÝ): matchmaking + autoritativní životy + střídání tahů. Spuštění: npm install && npm start
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MOVES_PER_TURN = 4;        // musí odpovídat Config.MovesPerTurn v Unity
const MAX_ROUNDS = 12;          // musí odpovídat Config.MaxRounds v Unity
const TURN_MS = 60000;          // když hráč 60 s nic neudělá, tah se mu automaticky ukončí
const MAX_POISON = 12;          // musí odpovídat Combat.MaxPoisonTicks v Unity
const QUEUE_TIMEOUT_MS = 20000;  // po 20 s bez soupeře pošleme "nomatch" -> klient spustí bota
const TILE_COUNT = 15, DECK = 4, MAX_LEVEL = 10;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(req.url === '/health' ? 'ok' : 'Match3 server running');
});
const wss = new WebSocketServer({ server });

let queue = [];
let nextId = 1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const opp = (p) => (p.room.a === p ? p.room.b : p.room.a);

wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, joined: false, room: null, f: null, effTimes: [], timer: null };
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
    case 'swap': {
      const r = p.room;
      if (!r || r.over || r.turn !== p || r.moves <= 0) return;   // jen hráč na tahu a jen dokud má tahy
      r.moves--;
      const c = (v) => clamp(v, 0, 5) | 0;
      send(opp(p), { t: 'swap', x1: c(m.x1), y1: c(m.y1), x2: c(m.x2), y2: c(m.y2) });
      return pushState(r);
    }
    case 'effect': return effect(p, m);
    case 'endturn': {
      const r = p.room;
      if (!r || r.over || r.turn !== p) return;
      return nextTurn(r);
    }
    case 'leave': return leave(p);
  }
}

function join(p, m) {
  if (p.joined) return;
  const deck = Array.isArray(m.deck) ? m.deck.map(Number) : [];
  const levels = Array.isArray(m.levels) ? m.levels.map(Number) : [];
  const ok = deck.length === DECK && levels.length === DECK &&
    deck.every((d) => Number.isInteger(d) && d >= 0 && d < TILE_COUNT) &&
    levels.every((l) => Number.isInteger(l) && l >= 1 && l <= MAX_LEVEL);
  if (!ok) return send(p, { t: 'error', reason: 'bad_join' });

  p.joined = true;
  p.name = String(m.name || 'Hráč').slice(0, 14);
  p.maxHp = clamp(m.maxHp, 100, 1500);
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
  const room = { a, b, over: false, turnTimer: null, turn: null, first: null, round: 1, moves: 0 };
  a.room = b.room = room;
  for (const p of [a, b]) p.f = { hp: p.maxHp, maxHp: p.maxHp, shield: 0, poisonTicks: 0, poisonDmg: 0 };
  const sA = 1 + Math.floor(Math.random() * 2e9), sB = 1 + Math.floor(Math.random() * 2e9);
  const startFor = (me, other, mine, theirs) => send(me, {
    t: 'start', seed: mine, oppSeed: theirs, oppName: other.name, oppMaxHp: other.maxHp,
    oppDeck: other.deck, oppLevels: other.levels,
  });
  startFor(a, b, sA, sB);   // A hraje na poli se seedem sA, B vidí A-ino pole se stejným seedem
  startFor(b, a, sB, sA);
  // kdo začíná rozhodne los; první tah pošleme se zpožděním, aby měli klienti čas postavit scénu
  room.first = room.turn = Math.random() < 0.5 ? a : b;
  room.moves = MOVES_PER_TURN;
  setTimeout(() => { if (!room.over) { announceTurn(room); pushState(room); } }, 800);
}

function announceTurn(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => nextTurn(room), TURN_MS);
  for (const p of [room.a, room.b])
    send(p, { t: 'turn', mine: room.turn === p ? 1 : 0, moves: room.moves, round: room.round });
}

function nextTurn(room) {
  if (room.over) return;
  room.turn = room.turn === room.a ? room.b : room.a;
  if (room.turn === room.first) {
    room.round++;
    if (room.round > MAX_ROUNDS) return finishByHp(room, 'rounds');
  }
  room.moves = MOVES_PER_TURN;
  const f = room.turn.f;                       // jed zabírá na začátku tahu postiženého
  if (f.poisonTicks > 0) { f.hp = Math.max(0, f.hp - f.poisonDmg); f.poisonTicks--; }
  pushState(room);
  if (checkEnd(room)) return;
  announceTurn(room);
}

// Stejná pravidla jako Combat.Apply v Unity
function apply(atk, def, e) {
  if (e.cleanse) atk.poisonTicks = 0;
  atk.hp = Math.min(atk.maxHp, atk.hp + e.heal);
  atk.shield = Math.min(atk.maxHp * 0.5, atk.shield + e.shield);
  if (e.breakShield > 0) def.shield = Math.max(0, def.shield - e.breakShield);
  let d = e.dmg;
  if (!e.pierce) { const ab = Math.min(def.shield, d); def.shield -= ab; d -= ab; }
  def.hp = Math.max(0, def.hp - d);
  if (e.recoil > 0) atk.hp = Math.max(1, atk.hp - e.recoil);
  if (e.poisonTicks > 0) {
    def.poisonTicks = Math.min(MAX_POISON, def.poisonTicks + e.poisonTicks);
    def.poisonDmg = Math.max(def.poisonDmg, e.poisonDmg);
  }
}

function effect(p, m) {
  const r = p.room;
  if (!r || r.over || r.turn !== p) return;   // účinky platí jen od hráče na tahu
  const now = Date.now();
  p.effTimes = p.effTimes.filter((t) => now - t < 1000);
  if (p.effTimes.length >= 15) return;   // ochrana proti spamu
  p.effTimes.push(now);
  const e = {
    dmg: clamp(m.dmg, 0, 400), heal: clamp(m.heal, 0, 200), shield: clamp(m.shield, 0, 200),
    poisonTicks: clamp(m.poisonTicks, 0, 40), poisonDmg: clamp(m.poisonDmg, 0, 15),
    breakShield: clamp(m.breakShield, 0, 300), recoil: clamp(m.recoil, 0, 60),
    pierce: m.pierce === 1, cleanse: m.cleanse === 1,
  };
  r.moves = Math.min(r.moves + (clamp(m.extraMoves, 0, 2) | 0), 12);   // bonusové tahy (Pán času)
  apply(p.f, opp(p).f, e);
  pushState(r);
  checkEnd(r);
}

function pushState(r) {
  const [a, b] = [r.a, r.b];
  send(a, { t: 'state', hp: a.f.hp, oppHp: b.f.hp, myShield: a.f.shield, oppShield: b.f.shield, myPoison: a.f.poisonTicks, oppPoison: b.f.poisonTicks, moves: r.moves });
  send(b, { t: 'state', hp: b.f.hp, oppHp: a.f.hp, myShield: b.f.shield, oppShield: a.f.shield, myPoison: b.f.poisonTicks, oppPoison: a.f.poisonTicks, moves: r.moves });
}

// vrací true, když zápas skončil
function checkEnd(r) {
  if (r.over) return true;
  const { a, b } = r;
  if (a.f.hp <= 0 && b.f.hp <= 0) { finish(r, null, 'draw'); return true; }
  if (a.f.hp <= 0) { finish(r, b, 'ko'); return true; }
  if (b.f.hp <= 0) { finish(r, a, 'ko'); return true; }
  return false;
}

function finishByHp(r, reason) {
  const { a, b } = r;
  const ra = a.f.hp / a.f.maxHp, rb = b.f.hp / b.f.maxHp;
  finish(r, ra === rb ? null : ra > rb ? a : b, reason);
}

function finish(r, winner, reason) {
  if (r.over) return;
  r.over = true;
  clearTimeout(r.turnTimer);
  for (const p of [r.a, r.b]) { send(p, { t: 'end', win: p === winner ? 1 : 0, reason }); p.room = null; }
}

function leave(p) {
  queue = queue.filter((q) => q !== p);
  clearTimeout(p.timer);
  if (p.room && !p.room.over) finish(p.room, opp(p), 'disconnect');
}

// Heartbeat (Render proxy zavírá nečinná spojení)
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

server.listen(PORT, () => console.log('Server listening on ' + PORT));
