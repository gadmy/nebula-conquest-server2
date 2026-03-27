// gameLoop.js — Nebula Conquest · Simulation autoritaire serveur
'use strict';

// ─── PRNG déterministe (mulberry32) — identique au client ─────
function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// ─── GameLoop par room ────────────────────────────────────────
class GameLoop {

    constructor(roomId, io) {
        this.roomId  = roomId;
        this.io      = io;
        this.state   = null;
        this._timer  = null;
        this._tick   = 0;
    }

    // Appelé depuis server.js au game_start
    start(universe) {
        this.state = _buildState(universe);
        const DT = 50 / 1000;
        this._timer = setInterval(() => this._step(DT), 50);
        console.log(`[GameLoop] room=${this.roomId} démarrée`);
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        console.log(`[GameLoop] room=${this.roomId} arrêtée`);
    }

    // Input joueur reçu (sera développé étape 3)
    handleInput(socketId, ev) { /* TODO */ }

    _step(dt) {
        if (!this.state) return;
        this._tick++;

        updateOrbits(this.state, dt);
        // TODO étapes suivantes : updateSporeGeneration, updateJets, updateComets, updateAI

        // Snapshot toutes les 2 ticks = 100ms
        if (this._tick % 2 === 0) {
            this.io.to(this.roomId).emit('game_snapshot', _buildSnapshot(this.state));
        }
    }
}

// ─── Construction état serveur depuis universe ────────────────
function _buildState(universe) {
    const seed = universe?.multiSeed || 42;

    // Reconstruire les tableaux plats depuis la hiérarchie suns
    const planets = [];
    const moons   = [];
    const allBodies = [];
    for (const sun of (universe?.suns || [])) {
        for (const planet of (sun.planets || [])) {
            planet.parent = sun;
            planets.push(planet);
            allBodies.push(planet);
            for (const moon of (planet.moons || [])) {
                moon.parent = planet;
                moons.push(moon);
                allBodies.push(moon);
            }
        }
    }

    return {
        suns:          universe?.suns          || [],
        planets,
        moons,
        allBodies,
        asteroidBelts: universe?.asteroidBelts || [],
        jets:          [],
        players:       universe?.players       || [],
        time:          0,
        _gameRng:      mulberry32(seed + 5555),
        _worldRng:     mulberry32(seed),
    };
}

// ─── Snapshot allégé émis aux clients (100ms) ─────────────────
// Orbites non incluses : les clients les calculent localement
// (updateOrbits est déterministe, même dt côté client)
// Seul l'état de conquête est autoritaire.
function _buildSnapshot(state) {
    return {
        planets: state.planets.map(p => ({
            name:          p.name,
            owner:         p.owner,
            spores:        Math.round(p.spores        || 0),
            sporesAttaque: Math.round(p.sporesAttaque || 0),
            sporesDefense: Math.round(p.sporesDefense || 0),
            symbiosis:     Math.round(p.symbiosis     || 0),
            nids:          p.nids    || 0,
            biomes:        p.biomes  || 0,
            alveoles:      p.alveoles || 0,
            buildMode:     p.buildMode || 'off',
        })),
        moons: state.moons.map(m => ({
            name:   m.name,
            owner:  m.owner,
            spores: Math.round(m.spores || 0),
        })),
        jets: state.jets.map(j => ({
            id:     j.id,
            x:      Math.round(j.x),
            y:      Math.round(j.y),
            alive:  j.alive,
            owner:  j.owner,
            spores: Math.round(j.spores || 0),
            color:  j.color,
        })),
        players: state.players.map(p => ({
            id:          p.id,
            alive:       p.alive,
            totalSpores: Math.round(p.totalSpores || 0),
        })),
    };
}

// ─── updateOrbits (portée à l'identique du client) ────────────
function updateOrbits(state, dt) {
    for (let i = 0; i < state.suns.length; i++) {
        const sun = state.suns[i];
        sun.angle += sun.orbitSpeed * dt;
        sun.x = Math.cos(sun.angle) * sun.orbitRadius;
        sun.y = Math.sin(sun.angle) * sun.orbitRadius;

        for (let j = 0; j < sun.planets.length; j++) {
            const planet = sun.planets[j];
            planet.angle += planet.orbitSpeed * dt;
            planet.x = sun.x + Math.cos(planet.angle) * planet.orbitRadius;
            planet.y = sun.y + Math.sin(planet.angle) * planet.orbitRadius;

            for (let k = 0; k < planet.moons.length; k++) {
                const moon = planet.moons[k];
                moon.angle += moon.orbitSpeed * dt;
                moon.x = planet.x + Math.cos(moon.angle) * moon.orbitRadius;
                moon.y = planet.y + Math.sin(moon.angle) * moon.orbitRadius;
            }
        }
    }

    for (const belt of state.asteroidBelts) {
        for (const rock of belt.rocks) {
            rock.angle += belt.orbitSpeed * dt;
        }
    }
}

module.exports = { GameLoop, updateOrbits, _buildState };