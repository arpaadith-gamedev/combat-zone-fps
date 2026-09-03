const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 18; // state broadcasts per second
const MAX_HEALTH = 100;
const HIT_DAMAGE = 25;
const HIT_RANGE = 250; // world units a shot can travel
const HIT_RADIUS = 1.4; // sphere radius used for hit detection against a player
const RESPAWN_DELAY_MS = 3000;

// Fixed spawn points (must roughly match open areas in the client's hardcoded map)
const SPAWN_POINTS = [
  { x: -30, y: 1.7, z: -30 },
  { x: 30, y: 1.7, z: -30 },
  { x: -30, y: 1.7, z: 30 },
  { x: 30, y: 1.7, z: 30 },
  { x: 0, y: 1.7, z: -45 },
  { x: 0, y: 1.7, z: 45 },
];

function randomSpawn() {
  return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
}

function randomName() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `Soldier_${n}`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Combat Zone multiplayer server is running.\n');
});

const wss = new WebSocket.Server({ server });

// id -> player state
const players = new Map();
let nextId = 1;

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(obj, exceptWs) {
  const msg = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.ws !== exceptWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

function publicState(p) {
  return {
    id: p.id, name: p.name,
    x: p.x, y: p.y, z: p.z, ry: p.ry,
    health: p.health, alive: p.alive,
  };
}

wss.on('connection', (ws) => {
  const id = nextId++;
  const spawn = randomSpawn();
  const player = {
    id, ws,
    name: randomName(),
    x: spawn.x, y: spawn.y, z: spawn.z, ry: 0,
    health: MAX_HEALTH,
    alive: true,
    lastMoveAt: Date.now(),
  };
  players.set(id, player);

  safeSend(ws, {
    type: 'welcome',
    id,
    name: player.name,
    spawn,
    maxHealth: MAX_HEALTH,
    players: Array.from(players.values()).map(publicState),
  });

  broadcast({ type: 'join', player: publicState(player) }, ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'move') {
      if (!player.alive) return;
      const { x, y, z, ry } = msg;
      if ([x, y, z, ry].some((v) => typeof v !== 'number' || !isFinite(v))) return;
      player.x = x; player.y = y; player.z = z; player.ry = ry;
      player.lastMoveAt = Date.now();
    } else if (msg.type === 'shoot') {
      if (!player.alive) return;
      handleShoot(player, msg);
    } else if (msg.type === 'chat') {
      if (typeof msg.text === 'string' && msg.text.length <= 140) {
        broadcast({ type: 'chat', id: player.id, name: player.name, text: msg.text });
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'leave', id });
  });

  ws.on('error', () => {});
});

function handleShoot(shooter, msg) {
  const { ox, oy, oz, dx, dy, dz } = msg;
  const vals = [ox, oy, oz, dx, dy, dz];
  if (vals.some((v) => typeof v !== 'number' || !isFinite(v))) return;

  // normalize direction defensively
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const ndx = dx / len, ndy = dy / len, ndz = dz / len;

  let closestT = Infinity;
  let hitTarget = null;

  for (const [, target] of players) {
    if (target.id === shooter.id || !target.alive) continue;
    // ray-sphere intersection: sphere centered at target's approximate chest height
    const cx = target.x, cy = target.y, cz = target.z;
    const ex = cx - ox, ey = cy - oy, ez = cz - oz;
    const t = ex * ndx + ey * ndy + ez * ndz;
    if (t < 0 || t > HIT_RANGE) continue;
    const closestX = ox + ndx * t, closestY = oy + ndy * t, closestZ = oz + ndz * t;
    const distSq = (closestX - cx) ** 2 + (closestY - cy) ** 2 + (closestZ - cz) ** 2;
    if (distSq <= HIT_RADIUS * HIT_RADIUS && t < closestT) {
      closestT = t;
      hitTarget = target;
    }
  }

  // Always tell the shooter's own client (and everyone) that a shot was fired, for tracer FX.
  broadcast({
    type: 'shotFired',
    shooterId: shooter.id,
    ox, oy, oz, dx: ndx, dy: ndy, dz: ndz,
  });

  if (hitTarget) {
    hitTarget.health = Math.max(0, hitTarget.health - HIT_DAMAGE);
    broadcast({
      type: 'hit',
      shooterId: shooter.id,
      targetId: hitTarget.id,
      damage: HIT_DAMAGE,
      health: hitTarget.health,
    });
    if (hitTarget.health <= 0) {
      hitTarget.alive = false;
      broadcast({ type: 'kill', killerId: shooter.id, victimId: hitTarget.id });
      setTimeout(() => respawn(hitTarget), RESPAWN_DELAY_MS);
    }
  }
}

function respawn(player) {
  if (!players.has(player.id)) return; // disconnected in the meantime
  const spawn = randomSpawn();
  player.x = spawn.x; player.y = spawn.y; player.z = spawn.z; player.ry = 0;
  player.health = MAX_HEALTH;
  player.alive = true;
  broadcast({ type: 'respawn', id: player.id, spawn, health: MAX_HEALTH });
}

// Periodic state broadcast (position sync)
setInterval(() => {
  if (players.size === 0) return;
  const snapshot = Array.from(players.values()).map(publicState);
  broadcast({ type: 'state', players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Combat Zone server listening on port ${PORT}`);
});
