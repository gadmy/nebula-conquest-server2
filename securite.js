// securite.js — Nebula Conquest Server v2
// Tout ce qu'un client envoie est suspect : ce module le borne, le trie et
// le rejette avant que le reste du serveur ne s'en serve.

/* Un nombre fini, sinon la valeur de repli ; borne entre min et max. */
function nombre(v, min, max, repli) {
    const n = Number(v);
    if (!isFinite(n)) return repli;
    return Math.max(min, Math.min(max, n));
}

/* Une chaine courte, sinon null. Rien d'autre qu'une chaine n'est accepte :
   un objet ou un tableau a la place d'un nom faisait planter .toLowerCase(). */
function texte(v, max) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || t.length > (max || 40)) return null;
    return t;
}

/* Un pseudo : memes caracteres que ceux permis a l'inscription (lettres,
   chiffres, espace, tiret, soulignement, accents). Tout le reste est refuse :
   un pseudo sert de texte dans la page des AUTRES joueurs, un chevron y
   deviendrait du code. */
function pseudo(v) {
    const t = texte(v, 20);
    if (!t || !/^[\w\- ÀÂÄÉÈÊËÎÏÔÙÛÜÇàâäéèêëîïôùûüç]+$/.test(t)) return null;
    return t;
}

function couleur(v, repli) {
    return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : repli;
}

/* ─────────────────────────────────────────────
   LIMITEUR DE DEBIT, par socket : un seau de jetons. Chaque message en
   consomme un, le seau se remplit a DEBIT par seconde jusqu'a RAFALE. Un
   client normal n'en approche jamais (visee : 7 messages/s au plus). Celui
   qui insiste voit ses messages ignores, puis est deconnecte.
   ───────────────────────────────────────────── */
const DEBIT = 30, RAFALE = 60, REFUS_AVANT_EXCLUSION = 300;

function limiteur() {
    return { jetons: RAFALE, maj: Date.now(), refus: 0 };
}

/* Vrai si le message passe. */
function accepter(l) {
    const t = Date.now();
    l.jetons = Math.min(RAFALE, l.jetons + (t - l.maj) / 1000 * DEBIT);
    l.maj = t;
    if (l.jetons >= 1) { l.jetons -= 1; return true; }
    l.refus++;
    return false;
}

function aExclure(l) { return l.refus >= REFUS_AVANT_EXCLUSION; }

/* ─────────────────────────────────────────────
   L'UNIVERS DE DEPART. Il est fabrique par le client de l'hote, et le
   serveur le prenait tel quel : un hote tricheur pouvait se donner les
   statistiques maximales, des technologies, des planetes geantes pleines
   a craquer, un trou noir inoffensif, ou des milliers d'astres pour faire
   tomber le serveur. On garde la CARTE (positions, tailles, flore, faune)
   dans des bornes realistes, et on remet a zero tout ce qui est un avantage :
   proprietaires, spores, batiments, statistiques, technologies.
   ───────────────────────────────────────────── */
const STATS_BASE = { growth: 3, velocity: 4, density: 2, sensitivity: 1 };
const LIMITES = { soleils: 16, planetes: 12, lunes: 6, ceintures: 8, rochers: 400, nettoyeurs: 12, ia: 8 };
const TROU_NOIR = { x: 0, y: 0, radius: 300, dangerZone: 300, gravityRange: 1500, gravityStrength: 1260 };

function _astre(b, type) {
    /* Bornes au-dessus des plus grands astres des cartes (lunes ~50, planetes
       ~130) : de quoi accepter une nouvelle carte, pas une planete geante. */
    const rMax = type === 'moon' ? 70 : 180;
    const radius = nombre(b && b.radius, 3, rMax, 20);
    const max = Math.floor(radius * 50);
    return {
        name:        texte(b && b.name, 40) || ('Astre-' + Math.random().toString(36).slice(2, 6)),
        type:        type,
        radius:      radius,
        flore:       Math.round(nombre(b && b.flore, 0, 100, 0)),
        faune:       Math.round(nombre(b && b.faune, 0, 100, 0)),
        _baseFaune:  Math.round(nombre(b && (b._baseFaune !== undefined ? b._baseFaune : b.faune), 0, 100, 0)),
        maxSpores:   max,
        baseMaxSpores: max,
        orbitRadius: nombre(b && b.orbitRadius, 0, 20000, 0),
        orbitSpeed:  nombre(b && b.orbitSpeed, -2, 2, 0),
        angle:       nombre(b && b.angle, -1000, 1000, 0),
        x:           nombre(b && b.x, -50000, 50000, 0),
        y:           nombre(b && b.y, -50000, 50000, 0),
        owner: null, spores: 0,
        symbiosis: 0, symOwnerTime: 0,
        buildMode: 'off', nids: 0, biomes: 0, alveoles: 0,
        parasiteSpore: 0, parasiteProgress: 0,
    };
}

/* room : la salle cote serveur, dont les emplacements donnent les VRAIS
   joueurs humains (pseudo et couleur verifies a la connexion). */
function nettoyerUnivers(u, room) {
    u = (u && typeof u === 'object') ? u : {};
    const soleilsBruts = Array.isArray(u.suns) ? u.suns.slice(0, LIMITES.soleils) : [];
    const noms = new Set();
    const nomUnique = (b) => {
        let n = b.name, k = 2;
        while (noms.has(n)) n = b.name + '-' + (k++);
        noms.add(n); b.name = n;
        return b;
    };
    const suns = soleilsBruts.map((s) => ({
        name:        texte(s && s.name, 40) || 'Soleil',
        type:        'sun',
        radius:      nombre(s && s.radius, 30, 400, 150),
        orbitRadius: nombre(s && s.orbitRadius, 0, 20000, 0),
        orbitSpeed:  nombre(s && s.orbitSpeed, -2, 2, 0),
        angle:       nombre(s && s.angle, -1000, 1000, 0),
        x:           nombre(s && s.x, -50000, 50000, 0),
        y:           nombre(s && s.y, -50000, 50000, 0),
        color:       couleur(s && s.color, '#FFB830'),
        planets: (Array.isArray(s && s.planets) ? s.planets.slice(0, LIMITES.planetes) : []).map((p) => {
            const pl = nomUnique(_astre(p, 'planet'));
            pl.moons = (Array.isArray(p && p.moons) ? p.moons.slice(0, LIMITES.lunes) : [])
                .map((m) => nomUnique(_astre(m, 'moon')));
            return pl;
        }),
    }));

    const asteroidBelts = (Array.isArray(u.asteroidBelts) ? u.asteroidBelts.slice(0, LIMITES.ceintures) : []).map((b) => ({
        radius:     nombre(b && b.radius, 0, 20000, 500),
        orbitSpeed: nombre(b && b.orbitSpeed, -2, 2, 0),
        sunIndex:   Math.round(nombre(b && b.sunIndex, 0, Math.max(0, suns.length - 1), 0)),
        rocks: (Array.isArray(b && b.rocks) ? b.rocks.slice(0, LIMITES.rochers) : []).map((r) => ({
            angle:     nombre(r && r.angle, -1000, 1000, 0),
            radiusOff: nombre(r && r.radiusOff, -2000, 2000, 0),
            type:      texte(r && r.type, 20) || 'rock',
            subRocks: (Array.isArray(r && r.subRocks) ? r.subRocks.slice(0, 8) : []).map((q) => ({
                offX: nombre(q && q.offX, -100, 100, 0), offY: nombre(q && q.offY, -100, 100, 0),
                size: nombre(q && q.size, 0, 60, 4), color: couleur(q && q.color, '#888888'),
            })),
        })),
    }));

    const bh = u.blackHole || {};
    const blackHole = {
        x: nombre(bh.x, -1000, 1000, TROU_NOIR.x),
        y: nombre(bh.y, -1000, 1000, TROU_NOIR.y),
        radius:          nombre(bh.radius, TROU_NOIR.radius * 0.5, TROU_NOIR.radius * 2, TROU_NOIR.radius),
        dangerZone:      nombre(bh.dangerZone, TROU_NOIR.dangerZone * 0.5, TROU_NOIR.dangerZone * 2, TROU_NOIR.dangerZone),
        gravityRange:    nombre(bh.gravityRange, TROU_NOIR.gravityRange * 0.5, TROU_NOIR.gravityRange * 2, TROU_NOIR.gravityRange),
        gravityStrength: nombre(bh.gravityStrength, TROU_NOIR.gravityStrength * 0.5, TROU_NOIR.gravityStrength * 2, TROU_NOIR.gravityStrength),
    };

    /* Les joueurs : les humains viennent de la salle, pas du client. Les IA
       gardent leur place mais partent toutes avec les memes armes. */
    const slots = (room && Array.isArray(room.slots)) ? room.slots : [];
    const humains = new Map(slots.map((s) => [s.slot, s]));
    const brutsJoueurs = Array.isArray(u.players) ? u.players : [];
    const players = [];
    const vus = new Set();
    for (const p of brutsJoueurs) {
        const id = Math.round(nombre(p && p.id, 0, 64, -1));
        if (id < 0 || vus.has(id)) continue;
        const h = humains.get(id);
        if (!h && players.filter((x) => !x.isHuman).length >= LIMITES.ia) continue;
        vus.add(id);
        players.push({
            id: id,
            name:  h ? h.pseudo : (pseudo(String(p && p.name || '').replace(/[\[\]]/g, '')) ? String(p.name) : ('IA ' + id)),
            color: h ? h.color : couleur(p && p.color, '#94A3B8'),
            isHuman: !!h,
            alive: true,
            stats: { ...STATS_BASE },
            tech: { homing: 0, tenacity: 0, mimicry: 0, _branchOrder: [] },
            multiSacrifice: 0, multiTier: 0,
            aiTimer: 0, aiCooldown: 1.5,
            bodies: [],
        });
    }
    /* Un humain de la salle absent de la liste du client : on l'ajoute, il
       ne doit pas disparaitre parce que l'hote l'a oublie. */
    for (const s of slots) {
        if (vus.has(s.slot)) continue;
        players.push({
            id: s.slot, name: s.pseudo, color: s.color, isHuman: true, alive: true,
            stats: { ...STATS_BASE }, tech: { homing: 0, tenacity: 0, mimicry: 0, _branchOrder: [] },
            multiSacrifice: 0, multiTier: 0, aiTimer: 0, aiCooldown: 1.5, bodies: [],
        });
    }
    players.sort((a, b) => a.id - b.id);

    const c = (u.config && typeof u.config === 'object') ? u.config : {};
    const config = {
        difficulty: ['easy', 'normal', 'brutal'].includes(c.difficulty) ? c.difficulty : 'normal',
        teamCount:  Math.round(nombre(c.teamCount, 0, 4, 0)),
        aiCount:    players.filter((p) => !p.isHuman).length,
        playerCount: players.length,
        useComets:  c.useComets !== false,
    };

    const cleaners = (Array.isArray(u.cleaners) ? u.cleaners.slice(0, LIMITES.nettoyeurs) : []).map((k) => ({
        type:  ['red', 'green', 'dark'].includes(k && k.type) ? k.type : 'red',
        x: nombre(k && k.x, -50000, 50000, 0), y: nombre(k && k.y, -50000, 50000, 0),
        vx: nombre(k && k.vx, -200, 200, 0),   vy: nombre(k && k.vy, -200, 200, 0),
        angle: nombre(k && k.angle, -1000, 1000, 0), size: nombre(k && k.size, 2, 30, 8),
    }));

    return {
        multiSeed:      Math.round(nombre(u.multiSeed, 1, 2147483646, 42)),
        blackHole,
        suns,
        asteroidBelts,
        players,
        config,
        jetRatio:       0.5,
        universeRadius: nombre(u.universeRadius, 2000, 20000, 6000),
        cleaners,
    };
}

module.exports = { nombre, texte, pseudo, couleur, limiteur, accepter, aExclure, nettoyerUnivers, STATS_BASE };
