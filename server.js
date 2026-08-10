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
    phase: room.phase,
    phaseEndTime: room.phaseEndTime
  };
}

function startPhase(room, phaseName, durationMs, endCallback) {

  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
  }

  room.phase = phaseName;
  room.phaseEndTime = Date.now() + durationMs;

  room.phaseTimer = setTimeout(() => {
    room.phaseTimer = null;
    endCallback(room);
  }, durationMs);

  broadcast(room, {
    type: "phaseStart",
    phase: phaseName,
    endTime: room.phaseEndTime
  });
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

function broadcastDeckInfo(room) {
  broadcast(room, {
    type: "deckInfo",
    deckCount: room.deck.length,
    discardCount: room.discardPile.length
  });
}

function finalizeCharacters(room) {

  if (room.phase !== "characterSelect")
    return;

  console.log("finalizeCharacters");

  // 未決定プレイヤーは仮選択→ランダムの順で決定
  room.players.forEach(p => {

    if (!room.selectedChars.hasOwnProperty(p.id)) {

      if (room.previewChars.hasOwnProperty(p.id)) {
        room.selectedChars[p.id] = room.previewChars[p.id];
      }
      else {
        room.selectedChars[p.id] = Math.floor(Math.random() * 12) + 1;
      }
    }

  });

  broadcast(room, {
    type: "charResult",
    results: Object.entries(room.selectedChars).map(
      ([playerId, charId]) => ({
        playerId,
        charId
      })
    )
  });
  
  dealCards(room);

  // 全員を未準備状態にする
  room.prepareReady = {};
  
  // ===== 準備フェーズ開始 =====
  startPhase(
    room,
    "prepare",
    90000,
    finalizePrepare
  );
}

function finalizePrepare(room) {
  // 二重実行防止
  if (room.phase !== "prepare") return;

  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }

  console.log("prepare finished");

  room.phase = "battle";
  room.phaseEndTime = 0;

  broadcast(room, {
    type: "battleStart",
    players: room.players.map(p => ({
      playerId: p.id,
      words: room.playerWords[p.id] || 3
    }))
  });
}

function createDeck(playerCount) {
    const deck = [];

    // 3人以上なら各数字2枚、それ以外なら各数字1枚
    const copies = playerCount >= 3 ? 2 : 1;

    for (let copy = 0; copy < copies; copy++) {
        for (let number = 0; number <= 9; number++) {
            deck.push(number);
        }
    }

    shuffleDeck(deck);

    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const randomIndex = Math.floor(Math.random() * (i + 1));

        const temp = deck[i];
        deck[i] = deck[randomIndex];
        deck[randomIndex] = temp;
    }
}

function dealCards(room) {
    const deck = createDeck(room.players.length);

    room.deck = deck;
    room.playerHands = {};
    room.discardPile = [];

    for (const player of room.players) {
        room.playerHands[player.id] = [];

        for (let i = 0; i < 3; i++) {
            const card = room.deck.pop();

            if (card === undefined) {
                console.error("山札のカードが足りません");
                break;
            }

            room.playerHands[player.id].push(card);
        }
    }

    // 各プレイヤーに自分の手札だけ送る
    for (const player of room.players) {
        send(player.ws, {
            type: "initialHand",
            cards: room.playerHands[player.id]
        });
    }

  broadcastDeckInfo(room);
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
      const isHost = data.isHost === true;

      // ===== ルーム作成 =====
      if (isHost) {

        // 同じ部屋がある
        if (rooms[roomId]) {
          send(ws, {
            type: "joinResult",
            success: false,
            reason: "room_duplication"
          });
          return;
        }

        rooms[roomId] = {
          roomId,
          maxPlayers: 4,
          maxSpectators: 20,

          players: [],
          spectators: [],

          phase: "waiting",

          selectedChars: {},
          previewChars: {},
          prepareReady: {},
          playerWords: {},
          
          deck: [],
          playerHands: {},
          discardPile: [],
          
          phaseTimer: null,
          phaseEndTime: 0
        };
      }

      // ===== ルーム参加 =====
      else {

        // 部屋が存在しない
        if (!rooms[roomId]) {
          send(ws, {
            type: "joinResult",
            success: false,
            reason: "room_not_found"
          });
          return;
        }
      }

      const room = rooms[roomId];

      // ===== 満員チェック =====
      if (
        room.players.length >= room.maxPlayers &&
        room.spectators.length >= room.maxSpectators
      ) {
        send(ws, {
          type: "joinResult",
          success: false,
          reason: "player_full"
        });
        return;
      }

      ws.id = clientId;
      ws.roomId = roomId;

      const isPlayer =
        room.players.length < room.maxPlayers &&
        room.phase === "waiting";

      if (isPlayer) {
        room.players.push({
          id: ws.id,
          name: data.name || "NoName",
          ws,
          ready: false,
          isHost: room.players.length === 0
        });
      }
      else {
        room.spectators.push({
          id: ws.id,
          name: data.name || "NoName",
          ws
        });
      }

      send(ws, {
        type: "joinResult",
        success: true
      });

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
        room.previewChars = {};
        room.phaseEndTime = 0;

        startPhase(
          room,
          "characterSelect",
          30000,
          finalizeCharacters
        );
      }
    }

    // ===== ルーム情報要求 =====
    if (data.type === "requestRoomInfo") {
      const room = rooms[ws.roomId];
      if (!room) return;
      send(ws, roomInfo(room));
    }
    // ===== キャラ仮選択 =====
    if (data.type === "previewChar") {

      const room = rooms[ws.roomId];
      if (!room || room.phase !== "characterSelect") return;

      room.previewChars[ws.id] = data.charId;
    }
    // ===== キャラクター選択 =====
    if (data.type === "selectChar") {
      const room = rooms[ws.roomId];
      if (!room || room.phase !== "characterSelect") return;

      const isPlayer = room.players.some(p => p.id === ws.id);
      if (!isPlayer) return;

      if (room.selectedChars.hasOwnProperty(ws.id)) return;

      room.selectedChars[ws.id] = data.charId;

      const allDecided = room.players.every(p =>
        room.selectedChars.hasOwnProperty(p.id)
      );

      if (allDecided) {

        if (room.phaseTimer) {
          clearTimeout(room.phaseTimer);
          room.phaseTimer = null;
        }

        finalizeCharacters(room);
      }
    }

    // ===== 準備フェーズ完了・取り消し =====
if (data.type === "prepareReady") {
  const room = rooms[ws.roomId];

  if (!room || room.phase !== "prepare") return;

  const isPlayer = room.players.some(p => p.id === ws.id);
  if (!isPlayer) return;

  const ready = data.ready === true;

  if (ready) {
    room.prepareReady[ws.id] = true;
    // このプレイヤーの文字数を保存
    room.playerWords[ws.id] = data.words;
  } else {
    delete room.prepareReady[ws.id];
  }

  const readyCount = room.players.filter(
    p => room.prepareReady[p.id] === true
  ).length;

  broadcast(room, {
    type: "prepareReadyUpdate",
    playerId: ws.id,
    ready,
    readyCount,
    playerCount: room.players.length
  });

  const allReady = room.players.every(
    p => room.prepareReady[p.id] === true
  );

  if (allReady) {
    if (room.phaseTimer) {
      clearTimeout(room.phaseTimer);
      room.phaseTimer = null;
    }

    finalizePrepare(room);
  }
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
