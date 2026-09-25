// server.js — Nebula Conquest Server v2
const http = require('http');
const { Server } = require('socket.io');
const RoomManager = require('./roomManager');
const TournamentManager = require('./tournamentManager');
const { createClient } = require('@supabase/supabase-js');
const S = require('./securite');

/* Une exception dans un gestionnaire ne doit jamais abattre le serveur -
   et avec lui toutes les parties en cours. On la journalise et on continue. */
process.on('uncaughtException', (e) => console.error('[ERREUR non rattrapee]', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('[PROMESSE rejetee]', e && e.stack || e));

// ── Supabase (service_role, serveur uniquement) ──────────────
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;
if (supa) console.log('[SUPABASE] client service_role prêt');
else console.warn('[SUPABASE] SUPABASE_URL ou SUPABASE_SERVICE_KEY manquant — ELO désactivé');

// ── ELO ──────────────────────────────────────────────────────
const ELO_K = 32;
const ELO_DEFAULT = 1000;

function computeElo(ra, rb, scoreA, k = ELO_K) {
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    return Math.round(ra + k * (scoreA - ea));
}

// Match 1v1 terminé : winner gagne, loser perd. {userId} requis.
async function applyEloForMatch(winner, loser) {
    if (!supa) return null;
    if (!winner?.userId || !loser?.userId) return null;
    try {
        const { data, error } = await supa
            .from('profiles')
            .select('id, elo')
            .in('id', [winner.userId, loser.userId]);
        if (error) { console.warn('[ELO] lecture échouée:', error.message); return null; }

        const rw = (data.find(r => r.id === winner.userId)?.elo ?? ELO_DEFAULT);
        const rl = (data.find(r => r.id === loser.userId)?.elo ?? ELO_DEFAULT);
        const newW = computeElo(rw, rl, 1);
        const newL = computeElo(rl, rw, 0);

        const upW = await supa.from('profiles').update({ elo: newW }).eq('id', winner.userId);
        const upL = await supa.from('profiles').update({ elo: newL }).eq('id', loser.userId);
        if (upW.error) console.warn('[ELO] update winner échoué:', upW.error.message);
        if (upL.error) console.warn('[ELO] update loser échoué:', upL.error.message);

        console.log(`[ELO] W ${rw}->${newW} | L ${rl}->${newL}`);
        return { winner: { before: rw, after: newW }, loser: { before: rl, after: newL } };
    } catch (e) {
        console.warn('[ELO] exception:', e.message);
        return null;
    }
}

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

io.use((socket, next) => {
  const a = socket.handshake.auth || {};
  const annonce = S.pseudo(a.pseudo);
  const teinte = S.couleur(a.color, '#C084FC');
  const invite = () => {
    socket.data.profile = {
      pseudo: supa ? 'Invite-' + socket.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) : (annonce || 'Joueur'),
      color: teinte, userId: null, verifie: false
    };
    next();
  };
  if (!supa || typeof a.token !== 'string' || a.token.length > 4096) return invite();
  supa.auth.getUser(a.token).then(({ data, error }) => {
    const u = data && data.user;
    if (error || !u) return invite();
    return supa.from('profiles').select('*').eq('id', u.id).maybeSingle().then(({ data: pr }) => {
      socket.data.profile = {
        pseudo: S.pseudo(pr && pr.pseudo) || annonce || ('Joueur-' + u.id.slice(0, 4)),
        color:  S.couleur(pr && (pr.avatar_color || pr.color), teinte),
        userId: u.id,
        verifie: true
      };
      next();
    });
  }).catch(() => invite());
});

const GameLoop = require('./gameLoop').GameLoop;
const roomManager = new RoomManager();
const gameLoops = new Map(); // roomId → GameLoop
const tournamentManager = new TournamentManager();
const pseudoToSocket = new Map();
const invitations = new Map();        // 'socketDe>socketVers' -> date (classe)
const invitationsLocales = new Map(); // 'salle>socketVers' -> date (partie privee)
setInterval(() => {                   /* on ne garde pas les invitations perimees */
  const t = Date.now();
  for (const [k, v] of invitations) if (t - v > 120000) invitations.delete(k);
  for (const [k, v] of invitationsLocales) if (t - v > 600000) invitationsLocales.delete(k);
}, 60000);
const socketToUserId = new Map();

// Fin de manche ranked : score best-of-3 autoritaire + ELO en fin de match
function handleRankedManche(roomId, winnerSlot) {
    const room = roomManager._getRoom(roomId);
    const loop = gameLoops.get(roomId);
    if (loop) { loop.stop(); gameLoops.delete(roomId); }   // stoppe la boucle + libère la room pour la manche suivante
    if (!room) return;

    if (!room._rankedScores) room._rankedScores = [0, 0];
    if (winnerSlot === 0 || winnerSlot === 1) room._rankedScores[winnerSlot]++;
    const scores = room._rankedScores;

    if (scores[0] >= 2 || scores[1] >= 2) {
        const winSlot  = scores[0] >= 2 ? 0 : 1;
        const loseSlot = winSlot === 0 ? 1 : 0;
        const winner = room.slots.find(s => s.slot === winSlot);
        const loser  = room.slots.find(s => s.slot === loseSlot);
        room.status = 'ended';
        applyEloForMatch(winner, loser).then((elo) => {
            io.to(roomId).emit('ranked_match_over', { winnerSlot: winSlot, scores, elo });
        });
    } else {
        room.status = 'waiting';     /* la manche suivante pourra demarrer */
        io.to(roomId).emit('ranked_manche_result', { winnerSlot, scores });
    }
}

/* TOURNOI : c'est le serveur qui designe le vainqueur d'un match, d'apres
   la fin de partie qu'il a lui-meme constatee. Le client l'annoncait, et
   n'importe qui pouvait declarer n'importe quel vainqueur. */
function handleTournamentEnd(roomId, winnerSlot) {
    const room = roomManager._getRoom(roomId);
    const t = tournamentManager.tournament;
    if (!room || !t) return;
    const slot = room.slots.find(s => s.slot === winnerSlot);
    const match = t.bracket.find(m => m.roomId === roomId);
    if (!slot || !match) return;
    const result = tournamentManager.reportResult(match.matchId, slot.pseudo);
    if (result) {
        io.to('tournament').emit('tournament_update', tournamentManager.getState());
        if (result.finished) {
            io.to('tournament').emit('tournament_finished', { champion: result.champion });
            setTimeout(() => tournamentManager.reset(), 30000);
        }
    }
}

/* Fin de partie, une seule fois par partie, quelle qu'en soit la cause. */
function finDePartie(roomId, loop, winnerSlot) {
    if (!loop || !loop.state || loop.state._resultatTransmis) return;
    loop.state._resultatTransmis = true;
    if (roomId.startsWith('ranked-')) handleRankedManche(roomId, winnerSlot);
    else if (roomId.startsWith('tournament-')) handleTournamentEnd(roomId, winnerSlot);
}

/* IDENTITE. Le pseudo et l'identifiant venaient du client, sans controle :
   on pouvait se connecter sous le nom de n'importe qui - et faire perdre des
   points de classement a son compte. Le client envoie maintenant son jeton de
   session Supabase ; le serveur le fait verifier et lit le pseudo dans la
   base. Sans jeton valide, on est un invite : pas de classe, pas de tournoi. */


io.on('connection', (socket) => {
  const profile = socket.data.profile;
  pseudoToSocket.set(profile.pseudo.toLowerCase(), socket.id);

  /* Toute ecoute passe par ici : debit limite par socket, charge utile
     toujours un objet, et une exception reste dans son gestionnaire. */
  const _lim = S.limiteur();
  const ecouter = (evt, fn) => socket.on(evt, (arg) => {
    if (!S.accepter(_lim)) {
      if (S.aExclure(_lim)) {
        console.warn(`[ANTICHEAT] ${profile.pseudo} deconnecte : inondation de messages`);
        socket.disconnect(true);
      }
      return;
    }
    try { fn((arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {}); }
    catch (e) { console.error(`[ERREUR] ${evt} (${profile.pseudo}) :`, e && e.message); }
  });
  /* Classe et tournoi exigent une identite verifiee - sauf en local, sans
     base configuree, pour pouvoir tester. */
  const identifie = () => !supa || profile.verifie;
  if (profile.userId) socketToUserId.set(socket.id, profile.userId);

  console.log(`[+] ${profile.pseudo} (${socket.id})`);

  // TOURNOI
  ecouter('tournament_state', () => {
    socket.emit('tournament_update', tournamentManager.getState());
  });

ecouter('tournament_register', () => {
    if (!identifie()) { socket.emit('tournament_error', { msg: 'Connectez-vous pour participer au tournoi' }); return; }
    const result = tournamentManager.register(profile.pseudo, profile.color, socket.id);
    if (result.error) { socket.emit('tournament_error', { msg: result.error }); return; }
    socket.join('tournament');
    io.to('tournament').emit('tournament_update', tournamentManager.getState());
    console.log(`[TOURNAMENT] ${profile.pseudo} inscrit (${result.count}/32)`);

    // 32 joueurs atteints → notifier + countdown 10s + lancer les rooms
    if (result.bracket) {
      console.log(`[TOURNAMENT] Bracket prêt — lancement dans 10s`);
      io.to('tournament').emit('tournament_starting', { countdown: 10 });
      setTimeout(() => {
        for (const match of result.bracket) {
          const roomId = `tournament-${match.matchId}`;
          match.roomId = roomId;
          // Créer la room tournoi
          roomManager.createTournamentRoom(roomId, match.p1, match.p2);
          // Notifier les deux joueurs
          io.to(match.p1.socketId).emit('tournament_match_start', {
            roomId,
            matchId: match.matchId,
            round: match.round,
            opponent: { pseudo: match.p2.pseudo, color: match.p2.color },
            slot: 0
          });
          io.to(match.p2.socketId).emit('tournament_match_start', {
            roomId,
            matchId: match.matchId,
            round: match.round,
            opponent: { pseudo: match.p1.pseudo, color: match.p1.color },
            slot: 1
          });
        }
        io.to('tournament').emit('tournament_update', tournamentManager.getState());
      }, 10000);
    }
  });

  /* Ignore : le vainqueur d'un match est constate par le serveur
     (handleTournamentEnd). Garde pour ne pas gener les anciens clients. */
  ecouter('tournament_result', () => {});

// MULTI
  ecouter('multi_queue', () => { roomManager.joinMultiQueue(socket, profile); });
  ecouter('multi_queue_leave', () => { roomManager.leaveMultiQueue(socket.id); socket.emit('queue_left'); });

  // RANKED 1v1
ecouter('ranked_queue', () => {
    console.log(`[RANKED] ranked_queue reçu de ${profile.pseudo}`);
    if (!identifie()) { socket.emit('ranked_invite_error', { msg: 'Connectez-vous pour jouer en classé' }); return; }
    if (profile._rankedBanUntil && Date.now() < profile._rankedBanUntil) {
      const remaining = Math.ceil((profile._rankedBanUntil - Date.now()) / 1000);
      socket.emit('ranked_invite_error', { msg: `Cooldown anti-déconnexion : ${remaining}s restantes` });
      return;
    }
    const result = roomManager.joinRankedQueue(socket, profile);
    if (result?.matched) {
      const { roomId, p1, p2, maps } = result;
      const room = roomManager._getRoom(roomId);
      if (room) { room._rankedMaps = maps; room._rankedManche = 0; }
      io.to(p1.socketId).emit('ranked_matched', { roomId, slot: 0, opponent: { pseudo: p2.pseudo, color: p2.color }, maps });
      io.to(p2.socketId).emit('ranked_matched', { roomId, slot: 1, opponent: { pseudo: p1.pseudo, color: p1.color }, maps });
      console.log(`[RANKED] ${p1.pseudo} vs ${p2.pseudo} — room=${roomId}`);
    }
  });

  ecouter('ranked_queue_leave', () => {
    roomManager.leaveRankedQueue(socket.id);
    socket.emit('ranked_queue_left');
  });

  ecouter('ranked_invite', ({ targetPseudo }) => {
    if (!identifie()) { socket.emit('ranked_invite_error', { msg: 'Connectez-vous pour jouer en classé' }); return; }
    const cible = S.pseudo(targetPseudo);
    const targetSocketId = cible && pseudoToSocket.get(cible.toLowerCase());
    if (!targetSocketId || targetSocketId === socket.id) { socket.emit('ranked_invite_error', { msg: 'Joueur introuvable ou non connecté' }); return; }
    /* L'invitation est retenue : seul celui qu'on a invite pourra
       l'accepter, et seulement pendant deux minutes. */
    invitations.set(socket.id + '>' + targetSocketId, Date.now());
    io.to(targetSocketId).emit('ranked_invite_received', { fromPseudo: profile.pseudo, fromColor: profile.color });
  });

  ecouter('ranked_invite_accept', ({ fromPseudo }) => {
    if (!identifie()) { socket.emit('ranked_invite_error', { msg: 'Connectez-vous pour jouer en classé' }); return; }
    const de = S.pseudo(fromPseudo);
    const fromSocketId = de && pseudoToSocket.get(de.toLowerCase());
    if (!fromSocketId) { socket.emit('ranked_invite_error', { msg: 'Joueur introuvable' }); return; }
    /* Accepter une invitation qui n'a jamais ete envoyee forcait un match
       classe - et ses points - avec n'importe qui. */
    const cle = fromSocketId + '>' + socket.id;
    const quand = invitations.get(cle);
    invitations.delete(cle);
    if (!quand || Date.now() - quand > 120000) { socket.emit('ranked_invite_error', { msg: 'Invitation expirée' }); return; }
    const autre = io.sockets.sockets.get(fromSocketId);
    const pa = autre && autre.data && autre.data.profile;
    if (!pa) { socket.emit('ranked_invite_error', { msg: 'Joueur introuvable' }); return; }
    const maps = roomManager.pickRankedMaps();
    const roomId = 'ranked-' + Math.random().toString(36).slice(2, 8);
    const p1 = { pseudo: pa.pseudo, color: pa.color, socketId: fromSocketId, userId: pa.userId || null };
    const p2 = { pseudo: profile.pseudo, color: profile.color, socketId: socket.id, userId: profile.userId || null };
    roomManager.createTournamentRoom(roomId, p1, p2);
    io.to(fromSocketId).emit('ranked_matched', { roomId, slot: 0, opponent: { pseudo: p2.pseudo, color: p2.color }, maps });
    socket.emit('ranked_matched', { roomId, slot: 1, opponent: { pseudo: p1.pseudo, color: p1.color }, maps });
    console.log(`[RANKED] invite ${p1.pseudo} vs ${p2.pseudo} — room=${roomId}`);
  });

  ecouter('ranked_invite_declined', ({ targetPseudo }) => {
    const cible = S.pseudo(targetPseudo);
    const targetSocketId = cible && pseudoToSocket.get(cible.toLowerCase());
    if (targetSocketId) io.to(targetSocketId).emit('ranked_invite_declined', { fromPseudo: profile.pseudo });
  });

// ranked_result ignoré — le serveur détermine le gagnant via game_over
  // ecouter('ranked_result', ...) supprimé anti-triche

  // LOCAL
  ecouter('local_create', () => {
    const room = roomManager.createLocalRoom(socket, profile);
    socket.emit('local_created', { roomId: room.id, slot: 0, players: room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color })) });
  });

  ecouter('local_join', ({ roomId }) => {
    /* On ne rejoint une salle privee que sur invitation. */
    const cle = (typeof roomId === 'string' ? roomId : '') + '>' + socket.id;
    const quand = invitationsLocales.get(cle);
    if (!quand || Date.now() - quand > 600000) { socket.emit('error', { msg: 'Invitation requise' }); return; }
    invitationsLocales.delete(cle);
    const result = roomManager.joinLocalRoom(socket, profile, roomId);
    if (result.error) { socket.emit('error', { msg: result.error }); return; }
    const players = result.room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color }));
    socket.emit('local_joined', { roomId, slot: result.slot, players });
    socket.to(roomId).emit('room_update', { players });
  });

  // EN JEU
ecouter('game_start', ({ roomId, universe }) => {
    /* Seul l'HOTE de SA salle lance la partie, une seule fois. N'importe qui
       pouvait relancer la salle d'un autre avec l'univers de son choix. */
    if (typeof roomId !== 'string' || roomManager.socketToRoom.get(socket.id) !== roomId) return;
    const salle = roomManager._getRoom(roomId);
    if (!salle || salle.status !== 'waiting' || gameLoops.has(roomId)) return;
    const hote = salle.slots.find(s => s.slot === (salle.hostSlot || 0));
    if (!hote || hote.socketId !== socket.id) return;
    /* L'univers est borne et remis a zero (voir securite.js) : l'hote ne
       fixe plus ni ses statistiques ni la taille des planetes. */
    universe = S.nettoyerUnivers(universe, salle);
    const room = roomManager.startGame(roomId, universe);
    if (!room) { socket.emit('error', { msg: 'Room introuvable' }); return; }
    console.log(`[game_start] room=${roomId} slots=${room.slots.length} universe=${!!universe}`);
    // S'assurer que tous les sockets de la room ont rejoint le canal socket.io
    for (const s of room.slots) {
        if (s.socketId) {
            const memberSocket = io.sockets.sockets.get(s.socketId);
            if (memberSocket) memberSocket.join(roomId);
        }
    }
    io.to(roomId).emit('game_start', { roomId, universe, players: room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color })) });
    // Démarrer la simulation autoritaire
if (!gameLoops.has(roomId)) {
      const loop = new GameLoop(roomId, io);
      loop.start(universe);
// Rooms ranked : numéro de manche, score de match et hook fin de manche
      if (roomId.startsWith('ranked-')) {
        loop.state._rankedManche = room._rankedManche || 0;
        room._rankedManche = (room._rankedManche || 0) + 1;
        if (!room._rankedScores) room._rankedScores = [0, 0];
      }
      /* Fin de partie constatee par le serveur : classe, tournoi. */
      loop.state._onGameOver = (winnerSlot) => finDePartie(roomId, loop, winnerSlot);
      // Associer socketId → slot sur chaque player
      for (const s of room.slots) {
        const p = loop.state.players.find(p => p.id === s.slot);
        if (p) p.socketId = s.socketId;
      }
      gameLoops.set(roomId, loop);
    }
  });

ecouter('player_action', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    const loop = gameLoops.get(roomId);
    if (!loop) return;

    // Rate limiting jets : max 5/seconde par joueur
    if (data?.type === 'jet') {
        const now = Date.now();
        if (!socket._jetTimestamps) socket._jetTimestamps = [];
        socket._jetTimestamps = socket._jetTimestamps.filter(t => now - t < 1000);
        if (socket._jetTimestamps.length >= 5) {
            console.warn(`[ANTICHEAT] spam jets détecté : ${profile.pseudo}`);
            return;
        }
        socket._jetTimestamps.push(now);
    }

    loop.handleInput(socket.id, data);
});

  ecouter('spawn_ready', () => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = roomManager._getRoom(roomId);
    if (!room) return;
    if (!room._spawnReady) room._spawnReady = new Set();
    room._spawnReady.add(socket.id);
    const humanSlots = room.slots.filter(s => s.socketId !== null);
    if (room._spawnReady.size >= humanSlots.length) {
      room._spawnReady.clear();
      io.to(roomId).emit('spawn_start');
    }
  });

  /* Supprimes : game_snapshot et game_end etaient relayes tels quels aux
     autres joueurs. Le jeu ne les envoie jamais - l'etat vient du serveur -
     ils ne servaient qu'a afficher un faux etat ou une fausse fin chez
     l'adversaire. */

  // Intercepter game_over pour les rooms ranked
  // (émis par gameLoop._checkVictory, on l'écoute via io.on)

  // DÉCONNEXION
  ecouter('invite_declined', ({ targetPseudo }) => {
    const cible = S.pseudo(targetPseudo);
    const targetSocketId = cible && pseudoToSocket.get(cible.toLowerCase());
    if (targetSocketId) io.to(targetSocketId).emit('invite_declined', { fromPseudo: profile.pseudo });
  });

ecouter('player_ready', ({ roomId }) => {
    if (typeof roomId !== 'string' || roomManager.socketToRoom.get(socket.id) !== roomId) return;
    const room = roomManager._getRoom(roomId);
    const players = room ? room.slots.map(s => ({ slot: s.slot, pseudo: s.pseudo, color: s.color })) : [];
    socket.to(roomId).emit('player_ready', { players });
  });

  /* Le pseudo annonce est ignore : on ne s'inscrit que sous le sien. Sinon
     on detournait les invitations destinees a un autre. */
  ecouter('register_pseudo', () => {
    pseudoToSocket.set(profile.pseudo.toLowerCase(), socket.id);
  });

  ecouter('local_invite', ({ roomId, targetPseudo }) => {
    if (typeof roomId !== 'string' || roomManager.socketToRoom.get(socket.id) !== roomId) return;
    const cible = S.pseudo(targetPseudo);
    const targetSocketId = cible && pseudoToSocket.get(cible.toLowerCase());
    if (!targetSocketId || targetSocketId === socket.id) { socket.emit('invite_error', { msg: 'Joueur introuvable ou non connecté' }); return; }
    invitationsLocales.set(roomId + '>' + targetSocketId, Date.now());
    io.to(targetSocketId).emit('invite_received', { roomId, fromPseudo: profile.pseudo });
  });

socket.on('disconnect', () => {
    console.log(`[-] ${profile.pseudo} (${socket.id})`);
    const tResult = tournamentManager.handleDisconnect(socket.id);
    if (tResult) io.to('tournament').emit('tournament_update', tournamentManager.getState());
    pseudoToSocket.delete(profile.pseudo.toLowerCase());

    // Anti-triche : déco volontaire en ranked = forfait + cooldown
    const disconnRoom = roomManager._getRoomOfSocket ? roomManager._getRoomOfSocket(socket.id) : null;
    if (disconnRoom && disconnRoom.id.startsWith('ranked-')) {
      if (!profile._rankedDiscoCount) profile._rankedDiscoCount = 0;
      profile._rankedDiscoCount++;
      if (profile._rankedDiscoCount >= 3) {
        console.warn(`[ANTICHEAT] ${profile.pseudo} déconnexions répétées en ranked (${profile._rankedDiscoCount})`);
        // Cooldown : bloquer la file ranked pendant 5 minutes
        profile._rankedBanUntil = Date.now() + 5 * 60 * 1000;
        profile._rankedDiscoCount = 0;
      }
    }
const result = roomManager.handleDisconnect(socket.id);
    if (result?.room) {
      const roomId = result.room.id;
      const slot = result.slotEntry?.slot;
      socket.to(roomId).emit('player_disconnected', { slot, pseudo: profile.pseudo });

      const loop = gameLoops.get(roomId);

      // Stopper le GameLoop si la room est vide
      if (!result.room.slots.length) {
        if (loop) { loop.stop(); gameLoops.delete(roomId); }
      } else if (loop && loop.state && !loop.state._gameOver) {
        // Marquer le joueur déconnecté comme mort dans la simulation
        const p = loop.state.players.find(p => p.id === slot);
        if (p) { p.alive = false; p.bodies = []; }

       // Joueurs humains encore connectés (hors celui qui vient de partir)
        const remainingSlots = result.room.slots.map(s => s.slot);
        const aliveHumans = loop.state.players.filter(p => p.isHuman && remainingSlots.includes(p.id));
        console.log(`[disconnect] slot=${slot} aliveHumans=${aliveHumans.length} remainingSlots=${remainingSlots}`);

        if (aliveHumans.length === 1) {
          // Un seul humain reste → vainqueur
          loop.state._gameOver = true;
          io.to(roomId).emit('game_over', {
            winnerSlot: aliveHumans[0].id,
            reason: 'disconnect',
            stats: { timeElapsed: loop.state.time }
          });
          /* Abandon = victoire de celui qui reste, au classement comme au
             tournoi. Avant, quitter une manche perdue ne coutait rien. */
          finDePartie(roomId, loop, aliveHumans[0].id);
        } else if (aliveHumans.length === 0) {
          // Match nul (tous déconnectés simultanément)
          loop.state._gameOver = true;
          io.to(roomId).emit('game_over', {
            winnerSlot: -1,
            reason: 'draw',
            stats: { timeElapsed: loop.state.time }
          });
        }
        // Sinon la partie continue normalement
      }
    }
  });
});

server.listen(PORT, () => console.log(`Nebula Conquest Server v2 — port ${PORT}`));
