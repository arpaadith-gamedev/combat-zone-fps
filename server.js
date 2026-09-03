const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20; // 20 times per second
const MAX_HEALTH = 100;
const RESPAWN_DELAY_MS = 3000;

// WEAPON CONSTANTS
const WEAPONS = {
  RIFLE: { id: 0, damage: 25, range: 250, spread: 0.002, speed: 8 }, // speed is shot interval/fire rate
  SHOTGUN: { id: 1, damage: 15, range: 60, pellets: 8, spread: 0.08, speed: 1.2 } 
};

// Fixed spawn points
const SPAWN_POINTS = [
  { x: -35, y: 1.7, z: -35 }, { x: 35, y: 1.7, z: -35 },
  { x: -35, y: 1.7, z: 35 }, { x: 35, y: 1.7, z: 35 },
];

function randomSpawn() { return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)]; }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Combat Zone multiplayer server running.\n');
});

const wss = new WebSocket.Server({ server });
const players = new Map();
let nextId = 1;

function safeSend(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptWs) {
  const msg = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.ws !== exceptWs && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function publicState(p) {
  return {
    id: p.id, name: p.name,
    x: p.x, y: p.y, z: p.z, ry: p.ry,
    health: p.health, alive: p.alive,
    currentWeaponId: p.currentWeaponId
  };
}

wss.on('connection', (ws) => {
  const id = nextId++;
  const spawn = randomSpawn();
  const player = {
    id, ws,
    name: `Soldier_${1000 + Math.random() * 9000}`,
    x: spawn.x, y: spawn.y, z: spawn.z, ry: 0,
    health: MAX_HEALTH,
    alive: true,
    currentWeaponId: WEAPONS.RIFLE.id
  };
  players.set(id, player);

  safeSend(ws, {
    type: 'welcome', id, spawn, players: Array.from(players.values()).map(publicState),
  });

  broadcast({ type: 'join', player: publicState(player) }, ws);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!player.alive && msg.type !== 'join') return;

    if (msg.type === 'move') {
      const { x, y, z, ry } = msg;
      player.x = x; player.y = y; player.z = z; player.ry = ry;
    } else if (msg.type === 'switch_weapon') {
      player.currentWeaponId = msg.weaponId;
      broadcast({ type: 'switch_weapon', id: player.id, weaponId: msg.weaponId });
    } else if (msg.type === 'shoot') {
      const weapon = (player.currentWeaponId === WEAPONS.SHOTGUN.id) ? WEAPONS.SHOTGUN : WEAPONS.RIFLE;
      broadcast({ type: 'shotFired', shooterId: player.id, weaponId: weapon.id, hits: msg.hits, tr: msg.tr });
    } else if (msg.type === 'hit_taken') {
      if (!player.alive) return;
      player.health = Math.max(0, player.health - msg.damage);
      broadcast({ type: 'health_sync', targetId: player.id, health: player.health });
      if (player.health <= 0) {
        player.alive = false;
        broadcast({ type: 'kill', victimId: player.id });
        setTimeout(() => respawn(player), RESPAWN_DELAY_MS);
      }
    }
  });

  ws.on('close', () => { players.delete(id); broadcast({ type: 'leave', id }); });
  ws.on('error', () => {});
});

function respawn(player) {
  if (!players.has(player.id)) return;
  const spawn = randomSpawn();
  player.x = spawn.x; player.y = spawn.y; player.z = spawn.z; player.ry = 0;
  player.health = MAX_HEALTH;
  player.alive = true;
  broadcast({ type: 'respawn', id: player.id, spawn });
}

setInterval(() => {
  if (players.size === 0) return;
  broadcast({ type: 'state', players: Array.from(players.values()).map(publicState) });
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`Combat Zone server listening on port ${PORT}`));