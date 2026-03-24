// server.js — Nebula Conquest Server v2
// Node.js + socket.io, autoritaire pour les modes MULTI et LOCAL

const http = require('http');
const { Server } = require('socket.io');
const RoomManager = require('./roomManager');

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'https://gadmy.github.io';

const server = http.createServer((req, res) => {
  // Health check pour Railway
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...roomManager.getStats() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(server, {
  cors: {
    origin: [CLIENT_ORIGIN, 'http://localhost', 'null'],
    methods: ['GET', 'POST']
  }
});

const roomManager = new RoomManager();

// ── Connexion ──────────────────────────────────────────────────

io.on('connection', (socket) => {
  const profile = {
    pseudo: socket.handshake.auth?.pseudo || 'Joueur',
    color:  socket.handshake.auth?.color  || '#C084FC',
    userId: socket.handshake.auth?.userId || null
  };

  console.log(`[+] ${profile.pseudo} connecté (${socket.id})`);

  // ── Mode MULTI : rejoindre la file de matchmaking ──

  socket.on('multi_queue', () => {
    console.log(`[MULTI] ${profile.pseudo} rejoint la file`);
    roomManager.joinMultiQueue(socket, profile);
  });

  socket.on('multi_queue_leave', () => {
    roomManager.leaveMultiQueue(socket.id);
    socket.emit('queue_left');
  });

  // ── Mode LOCAL : créer ou rejoindre une room ──

  socket.on('local_create', () => {
    const room = roomManager.createLocalRoom(socket, profile);
    socket.emit('local_created', {
      roomId: room.id,
      slot: 0,
      players: room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color }))
    });
  });

  socket.on('local_join', ({ roomId }) => {
    const result = roomManager.joinLocalRoom(socket, profile, roomId);
    if (result.error) {
      socket.emit('error', { msg: result.error });
      return;
    }
    const room = result.room;
    const players = room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color }));

    // Confirmer au nouveau joueur
    socket.emit('local_joined', { roomId, slot: result.slot, players });

    // Notifier tous les autres
    socket.to(roomId).emit('room_update', { players });
  });

  // ── Démarrage de partie (hôte LOCAL ou automatique MULTI) ──

  socket.on('game_start', ({ roomId, universe }) => {
    const room = roomManager.startGame(roomId, universe);
    if (!room) { socket.emit('error', { msg: 'Room introuvable' }); return; }

    console.log(`[GAME] Partie lancée: ${roomId}`);
    io.to(roomId).emit('game_start', {
      roomId,
      universe,
      players: room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color }))
    });
  });

  // ── Actions en jeu ──

  socket.on('player_action', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;

    // Relayer l'action à tous les autres joueurs de la room
    // (architecture autoritaire simplifiée : le serveur relaie,
    //  chaque client applique et renvoie son état)
    socket.to(roomId).emit('player_action', {
      ...data,
      fromSocketId: socket.id
    });
  });

  // ── Snapshot de l'état de jeu (envoyé par l'hôte) ──

  socket.on('game_snapshot', (snapshot) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    // L'hôte pousse son snapshot aux autres joueurs
    socket.to(roomId).emit('game_snapshot', snapshot);
  });

  // ── Fin de partie ──

  socket.on('game_end', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    io.to(roomId).emit('game_end', data);
    console.log(`[GAME] Fin de partie: ${roomId}`);
  });

  // ── Déconnexion ──

  socket.on('disconnect', () => {
    console.log(`[-] ${profile.pseudo} déconnecté (${socket.id})`);
    const result = roomManager.handleDisconnect(socket.id);
    if (result?.room) {
      socket.to(result.room.id).emit('player_disconnected', {
        slot: result.slotEntry?.slot,
        pseudo: profile.pseudo
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Nebula Conquest Server v2 — port ${PORT}`);
});
