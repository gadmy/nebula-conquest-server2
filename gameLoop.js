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
            /* Anti-triche : le joueur doit posseder l'astre, ou au moins y
               tenir du terrain - un astre a moitie conquis peut envoyer des
               spores ailleurs depuis le pied-a-terre qu'on y a. */
            const player = state.players.find(p => p.socketId === socketId);
            if (!player) return;
            const _chezLui = (src.owner === player.id);
            if (!_chezLui && !(src.lutte && zonesDe(src, player.id).length)) return;
            /* Si le joueur etait en visee, c'est le lanceur choisi par le
               serveur qui tire, pas l'astre nomme par le client. */
            let tireur = src;
            const vis = player._visee;
            if (vis && vis.lanceur && vis.lanceur.owner === player.id &&
                _groupeTir(vis.src).indexOf(vis.lanceur) >= 0) {
                tireur = vis.lanceur;
            }
            player._visee = null;
            const prevCount = state.jets.length;
            launchJet(state, tireur, ev.dirX, ev.dirY, ev.sporeType || 'normal', player.id, ev.zx, ev.zy);
            // Notifier tous les clients pour qu'ils animent le jet localement
            if (state.jets.length > prevCount) {
                const jet = state.jets[state.jets.length - 1];
this.io.to(this.roomId).emit('jet_fired', {
                    srcName:    tireur.name,
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

/* VISEE. Le chargement se joue pendant que le joueur vise, donc le serveur
   doit savoir ou il vise. Le client envoie sa cible de temps en temps ; c'est
   le serveur qui en deduit l'astre le plus proche et qui deplace les spores.
   Le client n'annonce jamais lui-meme quel astre tire ni combien il a charge :
   il n'y a rien a falsifier. */
if (ev.type === 'aim') {
            const player = state.players.find(p => p.socketId === socketId);
            if (!player) return;
            const src = state.planets.find(p => p.name === ev.srcName)
                     || state.moons.find(m => m.name === ev.srcName);
            if (!src || src.owner !== player.id) { player._visee = null; return; }
            if (!player._visee || player._visee.src !== src) {
                player._visee = { src: src, tx: ev.tx, ty: ev.ty, lanceur: null, acc: 0 };
            } else {
                player._visee.tx = ev.tx;
                player._visee.ty = ev.ty;
            }
        }

if (ev.type === 'jet_surface') {
            /* Tir a la surface d'un astre. Le client n'annonce que la cible :
               le serveur verifie qu'il a bien du terrain la-bas, choisit le
               point de depart et calcule la cloche lui-meme. */
            const player = state.players.find(p => p.socketId === socketId);
            if (!player) return;
            const body = state.planets.find(p => p.name === ev.srcName)
                      || state.moons.find(m => m.name === ev.srcName);
            if (!body) return;
            const tx = +ev.tx, ty = +ev.ty;
            if (!isFinite(tx) || !isFinite(ty)) return;
            lancerJetSurface(state, body, player.id, tx, ty, ev.zx, ev.zy);
            return;
        }

if (ev.type === 'riposte') {
            const player = state.players.find(p => p.socketId === socketId);
            if (player) riposteGenerale(state, player.id,
                typeof ev.bodyName === 'string' ? ev.bodyName : null);
            return;
        }

if (ev.type === 'aim_end') {
            const player = state.players.find(p => p.socketId === socketId);
            if (player) player._visee = null;
        }

if (ev.type === 'spawn') {
            /* Le slot etait celui annonce par le client. N'importe qui pouvait
               donc apparaitre a la place d'un autre, et rien ne verifiait que
               l'astre vise etait libre : il suffisait d'envoyer cette action
               pour s'emparer instantanement de la planete de son choix, meme
               tenue par un adversaire, a n'importe quel moment de la partie.
               Le slot vient maintenant du socket, et l'astre doit etre libre
               et etre le premier du joueur. */
            const player = state.players.find(p => p.socketId === socketId);
            if (!player) return;
            if (player.spawnPlanet) return;              /* deja apparu */
            const body = state.planets.find(p => p.name === ev.bodyName)
                      || state.moons.find(m => m.name === ev.bodyName);
            if (!body) return;
            if (body.owner !== null && body.owner !== undefined) return;
            body.owner  = player.id;
            body.spores = body.maxSpores * 0.5;
            player.bodies = [body];
            player.spawnPlanet = body;
        }

/* Part des spores envoyees a chaque tir. Elle etait reglee par un curseur
   cote client qui n'etait jamais transmis : le serveur tirait toujours 50 %
   tandis que le menu du joueur annonçait la valeur de son curseur. Elle
   devient aussi une valeur PAR JOUEUR - le serveur n'en gardait qu'une seule
   pour toute la partie, ce qui n'a pas de sens a plusieurs. */
if (ev.type === 'set_jet_ratio') {
            const player = state.players.find(p => p.socketId === socketId);
            if (!player) return;
            const v = Number(ev.value);
            player.jetRatio = isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
        }

if (ev.type === 'set_sacrifice') {
            const player = state.players.find(p => p.socketId === socketId);
            /* La valeur n'etait pas bornee. La production est multipliee par
               1 - min(valeur / 100, 0,5) : une valeur NEGATIVE rendait donc ce
               facteur superieur a 1. Un sacrifice de -900 multipliait la
               production par dix. */
            if (player) {
                const v = Number(ev.value);
                player.multiSacrifice = (isFinite(v)) ? Math.max(0, Math.min(100, v)) : 0;
            }
        }

if (ev.type === 'set_conquest_buildings') {
            /* Conserve pour les clients d'avant : les batiments survivent
               desormais toujours a la conquete, le reglage n'a plus d'effet. */
            const player = state.players.find(p => p.socketId === socketId);
            if (player) player.conquestKeepBuildings = ev.value;
        }

        if (ev.type === 'spawn_done') {
            const slot = ev.slot !== undefined ? ev.slot : state.players.findIndex(p => p.socketId === socketId);
            if (slot >= 0 && state.players[slot]) state.players[slot]._spawnDone = true;
            const humanPlayers = state.players.filter(p => p.isHuman);
            const allDone = humanPlayers.every(p => p._spawnDone);
            if (allDone) this.io.to(this.roomId).emit('all_spawned');
        }
if (ev.type === 'multi') {
            const player = state.players.find(p => p.socketId === socketId);
            if (!player) return;
            /* Il manquait la seule verification qui compte : que le joueur
               ait vraiment atteint un palier. Sans elle, repeter cette action
               donnait un point de statistique a chaque envoi - trois
               statistiques au maximum en quelques secondes, gratuitement. */
            if (!player._multiPendingTier) return;
            const stat = ev.stat;
            if (['growth', 'velocity', 'density', 'sensitivity'].includes(stat)) {
                if ((player.stats[stat] || 0) < 8) {
                    player.stats[stat] = (player.stats[stat] || 0) + 1;
                }
                player.multiTier = (player.multiTier || 0) + 1;
                player.multiProgress = 0;
                player._multiPendingTier = false;
            }
        }

            if (ev.type === 'build_mode') {
            const body = state.planets.find(p => p.name === ev.bodyName)
                      || state.moons.find(m => m.name === ev.bodyName);
            const player = state.players.find(p => p.socketId === socketId);
            /* On batit chez soi, mais aussi sur le bout de sol qu'on tient
               chez l'autre : une tete de pont est un territoire comme un
               autre. Le serveur verifie donc l'un ou l'autre. */
            const _chez = body && player && Number(body.owner) === Number(player.id);
            const _pied = body && player && body.lutte && zonesDe(body, player.id).length > 0;
            if (_chez || _pied) {
                body.buildMode = ev.mode || 'off';
                body.buildSlot = player.id;
                body.buildProgress = 0;
            }
        }
    }

    _step(dt) {
        if (!this.state) return;
        this._tick++;
        this.state.time += dt;
        updateOrbits(this.state, dt);
        updateSporeGeneration(this.state, dt);
        updateJets(this.state, dt);
        majLuttes(this.state, dt);
        majOndesSolaires(this.state, dt);
        updateComets(this.state, dt);
        updateCleaners(this.state, dt);
        majChargementTir(this.state, dt);
        if (this._tick % 2 === 0) updateAI(this.state, 50 / 1000);

     // Snapshot toutes les 2 ticks = 100ms
        if (this._tick % 2 === 0) {
            this.io.to(this.roomId).emit('game_snapshot', _buildSnapshot(this.state));
        }

     // Vérification fin de partie toutes les 20 ticks = 1s (pas avant 30s)
        if (this._tick % 20 === 0 && !this.state._gameOver && this.state.time >= 30) {
            _checkVictory(this.state, this.io, this.roomId);
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
            name:             p.name,
            owner:            p.owner,
            spores:           Math.round((p.spores        || 0) * 10) / 10,
            symbiosis:        Math.round(p.symbiosis     || 0),
            nids:             p.nids    || 0,
            biomes:           p.biomes  || 0,
            alveoles:         p.alveoles || 0,
            buildMode:        p.buildMode || 'off',
            parasiteSpore:    p.parasiteSpore || 0,
            parasiteProgress: Math.round((p.parasiteProgress || 0) * 10) / 10,
            baseMaxSpores:    p.baseMaxSpores || p.maxSpores,
            maxSpores:        Math.round(p.maxSpores || 0),
            parasite:         p.parasite ? { ownerSlot: p.parasite.ownerSlot, sourceName: p.parasite.sourceBody?.name || p.parasite.sourceName } : null,
            lu:               _resumeLutte(p),
        })),
            moons: state.moons.map(m => ({
            name:      m.name,
            owner:     m.owner,
            spores:    Math.round(m.spores || 0),
            buildMode: m.buildMode || 'off',
            nids:      m.nids     || 0,
            biomes:    m.biomes   || 0,
            alveoles:  m.alveoles || 0,
            lu:        _resumeLutte(m),
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
            id:           p.id,
            alive:        p.alive,
            totalSpores:  Math.round(p.totalSpores || 0),
            multiProgress: Math.round(p.multiProgress || 0),
            multiTier:    p.multiTier || 0,
            stats:        p.stats,
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
/* Effet des batiments : un seul endroit ou les regler, en miroir du client.
   Les deux doivent rester identiques, sinon solo et multijoueur ne calculent
   plus la meme chose. */
/* Rendements decroissants, les memes pour les trois genres : le premier
   batiment rapporte 20 %, le deuxieme 15 %, le troisieme 10 %, et chacun des
   suivants 5 %. A partir du quatrieme, le cout monte de 10 % a chaque fois.
   Ces regles doivent rester identiques a celles du client, sinon solo et
   multijoueur ne calculent plus la meme chose. */
const PALIERS_BATIMENT = [0.20, 0.15, 0.10];
const PALIER_SUIVANT   = 0.05;
const COUT_BATIMENT    = { alveole: 0.10, nid: 0.15, biome: 0.20 };
const COUT_MAJORATION  = 1.10;

/* Le nid est une fois et demie plus fort que les deux autres, a cout egal.
   Doit rester identique au client. */
const FORCE_GENRE = { alveole: 1, nid: 1.5, biome: 1 };

function bonusBatiment(n, genre) {
    if (!(n > 0)) return 0;
    let t = 0;
    for (let i = 0; i < PALIERS_BATIMENT.length && i < n; i++) t += PALIERS_BATIMENT[i];
    if (n > PALIERS_BATIMENT.length) t += (n - PALIERS_BATIMENT.length) * PALIER_SUIVANT;
    return t * (FORCE_GENRE[genre] || 1);
}

function nbBatiment(body, mode) {
    if (mode === 'alveole') return body.alveoles || 0;
    if (mode === 'nid')     return body.nids || 0;
    if (mode === 'biome')   return body.biomes || 0;
    return 0;
}

function coutBatiment(body, mode) {
    const pctc = COUT_BATIMENT[mode];
    if (!pctc) return 0;
    const base = (body.baseMaxSpores || body.maxSpores) * pctc;
    const rang = nbBatiment(body, mode) + 1;
    const majo = rang > PALIERS_BATIMENT.length
               ? Math.pow(COUT_MAJORATION, rang - PALIERS_BATIMENT.length)
               : 1;
    return Math.floor(base * majo);
}

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

        /* Astre en pleine bataille de surface : c'est majLutte qui repartit
           sa production entre les camps, au prorata du terrain tenu. */
        if (body.lutte) continue;

        if (body.flore <= 0) continue;
        const player = state.players[body.owner];
        if (!player) continue;

        const symBonusMax = body.type === 'planet' ? 0.20 : 0.10;
        const symBonus = 1 + (body.symbiosis / 100) * symBonusMax;
        const nidBonus = 1 + bonusBatiment(body.nids || 0, 'nid');
        /* Le maximum de base doit toujours exister avant d'appliquer les
           alveoles, sinon le maximum deja augmente sert de base et se
           multiplie a nouveau a chaque image. On le reconstitue a partir du
           maximum courant, ce qui rend le calcul idempotent. */
        if (body.baseMaxSpores === undefined || body.baseMaxSpores === null) {
            body.baseMaxSpores = Math.round(body.maxSpores / (1 + bonusBatiment(body.alveoles || 0, 'alveole')));
        }
        const _alvMax = Math.floor(body.baseMaxSpores * (1 + bonusBatiment(body.alveoles || 0, 'alveole')));
        if (body.maxSpores !== _alvMax) body.maxSpores = _alvMax;

        let sysBonus = 1;
        const bodySun = body.type === 'planet' ? body.parent : (body.parent?.parent || null);
        if (bodySun && isSystemComplete(bodySun, body.owner)) sysBonus = 1.03;

        /* Rendement maximal a mi-capacite : un astre presque vide ou plein
           produit peu. C'est la courbe de croissance. */
        const rate = Math.max(1, body.maxSpores) * TAUX_PROD
                   * (0.4 + (body.flore / 100) * 0.6) * (1 + player.stats.growth * 0.3)
                   * symBonus * nidBonus * sysBonus
                   * courbeCroissance(body.spores / Math.max(1, body.maxSpores));

        if (body.buildMode === 'parasite') {
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
// ── Drain parasite ──
        if (body.parasite) {
            const srcBody = body.parasite.sourceBody;
            if (!srcBody || srcBody.owner !== body.parasite.ownerSlot) {
                body.parasite = null;
            } else {
                const rawDrain = rate * 0.20;
                const drainPerSec = rate >= 10 ? Math.max(1, Math.round(rawDrain)) : rawDrain;
                const drain = drainPerSec * dt;
                body.spores = Math.max(0, (body.spores || 0) - drain);
                body.parasite._accumulator = (body.parasite._accumulator || 0) + drain;
                if (body.parasite._accumulator >= 10) {
                    const dx = srcBody.x - body.x, dy = srcBody.y - body.y;
                    const len = Math.sqrt(dx*dx + dy*dy);
                    if (len > 0) {
                        state.jets.push({
                            id: ++_jetIdCounter,
                            owner: body.parasite.ownerSlot,
                            color: '#22C55E',
                            spores: Math.round(body.parasite._accumulator),
                            sporeType: 'parasite_drain',
                            trajectory: computeTrajectory(state, body.x, body.y, dx/len, dy/len, 25),
                            posIndex: 0, x: body.x, y: body.y, speed: 25,
                            alive: true, trail: [], age: 0,
                            source: body, sourceName: body.name,
                            _hitBelt: {}, _parasiteDrain: true, _targetBody: srcBody
                        });
                        body.parasite._accumulator = 0;
                    }
                }
            }
        }

        } else {
            const multiPct = (player.multiSacrifice || 0) / 100;
            const totalSac = Math.min(multiPct, 0.5);
            const prodPct  = 1 - totalSac;
            const produced = rate * prodPct * dt;
            body.spores = Math.min(body.maxSpores, (body.spores || 0) + produced);

            /* La construction vient APRES la production, et ne l'interrompt
               plus. Tant que l'astre n'a pas de quoi payer, il continue a
               produire et le chantier attend. Auparavant la construction
               court-circuitait la production : un astre qui n'avait pas les
               spores restait fige pour toujours, puisqu'il ne pouvait plus en
               produire pour se les offrir. */
            if (body.buildMode === 'nid' || body.buildMode === 'biome' || body.buildMode === 'alveole') {
                const _buildType = body.buildMode;
                const _buildCost = coutBatiment(body, _buildType);
                if (body.spores >= _buildCost) {
                    body.spores -= _buildCost;
                    body.buildProgress = 0;
                    body.buildMode = 'off';
                    if (_buildType === 'alveole') body.baseMaxSpores = body.baseMaxSpores || body.maxSpores;
                    poserEdifice(state, body, _buildType, 0);
                    const _sg = { nid: ['🏗️', 'Nid construit', body.nids],
                                  alveole: ['🍯', 'Alvéole construite', body.alveoles],
                                  biome: ['🛡️', 'Biome construit', body.biomes] }[_buildType];
                    const _evIcon = _sg[0], _evMsg = `${_sg[1]} sur ${body.name} (×${_sg[2]})`;
                    if (bodySun) bodySun._sysCache = null;
                    if (state._io && state._roomId) state._io.to(state._roomId).emit('build_complete', { slot: body.owner, icon: _evIcon, msg: _evMsg, bodyName: body.name });
                }
            }

            // Multiplicité
            if (totalSac > 0 && player.multiTier < 10 && !player._multiPendingTier) {
                player.multiProgress = (player.multiProgress || 0) + rate * totalSac * dt;
                const tierCost = (player.multiTier + 1) * 100;
                if (player.multiProgress >= tierCost) {
                    player.multiProgress = 0;
                    player._multiPendingTier = true;
                    if (state._io && state._roomId) {
                        state._io.to(state._roomId).emit('multi_pending', { slot: player.id });
                    }
                }
            }
        }
    }
}

// ─── applyConquest (portée du client, UI neutralisée) ─────────

/* ─────────────────────────────────────────────
   BATAILLE DE SURFACE (portee du client, mot pour mot pour la simulation)
   Les spores qui touchent un astre ennemi ou neutre y prennent pied et
   s'etalent case par case sur une petite grille posee sur le disque. Ce que
   tient un camp lui donne sa part de la production de l'astre et sa pression
   - ses spores rapportees a sa surface -, et c'est la pression qui fait
   avancer le front. A pression egale seule l'usure decide, et comme les deux
   camps y perdent autant, le vainqueur garde la difference, exactement comme
   dans l'ancien choc instantane.
   Le serveur ne dessine rien : il ne transmet que les comptes de cases et
   les stocks, le client peint sa tache lui-meme.
   ───────────────────────────────────────────── */
const LUTTE_N = 32;
const LUTTE_PAS = 0.2;
const LUTTE_VIDE = 255;
const LUTTE_CADENCE = 30;      /* cases prises par seconde */
const LUTTE_MAJORITE = 0.5;    /* part etrangere au-dela de laquelle l'astre sort du groupement */

/* LE PRIX DU SOL. La planete entiere vaut sa capacite en spores : une case
   coute donc la capacite divisee par le nombre de cases. Attaquer avec X
   spores rapporte X cases-equivalentes - il n'est plus besoin d'avoir plus de
   troupes que l'adversaire. On pousse tant qu'on a de quoi payer, puis le
   front s'arrete et les deux camps se remettent a produire. */
function coutCase(body, total) {
    return Math.max(1, (body.maxSpores || 1) / Math.max(1, total));
}

/* LE RENDEMENT DE BASE, en part de la CAPACITE par seconde. C'etait un
   nombre fixe de spores, 2,5, sans rapport avec la taille de l'astre : une
   geante de vingt mille mettait des heures a se remplir au meme rythme qu'une
   lune de quatre cents, et tout le monde stagnait faute de pouvoir accumuler
   de quoi relancer une attaque. En part de capacite, un astre se remplit dans
   un temps qui ne depend plus de sa taille : vingt-cinq pour cent en une
   minute et demie, le grand pic de la courbe en moins de quatre minutes.
   Consequence heureuse : une alveole, qui agrandit le plafond, augmente
   desormais aussi la production - un plus grand silo nourrit plus de monde. */
const TAUX_PROD = 0.006;

/* COURBE DE PRODUCTION. Deux regimes plutot qu'un seul sommet : une bosse
   modeste au quart de la capacite, un creux a mi-chemin, un PIC franc aux
   sept dixiemes, puis l'extinction quand la zone sature - une population qui
   n'a plus de place ne se reproduit plus. Il y a donc deux rendements a
   connaitre : le petit, precoce et facile a tenir, et le gros, qui demande de
   rester juste sous le plafond au risque qu'un renfort vous y pousse et vous
   coupe tout. Le creux central, lui, punit qui reste a moitie plein.

   La courbe multiplie le reste - flore, growth, symbiose, nids, systeme
   complet, sacrifice - qui continuent donc de compter exactement pareil.
   Le pic vaut 1 : la valeur de crete est divisee pour cela. */
function courbeCroissance(part) {
    if (!(part > 0)) part = 0;
    if (part >= 1) return 0;
    const a = (part - 0.25) / 0.13;
    const b = (part - 0.70) / 0.10;
    return (0.20 + 0.32 * Math.exp(-a * a) + 0.80 * Math.exp(-b * b))
           * (1 - Math.pow(part, 8)) / 0.9437;
}

let _lutteMasque = null, _lutteVoisins = null, _lutteVoisins8 = null;
const _lutteCompte = new Int16Array(34);
const _lutteCandidats = [];

function _luttePrepare() {
    if (_lutteMasque) return;
    const N = LUTTE_N, c = (N - 1) / 2, r = N / 2 - 0.15;
    _lutteMasque = new Uint8Array(N * N);
    _lutteVoisins = new Int16Array(N * N * 4);
    _lutteVoisins8 = new Int16Array(N * N * 8);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const dx = x - c, dy = y - c;
        _lutteMasque[y * N + x] = (dx * dx + dy * dy <= r * r) ? 1 : 0;
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const v = [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1,
                   y > 0 ? i - N : -1, y < N - 1 ? i + N : -1];
        for (let k = 0; k < 4; k++) _lutteVoisins[i * 4 + k] = (v[k] >= 0 && _lutteMasque[v[k]]) ? v[k] : -1;
        /* Huit voisins pour la poussee : a quatre, la tache finit carree. */
        let k8 = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            const j = ny * N + nx;
            _lutteVoisins8[i * 8 + k8++] =
                (nx >= 0 && nx < N && ny >= 0 && ny < N && _lutteMasque[j]) ? j : -1;
        }
    }
}

function debitPour(state, body, slot) {
    if (!body || slot === null || slot === undefined) return 0;
    if (!(body.flore > 0)) return 0;
    const joueur = state.players[slot];
    if (!joueur || !joueur.stats) return 0;
    const sym = 1 + ((body.symbiosis || 0) / 100) * (body.type === 'planet' ? 0.20 : 0.10);
    /* Seuls comptent les nids qu'on tient : sur un astre partage, ceux de
       l'autre cote de la frontiere travaillent pour l'autre. */
    const nid = 1 + bonusBatiment(nbBatimentCamp(state, body, 'nid', campDe(body, slot)), 'nid');
    const soleil = body.type === 'planet' ? body.parent : (body.parent ? body.parent.parent : null);
    const sys = (soleil && isSystemComplete(soleil, slot)) ? 1.03 : 1;
    const part = 1 - Math.min((joueur.multiSacrifice || 0) / 100, 0.5);
    return Math.max(1, body.maxSpores) * TAUX_PROD
           * (0.4 + (body.flore / 100) * 0.6) * (1 + joueur.stats.growth * 0.3)
           * sym * nid * sys * part;
}

/* OUVRIR UNE BATAILLE sur un astre qui n'en avait pas. Le defenseur y entre
   avec ses spores, versees dans la zone unique qui couvre alors tout le
   disque : sans ce versement, declencher un combat effacerait la reserve de
   celui qu'on attaque. */
function naitreLutte(body) {
    if (body.lutte) return body.lutte;
    _luttePrepare();
    const N = LUTTE_N;
    const cel = new Uint8Array(N * N);
    for (let i = 0; i < cel.length; i++) cel[i] = _lutteMasque[i] ? 0 : LUTTE_VIDE;
    body.lutte = { cellules: cel, assaut: {}, acc: 0 };
    zonesRecalculer(body, body.lutte);
    const garnison = body.spores || 0;
    for (const id in body.lutte.zones) {
        if (body.lutte.zones[id].v === 0) body.lutte.zones[id].spores = garnison;
    }
    return body.lutte;
}

function engagerLutte(body, slot, spores, angle) {
    _luttePrepare();
    const N = LUTTE_N;
    naitreLutte(body);
    const L = body.lutte;
    const v = slot + 1;

    /* CHAQUE TIR OUVRE SON PROPRE FRONT, a l'endroit ou il touche. Deux
       attaques sur la meme planete ne grossissent donc pas la meme tache :
       elles en font deux, qui s'etalent chacune de leur cote. Les spores ne
       renforcent une tache existante que si le tir retombe SUR du terrain
       deja tenu - exactement comme le tir de surface. */
    let tete = -1;
    const c = (N - 1) / 2;
    for (let k = 0; k <= N; k++) {
        const rr = (N / 2 - 1) - k;
        if (rr < 0) break;
        const bx = Math.round(c + Math.cos(angle) * rr);
        const by = Math.round(c + Math.sin(angle) * rr);
        const i = by * N + bx;
        if (bx >= 0 && bx < N && by >= 0 && by < N && _lutteMasque[i]) { tete = i; break; }
    }
    if (!L.zid) zonesRecalculer(body, L);
    if (tete >= 0 && L.cellules[tete] !== v) { L.cellules[tete] = v; L.zid[tete] = 0; }
    /* Les spores vont a la ZONE touchee : un tir sur son propre terrain
       renforce la tache dessous, ailleurs il en ouvre une nouvelle. */
    zonesRecalculer(body, L);
    const zt = L.zones[(tete >= 0) ? L.zid[tete] : 0];
    if (zt) { zt.spores += spores; zt.elan = (zt.elan || 0) + spores; }
    zonesAgreger(body, L);
    L.dormante = false;
}

/* ─────────────────────────────────────────────
   ONDES SOLAIRES (portee du client)
   Un systeme entierement tenu voit son etoile envoyer, toutes les cinq
   secondes, une onde qui balaie ses astres. Chacun la recoit au passage du
   front, et ce qu'elle apporte depend de SENSITIVITY : cinq pour cent de la
   capacite de l'astre par point. Le serveur n'a pas d'anneau a dessiner - il
   ne fait que crediter les spores, que l'instantane transmet deja.
   ───────────────────────────────────────────── */
const ONDE_PERIODE = 5;
const ONDE_PAR_POINT = 0.05;
const ONDE_VITESSE = 1100;

function majOndesSolaires(state, dt) {
    if (!state._ondesSolaires) state._ondesSolaires = [];

    for (let i = 0; i < state.suns.length; i++) {
        const soleil = state.suns[i];
        const planetes = soleil.planets || [];
        if (!planetes.length) { soleil._ondeT = 0; continue; }
        const proprio = planetes[0].owner;
        if (proprio === null || proprio === undefined || !isSystemComplete(soleil, proprio)) {
            soleil._ondeT = 0;
            continue;
        }
        soleil._ondeT = (soleil._ondeT || 0) + dt;
        if (soleil._ondeT < ONDE_PERIODE) continue;
        soleil._ondeT = 0;

        let portee = soleil.radius;
        const corps = [];
        for (let k = 0; k < planetes.length; k++) {
            const pl = planetes[k];
            corps.push(pl);
            const lunes = pl.moons || [];
            for (let m = 0; m < lunes.length; m++) corps.push(lunes[m]);
        }
        for (let k = 0; k < corps.length; k++) {
            const b = corps[k];
            const d = Math.sqrt((b.x - soleil.x) * (b.x - soleil.x) + (b.y - soleil.y) * (b.y - soleil.y)) + b.radius;
            if (d > portee) portee = d;
        }
        state._ondesSolaires.push({ soleil: soleil, slot: proprio, corps: corps, touches: [],
                                    r: soleil.radius, portee: portee * 1.08 });
    }

    const os = state._ondesSolaires;
    for (let i = os.length - 1; i >= 0; i--) {
        const o = os[i];
        o.r += ONDE_VITESSE * dt;
        for (let k = 0; k < o.corps.length; k++) {
            if (o.touches[k]) continue;
            const b = o.corps[k];
            if (b.owner !== o.slot) { o.touches[k] = 1; continue; }
            const d = Math.sqrt((b.x - o.soleil.x) * (b.x - o.soleil.x) + (b.y - o.soleil.y) * (b.y - o.soleil.y));
            if (o.r < d) continue;
            o.touches[k] = 1;
            const j = state.players[o.slot];
            const sens = (j && j.stats) ? (j.stats.sensitivity || 0) : 0;
            const gain = (b.maxSpores || 0) * ONDE_PAR_POINT * sens;
            if (gain > 0) b.spores = Math.min(b.maxSpores, (b.spores || 0) + gain);
        }
        if (o.r >= o.portee) os.splice(i, 1);
    }
}


/* ─────────────────────────────────────────────
   TIR DE SURFACE (portee du client, mot pour mot)
   Depuis le terrain qu'on tient sur un astre, on lance des spores en cloche
   au-dessus de sa surface. Le vol dure d'autant plus longtemps que la cible
   est loin et part a la vitesse qu'il faut pour l'atteindre en ligne droite,
   mais une acceleration constante vers le centre le devie en chemin : plus
   on vise loin, plus il faut corriger. Le trace ne quitte jamais le disque.
   ───────────────────────────────────────────── */
const SURFACE_PAS = 0.05;
const SURFACE_COURBE = 0.16;

function _celluleVers(body, i) {
    const N = LUTTE_N, r = body.radius, pas = (2 * r) / N;
    return { x: body.x - r + ((i % N) + 0.5) * pas,
             y: body.y - r + (((i / N) | 0) + 0.5) * pas };
}
function _celluleA(body, wx, wy) {
    const N = LUTTE_N, r = body.radius, pas = (2 * r) / N;
    const x = Math.floor((wx - (body.x - r)) / pas);
    const y = Math.floor((wy - (body.y - r)) / pas);
    if (x < 0 || x >= N || y < 0 || y >= N) return -1;
    const i = y * N + x;
    return (_lutteMasque && _lutteMasque[i]) ? i : -1;
}

function peutTirerSurface(body, slot) {
    if (!body || body.type === 'sun') return false;
    if (body.owner === slot) return true;
    const L = body.lutte;
    /* Tenir du terrain suffit : une zone a court de spores reste une zone. */
    return !!(L && zonesDe(body, slot).length);
}

function pointTirSurface(body, slot, tx, ty) {
    const L = body.lutte, r = body.radius;
    if (!L) {
        const dx = tx - body.x, dy = ty - body.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        return { x: body.x + dx / d * r * 0.86, y: body.y + dy / d * r * 0.86 };
    }
    const zt = zoneDeTir(body, slot);
    const idz = zt ? zt.id : -1;
    const cel = L.cellules;
    let best = -1, bd = Infinity;
    for (let i = 0; i < cel.length; i++) {
        if (L.zid[i] !== idz) continue;
        const p = _celluleVers(body, i);
        const d = (p.x - tx) * (p.x - tx) + (p.y - ty) * (p.y - ty);
        if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? { x: body.x, y: body.y } : _celluleVers(body, best);
}

function trajectoireSurface(body, ox, oy, tx, ty) {
    const R = body.radius;
    const px = tx - ox, py = ty - oy;
    const portee = Math.sqrt(px * px + py * py) || 1;
    const tVol = Math.max(0.7, Math.min(3.4, 0.55 + portee / (R * 0.85)));
    const n = Math.max(6, Math.round(tVol / SURFACE_PAS));
    const a = R * SURFACE_COURBE;
    let x = ox, y = oy, vx = px / tVol, vy = py / tVol;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const d = Math.sqrt(x * x + y * y) || 1;
        vx -= x / d * a * SURFACE_PAS;
        vy -= y / d * a * SURFACE_PAS;
        x += vx * SURFACE_PAS;
        y += vy * SURFACE_PAS;
        pts.push({ x: x, y: y });
    }
    /* Le vol passe au-dessus du disque - dans l'atmosphere - mais la chute se
       fait sur la planete : un point sorti du limbe y est ramene. */
    const fin = pts[pts.length - 1];
    const df = Math.sqrt(fin.x * fin.x + fin.y * fin.y);
    if (df > R * 0.97) { fin.x = fin.x / df * R * 0.97; fin.y = fin.y / df * R * 0.97; }
    return pts;
}

function debarquerSurface(body, slot, spores, wx, wy) {
    _luttePrepare();
    const N = LUTTE_N;
    if (slot === body.owner && !body.lutte) {
        body.spores = Math.min(body.maxSpores, (body.spores || 0) + spores);
        return;
    }
    naitreLutte(body);
    const L = body.lutte;
    L.dormante = false;
    const v = (slot === body.owner) ? 0 : slot + 1;
    let centre = _celluleA(body, wx, wy);
    if (centre < 0) {
        const dx = wx - body.x, dy = wy - body.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        centre = _celluleA(body, body.x + dx / d * body.radius * 0.8,
                                 body.y + dy / d * body.radius * 0.8);
    }
    if (centre >= 0) {
        const rayon = Math.min(4.5, 0.7 + Math.sqrt(spores) / 10);
        const cx = centre % N, cy = (centre / N) | 0;
        const r2 = rayon * rayon;
        for (let y = Math.max(0, cy - 5); y <= Math.min(N - 1, cy + 5); y++) {
            for (let x = Math.max(0, cx - 5); x <= Math.min(N - 1, cx + 5); x++) {
                if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
                const i = y * N + x;
                if (L.cellules[i] === LUTTE_VIDE) continue;
                L.cellules[i] = v;
            }
        }
    }
    /* Les spores vont a la zone du point de chute. */
    zonesRecalculer(body, L);
    const zc = L.zones[(centre >= 0) ? L.zid[centre] : 0];
    if (zc) { zc.spores += spores; zc.elan = (zc.elan || 0) + spores; }
    zonesAgreger(body, L);
    L.dormante = false;
}

function lancerJetSurface(state, body, slot, tx, ty, zx, zy) {
    const joueur = state.players[slot];
    if (!joueur || !peutTirerSurface(body, slot)) return false;
    const ratio = (joueur.jetRatio !== undefined) ? joueur.jetRatio : (state.jetRatio || 0.5);
    const zt = body.lutte ? zoneDeTir(body, slot, zx, zy) : null;
    if (body.lutte && (!zt || zt.z.n < ZONE_MIN)) return false;
    const nb = Math.floor((zt ? zt.z.spores : body.spores) * ratio);
    if (nb < 5) return false;

    const p = pointTirSurface(body, slot, tx, ty);
    if ((tx - p.x) * (tx - p.x) + (ty - p.y) * (ty - p.y) < 1) return false;
    if (zt) { zt.z.spores -= nb; zonesAgreger(body, body.lutte); }
    else body.spores -= nb;

    const rel = trajectoireSurface(body, p.x - body.x, p.y - body.y,
                                   tx - body.x, ty - body.y);
    state.jets.push({
        id: state._jetId = (state._jetId || 0) + 1,
        owner: slot, color: joueur.color, spores: nb, sporeType: 'normal',
        trajectory: rel, posIndex: 0, x: p.x, y: p.y,
        speed: 1 / (0.70 * SURFACE_PAS),
        alive: true, age: 0, source: body, sourceName: body.name, _surface: body
    });
    return true;
}

/* ─────────────────────────────────────────────
   LES BATIMENTS SONT POSES SUR LE SOL
   Un batiment occupe une case de la surface : on le voit ou il est, et quand
   la frontiere passe dessus il change de mains avec le terrain. Les compteurs
   restent la somme, pour tout ce qui lit deja un bonus ; la liste dit ou ils
   sont et a qui ils appartiennent.
   ───────────────────────────────────────────── */
function _caseLibre(state, body, v) {
    _luttePrepare();
    const N = LUTTE_N;
    const cel = body.lutte ? body.lutte.cellules : null;
    const pris = {};
    const liste = body.edifices || [];
    for (let k = 0; k < liste.length; k++) pris[liste[k].i] = 1;
    const libres = [];
    for (let i = 0; i < N * N; i++) {
        if (!_lutteMasque[i] || pris[i]) continue;
        if (v !== null && cel && cel[i] !== v) continue;
        libres.push(i);
    }
    if (!libres.length) return -1;
    const alea = state._gameRng || Math.random;
    return libres[Math.floor(alea() * libres.length)];
}

function edifices(state, body) {
    if (body.edifices) return body.edifices;
    body.edifices = [];
    const genres = [['alveole', body.alveoles || 0], ['nid', body.nids || 0], ['biome', body.biomes || 0]];
    for (let g = 0; g < genres.length; g++) {
        for (let k = 0; k < genres[g][1]; k++) {
            const i = _caseLibre(state, body, null);
            if (i >= 0) body.edifices.push({ g: genres[g][0], i: i });
        }
    }
    return body.edifices;
}

function poserEdifice(state, body, genre, v) {
    const liste = edifices(state, body);
    const i = _caseLibre(state, body, (body.lutte && v !== undefined) ? v : null);
    if (i >= 0) liste.push({ g: genre, i: i });
    if (genre === 'nid') body.nids = (body.nids || 0) + 1;
    else if (genre === 'alveole') body.alveoles = (body.alveoles || 0) + 1;
    else body.biomes = (body.biomes || 0) + 1;
}

function nbBatimentCamp(state, body, genre, v) {
    const cle = genre === 'nid' ? 'nids' : genre === 'alveole' ? 'alveoles' : 'biomes';
    if (!body.lutte) return body[cle] || 0;
    const liste = edifices(state, body);
    const cel = body.lutte.cellules;
    let n = 0;
    for (let k = 0; k < liste.length; k++) {
        if (liste[k].g !== genre) continue;
        if (cel[liste[k].i] === v) n++;
    }
    return n;
}

function campDe(body, slot) {
    return (body.owner === slot) ? 0 : slot + 1;
}

/* CONTRE-ATTAQUE GENERALE (touche R du client). Sur chacun de ses astres ou
   un autre tient du terrain, les zones du joueur engagent juste ce qu'il faut
   pour le reprendre - cases etrangeres multipliees par le prix du sol - et
   pas une spore de plus. Rien a falsifier : le client ne fait que demander,
   le serveur calcule et n'engage que ce que les zones ont. */
/* nomCible : l'astre sous le curseur du joueur, ou rien du tout. Le client
   l'envoie par son nom - c'est le seul identifiant que les deux cotes
   partagent a coup sur. */
function riposteGenerale(state, slot, nomCible) {
    let astres = 0;
    const tous = state.allBodies || [];
    let bodies = tous;
    if (nomCible) {
        const b = tous.find(x => x.name === nomCible);
        if (!b) return 0;
        bodies = [b];
    }
    for (let bi = 0; bi < bodies.length; bi++) {
        const body = bodies[bi];
        const L = body.lutte;
        if (!L || !L.zones) continue;

        const vMoi = campDe(body, slot);
        let total = 0, etrangeres = 0;
        for (const id in L.zones) {
            const z = L.zones[id];
            total += z.n;
            if (z.v !== vMoi) etrangeres += z.n;
        }
        if (!etrangeres || !total) continue;

        const miennes = [];
        let dispo = 0;
        const liste = zonesDe(body, slot);
        for (let k = 0; k < liste.length; k++) {
            if (liste[k].z.n < ZONE_MIN) continue;
            miennes.push(liste[k].z);
            dispo += liste[k].z.spores;
        }
        const cout = coutCase(body, total);
        if (!miennes.length || dispo < cout) continue;

        const part = Math.min(1, (etrangeres * cout) / dispo);
        for (let k = 0; k < miennes.length; k++) {
            const z = miennes[k];
            z.elan = Math.max(z.elan || 0, z.spores * part);
        }
        L.dormante = false;
        astres++;
    }
    return astres;
}

function majLuttes(state, dt) {
    const bodies = state.allBodies || [];
    for (let bi = 0; bi < bodies.length; bi++) {
        const body = bodies[bi];
        if (!body.lutte) continue;
        body.lutte.acc += dt;
        let gardes = 8;
        while (body.lutte && body.lutte.acc >= LUTTE_PAS && gardes-- > 0) {
            body.lutte.acc -= LUTTE_PAS;
            majLutte(state, body, LUTTE_PAS);
        }
        if (body.lutte && body.lutte.acc > LUTTE_PAS) body.lutte.acc = 0;
    }
}

/* ─────────────────────────────────────────────
   LES ZONES (portee du client, mot pour mot)
   Une tache de couleur est une ZONE, avec ses spores a elle et son propre
   rendement. L.zid donne pour chaque case le numero de sa zone ; a chaque
   tour on refait les composantes connexes, une composante reprenant le numero
   le plus represente parmi ses cases. Deux zones soudees mettent leurs spores
   ensemble, une zone coupee les partage au prorata des cases. Perdre du sol,
   c'est perdre les spores qui etaient dessus.
   ───────────────────────────────────────────── */
const ZONE_MIN = 10;
const ZONE_FONTE = 0.5;
const _zoneMarque = new Int16Array(LUTTE_N * LUTTE_N);
const _zonePile = [];

function _zidNeuf(zones) {
    for (let id = 1; id < 255; id++) if (!zones[id]) return id;
    return 0;
}

function zonesRecalculer(body, L) {
    const nb = L.cellules.length, cel = L.cellules;
    if (!L.zid) L.zid = new Uint8Array(nb);
    if (!L.zones) L.zones = {};
    const zid = L.zid, anciennes = L.zones;
    _zoneMarque.fill(0);

    const compos = [];
    for (let i = 0; i < nb; i++) {
        if (cel[i] === LUTTE_VIDE || _zoneMarque[i]) continue;
        const v = cel[i];
        const comp = { v: v, cases: [], anciens: {} };
        compos.push(comp);
        const m = compos.length;
        _zonePile.length = 0; _zonePile.push(i); _zoneMarque[i] = m;
        while (_zonePile.length) {
            const j = _zonePile.pop();
            comp.cases.push(j);
            const a = zid[j];
            if (a) comp.anciens[a] = (comp.anciens[a] || 0) + 1;
            for (let k = 0; k < 8; k++) {
                const w = _lutteVoisins8[j * 8 + k];
                if (w >= 0 && !_zoneMarque[w] && cel[w] === v) { _zoneMarque[w] = m; _zonePile.push(w); }
            }
        }
    }
    compos.sort(function (a, b) { return b.cases.length - a.cases.length; });

    const neuves = {};
    for (let c = 0; c < compos.length; c++) {
        const comp = compos[c];
        let id = 0, best = 0;
        for (const a in comp.anciens) {
            if (neuves[a]) continue;
            if (comp.anciens[a] > best) { best = comp.anciens[a]; id = +a; }
        }
        if (!id) id = _zidNeuf(neuves);
        if (!id) continue;
        let sp = 0, el = 0;
        for (const a in comp.anciens) {
            const z = anciennes[a];
            if (!z) continue;
            /* Le prorata se prend sur nRef, le compte du dernier recalcul :
               la poussee a deja bouge les compteurs, s'en servir ferait payer
               deux fois le terrain perdu. */
            const part = Math.min(1, comp.anciens[a] / Math.max(1, z.nRef || z.n));
            sp += z.spores * part;
            el += (z.elan || 0) * part;
        }
        const z0 = anciennes[id];
        neuves[id] = { v: comp.v, n: comp.cases.length, nRef: comp.cases.length,
                       spores: sp, elan: el, cx: 0, cy: 0,
                       debit: z0 ? z0.debit : 0, rendement: z0 ? z0.rendement : 0,
                       fonte: z0 ? z0.fonte : 0 };
        let sx = 0, sy = 0;
        for (let k = 0; k < comp.cases.length; k++) {
            const j = comp.cases[k];
            zid[j] = id;
            sx += j % LUTTE_N; sy += (j / LUTTE_N) | 0;
        }
        neuves[id].cx = sx / comp.cases.length;
        neuves[id].cy = sy / comp.cases.length;
    }
    L.zones = neuves;
}

function zonesAgreger(body, L) {
    let def = 0;
    const att = {};
    for (const id in L.zones) {
        const z = L.zones[id];
        if (z.v === 0) def += z.spores;
        else att[z.v - 1] = (att[z.v - 1] || 0) + z.spores;
    }
    if (body.owner !== null && body.owner !== undefined) body.spores = def;
    L.assaut = att;
}

function zonesDe(body, slot) {
    const L = body.lutte;
    if (!L || !L.zones) return [];
    const v = campDe(body, slot);
    const out = [];
    for (const id in L.zones) if (L.zones[id].v === v) out.push({ id: +id, z: L.zones[id] });
    out.sort(function (a, b) { return b.z.n - a.z.n; });
    return out;
}

/* La zone d'ou l'on tire. Le client n'ayant pas la meme numerotation que le
   serveur, il annonce le POINT ou se trouve la zone qu'il a choisie ; a
   defaut, ou si ce point ne donne rien, c'est la plus grande qui tire. */
function zoneDeTir(body, slot, zx, zy) {
    const L = body.lutte;
    if (!L || !L.zones) return null;
    if (zx !== undefined && zy !== undefined && isFinite(zx) && isFinite(zy)) {
        const i = _celluleA(body, zx, zy);
        if (i >= 0) {
            const id = L.zid ? L.zid[i] : 0;
            const z = id ? L.zones[id] : null;
            if (z && z.v === campDe(body, slot)) return { id: id, z: z };
        }
    }
    /* A defaut, la zone la mieux pourvue parmi celles qui ont le droit de
       tirer : la plus grande n'est pas forcement celle qui a des troupes. */
    const liste = zonesDe(body, slot);
    if (!liste.length) return null;
    let best = null;
    for (let i = 0; i < liste.length; i++) {
        if (liste[i].z.n < ZONE_MIN) continue;
        if (!best || liste[i].z.spores > best.z.spores) best = liste[i];
    }
    return best || liste[0];
}

function _frontDe(L, id, v, sortie) {
    sortie.length = 0;
    const cel = L.cellules, zid = L.zid;
    for (let i = 0; i < cel.length; i++) {
        const w = cel[i];
        if (w === LUTTE_VIDE || w === v) continue;
        let n = 0;
        for (let k = 0; k < 8; k++) {
            const j = _lutteVoisins8[i * 8 + k];
            if (j >= 0 && zid[j] === id) n++;
        }
        if (n) sortie.push({ i: i, n: n });
    }
    return sortie;
}

function _grainLutte(state, L) {
    if (L.grain) return L.grain;
    const N = LUTTE_N;
    const alea = state._gameRng || Math.random;
    const brut = new Float32Array(N * N);
    for (let i = 0; i < brut.length; i++) brut[i] = alea();
    const g = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let somme = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
            somme += brut[ny * N + nx]; n++;
        }
        g[y * N + x] = somme / n;
    }
    L.grain = g;
    return g;
}

function majLutte(state, body, pas) {
    const L = body.lutte, cel = L.cellules, nb = cel.length;
    const neutre = (body.owner === null || body.owner === undefined);
    const alea = state._gameRng || Math.random;

    zonesRecalculer(body, L);

    _lutteCompte.fill(0);
    let total = 0;
    for (let i = 0; i < nb; i++) { const v = cel[i]; if (v === LUTTE_VIDE) continue; total++; _lutteCompte[v]++; }
    if (!total) { body.lutte = null; return; }

    /* Chaque zone produit pour elle-meme, au prorata de sa surface, sous le
       plafond que cette surface lui donne, et au rendement de la courbe. */
    for (const id in L.zones) {
        const z = L.zones[id];
        const slot = (z.v === 0) ? body.owner : z.v - 1;
        z.plafond = body.maxSpores * (z.n / total);
        if (slot === null || slot === undefined) { z.debit = 0; z.rendement = 0; continue; }
        z.rendement = courbeCroissance(z.spores / Math.max(1, z.plafond));
        z.debit = debitPour(state, body, slot) * (z.n / total) * z.rendement;
        if (z.spores < z.plafond) z.spores = Math.min(z.plafond, z.spores + z.debit * pas);
    }

    const cout = coutCase(body, total);
    const grain = _grainLutte(state, L);
    let pousseEncore = false;

    /* Le chantier d'un astre partage aboutit ici, paye par la zone qui l'a
       demande et pose sur son sol. */
    if (body.buildMode === 'nid' || body.buildMode === 'biome' || body.buildMode === 'alveole') {
        const bs = (body.buildSlot !== undefined) ? body.buildSlot : body.owner;
        const zb = zoneDeTir(body, bs);
        if (zb && zb.z.n >= ZONE_MIN) {
            const prixB = coutBatiment(body, body.buildMode);
            if (zb.z.spores >= prixB) {
                zb.z.spores -= prixB;
                if (body.buildMode === 'alveole') body.baseMaxSpores = body.baseMaxSpores || body.maxSpores;
                poserEdifice(state, body, body.buildMode, zb.z.v);
                body.buildMode = 'off';
                body.buildProgress = 0;
            }
        }
    }

    /* L'IA contre-attaque d'elle-meme des qu'elle a du surplus. */
    if (!neutre) {
        const j0 = state.players[body.owner];
        if (j0 && !j0.socketId) {
            const miennes = zonesDe(body, body.owner);
            for (let k = 0; k < miennes.length; k++) {
                const z = miennes[k].z;
                if (z.n < ZONE_MIN || z.elan >= cout) continue;
                const surplus = z.spores - z.plafond * 0.5;
                if (surplus >= cout) z.elan = surplus;
            }
        }
    }

    /* La poussee, zone par zone. */
    for (const id in L.zones) {
        const z = L.zones[id];
        if (!(z.elan >= cout)) { z.elan = 0; continue; }
        let cases = Math.max(1, Math.round(LUTTE_CADENCE * pas));
        const front = _frontDe(L, +id, z.v, _lutteCandidats);
        if (!front.length) { z.elan = 0; continue; }
        for (let i = 0; i < front.length; i++) {
            const f = front[i];
            f.p = f.n * 0.30 + grain[f.i] * 2.6 + alea() * 1.3;
        }
        front.sort(function (a, b) { return b.p - a.p; });
        for (let i = 0; i < front.length && cases > 0; i++) {
            const j = front[i].i;
            const perdant = cel[j];
            if (perdant === z.v || perdant === LUTTE_VIDE) continue;
            const prix = (perdant === 0 && neutre) ? cout * 0.15 : cout;
            if (z.elan < prix || z.spores < prix) break;
            const perdue = L.zones[L.zid[j]];
            if (perdue) perdue.n--;
            cel[j] = z.v;
            L.zid[j] = +id;
            z.n++;
            _lutteCompte[perdant]--;
            _lutteCompte[z.v]++;
            z.elan -= prix;
            z.spores = Math.max(0, z.spores - prix);
            cases--;
        }
        if (z.elan >= cout) pousseEncore = true; else z.elan = 0;
    }
    L.dormante = !pousseEncore;

    /* La fonte : une zone de moins de dix cases, une fois son elan retombe,
       s'effrite case par case jusqu'a disparaitre. */
    for (const id in L.zones) {
        const z = L.zones[id];
        if (z.n >= ZONE_MIN || z.elan >= cout) { z.fonte = 0; continue; }
        z.fonte = (z.fonte || 0) + pas;
        if (z.fonte < ZONE_FONTE) continue;
        z.fonte = 0;
        let pire = -1, pireN = -1, repreneur = 0;
        for (let i = 0; i < nb; i++) {
            if (L.zid[i] !== +id) continue;
            const voisins = {};
            let etrangers = 0;
            for (let k = 0; k < 8; k++) {
                const j = _lutteVoisins8[i * 8 + k];
                if (j < 0 || cel[j] === LUTTE_VIDE || cel[j] === z.v) continue;
                voisins[cel[j]] = (voisins[cel[j]] || 0) + 1;
                etrangers++;
            }
            if (etrangers > pireN) {
                pireN = etrangers; pire = i;
                let best = 0;
                for (const w in voisins) if (voisins[w] > best) { best = voisins[w]; repreneur = +w; }
            }
        }
        if (pire >= 0 && pireN > 0) {
            cel[pire] = repreneur;
            _lutteCompte[z.v]--;
            _lutteCompte[repreneur]++;
            z.n--;
        }
    }

    zonesAgreger(body, L);

    for (const k in L.assaut) {
        const sl = +k, v = sl + 1;
        if (_lutteCompte[v] > 0) continue;
        delete L.assaut[sl];
    }

    L.majorite = (total - _lutteCompte[0]) / total >= LUTTE_MAJORITE;

    let vainqueur = -1, meilleur = 0;
    for (let v = 1; v < _lutteCompte.length; v++) {
        if (_lutteCompte[v] > meilleur) { meilleur = _lutteCompte[v]; vainqueur = v - 1; }
    }
    if (vainqueur < 0) { body.lutte = null; return; }
    if (_lutteCompte[0] === 0) {
        const reste = L.assaut[vainqueur] || 0;
        body.lutte = null;
        conquerir(state, body, vainqueur, reste);
    }
}

/* Le resume transmis au client : combien de cases tient le defenseur, et pour
   chaque assaillant ses spores et ses cases. La grille elle-meme ne part
   jamais sur le reseau - trois cents octets par astre et par instantane pour
   une tache que le client sait peindre tout seul. */
function _resumeLutte(body) {
    const L = body.lutte;
    if (!L) return null;
    let def = 0;
    const compte = {};
    for (let i = 0; i < L.cellules.length; i++) {
        const v = L.cellules[i];
        if (v === LUTTE_VIDE) continue;
        if (v === 0) def++; else compte[v - 1] = (compte[v - 1] || 0) + 1;
    }
    const a = [];
    for (const k in L.assaut) a.push([+k, Math.round(L.assaut[k]), compte[+k] || 0]);
    /* Les zones, pour que le client affiche de vrais chiffres et sache d'ou il
       tire : numero, camp, cases, spores, rendement et centre sur la grille.
       La grille elle-meme ne part toujours pas sur le reseau. */
    const zs = [];
    for (const id in L.zones) {
        const z = L.zones[id];
        zs.push([+id, z.v, z.n, Math.round(z.spores), Math.round((z.rendement || 0) * 100),
                 Math.round(z.cx * 10) / 10, Math.round(z.cy * 10) / 10]);
    }
    return { d: def, a: a, m: !!L.majorite, z: zs };
}

/* PRISE D'UN ASTRE : ce n'est plus l'impact qui conquiert mais la bataille
   de surface qui se termine. Extrait d'applyConquest, les deux en ont besoin. */
function conquerir(state, body, nouveauProprio, sporesArrivees) {
    body.lutte = null;
    const attacking = sporesArrivees;
    const jet = { owner: nouveauProprio };
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
    /* Les batiments restent : ils sont poses sur le sol, et qui prend le sol
       prend ce qui est dessus. */
    if (state.players[jet.owner]?.bodies) state.players[jet.owner].bodies.push(body);
    if (oldOwner === null) {
        const _vb = body.type === 'planet' ? 500 : 250;
        body.spores = Math.min(body.maxSpores, body.spores + _vb);
    }
}

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
                body.parasite = { ownerSlot: jet.owner, sourceBody: jet.source, sourceName: jet.sourceName, _accumulator: 0 };
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

    if (body.owner !== null && body.owner !== jet.owner && _isAllied(jet.owner, body.owner, state.players)) {
        body.spores = Math.min(body.maxSpores, (body.spores || 0) + Math.floor(jet.spores));
        return;
    }

    const densityBonus = 1 + (state.players[jet.owner]?.stats?.density || 0) * 0.05;
    let attacking = jet.spores * densityBonus;

    if (body.owner === jet.owner) {
        const _g = Math.floor(Math.min(jet.spores, body.maxSpores - body.spores));
        if (body.spores < body.maxSpores) body.spores = Math.min(body.maxSpores, body.spores + _g);
        /* Renforcer un astre assiege, c'est contre-attaquer. */
        if (body.lutte && _g > 0) {
            if (!body.lutte.elan) body.lutte.elan = {};
            body.lutte.elan[0] = (body.lutte.elan[0] || 0) + _g;
            body.lutte.dormante = false;
        }
        return;
    }

    if (body.faune > 0) {
        const fauneDmg = Math.min(body.faune, attacking);
        body.faune  -= fauneDmg;
        attacking   -= fauneDmg;
    }

    /* Les biomes qui defendent sont ceux que l'assaillant NE tient PAS. */
    const _bioDef = body.lutte
        ? (body.biomes || 0) - nbBatimentCamp(state, body, 'biome', campDe(body, jet.owner))
        : (body.biomes || 0);
    const biomeDefense = 1 + bonusBatiment(Math.max(0, _bioDef), 'biome');
    attacking = attacking / biomeDefense;

    /* Les spores qui restent debarquent et se battent pour la surface. */
    if (attacking > 0) {
        engagerLutte(body, jet.owner, attacking,
                     Math.atan2((jet.y || body.y) - body.y, (jet.x || body.x) - body.x));
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
            if (idx >= jet.trajectory.length - 1) {
                /* Un tir de surface arrive au bout de sa cloche : il se pose. */
                if (jet._surface) {
                    const fin = jet.trajectory[jet.trajectory.length - 1];
                    debarquerSurface(jet._surface, jet.owner, jet.spores,
                                     jet._surface.x + fin.x, jet._surface.y + fin.y);
                }
                jet.alive = false; continue;
            }
            const pt = jet.trajectory[idx];
            if (jet._surface) {
                /* Trajectoire gardee dans le repere de l'astre, qui orbite. */
                jet.x = jet._surface.x + pt.x;
                jet.y = jet._surface.y + pt.y;
            } else {
                jet.x = pt.x;
                jet.y = pt.y;
            }
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
// ─── Neutralisation jets croisés ─────────────────────────────
function checkJetNeutralization(state) {
    const jets = state.jets;
    for (let i = 0; i < jets.length; i++) {
        if (!jets[i].alive) continue;
        for (let j = i + 1; j < jets.length; j++) {
            if (!jets[j].alive) continue;
            if (jets[i].owner === jets[j].owner) continue;
            const dx = jets[i].x - jets[j].x;
            const dy = jets[i].y - jets[j].y;
            if (dx * dx + dy * dy < 225) {
                const min = Math.min(jets[i].spores, jets[j].spores);
                jets[i].spores -= min;
                jets[j].spores -= min;
                if (jets[i].spores <= 0) jets[i].alive = false;
                if (jets[j].spores <= 0) jets[j].alive = false;
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
/* ─────────────────────────────────────────────
   TIR DEPUIS L'ASTRE LE PLUS PROCHE, ET CHARGEMENT
   Meme regle que le client, mais c'est ici qu'elle fait autorite : pendant
   qu'un joueur vise, l'astre de son groupe le plus proche de la cible recoit
   les spores des autres par paquets de 100, et c'est lui qui tirera.
   Changer de cible remet le chargement a zero sans rien rendre.
   Le groupe est une planete et SES lunes, toutes tenues par le meme joueur.
   ───────────────────────────────────────────── */
const CHARGE_PAQUET = 100;
const CHARGE_PERIODE = 0.35;
/* La marge que le client ajoute autour de chaque astre pour tracer la
   frontiere. Reprise ici a l'identique : le serveur doit juger "vise chez
   lui" exactement comme le client le dessine. */
const MARGE_FRONTIERE = 26;

function _groupeTir(src) {
    if (!src) return [];
    const planete = (src.type === 'planet') ? src : (src.parent || null);
    if (!planete || planete.type !== 'planet') return [src];
    const proprio = src.owner;
    if (planete.owner !== proprio) return [src];
    const lunes = planete.moons || [];
    if (!lunes.length) return [planete];
    for (let i = 0; i < lunes.length; i++) {
        if (lunes[i].owner !== proprio) return [src];
    }
    return [planete].concat(lunes);
}

/* La cible est-elle DANS la frontiere du groupe qui tire ? Le groupe est une
   planete et ses lunes : sa frontiere tient dans un cercle centre sur la
   planete, du rayon de l'orbite lunaire la plus large, plus la marge. Meme
   calcul, mot pour mot, que dans le client. */
/* Le segment ax,ay -> bx,by coupe-t-il le disque cx,cy,r ? */
function _segmentCoupeDisque(ax, ay, bx, by, cx, cy, r) {
    const dx = bx - ax, dy = by - ay;
    const a = dx * dx + dy * dy;
    if (a < 1e-9) { const ux = ax - cx, uy = ay - cy; return ux * ux + uy * uy < r * r; }
    let t = -((ax - cx) * dx + (ay - cy) * dy) / a;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = ax + dx * t - cx, py = ay + dy * t - cy;
    return px * px + py * py < r * r;
}

/* Un tir de A vers B traverse-t-il une etoile ou le trou noir ? Les deux
   detruisent le jet : le plus proche de la cible n'est pas le bon lanceur
   s'il tire a travers un soleil. Meme regle que dans le client. */
function tirBloque(state, ax, ay, bx, by) {
    const suns = state.suns || [];
    for (let i = 0; i < suns.length; i++) {
        const s = suns[i];
        if (_segmentCoupeDisque(ax, ay, bx, by, s.x, s.y, s.radius + 14)) return true;
    }
    const bh = state.blackHole;
    if (bh && _segmentCoupeDisque(ax, ay, bx, by, bh.x, bh.y, bh.dangerZone * 0.4 + 10)) return true;
    return false;
}

function _viseeInterne(groupe, x, y) {
    if (!groupe || groupe.length < 2) return false;
    const p = groupe[0];
    let r = p.radius;
    for (let i = 1; i < groupe.length; i++) {
        const b = groupe[i];
        const d = Math.sqrt((b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y)) + b.radius;
        if (d > r) r = d;
    }
    r += MARGE_FRONTIERE;
    const dx = x - p.x, dy = y - p.y;
    return dx * dx + dy * dy <= r * r;
}

function majChargementTir(state, dt) {
    const joueurs = state.players || [];
    for (let j = 0; j < joueurs.length; j++) {
        const vis = joueurs[j]._visee;
        if (!vis || !vis.src) continue;
        if (vis.src.owner !== joueurs[j].id) { joueurs[j]._visee = null; continue; }

        const groupe = _groupeTir(vis.src);
        /* Viser chez soi ne change plus le lanceur : traverser sa propre
           frontiere pour aller chercher une cible derriere faisait sauter le
           tir d'une lune a l'autre, et chaque saut remettait la charge a
           zero. Des que la cible ressort, la bascule reprend. */
        const interne = _viseeInterne(groupe, vis.tx, vis.ty);
        let lanceur = vis.lanceur;
        if (!interne || !lanceur || groupe.indexOf(lanceur) < 0) {
            /* Le plus proche QUI VOIT LA CIBLE : une etoile avale le jet. On
               ne retombe sur le plus proche tout court que si aucun n'a la
               vue. */
            lanceur = vis.src;
            let meilleure = Infinity, meilleureVue = Infinity, lanceurVue = null;
            for (let i = 0; i < groupe.length; i++) {
                const b = groupe[i];
                const dx = vis.tx - b.x, dy = vis.ty - b.y;
                const d = dx * dx + dy * dy;
                if (d < meilleure) { meilleure = d; lanceur = b; }
                if (d < meilleureVue && !tirBloque(state, b.x, b.y, vis.tx, vis.ty)) {
                    meilleureVue = d; lanceurVue = b;
                }
            }
            if (lanceurVue) lanceur = lanceurVue;
        }
        if (lanceur !== vis.lanceur) { vis.lanceur = lanceur; vis.acc = 0; }
        if (groupe.length < 2) continue;

        vis.acc += dt;
        while (vis.acc >= CHARGE_PERIODE) {
            vis.acc -= CHARGE_PERIODE;
            let place = lanceur.maxSpores - lanceur.spores;
            if (place <= 1) break;
            let envoye = 0;
            for (let i = 0; i < groupe.length && place > 1; i++) {
                const b = groupe[i];
                if (b === lanceur) continue;
                const envoi = Math.min(CHARGE_PAQUET, Math.floor(b.spores), Math.floor(place));
                if (envoi <= 0) continue;
                b.spores -= envoi;
                lanceur.spores += envoi;
                place -= envoi;
                envoye += envoi;
            }
            if (envoye === 0) break;
        }
    }
}

/* Le tireur n'est pas forcement le proprietaire : on peut lancer depuis la
   tete de pont qu'on tient sur la planete de quelqu'un d'autre. */
function launchJet(state, source, dirX, dirY, sporeType, slot, zx, zy) {
    sporeType = sporeType || 'normal';
    const tireur = (slot === undefined || slot === null) ? source.owner : slot;
    const player = state.players[tireur];
    if (!player) return;
    const chezSoi = (source.owner === tireur);
    if (!chezSoi && !(source.lutte && zonesDe(source, tireur).length)) return;

    let sporeCount;
    if (sporeType === 'parasite') {
        if (!chezSoi) return;
        if ((source.parasiteSpore || 0) < 1) return;
        source.parasiteSpore = 0;
        sporeCount = 1;
    } else {
        const _ratio = (player.jetRatio !== undefined) ? player.jetRatio
                     : (state.jetRatio || 0.5);
        if (source.lutte) {
            /* Sur un astre partage, un tir part d'une ZONE et de sa reserve.
               Sous dix cases, elle n'a pas de quoi organiser un depart. */
            const zt = zoneDeTir(source, tireur, zx, zy);
            if (!zt || zt.z.n < ZONE_MIN) return;
            sporeCount = Math.floor(zt.z.spores * _ratio);
            if (sporeCount < 5) return;
            zt.z.spores -= sporeCount;
            zonesAgreger(source, source.lutte);
        } else {
            sporeCount = Math.floor(source.spores * _ratio);
            if (sporeCount < 5) return;
            source.spores -= sporeCount;
        }
    }

    const speed = 20 + player.stats.velocity * 6;
    const traj  = computeTrajectory(state, source.x, source.y, dirX, dirY, speed);
    const jetColor = sporeType === 'parasite' ? '#22C55E' : player.color;

    state.jets.push({
        id:         ++_jetIdCounter,
        owner:      tireur,
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

// ─── Détection fin de partie (autoritaire serveur) ────────────
function _checkVictory(state, io, roomId) {
    const totalBodies = state.planets.length + state.moons.length;
    if (totalBodies === 0) return;

    // Timer 10 minutes → victoire au score
    if (state.time >= 600) {
        const alive = state.players.filter(p => p.alive);
        if (alive.length >= 2) {
            const best = alive.reduce((a, b) => b.bodies.length > a.bodies.length ? b : a);
            state._gameOver = true;
            io.to(roomId).emit('game_over', {
                winnerSlot: best.id,
                reason: 'time',
                stats: { timeElapsed: state.time }
            });
            return;
        }
    }

    for (const player of state.players) {
        if (!player.alive) continue;

        // Élimination
        if (player.bodies.length === 0) {
            const hasJets = state.jets.some(j => j.alive && j.owner === player.id);
            if (!hasJets) {
                player.alive = false;
                player._inSursis = false;
                io.to(roomId).emit('player_eliminated', { slot: player.id, pseudo: player.name });
            } else if (!player._inSursis) {
                player._inSursis = true;
            }
        } else {
            player._inSursis = false;
        }
    }

    // Victoire : 80% des astres OU un seul joueur vivant
    const alivePlayers = state.players.filter(p => p.alive);
    if (alivePlayers.length === 0) return;

if (alivePlayers.length === 1) {
        state._gameOver = true;
        io.to(roomId).emit('game_over', {
            winnerSlot: alivePlayers[0].id,
            reason: 'last_standing',
            stats: { timeElapsed: state.time }
        });
// Résultat de manche géré par le serveur (score best-of-3 + ELO)
        if (roomId.startsWith('ranked-') && state._onRankedManche) {
            state._onRankedManche(alivePlayers[0].id);
        }
        return;
    }

    for (const player of alivePlayers) {
        const teamCount = state.config?.teamCount || 0;
        let owned = player.bodies.length;
        if (teamCount >= 2 && player.team !== undefined) {
            owned = state.players
                .filter(p => p.team === player.team)
                .reduce((sum, p) => sum + p.bodies.length, 0);
        }
if (owned / totalBodies >= 0.8) {
            state._gameOver = true;
            io.to(roomId).emit('game_over', {
                winnerSlot: player.id,
                reason: 'domination',
                stats: { timeElapsed: state.time }
            });
if (roomId.startsWith('ranked-') && state._onRankedManche) {
                state._onRankedManche(player.id);
            }
            return;
        }
    }
}

module.exports = { GameLoop, updateOrbits, updateSporeGeneration, updateJets, applyConquest, updateAI, _buildState, _groupeTir, majChargementTir, _viseeInterne, tirBloque, engagerLutte, majLuttes, conquerir, _resumeLutte, majOndesSolaires, riposteGenerale,
    lancerJetSurface, debarquerSurface, peutTirerSurface };
