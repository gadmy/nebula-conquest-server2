// server.js — Nebula Conquest Server v2
const http = require('http');
const { Server } = require('socket.io');
const RoomManager = require('./roomManager');
const TournamentManager = require('./tournamentManager');

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'https://gadmy.github.io';
const ALLOWED_ORIGINS = [
  CLIENT_ORIGIN,
  'https://nebulaconquest.com',
  'https://www.nebulaconquest.com',
  'http://localhost',
  'null'
];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...roomManager.getStats() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }
});

const roomManager = new RoomManager();
const tournamentManager = new TournamentManager();
const pseudoToSocket = new Map();

io.on('connection', (socket) => {
const profile = {
    pseudo: socket.handshake.auth?.pseudo || 'Joueur',
    color:  socket.handshake.auth?.color  || '#C084FC',
    userId: socket.handshake.auth?.userId || null
  };
  pseudoToSocket.set(profile.pseudo.toLowerCase(), socket.id);

  console.log(`[+] ${profile.pseudo} (${socket.id})`);

  // TOURNOI
  socket.on('tournament_state', () => {
    socket.emit('tournament_update', tournamentManager.getState());
  });

  socket.on('tournament_register', () => {
    const result = tournamentManager.register(profile.pseudo, profile.color, socket.id);
    if (result.error) { socket.emit('tournament_error', { msg: result.error }); return; }
    socket.join('tournament');
    io.to('tournament').emit('tournament_update', tournamentManager.getState());
    console.log(`[TOURNAMENT] ${profile.pseudo} inscrit (${result.count}/32)`);
  });

  socket.on('tournament_result', ({ matchId, winnerPseudo }) => {
    const result = tournamentManager.reportResult(matchId, winnerPseudo);
    if (result) {
      io.to('tournament').emit('tournament_update', tournamentManager.getState());
      if (result.finished) {
        io.to('tournament').emit('tournament_finished', { champion: result.champion });
        setTimeout(() => tournamentManager.reset(), 30000);
      }
    }
  });

  // MULTI
  socket.on('multi_queue', () => { roomManager.joinMultiQueue(socket, profile); });
  socket.on('multi_queue_leave', () => { roomManager.leaveMultiQueue(socket.id); socket.emit('queue_left'); });

  // LOCAL
  socket.on('local_create', () => {
    const room = roomManager.createLocalRoom(socket, profile);
    socket.emit('local_created', { roomId: room.id, slot: 0, players: room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color })) });
  });

  socket.on('local_join', ({ roomId }) => {
    const result = roomManager.joinLocalRoom(socket, profile, roomId);
    if (result.error) { socket.emit('error', { msg: result.error }); return; }
    const players = result.room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color }));
    socket.emit('local_joined', { roomId, slot: result.slot, players });
    socket.to(roomId).emit('room_update', { players });
  });

  // EN JEU
  socket.on('game_start', ({ roomId, universe }) => {
    const room = roomManager.startGame(roomId, universe);
    if (!room) { socket.emit('error', { msg: 'Room introuvable' }); return; }
    io.to(roomId).emit('game_start', { roomId, universe, players: room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color })) });
  });

  socket.on('player_action', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('player_action', { ...data, fromSocketId: socket.id });
  });

  socket.on('game_snapshot', (snapshot) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('game_snapshot', snapshot);
  });

  socket.on('game_end', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    io.to(roomId).emit('game_end', data);
  });

  // DÉCONNEXION
  socket.on('invite_declined', ({ targetPseudo }) => {
    const targetSocketId = pseudoToSocket.get(targetPseudo.toLowerCase());
    if (targetSocketId) io.to(targetSocketId).emit('invite_declined', { fromPseudo: profile.pseudo });
  });

  socket.on('register_pseudo', ({ pseudo }) => {
    if (pseudo) pseudoToSocket.set(pseudo.toLowerCase(), socket.id);
  });

  socket.on('local_invite', ({ roomId, targetPseudo }) => {
    const targetSocketId = pseudoToSocket.get(targetPseudo.toLowerCase());
    if (!targetSocketId) { socket.emit('invite_error', { msg: 'Joueur introuvable ou non connecté' }); return; }
    io.to(targetSocketId).emit('invite_received', { roomId, fromPseudo: profile.pseudo });
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${profile.pseudo} (${socket.id})`);
    const tResult = tournamentManager.handleDisconnect(socket.id);
    if (tResult) io.to('tournament').emit('tournament_update', tournamentManager.getState());
    pseudoToSocket.delete(profile.pseudo.toLowerCase());
    const result = roomManager.handleDisconnect(socket.id);
    if (result?.room) socket.to(result.room.id).emit('player_disconnected', { slot: result.slotEntry?.slot, pseudo: profile.pseudo });
  });
});

server.listen(PORT, () => console.log(`Nebula Conquest Server v2 — port ${PORT}`));
