const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MATCH_DURATION_MS = 60_000;
const ITEM_COOLDOWN_MS = 8_000;
const ORB_DURATION_MS = 3_000;
const SMOKE_DURATION_MS = 2_000;
const ITEM_STAGE_INTERVAL = 5;
const INVENTORY_MAX = 2;
const ITEM_POOL = ['orb', 'smoke', 'shield'];

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '/index.html') {
    sendFile(res, path.join(ROOT, 'index.html'));
    return;
  }
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(ROOT, safePath);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end('Forbidden');
    return;
  }
  sendFile(res, full);
});

const wss = new WebSocket.Server({ noServer: true });
let waitingPlayer = null;
let roomSeq = 1;
let playerSeq = 1;
let itemSeq = 1;
const rooms = new Map();

function mkPlayerId() {
  const id = `p${playerSeq}`;
  playerSeq += 1;
  return id;
}

function mkRoomId() {
  const id = `r${roomSeq}`;
  roomSeq += 1;
  return id;
}

function mkItemId() {
  const id = `i${itemSeq}`;
  itemSeq += 1;
  return id;
}

function pickRandomItemType() {
  const i = Math.floor(Math.random() * ITEM_POOL.length);
  return ITEM_POOL[i];
}

function send(ws, msg) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  room.players.forEach((p) => send(p.ws, msg));
}

function detachFromWaiting(ws) {
  if (waitingPlayer && waitingPlayer.ws === ws) {
    waitingPlayer = null;
  }
}

function closeRoom(room, reason) {
  if (!room) return;
  clearTimeout(room.timer);
  rooms.delete(room.id);
  if (reason === 'opponent_left') {
    room.players.forEach((p) => send(p.ws, { type: 'opponent_left' }));
  }
}

function beginMatch(p1, p2) {
  const room = {
    id: mkRoomId(),
    players: [p1, p2],
    scores: {[p1.id]: 0, [p2.id]: 0},
    states: {
      [p1.id]: { inventory: [], nextGrantStage: ITEM_STAGE_INTERVAL, lastItemUsedAt: 0, lastItemUsedStage: 0, shieldOn: false, stageReached: 1 },
      [p2.id]: { inventory: [], nextGrantStage: ITEM_STAGE_INTERVAL, lastItemUsedAt: 0, lastItemUsedStage: 0, shieldOn: false, stageReached: 1 }
    },
    endAt: Date.now() + MATCH_DURATION_MS,
    timer: null
  };
  p1.roomId = room.id;
  p2.roomId = room.id;
  rooms.set(room.id, room);

  room.timer = setTimeout(() => {
    broadcast(room, { type: 'match_end', scores: room.scores, endAt: room.endAt });
    // Keep room for rematch request handling; cleanup lazily on disconnect/new rematch.
  }, MATCH_DURATION_MS + 20);

  room.players.forEach((p) => {
    send(p.ws, {
      type: 'match_start',
      roomId: room.id,
      playerId: p.id,
      scores: room.scores,
      endAt: room.endAt
    });
  });
}

function pairOrWait(player) {
  if (!waitingPlayer || waitingPlayer.ws.readyState !== WebSocket.OPEN) {
    waitingPlayer = player;
    send(player.ws, { type: 'waiting' });
    return;
  }
  const p2 = waitingPlayer;
  waitingPlayer = null;
  beginMatch(p2, player);
}

function getRoomByPlayer(player) {
  if (!player.roomId) return null;
  return rooms.get(player.roomId) || null;
}

function handleFound(player) {
  const room = getRoomByPlayer(player);
  if (!room) return;
  if (Date.now() >= room.endAt) return;
  room.scores[player.id] = (room.scores[player.id] || 0) + 1;
  broadcast(room, { type: 'score_update', scores: room.scores });
}

function maybeGrantItems(room, player) {
  const st = room.states[player.id];
  if (!st) return;
  let granted = 0;
  while (st.stageReached >= st.nextGrantStage) {
    if (st.inventory.length < INVENTORY_MAX) {
      st.inventory.push({ id: mkItemId(), type: pickRandomItemType() });
      granted += 1;
    }
    st.nextGrantStage += ITEM_STAGE_INTERVAL;
  }
  send(player.ws, { type: 'inventory_update', items: st.inventory, reason: granted > 0 ? 'grant' : 'sync' });
}

function handleStageReached(player, stageNo) {
  const room = getRoomByPlayer(player);
  if (!room) return;
  const st = room.states[player.id];
  if (!st) return;
  const n = Number(stageNo);
  if (!Number.isFinite(n)) return;
  const stageInt = Math.max(1, Math.floor(n));
  st.stageReached = Math.max(st.stageReached, stageInt);
  maybeGrantItems(room, player);
}

function handleUseItem(player, itemId) {
  const room = getRoomByPlayer(player);
  if (!room) return;
  const now = Date.now();
  if (now >= room.endAt) return;
  if ((room.endAt - now) < 3_000) return;

  const me = room.states[player.id];
  if (!me) return;
  if (now - me.lastItemUsedAt < ITEM_COOLDOWN_MS) return;
  if (me.lastItemUsedStage === me.stageReached) return;

  const idx = me.inventory.findIndex((x) => x.id === itemId);
  if (idx === -1) return;
  const item = me.inventory[idx];
  me.inventory.splice(idx, 1);
  me.lastItemUsedAt = now;
  me.lastItemUsedStage = me.stageReached;

  if (item.type === 'orb') {
    me.orbUntil = now + ORB_DURATION_MS;
    broadcast(room, {
      type: 'item_applied',
      by: player.id,
      typeName: 'orb',
      effectUntil: me.orbUntil
    });
  } else if (item.type === 'smoke') {
    const target = room.players.find((p) => p.id !== player.id);
    if (!target) return;
    const ts = room.states[target.id];
    if (ts && ts.shieldOn) {
      ts.shieldOn = false;
      broadcast(room, {
        type: 'item_applied',
        by: player.id,
        typeName: 'smoke',
        targetId: target.id,
        blocked: true
      });
      send(target.ws, { type: 'inventory_update', items: ts.inventory, reason: 'shield_consumed' });
    } else {
      broadcast(room, {
        type: 'item_applied',
        by: player.id,
        typeName: 'smoke',
        targetId: target.id,
        effectUntil: now + SMOKE_DURATION_MS
      });
    }
  } else if (item.type === 'shield') {
    me.shieldOn = true;
    broadcast(room, {
      type: 'item_applied',
      by: player.id,
      typeName: 'shield',
      targetId: player.id
    });
  }

  send(player.ws, { type: 'inventory_update', items: me.inventory, reason: 'consume' });
}

function handleRematch(player) {
  const room = getRoomByPlayer(player);
  if (room) {
    // Leave current room and re-queue
    room.players = room.players.filter((p) => p.id !== player.id);
    player.roomId = '';
    if (room.players.length === 0) {
      closeRoom(room);
    } else {
      // Notify remaining player and close room.
      closeRoom(room, 'opponent_left');
    }
  }
  pairOrWait(player);
}

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const player = { id: mkPlayerId(), ws, roomId: '' };
  pairOrWait(player);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (msg.type === 'found') {
      handleFound(player);
      return;
    }
    if (msg.type === 'stage_reached') {
      handleStageReached(player, msg.stage);
      return;
    }
    if (msg.type === 'use_item') {
      handleUseItem(player, msg.itemId);
      return;
    }
    if (msg.type === 'rematch') {
      handleRematch(player);
    }
  });

  ws.on('close', () => {
    detachFromWaiting(ws);
    const room = getRoomByPlayer(player);
    if (!room) return;
    room.players = room.players.filter((p) => p.id !== player.id);
    player.roomId = '';
    if (room.players.length === 0) {
      closeRoom(room);
    } else {
      closeRoom(room, 'opponent_left');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
