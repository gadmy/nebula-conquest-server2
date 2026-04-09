// tournamentManager.js — Nebula Conquest
// Gère 1 tournoi à la fois, 32 joueurs, bracket 1v1

const TOURNAMENT_SIZE = 32;
const MATCH_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const DISCONNECT_FORFEIT_MS = 60 * 1000;   // 60s déco = forfait

class TournamentManager {
  constructor() {
    this.tournament = null; // 1 seul tournoi à la fois
  }

  // ── État courant ──────────────────────────────────────────────

  getState() {
    if (!this.tournament) {
      return { status: 'open', players: [], bracket: [], round: 0 };
    }
    return {
      status:  this.tournament.status,
      players: this.tournament.players,
      bracket: this.tournament.bracket,
      round:   this.tournament.round
    };
  }

  // ── Inscription ───────────────────────────────────────────────

  register(pseudo, color, socketId) {
    // Créer le tournoi si inexistant
    if (!this.tournament) {
      this.tournament = {
        status: 'open',
        players: [],
        bracket: [],
        round: 0,
        matches: new Map() // matchId → { p1, p2, winner, roomId }
      };
    }

    if (this.tournament.status !== 'open') {
      return { error: 'Tournoi déjà lancé' };
    }

    // Éviter les doublons
    if (this.tournament.players.find(p => p.pseudo === pseudo)) {
      return { error: 'Déjà inscrit' };
    }

    if (this.tournament.players.length >= TOURNAMENT_SIZE) {
      return { error: 'Tournoi complet' };
    }

    this.tournament.players.push({ pseudo, color, socketId });
    const count = this.tournament.players.length;

    // Lancement auto à 32 joueurs
    if (count >= TOURNAMENT_SIZE) {
      this._buildBracket();
    }

    return { ok: true, count };
  }

  // ── Construction du bracket ───────────────────────────────────

_buildBracket() {
    const t = this.tournament;
    t.status = 'playing';
    t.round = 1;

    // Mélange aléatoire
    const shuffled = [...t.players].sort(() => Math.random() - 0.5);

    // 16 matchs du tour 1
    t.bracket = [];
    for (let i = 0; i < 16; i++) {
      const p1 = shuffled[i * 2];
      const p2 = shuffled[i * 2 + 1];
      const matchId = `r1-m${i + 1}`;
      t.bracket.push({
        matchId,
        round: 1,
        p1: { pseudo: p1.pseudo, color: p1.color, socketId: p1.socketId },
        p2: { pseudo: p2.pseudo, color: p2.color, socketId: p2.socketId },
        winner: null,
        status: 'pending'
      });
    }
    // Retourner les matchs pour que server.js crée les rooms
    return t.bracket;
  }

  // ── Résultat d'un match ───────────────────────────────────────

  reportResult(matchId, winnerPseudo) {
    if (!this.tournament) return null;
    const match = this.tournament.bracket.find(m => m.matchId === matchId);
    if (!match) return null;
    if (match.winner) return null; // déjà joué

    match.winner = winnerPseudo;
    match.status = 'done';

    // Vérifier si le round est terminé
    const roundMatches = this.tournament.bracket.filter(m => m.round === this.tournament.round);
    const allDone = roundMatches.every(m => m.status === 'done');

    if (allDone) {
      return this._advanceRound();
    }

    return { updated: true, bracket: this.tournament.bracket };
  }

  _advanceRound() {
    const t = this.tournament;
    const currentRound = t.round;
    const winners = t.bracket
      .filter(m => m.round === currentRound)
      .map(m => t.players.find(p => p.pseudo === m.winner))
      .filter(Boolean);

    // Tournoi terminé
    if (winners.length === 1) {
      t.status = 'finished';
      t.champion = winners[0].pseudo;
      return { finished: true, champion: t.champion };
    }

    // Nouveau round
    t.round++;
    for (let i = 0; i < winners.length / 2; i++) {
      const p1 = winners[i * 2];
      const p2 = winners[i * 2 + 1];
      const matchId = `r${t.round}-m${i + 1}`;
      t.bracket.push({
        matchId,
        round: t.round,
        p1: { pseudo: p1.pseudo, color: p1.color, socketId: p1.socketId },
        p2: { pseudo: p2.pseudo, color: p2.color, socketId: p2.socketId },
        winner: null,
        status: 'pending'
      });
    }

    return { newRound: t.round, bracket: t.bracket };
  }

  // ── Forfait sur déconnexion ───────────────────────────────────

  handleDisconnect(socketId) {
    if (!this.tournament || this.tournament.status !== 'playing') return null;

    const match = this.tournament.bracket.find(m =>
      m.status === 'playing' &&
      (m.p1.socketId === socketId || m.p2.socketId === socketId)
    );
    if (!match) return null;

    const winner = match.p1.socketId === socketId ? match.p2.pseudo : match.p1.pseudo;
    return this.reportResult(match.matchId, winner);
  }

  // ── Réinitialiser après tournoi terminé ───────────────────────

  reset() {
    this.tournament = null;
  }
}

module.exports = TournamentManager;
