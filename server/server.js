// 1v1 match-3 server: matchmaking + autoritativní životy. Spuštění: npm install && npm start
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MATCH_TIME = 150;          // s, musí odpovídat Config.MatchTime v Unity
const QUEUE_TIMEOUT_MS = 20000;  // po 20 s bez soupeře pošleme "nomatch" -> klient spustí bota
const TILE_COUNT = 6, DECK = 4, MAX_LEVEL = 10;

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
      if (!p.room || p.room.over) return;
      const c = (v) => clamp(v, 0, 5) | 0;
      return send(opp(p), { t: 'swap', x1: c(m.x1), y1: c(m.y1), x2: c(m.x2), y2: c(m.y2) });
    }
    case 'effect': return effect(p, m);
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
  const room = { a, b, time: MATCH_TIME, over: false, timer: null };
  a.room = b.room = room;
  for (const p of [a, b]) p.f = { hp: p.maxHp, maxHp: p.maxHp, shield: 0, poisonTicks: 0, poisonDmg: 0 };
  const sA = 1 + Math.floor(Math.random() * 2e9), sB = 1 + Math.floor(Math.random() * 2e9);
  const startFor = (me, other, mine, theirs) => send(me, {
    t: 'start', seed: mine, oppSeed: theirs, oppName: other.name, oppMaxHp: other.maxHp,
    oppDeck: other.deck, oppLevels: other.levels,
  });
  startFor(a, b, sA, sB);   // A hraje na poli se seedem sA, B vidí A-ino pole se stejným seedem
  startFor(b, a, sB, sA);
  room.timer = setInterval(() => tick(room), 1000);
}

// Stejná pravidla jako Combat.Apply v Unity
function apply(atk, def, e) {
  atk.hp = Math.min(atk.maxHp, atk.hp + e.heal);
  atk.shield = Math.min(atk.maxHp * 0.5, atk.shield + e.shield);
  let d = e.dmg;
  const ab = Math.min(def.shield, d);
  def.shield -= ab; d -= ab;
  def.hp = Math.max(0, def.hp - d);
  if (e.poisonTicks > 0) {
    def.poisonTicks = Math.min(40, def.poisonTicks + e.poisonTicks);
    def.poisonDmg = Math.max(def.poisonDmg, e.poisonDmg);
  }
}

function effect(p, m) {
  const r = p.room;
  if (!r || r.over) return;
  const now = Date.now();
  p.effTimes = p.effTimes.filter((t) => now - t < 1000);
  if (p.effTimes.length >= 15) return;   // ochrana proti spamu
  p.effTimes.push(now);
  const e = {
    dmg: clamp(m.dmg, 0, 400), heal: clamp(m.heal, 0, 200), shield: clamp(m.shield, 0, 200),
    poisonTicks: clamp(m.poisonTicks, 0, 40), poisonDmg: clamp(m.poisonDmg, 0, 15),
  };
  apply(p.f, opp(p).f, e);
  pushState(r);
  checkEnd(r);
}

function tick(room) {
  if (room.over) return;
  room.time--;
  for (const p of [room.a, room.b]) {
    const f = p.f;
    if (f.poisonTicks > 0) { f.hp = Math.max(0, f.hp - f.poisonDmg); f.poisonTicks--; }
  }
  pushState(room);
  checkEnd(room);
}

function pushState(r) {
  const [a, b] = [r.a, r.b];
  send(a, { t: 'state', hp: a.f.hp, oppHp: b.f.hp, myShield: a.f.shield, oppShield: b.f.shield });
  send(b, { t: 'state', hp: b.f.hp, oppHp: a.f.hp, myShield: b.f.shield, oppShield: a.f.shield });
}

function checkEnd(r) {
  if (r.over) return;
  const { a, b } = r;
  if (a.f.hp <= 0 && b.f.hp <= 0) return finish(r, null, 'draw');
  if (a.f.hp <= 0) return finish(r, b, 'ko');
  if (b.f.hp <= 0) return finish(r, a, 'ko');
  if (r.time <= 0) {
    const ra = a.f.hp / a.f.maxHp, rb = b.f.hp / b.f.maxHp;
    return finish(r, ra === rb ? null : ra > rb ? a : b, 'time');
  }
}

function finish(r, winner, reason) {
  if (r.over) return;
  r.over = true;
  clearInterval(r.timer);
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
