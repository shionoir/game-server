const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log("WebSocket server started on port " + PORT);
});

const rooms = {}; // roomId -> room

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj) {
  [...room.players, ...room.spectators].forEach(c => {
    send(c.ws, obj);
  });
}

function roomInfo(room) {
  return {
    type: "roomInfo",
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      isHost: p.isHost
    })),
    spectators: room.spectators.map(s => ({
      id: s.id,
      name: s.name
    })),
    playerCount: room.players.length,
    spectatorCount: room.spectators.length,
    maxPlayers: room.maxPlayers,
    maxSpectators: room.maxSpectators,
    phase: room.phase
  };
}

function ensureHost(room) {
  room.players.forEach(p => (p.isHost = false));
  if (room.players.length > 0) {
    room.players[0].isHost = true;
  }
}

function findRoomByWs(ws) {
  return Object.values(rooms).find(
    room =>
      room.players.some(p => p.ws === ws) ||
      room.spectators.some(s => s.ws === ws)
  );
}

function finalizeCharacters(room) {
  // すでに確定済みなら何もしない
  if (room.phase === "battle") return;

  console.log("finalizeCharacters");

  room.players.forEach(p => {
    if (!room.selectedChars.hasOwnProperty(p.id)) {
      room.selectedChars[p.id] = Math.floor(Math.random() * 12) + 1;
    }
  });

  room.phase = "battle";

  broadcast(room, {
    type: "charResult",
    results: Object.entries(room.selectedChars).map(
      ([playerId, charId]) => ({ playerId, charId })
    )
  });
}

wss.on("connection", ws => {
  ws.id = null;
  ws.roomId = null;

  ws.on("close", () => {
    const room = findRoomByWs(ws);
    if (!room) return;

    const wasHost = room.players.find(p => p.ws === ws)?.isHost;

    room.players = room.players.filter(p => p.ws !== ws);
    room.spectators = room.spectators.filter(s => s.ws !== ws);

    // プレイヤー0になったら削除
    if (room.players.length === 0) {
      delete rooms[room.roomId];
      return;
    }

    if (wasHost) {
      ensureHost(room);
      broadcast(room, {
        type: "hostChanged",
        hostId: room.players[0].id
      });
    }

    broadcast(room, roomInfo(room));
  });

  ws.on("message", msg => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // ===== ルーム作成 or 参加 =====
    if (data.type === "join") {
      const roomId = data.roomId;
      const clientId = data.id;

      if (!rooms[roomId]) {
        rooms[roomId] = {
          roomId,
          maxPlayers: 4,
          maxSpectators: 1,
          players: [],
          spectators: [],
          phase: "waiting",
          selectedChars: {},
          charFinalizeTimer: null
        };
      }

      const room = rooms[roomId];

      ws.id = clientId;
      ws.roomId = roomId;

      const isPlayer =
        room.players.length < room.maxPlayers && room.phase === "waiting";
      if (isPlayer) {
        room.players.push({
          id: ws.id,
          name: data.name || "NoName",
          ws,
          ready: false,
          isHost: room.players.length === 0
        });
      } else {
        room.spectators.push({
          id: ws.id,
          name: data.name || "NoName",
          ws
        });
      }

      // 自分に joinResult
      send(ws, { type: "joinResult", success: true });

      // ルーム情報を全員に通知
      broadcast(room, roomInfo(room));
    }

    // ===== 準備完了 =====
    if (data.type === "ready") {
      const room = rooms[ws.roomId];
      if (!room) return;

      const player = room.players.find(p => p.id === ws.id);
      if (player) {
        player.ready = data.ready;
        broadcast(room, roomInfo(room));
      }
    }

    // ===== ゲーム開始（ホストのみ）=====
    if (data.type === "start") {
      const room = rooms[ws.roomId];
      if (!room) return;

      const player = room.players.find(p => p.id === ws.id);
      if (!player || !player.isHost) return;

      if (
        room.players.length >= 2 &&
        room.players.every(p => p.ready || p.isHost)
      ) {
        room.selectedChars = {};
        room.phase = "playing";

        // ★30秒後に強制確定
        room.charFinalizeTimer = setTimeout(() => {
        finalizeCharacters(room);
        }, 30000);
        
        broadcast(room, { type: "gameStart" });
      }
    }

    // ===== ルーム情報要求 =====
    if (data.type === "requestRoomInfo") {
      const room = rooms[ws.roomId];
      if (!room) return;
      send(ws, roomInfo(room));
    }

    // ===== キャラクター選択 =====
if (data.type === "selectChar") {
  const room = rooms[ws.roomId];
  if (!room || room.phase !== "playing") return;

  const isPlayer = room.players.some(p => p.id === ws.id);
  if (!isPlayer) return;

  if (room.selectedChars.hasOwnProperty(ws.id)) return;

  room.selectedChars[ws.id] = data.charId;

  const allDecided = room.players.every(p =>
    room.selectedChars.hasOwnProperty(p.id)
  );

  if (!allDecided) return;

  if (room.charFinalizeTimer) {
    clearTimeout(room.charFinalizeTimer);
    room.charFinalizeTimer = null;
  }

  finalizeCharacters(room);
}

    // ===== 役割変更 =====
    if (data.type === "changeRole") {
      const room = rooms[ws.roomId];
      if (!room || room.phase !== "waiting") return;

      let user =
        room.players.find(p => p.id === ws.id) ||
        room.spectators.find(s => s.id === ws.id);
      if (!user) return;

      const name = user.name;

      // 削除
      room.players = room.players.filter(p => p.id !== ws.id);
      room.spectators = room.spectators.filter(s => s.id !== ws.id);

      if (data.to === "player") {
        if (room.players.length < room.maxPlayers) {
          room.players.push({
            id: ws.id,
            name,
            ws,
            ready: false,
            isHost: false
          });
        } else {
          room.spectators.push({ id: ws.id, name, ws });
        }
      } else {
        room.spectators.push({ id: ws.id, name, ws });
      }

      ensureHost(room);
      broadcast(room, roomInfo(room));
    }
  });
});

console.log("WebSocket server started on port " + PORT);
