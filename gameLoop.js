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
        this.state._io     = this.io;
        this.state._roomId = this.roomId;
        const DT = 50 / 1000;
        this._timer = setInterval(() => this._step(DT), 50);
        console.log(`[GameLoop] room=${this.roomId} démarrée`);
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        console.log(`[GameLoop] room=${this.roomId} arrêtée`);
    }
handleInput(socketId, ev) {
        if (!this.state || !ev?.type) return;
        const state = this.state;

        if (ev.type === 'jet') {
            const src = state.planets.find(p => p.name === ev.srcName)
                     || state.moons.find(m => m.name === ev.srcName);
            if (!src) return;
            const prevCount = state.jets.length;
            launchJet(state, src, ev.dirX, ev.dirY, ev.sporeType || 'normal');
            // Notifier tous les clients pour qu'ils animent le jet localement
            if (state.jets.length > prevCount) {
                const jet = state.jets[state.jets.length - 1];
this.io.to(this.roomId).emit('jet_fired', {
                    srcName:    ev.srcName,
                    dirX:       ev.dirX,
                    dirY:       ev.dirY,
                    sporeType:  ev.sporeType || 'normal',
                    owner:      src.owner,
                    spores:     jet.spores,
                    color:      jet.color,
                    speed:      jet.speed,
                    id:         jet.id,
                    trajectory: jet.trajectory,
                });
            }
        }

if (ev.type === 'spawn') {
            const body   = state.planets.find(p => p.name === ev.bodyName)
                        || state.moons.find(m => m.name === ev.bodyName);
            const slot   = ev.fromSlot !== undefined ? ev.fromSlot : ev.slot;
            const player = state.players[slot];
    if (body && player) {
                body.owner  = slot;
                body.spores = body.maxSpores * 0.5;
                player.bodies = [body];
                player.spawnPlanet = body;
            }
        }

        if (ev.type === 'set_sacrifice') {
            const player = state.players.find(p => p.socketId === socketId);
            if (player) player.multiSacrifice = ev.value;
        }

        if (ev.type === 'build_mode') {
            const body = state.planets.find(p => p.name === ev.bodyName)
                      || state.moons.find(m => m.name === ev.bodyName);
            if (body && body.owner === state.players.findIndex(p => p.socketId === socketId)) {
                body.buildMode = ev.mode || 'off';
            }
        }
    }

    _step(dt) {
        if (!this.state) return;
        this._tick++;
        updateOrbits(this.state, dt);
        updateSporeGeneration(this.state, dt);
        updateJets(this.state, dt);
        updateComets(this.state, dt);
        updateCleaners(this.state, dt);
        if (this._tick % 2 === 0) updateAI(this.state, 50 / 1000);

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

const suns = universe?.suns || [];
    const asteroidBelts = (universe?.asteroidBelts || []).map(b => ({
        ...b,
        sun: suns[b.sunIndex] || suns[0] || null,
    }));

// Initialiser les cleaners depuis l'universe
    const cleaners = (universe?.cleaners || []).map(c => ({ ...c, _target: null, fireTimer: CLN_CFG.fireRate, turnTimer: 0 }));

    return {
        suns,
        planets,
        moons,
        allBodies,
        asteroidBelts,
        blackHole:      universe?.blackHole     || { x: 0, y: 0, radius: 300, dangerZone: 300, gravityRange: 1500, gravityStrength: 1260 },
        jets:           [],
        cleaners,
        players:        universe?.players       || [],
        config:         universe?.config        || { difficulty: 'normal' },
        jetRatio:       universe?.jetRatio      || 0.5,
        universeRadius: universe?.universeRadius || 6000,
        time:           0,
        _gameRng:       mulberry32(seed + 5555),
        _worldRng:      mulberry32(seed),
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
            spores: Math.round(j.spores || 0),
        })),
        cleaners: state.cleaners.map(c => ({
            type:  c.type,
            x:     Math.round(c.x),
            y:     Math.round(c.y),
            vx:    Math.round(c.vx * 100) / 100,
            vy:    Math.round(c.vy * 100) / 100,
            angle: c.angle,
        })),
time: state.time,
        orbits: state.suns.map(s => ({
            a: Math.round(s.angle * 10000) / 10000,
            planets: s.planets.map(p => ({
                a: Math.round(p.angle * 10000) / 10000,
                moons: p.moons.map(m => ({ a: Math.round(m.angle * 10000) / 10000 }))
            }))
        })),
        belts: state.asteroidBelts.map(b => ({
            a: Math.round((b.rocks[0]?.angle || 0) * 10000) / 10000,
            orbitSpeed: b.orbitSpeed,
        })),
        players: state.players.map(p => ({
            id:          p.id,
            alive:       p.alive,
            totalSpores: Math.round(p.totalSpores || 0),
        })),
    };
}

// ─── Helpers simulation (portés à l'identique du client) ──────

function isSystemComplete(sun, owner) {
    if (sun._sysCache?.owner === owner && sun._sysCache?.valid) return sun._sysCache.result;
    for (const planet of sun.planets) {
        if (planet.owner !== owner) { sun._sysCache = { owner, valid: true, result: false }; return false; }
        for (const moon of planet.moons) {
            if (moon.owner !== owner) { sun._sysCache = { owner, valid: true, result: false }; return false; }
        }
    }
    sun._sysCache = { owner, valid: true, result: true };
    return true;
}

function _isAllied(a, b, players) {
    if (a === b) return false;
    const pa = players[a], pb = players[b];
    if (!pa || !pb) return false;
    return pa.team !== undefined && pa.team !== null && pa.team === pb.team;
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

// ─── updateSporeGeneration (portée du client, UI neutralisée) ─
function updateSporeGeneration(state, dt) {
    const bodies = state.allBodies;
    for (const body of bodies) {
        if (body.owner === null && body._baseFaune !== undefined && body.faune < body._baseFaune) {
            body.faune += 2 * dt;
            if (body.faune > body._baseFaune) body.faune = body._baseFaune;
        }
        if (body.owner === null) continue;

        body.symOwnerTime += dt;
        const symMaxTime = body.type === 'planet' ? 600 : 300;
        body.symbiosis = Math.min(100, (body.symOwnerTime / symMaxTime) * 100);

        if (body.flore <= 0) continue;
        const player = state.players[body.owner];
        if (!player) continue;

        const symBonusMax = body.type === 'planet' ? 0.20 : 0.10;
        const symBonus = 1 + (body.symbiosis / 100) * symBonusMax;
        const nidBonus = 1 + (body.nids || 0) * 0.025;
        const _alvMax = Math.floor((body.baseMaxSpores || body.maxSpores) * (1 + (body.alveoles || 0) * 0.05));
        if (body.maxSpores !== _alvMax) body.maxSpores = _alvMax;

        let sysBonus = 1;
        const bodySun = body.type === 'planet' ? body.parent : (body.parent?.parent || null);
        if (bodySun && isSystemComplete(bodySun, body.owner)) sysBonus = 1.03;

        const rate = (0.4 + (body.flore / 100) * 0.6) * (1 + player.stats.growth * 0.3) * 2.5 * symBonus * nidBonus * sysBonus;

        if (body.buildMode === 'nid' || body.buildMode === 'biome' || body.buildMode === 'alveole') {
            const _buildType = body.buildMode;
            const _costPct = body.buildMode === 'nid' ? 0.15 : body.buildMode === 'alveole' ? 0.10 : 0.20;
            const _buildCost = Math.floor((body.baseMaxSpores || body.maxSpores) * _costPct);
            if (body.spores < _buildCost * 0.8 && (body.buildProgress || 0) === 0) {
                // attendre
            } else if (body.spores < 5 && (body.buildProgress || 0) > 0) {
                body.buildProgress = 0;
                body.buildMode = 'off';
            } else {
                const _drainRate = _buildCost / 8;
                const _drain = Math.min(_drainRate * dt, body.spores - 5, _buildCost - (body.buildProgress || 0));
                if (_drain > 0) {
                    body.spores -= _drain;
                    body.buildProgress = (body.buildProgress || 0) + _drain;
                }
                if ((body.buildProgress || 0) >= _buildCost) {
                    body.buildProgress = 0;
                    body.buildMode = 'off';
                    if (_buildType === 'nid')          body.nids     = (body.nids     || 0) + 1;
                    else if (_buildType === 'alveole') { body.alveoles = (body.alveoles || 0) + 1; body.baseMaxSpores = body.baseMaxSpores || body.maxSpores; }
                    else                               body.biomes   = (body.biomes   || 0) + 1;
                    // invalidate cache système
                    if (bodySun) bodySun._sysCache = null;
                }
            }
        } else if (body.buildMode === 'parasite') {
            if ((body.parasiteSpore || 0) < 1) {
                body.parasiteProgress = (body.parasiteProgress || 0) + dt;
                if (body.parasiteProgress >= 120) {
                    body.parasiteSpore = 1;
                    body.parasiteProgress = 0;
                    body.buildMode = 'off';
                }
            } else {
                body.buildMode = 'off';
            }
        } else if (body.buildMode === 'ruche') {
            const maxAtt = body.maxSpores;
            if ((body.sporesAttaque || 0) < maxAtt) {
                body.sporesAttaque = Math.min(maxAtt, (body.sporesAttaque || 0) + rate * 0.5 * dt);
            }
        } else if (body.buildMode === 'mare') {
            const maxDef = body.maxSpores * 2;
            if ((body.sporesDefense || 0) < maxDef) {
                body.sporesDefense = Math.min(maxDef, (body.sporesDefense || 0) + rate * 0.5 * dt);
            }
        } else {
            const multiPct = (player.multiSacrifice || 0) / 100;
            const totalSac = Math.min(multiPct, 0.5);
            const prodPct  = 1 - totalSac;
            const produced = rate * prodPct * dt;
            body.spores = Math.min(body.maxSpores, (body.spores || 0) + produced);

            // Multiplicité
            if (totalSac > 0) {
                player._multiPool = (player._multiPool || 0) + rate * totalSac * dt;
            }
        }
    }
}

// ─── applyConquest (portée du client, UI neutralisée) ─────────
function applyConquest(state, body, jet) {
    if (jet._parasiteDrain) {
        if (jet._targetBody && jet._targetBody === body) {
            body.spores = Math.min(body.maxSpores, (body.spores || 0) + jet.spores);
        }
        return;
    }

    if (jet.sporeType === 'parasite') {
        if (body.owner !== null && body.owner !== jet.owner) {
            if (!body.parasite) {
                body.parasite = { ownerSlot: jet.owner, sourceBody: jet.source, _accumulator: 0 };
                body.droneCount = 0;
            }
        }
        return;
    }

    if (body.parasite && body.owner === jet.owner && jet.sporeType === 'normal') {
        body.droneCount = (body.droneCount || 0) + jet.spores;
        if (body.droneCount >= 500) { body.parasite = null; body.droneCount = 0; }
        return;
    }

    if (body.isMotherPlanet) {
        const _hasLunes  = body.moons && body.moons.length > 0;
        const _lunesOwned = !_hasLunes || body.moons.every(m => m.owner === body.owner);
        if (_lunesOwned) return;
    }

    if (body.owner !== null && body.owner !== jet.owner && _isAllied(jet.owner, body.owner, state.players)) {
        if (jet.sporeType === 'attaque')       body.sporesAttaque = Math.min(body.maxSpores,     (body.sporesAttaque || 0) + Math.floor(jet.spores));
        else if (jet.sporeType === 'defense')  body.sporesDefense = Math.min(body.maxSpores * 2, (body.sporesDefense || 0) + Math.floor(jet.spores * 5));
        else                                   body.spores        = Math.min(body.maxSpores,     (body.spores        || 0) + Math.floor(jet.spores));
        return;
    }

    const densityBonus = 1 + (state.players[jet.owner]?.stats?.density || 0) * 0.05;
    let attacking = jet.spores * densityBonus;

    if (body.owner === jet.owner) {
        if (jet.sporeType === 'attaque')       body.sporesAttaque = Math.min(body.maxSpores,     (body.sporesAttaque || 0) + Math.floor(jet.spores));
        else if (jet.sporeType === 'defense')  body.sporesDefense = Math.min(body.maxSpores * 2, (body.sporesDefense || 0) + Math.floor(jet.spores * 5));
        else if (body.spores < body.maxSpores) body.spores        = Math.min(body.maxSpores,      body.spores + Math.floor(Math.min(jet.spores, body.maxSpores - body.spores)));
        return;
    }

    if (jet.sporeType === 'attaque')      attacking *= 5;
    else if (jet.sporeType === 'defense') attacking  = 0;

    if (body.faune > 0) {
        const fauneDmg = Math.min(body.faune, attacking);
        body.faune  -= fauneDmg;
        attacking   -= fauneDmg;
    }

    const biomeDefense = 1 + (body.biomes || 0) * 0.05;
    attacking = attacking / biomeDefense;

    if (attacking > 0 && body.owner !== null && body.spores > 0) {
        const defenseDmg = Math.min(body.spores, attacking);
        body.spores  -= defenseDmg;
        attacking    -= defenseDmg;
    }

    if (attacking > 0 && body.spores <= 0) {
        const oldOwner = body.owner;
        if (oldOwner !== null && state.players[oldOwner]) {
            const arr = state.players[oldOwner].bodies;
            if (arr) { const idx = arr.indexOf(body); if (idx >= 0) arr.splice(idx, 1); }
        }
        body.owner       = jet.owner;
        body.spores      = attacking;
        body.faune       = 0;
        body.symbiosis   = 0;
        body.symOwnerTime = 0;
        body.buildMode   = 'off';
        const _conquSun  = body.type === 'planet' ? body.parent : (body.parent?.parent || null);
        if (_conquSun) _conquSun._sysCache = null;
        if (state.players[jet.owner]?.bodies) state.players[jet.owner].bodies.push(body);
    }
}

// ─── Constantes simulation ────────────────────────────────────
const COMET_CFG = { freq: 8, speed: 150, size: 8, tail: 80 };
const CLN_CFG = { speedMin: 67, speedMax: 120, turnInterval: 15, detectRange: 120, fireRate: 0.3, dmgMin: 34, dmgMax: 106 };

// ─── updateCleaners (portée du client, UI neutralisée) ────────
function updateCleaners(state, dt) {
    if (!state.cleaners || !state.cleaners.length) return;
    const bh = state.blackHole;

    for (const cl of state.cleaners) {
        cl.turnTimer -= dt;
        if (cl.turnTimer <= 0) {
            cl.turnTimer = CLN_CFG.turnInterval + state._gameRng() * 5;
            const speed = CLN_CFG.speedMin + state._gameRng() * (CLN_CFG.speedMax - CLN_CFG.speedMin);
            if (state._gameRng() < 0.7 && state.planets.length > 0) {
                const target = state.planets[Math.floor(state._gameRng() * state.planets.length)];
                cl._target = target;
                const tdx = target.x - cl.x, tdy = target.y - cl.y;
                const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
                if (tDist > 0) { cl.vx = (tdx / tDist) * speed; cl.vy = (tdy / tDist) * speed; }
            } else {
                cl._target = null;
                const wanderAngle = Math.atan2(cl.y, cl.x) + (state._gameRng() - 0.5) * 1.5;
                cl.vx = Math.cos(wanderAngle) * speed * 0.5;
                cl.vy = Math.sin(wanderAngle) * speed * 0.5;
            }
        }

        if (cl._target) {
            const tdx = cl._target.x - cl.x, tdy = cl._target.y - cl.y;
            const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
            if (tDist < 80) { cl.turnTimer = 0; }
            else if (tDist > 0) {
                const currentSpeed = Math.sqrt(cl.vx * cl.vx + cl.vy * cl.vy);
                cl.vx += (tdx / tDist) * 15 * dt;
                cl.vy += (tdy / tDist) * 15 * dt;
                const newSpeed = Math.sqrt(cl.vx * cl.vx + cl.vy * cl.vy);
                if (newSpeed > currentSpeed * 1.2) { cl.vx = (cl.vx / newSpeed) * currentSpeed; cl.vy = (cl.vy / newSpeed) * currentSpeed; }
            }
        }

        cl.x += cl.vx * dt;
        cl.y += cl.vy * dt;
        cl.angle = Math.atan2(cl.vy, cl.vx);

        // Repousser du trou noir
        const bhDx = cl.x - bh.x, bhDy = cl.y - bh.y;
        const bhDist = Math.sqrt(bhDx * bhDx + bhDy * bhDy);
        if (bhDist < bh.dangerZone * 2) { cl.vx += (bhDx / bhDist) * 30 * dt; cl.vy += (bhDy / bhDist) * 30 * dt; }

        // Garder dans la zone de jeu
        const maxRange = state.universeRadius || 6000;
        const distFromCenter = Math.sqrt(cl.x * cl.x + cl.y * cl.y);
        if (distFromCenter > maxRange) { cl.vx -= cl.x * 0.02; cl.vy -= cl.y * 0.02; }
        // Tirer sur les jets
        cl.fireTimer -= dt;
        if (cl.fireTimer <= 0) {
            cl.fireTimer = CLN_CFG.fireRate;
            for (const jet of state.jets) {
                if (!jet.alive) continue;
                const dx = jet.x - cl.x, dy = jet.y - cl.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < CLN_CFG.detectRange) {
                    if (cl.type === 'red') {
                        const damage = CLN_CFG.dmgMin + state._gameRng() * (CLN_CFG.dmgMax - CLN_CFG.dmgMin);
                        jet.spores -= damage;
                        if (jet.spores <= 0) jet.alive = false;
                        if (state._io && state._roomId) state._io.to(state._roomId).emit('cleaner_hit', { type: 'red', x: jet.x, y: jet.y, damage: Math.round(damage) });
                     } else if (cl.type === 'green') {
                        if (!jet._boosted) {
                            jet.spores = Math.floor(jet.spores * 2);
                            jet._boosted = true;
                            if (state._io && state._roomId) state._io.to(state._roomId).emit('cleaner_hit', { type: 'green', x: jet.x, y: jet.y });
                        }
                    } else if (cl.type === 'dark') {
                        if (!jet._darkHit) {
                            jet._darkHit = true;
                            // Inverser la trajectoire vers la source
                            const src = state.allBodies.find(b => b.name === jet.sourceName);
                            if (src) {
                                const rdx = src.x - jet.x, rdy = src.y - jet.y;
                                const rDist = Math.sqrt(rdx * rdx + rdy * rdy);
                                if (rDist > 0) {
                                    jet._targetBody = src;
                                    jet._parasiteDrain = true;
                                }
                            }
                            if (state._io && state._roomId) state._io.to(state._roomId).emit('cleaner_hit', { type: 'dark', x: jet.x, y: jet.y });
                        }
                    }
                    break;
                }
            }
        }
    }
}

// ─── updateComets (portée du client, UI neutralisée) ──────────
function updateComets(state, dt) {
    if (!state.comets) state.comets = [];
    if (state.cometTimer === undefined) state.cometTimer = COMET_CFG.freq;

    state.cometTimer -= dt;
    if (state.cometTimer <= 0) {
        state.cometTimer = COMET_CFG.freq * (0.7 + state._gameRng() * 0.6);
        const range      = (state.universeRadius || 6000) * 2;
        const angle      = state._gameRng() * Math.PI * 2;
        const startDist  = range * 0.8;
        const cx         = Math.cos(angle) * startDist;
        const cy         = Math.sin(angle) * startDist;
        const targetAngle = angle + Math.PI + (state._gameRng() - 0.5) * 1.2;
        const spd        = COMET_CFG.speed + state._gameRng() * COMET_CFG.speed * 0.5;
        state.comets.push({
            x: cx, y: cy,
            vx: Math.cos(targetAngle) * spd,
            vy: Math.sin(targetAngle) * spd,
            size: COMET_CFG.size * (0.6 + state._gameRng() * 0.8),
            tail: COMET_CFG.tail * (0.7 + state._gameRng() * 0.6),
            life: range * 2 / spd,
            age:  0,
        });
    }

    for (let i = state.comets.length - 1; i >= 0; i--) {
        const c = state.comets[i];
        c.age += dt;
        c.x   += c.vx * dt;
        c.y   += c.vy * dt;
        if (c.age >= c.life) { state.comets.splice(i, 1); continue; }

        for (const body of state.allBodies) {
            const dx = body.x - c.x;
            const dy = body.y - c.y;
            if (Math.sqrt(dx * dx + dy * dy) < body.radius + c.size) {
                if (!body.invincible) body.spores = 0;
                state.comets.splice(i, 1);
                break;
            }
        }
    }
}

// ─── updateJets (portée du client, UI neutralisée) ────────────
function updateJets(state, dt) {
    const jets = state.jets;

    for (let i = jets.length - 1; i >= 0; i--) {
        const jet = jets[i];
        if (!jet.alive) {
            jet._deadTick = (jet._deadTick || 0) + 1;
            if (jet._deadTick > 2) jets.splice(i, 1);
            continue;
        }

        jet.age += dt;

        if (jet._targetBody) {
            const tb  = jet._targetBody;
            const tdx = tb.x - jet.x;
            const tdy = tb.y - jet.y;
            const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
            if (tDist < tb.radius + 8) {
                jet.x = tb.x;
                jet.y = tb.y;
            } else {
                const moveSpeed = jet.speed * 0.70 * dt;
                jet.x += (tdx / tDist) * moveSpeed;
                jet.y += (tdy / tDist) * moveSpeed;
            }
        } else {
            jet.posIndex += jet.speed * dt * 0.70;
            const idx = Math.floor(jet.posIndex);
            if (idx >= jet.trajectory.length - 1) { jet.alive = false; continue; }
            const pt = jet.trajectory[idx];
            jet.x = pt.x;
            jet.y = pt.y;
        }

        // Tête chercheuse (homing)
        const _hp = state.players[jet.owner];
        const _hl = _hp?.tech?.homing || 0;
        if (_hl > 0 && !jet._targetBody) {
            const hRange = 80 + _hl * 30;
            const hForce = 0.02 + _hl * 0.01;
            let hBest = null, hDist = hRange;
            for (const b of state.allBodies) {
                if (b.owner === jet.owner || b === jet.source) continue;
                const hdx = b.x - jet.x, hdy = b.y - jet.y;
                const hd  = Math.sqrt(hdx * hdx + hdy * hdy);
                if (hd < hDist) { hDist = hd; hBest = b; }
            }
            if (hBest) {
                const i2 = Math.floor(jet.posIndex);
                for (let ti = i2; ti < jet.trajectory.length; ti++) {
                    const tp = jet.trajectory[ti];
                    const tx = hBest.x - tp.x, ty = hBest.y - tp.y;
                    const td = Math.sqrt(tx * tx + ty * ty);
                    if (td > 1) {
                        const f = Math.max(0, 1 - (ti - i2) / 60);
                        tp.x += tx / td * hForce * f * jet.speed * 0.3;
                        tp.y += ty / td * hForce * f * jet.speed * 0.3;
                    }
                }
            }
        }

// Traversée amas de météorites
        if (!jet._hitBelt) jet._hitBelt = {};
        for (let bi = 0; bi < state.asteroidBelts.length; bi++) {
            if (jet._hitBelt[bi]) continue;
            const belt = state.asteroidBelts[bi];
            const sun  = belt.sun || state.suns[belt.sunIndex] || null;
            if (!sun) continue;
            let closestDist = Infinity;
            let closestType = null;
            for (const rock of belt.rocks) {
                const rr  = belt.radius + rock.radiusOff;
                const rcx = sun.x + Math.cos(rock.angle) * rr;
                const rcy = sun.y + Math.sin(rock.angle) * rr;
                const rd  = (jet.x - rcx) ** 2 + (jet.y - rcy) ** 2;
                if (rd < closestDist) { closestDist = rd; closestType = rock.type; }
            }
            if (closestDist > 1600) continue;
            jet._hitBelt[bi] = true;
            if (closestType === 'dark') {
                const _tl1 = state.players[jet.owner]?.tech?.tenacity || 0;
                jet.spores = Math.max(1, Math.floor(jet.spores * (0.5 + _tl1 * 0.05)));
            } else if (closestType === 'red') {
                const devAngle = (5 + state._gameRng() * 10) * Math.PI / 180;
                const sign     = state._gameRng() > 0.5 ? 1 : -1;
                const cos      = Math.cos(devAngle * sign);
                const sin      = Math.sin(devAngle * sign);
                for (const pt of jet.trajectory) {
                    const rx = pt.x - jet.x, ry = pt.y - jet.y;
                    pt.x = jet.x + rx * cos - ry * sin;
                    pt.y = jet.y + rx * sin + ry * cos;
                }
            }
        }

// Collision avec les corps (ignorer la source pendant les 0.5 premières secondes)
        for (const body of state.allBodies) {
            if (jet.age < 0.5 && jet.sourceName && body.name === jet.sourceName) continue;
            const dx   = jet.x - body.x;
            const dy   = jet.y - body.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < body.radius + 6) {
                jet.alive = false;
                applyConquest(state, body, jet);
                break;
            }
        }
    }
}
// ─── Tech ────────────────────────────────────────────────────
function getTechCost(player, branch) {
    const tech = player.tech; const lvl = tech[branch];
    if (lvl >= 10) return Infinity;
    let order = tech._branchOrder.indexOf(branch);
    if (order === -1) order = tech._branchOrder.length;
    const baseCost      = [1000, 2000, 3000][Math.min(order, 2)];
    const increment     = [100,  200,  300 ][Math.min(order, 2)];
    return baseCost + lvl * increment;
}

function buyTech(player, branch) {
    const cost = getTechCost(player, branch);
    if (player.totalSpores < cost || player.tech[branch] >= 10) return false;
    let toDeduct = cost;
    const bodies = player.bodies.slice().sort((a, b) => b.spores - a.spores);
    for (const body of bodies) {
        const take = Math.min(body.spores, toDeduct);
        body.spores  -= take;
        toDeduct     -= take;
        if (toDeduct <= 0) break;
    }
    if (toDeduct > 0) return false;
    if (player.tech[branch] === 0 && !player.tech._branchOrder.includes(branch))
        player.tech._branchOrder.push(branch);
    player.tech[branch]++;
    return true;
}

// ─── Trajectoire (portée du client) ──────────────────────────
function computeTrajectory(state, startX, startY, dirX, dirY, speed) {
    const bh     = state.blackHole;
    const points = [];
    let x = startX, y = startY;
    let vx = dirX * speed, vy = dirY * speed;
    const dt = 0.4;
    const steps = 200;

    for (let i = 0; i < steps; i++) {
        const dx   = bh.x - x, dy = bh.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < (bh.dangerZone || 300) * 0.4) break;

        const gRange = bh.gravityRange || 1500;
        if (dist < gRange) {
            const G        = bh.gravityStrength || 500;
            const edgeFade = 1 - Math.pow(dist / gRange, 2);
            const factor   = (G / (dist + 50)) * edgeFade * dt;
            vx += (dx / dist) * factor;
            vy += (dy / dist) * factor;
        }

        for (const sun of state.suns) {
            const sdx   = sun.x - x, sdy = sun.y - y;
            const sdist = Math.sqrt(sdx * sdx + sdy * sdy);
            const sRange = sun.radius * 8;
            if (sdist < sRange && sdist > sun.radius + 5) {
                const sG       = sun.radius * 2;
                const sEdge    = 1 - Math.pow(sdist / sRange, 2);
                const sGravity = sG / (sdist + 30) * sEdge;
                vx += (sdx / sdist) * sGravity * dt;
                vy += (sdy / sdist) * sGravity * dt;
            }
        }

        x += vx * dt;
        y += vy * dt;
        points.push({ x, y });
    }
    return points;
}

// ─── launchJet (version serveur, sans sons ni sparkles) ───────
let _jetIdCounter = 0;
function launchJet(state, source, dirX, dirY, sporeType) {
    sporeType = sporeType || 'normal';
    const player = state.players[source.owner];
    if (!player) return;

    let sporeCount;
    if (sporeType === 'parasite') {
        if ((source.parasiteSpore || 0) < 1) return;
        source.parasiteSpore = 0;
        sporeCount = 1;
    } else if (sporeType === 'attaque') {
        sporeCount = Math.floor((source.sporesAttaque || 0) * (state.jetRatio || 0.5));
        if (sporeCount < 5) return;
        source.sporesAttaque -= sporeCount;
    } else if (sporeType === 'defense') {
        sporeCount = Math.floor((source.sporesDefense || 0) * (state.jetRatio || 0.5));
        if (sporeCount < 5) return;
        source.sporesDefense -= sporeCount;
    } else {
        sporeCount = Math.floor(source.spores * (state.jetRatio || 0.5));
        if (sporeCount < 5) return;
        source.spores -= sporeCount;
    }

    const speed = 20 + player.stats.velocity * 6;
    const traj  = computeTrajectory(state, source.x, source.y, dirX, dirY, speed);
    const jetColor = sporeType === 'attaque' ? '#EF4444'
                   : sporeType === 'defense' ? '#38BDF8'
                   : sporeType === 'parasite' ? '#22C55E'
                   : player.color;

    state.jets.push({
        id:         ++_jetIdCounter,
        owner:      source.owner,
        color:      jetColor,
        spores:     sporeCount,
        sporeType:  sporeType,
        trajectory: traj,
        posIndex:   0,
        x:          source.x,
        y:          source.y,
        speed,
        alive:      true,
        trail:      [],
        age:        0,
        source,
        sourceName: source.name,
        _hitBelt:   {},
    });
}

// ─── updateAI (portée du client) ─────────────────────────────
function updateAI(state, dt) {
    const difficulty = state.config?.difficulty || 'normal';

    for (const player of state.players) {
        if (player.isHuman || !player.alive) continue;
        if (!player.bodies || player.bodies.length === 0) continue;

        if (player.multiSacrifice === 0 && player.multiTier < 10) {
            player.multiSacrifice = 15 + Math.floor(state._gameRng() * 20);
        }
        if (player.totalSpores > 2000 && state._gameRng() < 0.03) {
            const _br = ['homing', 'tenacity', 'mimicry'][Math.floor(state._gameRng() * 3)];
            if (player.tech[_br] < 10) buyTech(player, _br);
        }

        for (const body of player.bodies) {
            if (body.buildMode === 'off' && body.spores > body.maxSpores * 0.7) {
                body.buildMode = player.bodies.length < 4 ? 'nid' : (state._gameRng() > 0.5 ? 'nid' : 'biome');
            }
        }

        player.aiTimer -= dt;
        if (player.aiTimer > 0) continue;
        player.aiTimer = player.aiCooldown + state._gameRng() * player.aiCooldown * 0.5;

        if (difficulty === 'easy')        aiActionEasy(state, player);
        else if (difficulty === 'normal') aiActionNormal(state, player);
        else                              aiActionBrutal(state, player);
    }
}

function aiActionEasy(state, player) {
    const sources = player.bodies.filter(b => b.spores > 20);
    if (!sources.length) return;
    const source  = sources[Math.floor(state._gameRng() * sources.length)];
    const targets = state.allBodies.filter(b => b.owner !== player.id && b.type !== 'sun');
    if (!targets.length) return;
    const target  = targets[Math.floor(state._gameRng() * targets.length)];
    aiLaunchAt(state, source, target, player);
}

function aiActionNormal(state, player) {
    const sources = player.bodies.filter(b => b.spores > 30);
    if (!sources.length) return;
    const targets = state.allBodies.filter(b => b.owner !== player.id && b.type !== 'sun');
    if (!targets.length) return;

    let bestTarget = null, bestScore = -Infinity;
    for (const target of targets) {
        let minDist = Infinity;
        for (const src of sources) {
            const dx = target.x - src.x, dy = target.y - src.y;
            minDist  = Math.min(minDist, Math.sqrt(dx * dx + dy * dy));
        }
        const score = (target.flore || 0) * 2 - (target.faune || 0) - minDist * 0.05 + (target.owner === null ? 50 : 0);
        if (score > bestScore) { bestScore = score; bestTarget = target; }
    }
    if (!bestTarget) return;

    let bestSource = sources[0], bestDist = Infinity;
    for (const src of sources) {
        const dx = bestTarget.x - src.x, dy = bestTarget.y - src.y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; bestSource = src; }
    }
    aiLaunchAt(state, bestSource, bestTarget, player);
}

function aiActionBrutal(state, player) {
    const sources = player.bodies.filter(b => b.spores > 25);
    if (!sources.length) return;
    const targets = state.allBodies.filter(b => b.owner !== player.id && b.type !== 'sun');
    if (!targets.length) return;

    let bestTarget = null, bestScore = -Infinity;
    for (const target of targets) {
        let minDist = Infinity;
        for (const src of sources) {
            const dx = target.x - src.x, dy = target.y - src.y;
            minDist  = Math.min(minDist, Math.sqrt(dx * dx + dy * dy));
        }
        const humanBonus = (target.owner !== null && state.players[target.owner]?.isHuman) ? 60 : 0;
        const score = (target.flore || 0) * 3 - (target.faune || 0) * 0.5 - minDist * 0.03
                    + (target.owner === null ? 40 : 20) - (target.spores || 0) * 0.3 + humanBonus;
        if (score > bestScore) { bestScore = score; bestTarget = target; }
    }
    if (!bestTarget) return;

    const attackSources = sources
        .map(src => {
            const dx = bestTarget.x - src.x, dy = bestTarget.y - src.y;
            return { src, dist: Math.sqrt(dx * dx + dy * dy) };
        })
        .filter(e => e.dist < 1500)
        .sort((a, b) => a.dist - b.dist);

    const count = Math.min(attackSources.length, 1 + Math.floor(state._gameRng() * 3));
    for (let i = 0; i < count; i++) {
        if (attackSources[i].src.spores < 40) continue;
        aiLaunchAt(state, attackSources[i].src, bestTarget, player);
    }
}

function aiLaunchAt(state, source, target, player) {
    const dx   = target.x - source.x, dy = target.y - source.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const speed      = 20 + player.stats.velocity * 6;
    const travelTime = dist / speed * 0.4;
    const difficulty = state.config?.difficulty || 'normal';

    let futureX = target.x, futureY = target.y;
    if (difficulty !== 'easy' && target.parent) {
        const futureAngle = target.angle + target.orbitSpeed * travelTime;
        futureX = target.parent.x + Math.cos(futureAngle) * target.orbitRadius;
        futureY = target.parent.y + Math.sin(futureAngle) * target.orbitRadius;

        if (difficulty === 'brutal' && target.parent.parent) {
            const pfa = target.parent.angle + target.parent.orbitSpeed * travelTime;
            const pfx = target.parent.parent.x + Math.cos(pfa) * target.parent.orbitRadius;
            const pfy = target.parent.parent.y + Math.sin(pfa) * target.parent.orbitRadius;
            futureX   = pfx + Math.cos(futureAngle) * target.orbitRadius;
            futureY   = pfy + Math.sin(futureAngle) * target.orbitRadius;
        } else if (difficulty === 'brutal' && target.parent.orbitRadius) {
            const sfa = target.parent.angle + target.parent.orbitSpeed * travelTime;
            futureX   = Math.cos(sfa) * target.parent.orbitRadius + Math.cos(futureAngle) * target.orbitRadius;
            futureY   = Math.sin(sfa) * target.parent.orbitRadius + Math.sin(futureAngle) * target.orbitRadius;
        }
    }

    const aimDx = futureX - source.x, aimDy = futureY - source.y;
    const aimLen = Math.sqrt(aimDx * aimDx + aimDy * aimDy);
    if (aimLen < 5) return;
    launchJet(state, source, aimDx / aimLen, aimDy / aimLen);
}

module.exports = { GameLoop, updateOrbits, updateSporeGeneration, updateJets, applyConquest, updateAI, _buildState };
