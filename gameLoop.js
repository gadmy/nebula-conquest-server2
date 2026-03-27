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
        updateSporeGeneration(this.state, dt);
        updateJets(this.state, dt);
        // TODO étapes suivantes : updateComets, updateAI

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

// ─── updateJets (portée du client, UI neutralisée) ────────────
function updateJets(state, dt) {
    const jets = state.jets;

    for (let i = jets.length - 1; i >= 0; i--) {
        const jet = jets[i];
        if (!jet.alive) { jets.splice(i, 1); continue; }

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
            const sun  = belt.sun;
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

        // Collision avec les corps
        for (const body of state.allBodies) {
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

module.exports = { GameLoop, updateOrbits, updateSporeGeneration, updateJets, applyConquest, _buildState };
