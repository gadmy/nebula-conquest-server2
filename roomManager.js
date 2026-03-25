// roomManager.js — Nebula Conquest Server v2
// Gère les rooms MULTI (matchmaking 4 joueurs) et LOCAL (invitations par pseudo)

const MULTI_MAX_PLAYERS = 2;
const LOCAL_MIN_PLAYERS = 2;
const LOCAL_MAX_PLAYERS = 2;

class RoomManager {
  constructor() {
    this.rooms = new Map();       // roomId → room
    this.multiQueue = [];         // sockets en attente de matchmaking
    this.socketToRoom = new Map(); // socketId → roomId
  }

  // ── Utilitaires ──────────────────────────────────────────────

  _generateId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 8);
  }

  _getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  _getRoomOfSocket(socketId) {
    const roomId = this.socketToRoom.get(socketId);
    return roomId ? this._getRoom(roomId) : null;
  }

  // ── MULTI : matchmaking automatique ──────────────────────────

  joinMultiQueue(socket, profile) {
    // Éviter les doublons
    if (this.multiQueue.find(e => e.socket.id === socket.id)) return;

    this.multiQueue.push({ socket, profile });
    console.log(`[MULTI] File d'attente: ${this.multiQueue.length}/${MULTI_MAX_PLAYERS}`);

    // Envoyer le statut d'attente à tous les joueurs en file
    this._broadcastQueueStatus();

    // Si la file est pleine → créer la room et lancer
    if (this.multiQueue.length >= MULTI_MAX_PLAYERS) {
      this._launchMultiRoom();
    }
  }

  leaveMultiQueue(socketId) {
    const before = this.multiQueue.length;
    this.multiQueue = this.multiQueue.filter(e => e.socket.id !== socketId);
    if (this.multiQueue.length < before) {
      this._broadcastQueueStatus();
    }
  }

  _broadcastQueueStatus() {
    this.multiQueue.forEach((entry, idx) => {
      entry.socket.emit('queue_status', {
        position: idx + 1,
        total: this.multiQueue.length,
        needed: MULTI_MAX_PLAYERS
      });
    });
  }

  _launchMultiRoom() {
    const players = this.multiQueue.splice(0, MULTI_MAX_PLAYERS);
    const roomId = this._generateId('multi');

    const slots = players.map((entry, idx) => ({
      slot: idx,
      socketId: entry.socket.id,
      pseudo: entry.profile.pseudo || 'Joueur' + (idx + 1),
      color: entry.profile.color || ['#C084FC','#4ADE80','#60A5FA','#FB923C'][idx],
      ready: false
    }));

    const room = {
      id: roomId,
      mode: 'multi',
      slots,
      status: 'waiting',  // waiting → playing → ended
      hostSlot: 0,
      createdAt: Date.now()
    };

    this.rooms.set(roomId, room);
    slots.forEach(s => this.socketToRoom.set(s.socketId, roomId));

    // Faire rejoindre tous les sockets dans la room socket.io
    players.forEach((entry, idx) => {
      entry.socket.join(roomId);
      entry.socket.emit('matched', {
        roomId,
        slot: idx,
        players: slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color }))
      });
    });

    console.log(`[MULTI] Room créée: ${roomId} avec ${slots.length} joueurs`);
  }

  // ── LOCAL : création et invitations ──────────────────────────

  createLocalRoom(socket, profile) {
    const roomId = this._generateId('local');

    const hostSlot = {
      slot: 0,
      socketId: socket.id,
      pseudo: profile.pseudo || 'Hôte',
      color: profile.color || '#C084FC',
      ready: false,
      isHost: true
    };

    const room = {
      id: roomId,
      mode: 'local',
      slots: [hostSlot],
      status: 'waiting',
      hostSlot: 0,
      createdAt: Date.now()
    };

    this.rooms.set(roomId, room);
    this.socketToRoom.set(socket.id, roomId);
    socket.join(roomId);

    console.log(`[LOCAL] Room créée: ${roomId} par ${hostSlot.pseudo}`);
    return room;
  }

  joinLocalRoom(socket, profile, roomId) {
    const room = this._getRoom(roomId);
    if (!room) return { error: 'Room introuvable' };
    if (room.mode !== 'local') return { error: 'Mauvais mode' };
    if (room.status !== 'waiting') return { error: 'Partie déjà lancée' };
    if (room.slots.length >= LOCAL_MAX_PLAYERS) return { error: 'Room pleine' };

    const slot = room.slots.length;
    const newSlot = {
      slot,
      socketId: socket.id,
      pseudo: profile.pseudo || 'Joueur' + (slot + 1),
      color: profile.color || ['#C084FC','#4ADE80','#60A5FA','#FB923C'][slot],
      ready: false,
      isHost: false
    };

    room.slots.push(newSlot);
    this.socketToRoom.set(socket.id, roomId);
    socket.join(roomId);

    console.log(`[LOCAL] ${newSlot.pseudo} a rejoint ${roomId} (slot ${slot})`);
    return { slot, room };
  }

  // ── Démarrage de partie ───────────────────────────────────────

  startGame(roomId, universe) {
    const room = this._getRoom(roomId);
    if (!room) return null;
    room.status = 'playing';
    room.universe = universe;
    return room;
  }

  // ── Déconnexion ───────────────────────────────────────────────

  handleDisconnect(socketId) {
    // Retirer de la file multi
    this.leaveMultiQueue(socketId);

    // Retirer de la room
    const room = this._getRoomOfSocket(socketId);
    if (!room) return null;

    this.socketToRoom.delete(socketId);

    const slotEntry = room.slots.find(s => s.socketId === socketId);
    if (slotEntry) {
      slotEntry.socketId = null;
      slotEntry.connected = false;
    }

    // Si plus personne → supprimer la room
    const stillConnected = room.slots.filter(s => s.socketId !== null);
    if (stillConnected.length === 0) {
      this.rooms.delete(room.id);
      console.log(`[ROOM] Room ${room.id} supprimée (vide)`);
    }

    return { room, slotEntry };
  }

  // ── Stats ─────────────────────────────────────────────────────

  getStats() {
    return {
      rooms: this.rooms.size,
      queue: this.multiQueue.length
    };
  }
}

module.exports = RoomManager;
