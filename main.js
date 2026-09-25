/*
 * FtHoF Planner - a Cookie Clicker mod
 *
 * - Shows the upcoming Force the Hand of Fate (and Gambler's Fever Dream) result
 *   right under the spell in the Grimoire, plus a list of the next casts.
 * - Finds, in the current run, the next cast window that matches your combo filters.
 * - On the ascension screen, rerolls the seed of the next run until its
 *   FtHoF outcomes match your filters, and applies it when you reincarnate.
 *
 * Prediction mirrors the game code (v2.04x-2.05x):
 *   castSpell:  Math.seedrandom(Game.seed + '/' + M.spellsCastTotal)
 *   roll 0:     success if random < 1 - failChance
 *   shimmer:    +1 roll if season is valentines/easter, +2 rolls for x/y position
 *   win/fail:   choice rolls, then choose()
 */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Core (no Game dependency)                                          */
  /* ------------------------------------------------------------------ */

  // Same algorithm as the game's Math.seedrandom (ARC4, davidbau v2), without touching Math.random.
  var WIDTH = 256,
    CHUNKS = 6,
    MASK = 255,
    STARTDENOM = Math.pow(WIDTH, CHUNKS),
    SIGNIFICANCE = Math.pow(2, 52),
    OVERFLOW = SIGNIFICANCE * 2;

  function ARC4(key) {
    var t,
      keylen = key.length,
      i = 0,
      j = 0,
      s = (this.S = []);
    this.i = this.j = 0;
    if (!keylen) key = [keylen++];
    while (i < WIDTH) s[i] = i++;
    for (i = 0; i < WIDTH; i++) {
      s[i] = s[(j = MASK & (j + key[i % keylen] + (t = s[i])))];
      s[j] = t;
    }
    this.g(WIDTH);
  }
  ARC4.prototype.g = function (count) {
    var t,
      r = 0,
      i = this.i,
      j = this.j,
      s = this.S;
    while (count--) {
      t = s[(i = MASK & (i + 1))];
      r = r * WIDTH + s[MASK & ((s[i] = s[(j = MASK & (j + t))]) + (s[j] = t))];
    }
    this.i = i;
    this.j = j;
    return r;
  };

  function seededRandom(seed) {
    var key = [],
      str = seed + "",
      smear,
      j = 0;
    while (j < str.length) {
      key[MASK & j] = MASK & ((smear ^= key[MASK & j] * 19) + str.charCodeAt(j++));
    }
    var arc4 = new ARC4(key);
    return function () {
      var n = arc4.g(CHUNKS),
        d = STARTDENOM,
        x = 0;
      while (n < SIGNIFICANCE) {
        n = (n + x) * WIDTH;
        d *= WIDTH;
        x = arc4.g(1);
      }
      while (n >= OVERFLOW) {
        n /= 2;
        d /= 2;
        x >>>= 1;
      }
      return (n + x) / d;
    };
  }

  // The most rolls a single FtHoF cast can consume (roll + season + x/y + 4 choice rolls + choose).
  var ROLLS_PER_CAST = 9;

  function castRolls(seed, index) {
    var rng = seededRandom(seed + "/" + index);
    var r = new Array(ROLLS_PER_CAST);
    for (var i = 0; i < ROLLS_PER_CAST; i++) r[i] = rng();
    return r;
  }

  /**
   * Both possible FtHoF outcomes of one cast.
   * env: { seasonRoll, dragonflight, buildings10 }
   * Returns { roll, win, fail } where win/fail are the game's force keys.
   */
  function castOutcome(rolls, env) {
    var skip = 1 + (env.seasonRoll ? 1 : 0) + 2; // success roll, season picture, x, y

    var k = skip;
    var choices = ["frenzy", "multiply cookies"];
    if (!env.dragonflight) choices.push("click frenzy");
    if (rolls[k++] < 0.1) choices.push("cookie storm", "cookie storm", "blab");
    if (env.buildings10 && rolls[k++] < 0.25) choices.push("building special");
    if (rolls[k++] < 0.15) choices = ["cookie storm drop"];
    if (rolls[k++] < 0.0001) choices.push("free sugar lump");
    var win = choices[Math.floor(rolls[k++] * choices.length)];

    k = skip;
    choices = ["clot", "ruin cookies"];
    if (rolls[k++] < 0.1) choices.push("cursed finger", "blood frenzy");
    if (rolls[k++] < 0.003) choices.push("free sugar lump");
    if (rolls[k++] < 0.1) choices = ["blab"];
    var fail = choices[Math.floor(rolls[k++] * choices.length)];

    return { roll: rolls[0], win: win, fail: fail };
  }

  function resolve(outcome, failChance) {
    return outcome.roll < 1 - failChance ? outcome.win : outcome.fail;
  }

  /** Smallest number of golden cookies on screen that makes this cast backfire. */
  function backfireThreshold(roll, baseFail) {
    var n = Math.ceil((1 - baseFail - roll) / 0.15 - 1e-9);
    return Math.max(0, n);
  }

  /**
   * Lazily computes outcomes for consecutive casts of one seed.
   * at() uses the season in `env`; seasonAt() is the same cast after a season change
   * (switching to/from Easter or Valentine's adds/removes the season roll).
   */
  function SeedView(seed, startIndex, env) {
    this.seed = seed;
    this.start = startIndex;
    this.env = env;
    this.altEnv = { seasonRoll: !env.seasonRoll, dragonflight: env.dragonflight, buildings10: env.buildings10 };
    this.rolls = [];
    this.list = [];
    this.alt = [];
  }
  SeedView.prototype.rollsAt = function (offset) {
    var r = this.rolls[offset];
    if (!r) r = this.rolls[offset] = castRolls(this.seed, this.start + offset);
    return r;
  };
  SeedView.prototype.at = function (offset) {
    var o = this.list[offset];
    if (!o) o = this.list[offset] = castOutcome(this.rollsAt(offset), this.env);
    return o;
  };
  SeedView.prototype.seasonAt = function (offset) {
    var o = this.alt[offset];
    if (!o) o = this.alt[offset] = castOutcome(this.rollsAt(offset), this.altEnv);
    return o;
  };

  /**
   * Checks whether the `filter.k` casts starting at `s` contain at least the required counts.
   * With seasonChanges, each cast may instead use its season-change outcome.
   * Returns picks (per cast: 0 = no season change, 1 = season change) or null.
   */
  function matchWindow(view, s, filter, baseFail, seasonChanges) {
    var need = {},
      remaining = 0;
    for (var key in filter.req) {
      if (filter.req[key] > 0) {
        need[key] = filter.req[key];
        remaining += need[key];
      }
    }
    var picks = [];
    for (var p = 0; p < filter.k; p++) picks.push(0);
    if (remaining > filter.k) return null;

    var opts = [];
    for (var i = 0; i < filter.k; i++) {
      var fail = baseFail + 0.15 * (filter.stack ? i : 0);
      var a = resolve(view.at(s + i), fail);
      var b = seasonChanges ? resolve(view.seasonAt(s + i), fail) : a;
      opts.push(b === a ? [a] : [a, b]);
    }

    // Using a cast for a still-needed force is never worse than skipping it,
    // so we only branch between a cast's two outcomes.
    function dfs(i, left) {
      if (left === 0) return true;
      if (filter.k - i < left) return false;
      var used = false;
      for (var c = 0; c < opts[i].length; c++) {
        var force = opts[i][c];
        if (!(need[force] > 0)) continue;
        used = true;
        need[force]--;
        picks[i] = c;
        if (dfs(i + 1, left - 1)) return true;
        need[force]++;
      }
      picks[i] = 0;
      return used ? false : dfs(i + 1, left);
    }
    return dfs(0, remaining) ? picks : null;
  }

  /**
   * Finds the first window of `filter.k` consecutive casts, starting within the first
   * `filter.n` casts, that contains at least the required counts.
   * Returns { start, picks } or null.
   */
  function findWindow(view, filter, baseFail, seasonChanges) {
    var last = filter.n - filter.k;
    for (var s = 0; s <= last; s++) {
      var picks = matchWindow(view, s, filter, baseFail, seasonChanges);
      if (picks) return { start: s, picks: picks };
    }
    return null;
  }

  function seedMatches(seed, ctx) {
    var view = new SeedView(seed, ctx.start, ctx.env);
    for (var i = 0; i < ctx.filters.length; i++) {
      if (!findWindow(view, ctx.filters[i], ctx.baseFail, ctx.seasonChanges)) return false;
    }
    return true;
  }

  var LETTERS = "abcdefghijklmnopqrstuvwxyz";
  function randomSeed() {
    var s = "";
    for (var i = 0; i < 5; i++) s += LETTERS[Math.floor(Math.random() * 26)];
    return s;
  }

  var core = {
    seededRandom: seededRandom,
    castRolls: castRolls,
    castOutcome: castOutcome,
    resolve: resolve,
    backfireThreshold: backfireThreshold,
    SeedView: SeedView,
    matchWindow: matchWindow,
    findWindow: findWindow,
    seedMatches: seedMatches,
    randomSeed: randomSeed,
  };

  if (typeof root.Game === "undefined") {
    // Loaded outside the game (tests).
    if (typeof module === "object" && module.exports) module.exports = core;
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Mod                                                                */
  /* ------------------------------------------------------------------ */

  var Game = root.Game;
  if (root.FtHoFPlanner) return;
  var P = (root.FtHoFPlanner = { core: core });

  var FORCES = {
    frenzy: { name: "Frenzy", short: "Frenzy", color: "#ffd84a" },
    "multiply cookies": { name: "Lucky", short: "Lucky", color: "#ffe9a0" },
    "click frenzy": { name: "Click Frenzy", short: "CF", color: "#5fd8ff" },
    "cookie storm": { name: "Cookie Storm", short: "Storm", color: "#ffb347" },
    "cookie storm drop": { name: "Cookie Storm Drop", short: "Drop", color: "#b8a888" },
    blab: { name: "Blab", short: "Blab", color: "#aaaaaa" },
    "building special": { name: "Building Special", short: "BS", color: "#66ff66" },
    "free sugar lump": { name: "Free Sugar Lump", short: "Lump", color: "#ff88ff" },
    clot: { name: "Clot", short: "Clot", color: "#ff6666" },
    "ruin cookies": { name: "Ruin", short: "Ruin", color: "#ff6666" },
    "cursed finger": { name: "Cursed Finger", short: "Cursed", color: "#ff9966" },
    "blood frenzy": { name: "Elder Frenzy", short: "EF", color: "#ff3344" },
  };
  var FILTER_KEYS = [
    "click frenzy",
    "building special",
    "blood frenzy",
    "frenzy",
    "multiply cookies",
    "cookie storm",
    "free sugar lump",
  ];
  var SPELL_SHORT = {
    "conjure baked goods": "Conjure",
    "hand of fate": "FtHoF",
    "stretch time": "Stretch",
    "spontaneous edifice": "Edifice",
    "haggler's charm": "Haggler",
    "summon crafty pixies": "Pixies",
    "gambler's fever dream": "GFD",
    "resurrect abomination": "Abomination",
    "diminish ineptitude": "Diminish",
  };
  var WIN_FORCES = { frenzy: 1, "multiply cookies": 1, "click frenzy": 1, "cookie storm": 1, "cookie storm drop": 1, "building special": 1, "free sugar lump": 1 };

  var settings = {
    showUnderSpell: 1,
    upcomingCount: 10,
    autoSearchOnAscend: 1,
    applyOnReincarnate: 1,
    maxSeeds: 3000000,
    season: "auto", // auto | none | roll  (easter/valentines add a roll)
    supremeIntellect: "auto", // auto | on | off
    buildings10: 1,
    dragonflight: 0,
    seasonChanges: 0, // let filters use the season-change outcome of a cast
    filters: [defaultFilter()],
  };

  function defaultFilter() {
    return { n: 10, k: 2, stack: 0, req: { "click frenzy": 1, "building special": 1 } };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clampInt(v, min, max, def) {
    v = parseInt(v, 10);
    if (isNaN(v)) return def;
    return Math.max(min, Math.min(max, v));
  }
  function forceSpan(key, useShort) {
    var f = FORCES[key] || { name: key, short: key, color: "#fff" };
    return '<span style="color:' + f.color + ';">' + esc(useShort ? f.short : f.name) + "</span>";
  }
  function filterLabel(f) {
    var parts = [];
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      var key = FILTER_KEYS[i];
      if (f.req[key] > 0) parts.push((f.req[key] > 1 ? f.req[key] + "x " : "") + FORCES[key].short);
    }
    return (parts.length ? parts.join(" + ") : "anything") + " in " + f.k + " cast" + (f.k > 1 ? "s" : "") + (f.stack ? " (stacked)" : "");
  }
  /**
   * Matches every filter against a view. `n` overrides each filter's search range.
   * hits[offset] is 1 for a matching cast, 2 if it needs a season change first.
   */
  function filterHits(view, filters, baseFail, n) {
    var hits = {},
      matches = [];
    for (var i = 0; i < filters.length; i++) {
      var f = filters[i];
      var m = findWindow(view, n ? { n: n, k: f.k, stack: f.stack, req: f.req } : f, baseFail, settings.seasonChanges);
      matches.push({ filter: f, start: m ? m.start : -1 });
      if (m) for (var j = 0; j < f.k; j++) hits[m.start + j] = Math.max(hits[m.start + j] || 0, m.picks[j] ? 2 : 1);
    }
    return { hits: hits, matches: matches };
  }

  /** The force shown for a cast: the season-change outcome when a filter match needs it. */
  function hitForce(view, offset, hit, failChance) {
    return hit === 2 ? forceSpan(resolve(view.seasonAt(offset), failChance), true) + '<span class="fthofSeason" title="Change season before this cast">&#8644;</span>' : forceSpan(resolve(view.at(offset), failChance), true);
  }

  function seasonChangeLabel(env) {
    return env.seasonRoll ? "to a season other than Easter/Valentine's" : "to Easter or Valentine's";
  }

  function normalizeFilters(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var f = list[i] || {};
      var k = clampInt(f.k, 1, 10, 1);
      var n = clampInt(f.n, k, 500, Math.max(k, 10));
      var req = {};
      for (var j = 0; j < FILTER_KEYS.length; j++) {
        var key = FILTER_KEYS[j];
        req[key] = clampInt(f.req && f.req[key], 0, 10, 0);
      }
      out.push({ n: n, k: k, stack: f.stack ? 1 : 0, req: req });
    }
    return out;
  }

  /* ---------------- live (current run) prediction ---------------- */

  function getGrimoire() {
    var tower = Game.Objects["Wizard tower"];
    return tower && tower.minigameLoaded && tower.minigame && tower.minigame.spells ? tower.minigame : null;
  }

  function liveEnv() {
    return {
      seasonRoll: Game.season == "valentines" || Game.season == "easter",
      dragonflight: !!Game.hasBuff("Dragonflight"),
      buildings10: Game.BuildingsOwned >= 10,
    };
  }

  var live = null; // cached live state
  function computeLive(M) {
    var fthof = M.spells["hand of fate"];
    var onScreen = Game.shimmerTypes.golden.n;
    var failNow = M.getFailChance(fthof);
    var env = liveEnv();
    var state = {
      seed: Game.seed,
      index: M.spellsCastTotal,
      onScreen: onScreen,
      failNow: failNow,
      baseFail: failNow - 0.15 * onScreen,
      env: env,
      gfd: gfdEligible(M),
    };
    state.key = [
      state.seed,
      state.index,
      onScreen,
      Math.round(failNow * 1e6),
      env.seasonRoll ? 1 : 0,
      env.dragonflight ? 1 : 0,
      env.buildings10 ? 1 : 0,
      state.gfd ? state.gfd.map(function (s) { return s.id; }).join(".") : "-",
      settings.upcomingCount,
      P.filtersVersion,
    ].join("|");
    if (live && live.key === state.key) return live;
    state.view = new SeedView(state.seed, state.index, env);
    return (live = state);
  }

  function gfdEligible(M) {
    var gfd = M.spells["gambler's fever dream"];
    if (!gfd) return null;
    var selfCost = M.getSpellCost(gfd);
    var list = [];
    for (var i in M.spells) {
      if (i != "gambler's fever dream" && M.magic - selfCost >= M.getSpellCost(M.spells[i]) * 0.5) list.push(M.spells[i]);
    }
    return list;
  }

  /** What Gambler's Fever Dream would do if cast at `offset` casts from now. */
  function gfdPrediction(M, state, offset) {
    if (!state.gfd || !state.gfd.length) return null;
    var index = state.index + offset;
    var pick = state.gfd[Math.floor(seededRandom(state.seed + "/" + index)() * state.gfd.length)];
    // The picked spell is cast one second later, using the next cast index and >= 50% backfire.
    var failChance = Math.max(M.getFailChance(pick), 0.5);
    var outcome = state.view.at(offset + 1);
    var result = { spell: pick, key: null, success: true };
    if (pick.fail) result.success = outcome.roll < 1 - failChance;
    if (pick === M.spells["hand of fate"]) result.key = result.success ? outcome.win : outcome.fail;
    return result;
  }

  function gfdLabel(g, useShort) {
    if (!g) return '<span style="color:#999;">no eligible spell</span>';
    var name = g.spell.name;
    if (useShort) {
      var spells = getGrimoire().spells;
      for (var key in spells) if (spells[key] === g.spell && SPELL_SHORT[key]) name = SPELL_SHORT[key];
    }
    if (g.key) return esc(name) + " &rarr; " + forceSpan(g.key, useShort);
    return esc(name) + " " + (g.success ? '<span style="color:#6f6;">win</span>' : '<span style="color:#f66;">backfire</span>');
  }

  /* ---------------- grimoire UI ---------------- */

  function injectStyle() {
    if (document.getElementById("fthofStyle")) return;
    var css =
      "#grimoireSpells.fthofOn .grimoireSpell{margin-bottom:16px;}" +
      ".fthofUnder{position:absolute;left:-14px;right:-14px;top:76px;font-size:10px;line-height:12px;text-align:center;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 3px #000,0 0 5px #000;font-family:Tahoma,Arial,sans-serif;font-weight:bold;color:#fff;}" +
      "#fthofUpcoming{text-align:center;font-size:11px;margin:0 auto 4px auto;max-width:95%;color:rgba(255,255,255,0.8);text-shadow:-1px 1px 0 #000;position:relative;}" +
      ".fthofChip{display:inline-block;padding:1px 5px;margin:1px;border-radius:3px;background:rgba(0,0,0,0.55);font-weight:bold;font-family:Tahoma,Arial,sans-serif;font-size:10px;cursor:default;}" +
      ".fthofChip .fthofIdx{color:#888;font-weight:normal;margin-right:3px;}" +
      ".fthofChip.fthofHit{box-shadow:0 0 0 1px #6f6 inset;}" +
      ".fthofBtn{display:inline-block;cursor:pointer;padding:2px 6px;margin:2px;border-radius:3px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);color:#fff;font-size:11px;user-select:none;}" +
      ".fthofBtn:hover{background:rgba(255,255,255,0.25);}" +
      ".fthofBtn.fthofPrimary{background:rgba(80,160,255,0.35);border-color:rgba(120,190,255,0.7);}" +
      ".fthofMatch{font-size:10px;color:#ccc;margin-top:2px;}" +
      "#prompt.fthofPlanPrompt{width:min(760px,calc(100vw - 40px)) !important;left:50% !important;margin-left:0 !important;transform:translateX(-50%);box-sizing:border-box;}" +
      "#fthofPlanWrap{max-height:calc(100vh - 230px);min-height:120px;overflow:auto;margin:6px 0;}" +
      "#fthofPlanTable{border-collapse:collapse;width:100%;font-size:11px;}" +
      "#fthofPlanTable td,#fthofPlanTable th{padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.1);text-align:left;white-space:nowrap;}" +
      "#fthofPlanTable th{color:#ccc;position:sticky;top:0;background:#1a1a1a;z-index:1;}" +
      "#fthofPlanTable tr.fthofHit td{background:rgba(100,255,100,0.08);}" +
      "#fthofPlanTable tr.fthofHit td.fthofHitCell{background:rgba(100,255,100,0.22);}" +
      ".fthofGc{display:inline-block;padding:0 3px;border-radius:2px;background:rgba(255,255,255,0.12);color:#ccc;font-size:10px;font-weight:normal;}" +
      ".fthofGc.fthofEf{background:rgba(255,51,68,0.25);color:#ff8090;}" +
      "#fthofPlanTable .fthofSeasonCol{border-left:1px solid rgba(255,255,255,0.25);}" +
      ".fthofSeason{color:#8cf;margin-left:2px;}" +
      "#fthofAscendPanel{position:fixed;left:12px;bottom:12px;width:370px;max-height:calc(100vh - 24px);overflow-y:auto;z-index:100000000;background:rgba(0,0,0,0.85);border:1px solid rgba(255,255,255,0.3);border-radius:6px;box-shadow:0 0 12px #000;color:#fff;font-family:Tahoma,Arial,sans-serif;font-size:11px;padding:8px;display:none;}" +
      "#fthofAscendPanel h4{margin:0 0 6px 0;font-size:13px;cursor:pointer;}" +
      "#fthofAscendPanel input[type=number]{width:34px;background:#222;color:#fff;border:1px solid #555;border-radius:2px;font-size:11px;padding:1px 2px;}" +
      "#fthofAscendPanel select{background:#222;color:#fff;border:1px solid #555;font-size:11px;}" +
      "#fthofAscendPanel label{white-space:nowrap;margin-right:6px;}" +
      ".fthofFilter{border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:4px;margin:4px 0;}" +
      ".fthofSection{margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.15);}" +
      ".fthofMuted{color:#999;}";
    var el = document.createElement("style");
    el.id = "fthofStyle";
    el.textContent = css;
    document.head.appendChild(el);
  }

  function ensureGrimoireUI(M) {
    var spellsL = document.getElementById("grimoireSpells");
    if (!spellsL) return false;
    if (!document.getElementById("fthofUpcoming")) {
      var up = document.createElement("div");
      up.id = "fthofUpcoming";
      spellsL.parentNode.insertBefore(up, spellsL.nextSibling);
      live = null;
    }
    var ids = ["hand of fate", "gambler's fever dream"];
    for (var i = 0; i < ids.length; i++) {
      var spell = M.spells[ids[i]];
      if (!spell) continue;
      var spellL = document.getElementById("grimoireSpell" + spell.id);
      if (spellL && !document.getElementById("fthofUnder" + spell.id)) {
        var under = document.createElement("div");
        under.className = "fthofUnder";
        under.id = "fthofUnder" + spell.id;
        spellL.appendChild(under);
      }
    }
    if (!M.fthofWrapped) {
      var origTooltip = M.spellTooltip;
      M.spellTooltip = function (id) {
        var f = origTooltip(id);
        return function () {
          return f() + spellTooltipExtra(M, id);
        };
      };
      M.fthofWrapped = true;
    }
    return true;
  }

  function spellTooltipExtra(M, id) {
    var state = computeLive(M);
    var spell = M.spellsById[id];
    var str = '<div style="padding:0 8px 8px 8px;font-size:11px;"><div class="line"></div><b>FtHoF Planner</b> <small class="fthofMuted">(cast #' + (state.index + 1) + ", seed " + esc(state.seed) + ")</small><br>";
    if (spell === M.spells["hand of fate"]) {
      str += castDetails(state, 0);
    } else if (spell === M.spells["gambler's fever dream"]) {
      str += "Next GFD casts: " + gfdLabel(gfdPrediction(M, state, 0), false) + '<br><small class="fthofMuted">GFD picks from spells you can afford at half price, so the pick can change as your magic changes.</small>';
    } else {
      str += "Casting this uses up the next roll. FtHoF afterwards: " + forceSpan(resolve(state.view.at(1), state.failNow)) + ".";
    }
    return str + "</div>";
  }

  function castDetails(state, offset) {
    var o = state.view.at(offset);
    var now = resolve(o, state.failNow);
    var threshold = backfireThreshold(o.roll, state.baseFail);
    var str = "Result now: <b>" + forceSpan(now) + "</b> <small>(" + state.onScreen + " GC on screen)</small><br>";
    var alt = state.view.seasonAt(offset);
    str += "No season change: " + forceSpan(o.win) + " / backfire " + forceSpan(o.fail) + "<br>";
    str += "Season change <small>(" + seasonChangeLabel(state.env) + ")</small>: " + forceSpan(alt.win) + " / backfire " + forceSpan(alt.fail) + "<br>";
    str += '<small class="fthofMuted">Roll ' + o.roll.toFixed(4) + " &middot; ";
    str += threshold === 0 ? "backfires even with no golden cookies on screen" : "backfires with " + threshold + "+ golden cookies on screen";
    return str + "</small>";
  }

  P.chipTooltip = function (offset) {
    return function () {
      var M = getGrimoire();
      if (!M) return "";
      var state = computeLive(M);
      return (
        '<div style="padding:8px;min-width:260px;font-size:11px;"><b>Cast +' + offset + "</b> <small class=\"fthofMuted\">(spell #" + (state.index + offset + 1) + ")</small><div class=\"line\"></div>" +
        castDetails(state, offset) +
        (offset > 0 ? '<br><small class="fthofMuted">Cast ' + offset + " other spell" + (offset > 1 ? "s" : "") + " first to reach this one.</small>" : "") +
        "</div>"
      );
    };
  };

  var lastRenderedKey = null;
  function updateGrimoireUI(M) {
    if (!ensureGrimoireUI(M)) return;
    var state = computeLive(M);
    if (lastRenderedKey === state.key && document.getElementById("fthofUpcoming").innerHTML) return;
    lastRenderedKey = state.key;

    var spellsL = document.getElementById("grimoireSpells");
    spellsL.classList.toggle("fthofOn", !!settings.showUnderSpell);
    var fthof = M.spells["hand of fate"],
      gfd = M.spells["gambler's fever dream"];
    var underF = document.getElementById("fthofUnder" + fthof.id);
    if (underF) underF.innerHTML = settings.showUnderSpell ? forceSpan(resolve(state.view.at(0), state.failNow), true) : "";
    var underG = gfd && document.getElementById("fthofUnder" + gfd.id);
    if (underG) underG.innerHTML = settings.showUnderSpell ? gfdLabel(gfdPrediction(M, state, 0), true) : "";

    // Upcoming casts + next filter matches.
    var fh = filterHits(state.view, settings.filters, state.baseFail, 200);
    var hits = fh.hits,
      matches = fh.matches;
    var str = '<div class="fthofMuted" style="margin-bottom:2px;">Next FtHoF casts <small>(' + state.onScreen + " GC on screen, " + Math.round(state.failNow * 100) + "% backfire)</small></div>";
    for (var c = 0; c < settings.upcomingCount; c++) {
      str += '<span class="fthofChip' + (hits[c] ? " fthofHit" : "") + '" ' + Game.getDynamicTooltip("FtHoFPlanner.chipTooltip(" + c + ")", "this") + '><span class="fthofIdx">+' + c + "</span>" + hitForce(state.view, c, hits[c], state.failNow) + "</span>";
    }
    str += '<div class="fthofMatch">';
    for (var m = 0; m < matches.length; m++) {
      var mt = matches[m];
      str += (m ? " &middot; " : "") + esc(filterLabel(mt.filter)) + ": ";
      str += mt.start < 0 ? '<span style="color:#f66;">not in next 200</span>' : mt.start === 0 ? '<b style="color:#6f6;">now!</b>' : '<b style="color:#6f6;">in ' + mt.start + " cast" + (mt.start > 1 ? "s" : "") + "</b>";
    }
    str += ' <span class="fthofBtn" onclick="FtHoFPlanner.openPlanner();">Planner</span></div>';
    document.getElementById("fthofUpcoming").innerHTML = str;
  }

  P.openPlanner = function () {
    var M = getGrimoire();
    if (!M) return;
    var state = computeLive(M);
    var hits = filterHits(state.view, settings.filters, state.baseFail, 200).hits;
    var rows = "";
    for (var c = 0; c < 40; c++) {
      var o = state.view.at(c);
      var th = backfireThreshold(o.roll, state.baseFail);
      rows +=
        "<tr" + (hits[c] ? ' class="fthofHit"' : "") + "><td>+" + c + ' <small class="fthofMuted">#' + (state.index + c + 1) + "</small></td>" +
        "<td" + (hits[c] === 1 ? ' class="fthofHitCell"' : "") + ">" + planCell(o, th, state.failNow) + "</td>" +
        '<td class="fthofSeasonCol' + (hits[c] === 2 ? " fthofHitCell" : "") + '">' + planCell(state.view.seasonAt(c), th, state.failNow) + "</td>" +
        "<td>" + gfdLabel(gfdPrediction(M, state, c), true) + "</td></tr>";
    }
    Game.Prompt(
      "<id FtHoFPlanner><h3>Force the Hand of Fate planner</h3>" +
        '<div class="block" style="font-size:11px;">Seed <b>' + esc(state.seed) + "</b> &middot; " + state.index + " spells cast &middot; " + state.onScreen + " GC on screen &middot; season: " + esc(Game.season || "none") +
        (state.env.dragonflight ? " &middot; Dragonflight (no Click Frenzy)" : "") + (!state.env.buildings10 ? " &middot; fewer than 10 buildings (no Building Special)" : "") +
        '<div id="fthofPlanWrap"><table id="fthofPlanTable"><thead><tr><th>Cast</th><th>No season change</th><th class="fthofSeasonCol">Season change <small>(' + seasonChangeLabel(state.env) + ")</small></th><th>GFD here</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
        '<small class="fthofMuted"><span style="color:#f66;">Red</span> = backfires. <span class="fthofGc">N GC</span> = backfires with N or more golden cookies on screen. <span class="fthofGc fthofEf">N GC &rarr; Elder Frenzy</span> = the backfire is Elder Frenzy: let N golden cookies stack on screen (don\'t click them) before casting. Every spell you cast moves you down one row; changing the season does not. Green rows match your filters' +
        (settings.seasonChanges ? " (the brighter cell is the season to cast in)" : "") + ".</small></div>",
      [["Close", "Game.ClosePrompt();"]],
      0,
      "widePrompt fthofPlanPrompt"
    );
  };

  /** Planner cell: the result with the current backfire chance, in red if it backfires. */
  function planCell(o, threshold, failChance) {
    if (o.roll >= 1 - failChance) return '<span style="color:#f66;">' + esc(FORCES[o.fail].name) + "</span>";
    if (o.fail === "blood frenzy") {
      return forceSpan(o.win) + ' <span class="fthofGc fthofEf" title="Let ' + threshold + ' golden cookies stack on screen (don\'t click them) and this cast backfires into Elder Frenzy">' + threshold + " GC &rarr; Elder Frenzy</span>";
    }
    return forceSpan(o.win) + ' <span class="fthofGc" title="Backfires with ' + threshold + '+ golden cookies on screen">' + threshold + " GC</span>";
  }

  /* ---------------- ascension: seed reroll ---------------- */

  var search = { running: false, tested: 0, started: 0, result: null, status: "" };
  P.pendingSeed = null;
  P.filtersVersion = 0;

  function nextRunSpellIndex() {
    var tower = Game.Objects["Wizard tower"];
    if (!tower) return 0;
    if (tower.minigameLoaded && tower.minigame) return tower.minigame.spellsCastTotal || 0;
    var save = (tower.minigameSave || "").split(" ");
    return parseInt(save[2], 10) || 0;
  }

  function ascensionCtx() {
    var si = settings.supremeIntellect === "on" ? 1 : settings.supremeIntellect === "off" ? 0 : Game.auraMult ? Game.auraMult("Supreme Intellect") : 0;
    var seasonRoll = settings.season === "roll" ? true : settings.season === "none" ? false : Game.season == "valentines" || Game.season == "easter";
    return {
      start: nextRunSpellIndex(),
      baseFail: 0.15 * (1 + 0.1 * si),
      env: { seasonRoll: seasonRoll, dragonflight: !!settings.dragonflight, buildings10: !!settings.buildings10 },
      seasonChanges: !!settings.seasonChanges,
      filters: settings.filters,
    };
  }

  P.startSearch = function () {
    P.stopSearch();
    search = { running: true, tested: 0, started: Date.now(), result: null, status: "" };
    P.pendingSeed = null;
    var ctx = ascensionCtx();
    function tick() {
      if (!search.running) return;
      var t0 = Date.now();
      while (Date.now() - t0 < 30) {
        for (var b = 0; b < 100; b++) {
          var seed = randomSeed();
          search.tested++;
          if (seedMatches(seed, ctx)) {
            search.running = false;
            search.result = seed;
            P.pendingSeed = seed;
            search.status = "found";
            renderAscend();
            return;
          }
        }
        if (search.tested >= settings.maxSeeds) {
          search.running = false;
          search.status = "notfound";
          renderAscend();
          return;
        }
      }
      renderAscendStatus();
      search.timer = setTimeout(tick, 1);
    }
    renderAscend();
    tick();
  };

  P.stopSearch = function () {
    if (search.timer) clearTimeout(search.timer);
    if (search.running) search.status = "stopped";
    search.running = false;
  };

  P.reroll = function () {
    P.stopSearch();
    P.pendingSeed = randomSeed();
    search.status = seedMatches(P.pendingSeed, ascensionCtx()) ? "rollmatch" : "rollnomatch";
    renderAscend();
  };

  P.clearSeed = function () {
    P.stopSearch();
    P.pendingSeed = null;
    search.status = "";
    renderAscend();
  };

  function onSettingsChanged(restart) {
    settings.filters = normalizeFilters(settings.filters);
    P.filtersVersion++;
    live = null;
    lastRenderedKey = null;
    if (restart && search.running) P.startSearch();
    else if (P.pendingSeed && !search.running) search.status = seedMatches(P.pendingSeed, ascensionCtx()) ? "rollmatch" : "rollnomatch";
    renderAscend();
  }

  var panel = null;
  function buildPanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "fthofAscendPanel";
    // Keep the ascension screen from dragging / reacting to keys while using the panel.
    ["mousedown", "mouseup", "click", "wheel", "keydown", "keyup", "keypress", "touchstart", "touchend"].forEach(function (ev) {
      panel.addEventListener(ev, function (e) {
        e.stopPropagation();
      });
    });
    panel.addEventListener("change", onPanelInput);
    panel.addEventListener("click", onPanelClick);
    document.body.appendChild(panel);
    return panel;
  }

  var panelCollapsed = false;

  function renderAscend() {
    if (!panel) return;
    var ctx = ascensionCtx();
    var str = '<h4 data-act="collapse">FtHoF seed reroll <small class="fthofMuted">' + (panelCollapsed ? "[show]" : "[hide]") + "</small></h4>";
    if (panelCollapsed) {
      panel.innerHTML = str + '<div id="fthofAscStatus">' + statusText() + "</div>";
      return;
    }
    str += '<div>Next run seed: <b style="font-size:13px;">' + (P.pendingSeed ? esc(P.pendingSeed) : '<span class="fthofMuted">random</span>') + "</b>";
    str += ' <small class="fthofMuted">(first FtHoF roll is spell #' + (ctx.start + 1) + ")</small></div>";
    str += '<div style="margin:4px 0;">';
    str += search.running
      ? '<span class="fthofBtn" data-act="stop">Stop search</span>'
      : '<span class="fthofBtn fthofPrimary" data-act="search">Reroll until filters match</span>';
    str += '<span class="fthofBtn" data-act="reroll">Reroll once</span>';
    if (P.pendingSeed) str += '<span class="fthofBtn" data-act="clear">Use random seed</span>';
    str += "</div>";
    str += '<div id="fthofAscStatus">' + statusText() + "</div>";
    if (P.pendingSeed) str += previewHtml(P.pendingSeed, ctx);

    str += '<div class="fthofSection"><b>Filters</b> <small class="fthofMuted">(all must match)</small><br>';
    str += '<label title="Switching to or from Easter/Valentine\'s changes what a cast gives without using up a spell."><input type="checkbox" data-set="seasonChanges"' + (settings.seasonChanges ? " checked" : "") + "> I'll change seasons during my combo</label>";
    str += '<div class="fthofMuted">' + (settings.seasonChanges ? "Each cast can use its no-season-change or season-change result." : "Off: only results without a season change count.") + "</div>";
    for (var i = 0; i < settings.filters.length; i++) {
      var f = settings.filters[i];
      str += '<div class="fthofFilter">';
      str += 'Within the first <input type="number" min="1" max="500" data-f="' + i + '" data-field="n" value="' + f.n + '"> casts, ';
      str += '<input type="number" min="1" max="10" data-f="' + i + '" data-field="k" value="' + f.k + '"> in a row ';
      str += '<select data-f="' + i + '" data-field="stack"><option value="0"' + (f.stack ? "" : " selected") + '>click each GC before the next cast</option><option value="1"' + (f.stack ? " selected" : "") + ">let GCs stack (more backfires)</option></select>";
      str += ' <span class="fthofBtn" data-act="remove" data-f="' + i + '" title="Remove filter">&times;</span><br>';
      for (var j = 0; j < FILTER_KEYS.length; j++) {
        var key = FILTER_KEYS[j];
        str += '<label>' + forceSpan(key, true) + ' <input type="number" min="0" max="10" data-f="' + i + '" data-field="req" data-key="' + key + '" value="' + (f.req[key] || 0) + '"></label>';
      }
      str += "</div>";
    }
    str += '<span class="fthofBtn" data-act="add">+ Add filter</span></div>';

    str += '<div class="fthofSection"><b>Assumptions for the next run</b><br>';
    str += '<label>Season <select data-set="season">' + opt("auto", "current (" + (Game.season || "none") + ")", settings.season) + opt("none", "no extra roll", settings.season) + opt("roll", "Easter / Valentine's", settings.season) + "</select></label><br>";
    str += '<label>Supreme Intellect <select data-set="supremeIntellect">' + opt("auto", "current aura", settings.supremeIntellect) + opt("on", "on", settings.supremeIntellect) + opt("off", "off", settings.supremeIntellect) + "</select></label><br>";
    str += '<label><input type="checkbox" data-set="buildings10"' + (settings.buildings10 ? " checked" : "") + "> 10+ buildings when casting</label>";
    str += '<label><input type="checkbox" data-set="dragonflight"' + (settings.dragonflight ? " checked" : "") + "> Dragonflight active</label></div>";

    str += '<div class="fthofSection">';
    str += '<label><input type="checkbox" data-set="autoSearchOnAscend"' + (settings.autoSearchOnAscend ? " checked" : "") + "> Start searching when I ascend</label><br>";
    str += '<label><input type="checkbox" data-set="applyOnReincarnate"' + (settings.applyOnReincarnate ? " checked" : "") + "> Use this seed when I reincarnate</label><br>";
    str += '<label>Give up after <input type="number" style="width:70px" data-set="maxSeeds" min="1000" value="' + settings.maxSeeds + '"> seeds</label>';
    str += "</div>";
    panel.innerHTML = str;
  }

  function opt(value, label, current) {
    return '<option value="' + value + '"' + (value === current ? " selected" : "") + ">" + esc(label) + "</option>";
  }

  function statusText() {
    var rate = search.started ? Math.round(search.tested / Math.max(0.001, (Date.now() - search.started) / 1000)) : 0;
    var tested = search.tested ? Beautify(search.tested) + " seeds tested" + (rate ? " (" + Beautify(rate) + "/s)" : "") : "";
    switch (search.status) {
      case "":
        return search.running ? "Searching... " + tested : '<span class="fthofMuted">No seed chosen. The game will pick a random one.</span>';
      case "found":
        return '<b style="color:#6f6;">Match found!</b> ' + tested;
      case "notfound":
        return '<b style="color:#f66;">No match.</b> ' + tested + ". Try looser filters.";
      case "stopped":
        return "Search stopped. " + tested;
      case "rollmatch":
        return '<span style="color:#6f6;">This seed matches your filters.</span>';
      case "rollnomatch":
        return '<span style="color:#fc6;">This seed does not match your filters.</span>';
    }
    return "";
  }

  function renderAscendStatus() {
    var el = document.getElementById("fthofAscStatus");
    if (el) el.innerHTML = statusText();
  }

  function previewHtml(seed, ctx) {
    var view = new SeedView(seed, ctx.start, ctx.env);
    var count = 10;
    for (var i = 0; i < ctx.filters.length; i++) count = Math.max(count, Math.min(ctx.filters[i].n, 30));
    var fh = filterHits(view, ctx.filters, ctx.baseFail, 0);
    var hits = fh.hits;
    var lines = "";
    for (var f = 0; f < fh.matches.length; f++) {
      var s = fh.matches[f].start,
        k = fh.matches[f].filter.k;
      lines += "<div>" + esc(filterLabel(fh.matches[f].filter)) + ": " + (s < 0 ? '<span style="color:#f66;">no</span>' : '<span style="color:#6f6;">casts ' + (s + 1) + (k > 1 ? "-" + (s + k) : "") + "</span>") + "</div>";
    }
    var chips = "";
    for (var c = 0; c < count; c++) {
      var o = view.at(c),
        alt = view.seasonAt(c);
      var title = "No season change: " + FORCES[o.win].name + " / backfire " + FORCES[o.fail].name + "\nSeason change: " + FORCES[alt.win].name + " / backfire " + FORCES[alt.fail].name;
      chips += '<span class="fthofChip' + (hits[c] ? " fthofHit" : "") + '" title="' + esc(title) + '"><span class="fthofIdx">' + (c + 1) + "</span>" + hitForce(view, c, hits[c], ctx.baseFail) + "</span>";
    }
    var legend = ctx.seasonChanges ? '<div class="fthofMuted"><span class="fthofSeason">&#8644;</span> = change season (' + esc(seasonChangeLabel(ctx.env)) + ") before that cast</div>" : "";
    return '<div style="margin-top:4px;">' + chips + '</div><div class="fthofMatch">' + lines + legend + "</div>";
  }

  function onPanelClick(e) {
    var t = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!t) return;
    var act = t.getAttribute("data-act");
    if (act === "collapse") {
      panelCollapsed = !panelCollapsed;
      renderAscend();
    } else if (act === "search") P.startSearch();
    else if (act === "stop") {
      P.stopSearch();
      renderAscend();
    } else if (act === "reroll") P.reroll();
    else if (act === "clear") P.clearSeed();
    else if (act === "add") {
      settings.filters.push({ n: 10, k: 1, stack: 0, req: {} });
      onSettingsChanged(true);
    } else if (act === "remove") {
      settings.filters.splice(parseInt(t.getAttribute("data-f"), 10), 1);
      onSettingsChanged(true);
    }
  }

  function onPanelInput(e) {
    var t = e.target;
    var setKey = t.getAttribute("data-set");
    if (setKey) {
      if (t.type === "checkbox") settings[setKey] = t.checked ? 1 : 0;
      else if (setKey === "maxSeeds") settings.maxSeeds = clampInt(t.value, 1000, 1e9, 3000000);
      else settings[setKey] = t.value;
      onSettingsChanged(setKey !== "autoSearchOnAscend" && setKey !== "applyOnReincarnate" && setKey !== "maxSeeds");
      return;
    }
    var fi = t.getAttribute("data-f");
    if (fi === null) return;
    var f = settings.filters[parseInt(fi, 10)];
    if (!f) return;
    var field = t.getAttribute("data-field");
    if (field === "req") f.req[t.getAttribute("data-key")] = t.value;
    else f[field] = field === "stack" ? parseInt(t.value, 10) : t.value;
    onSettingsChanged(true);
  }

  var wasAscending = false;
  function watchAscension() {
    var asc = !!Game.OnAscend;
    if (asc && !wasAscending) {
      buildPanel();
      panel.style.display = "block";
      P.pendingSeed = null;
      search.status = "";
      search.tested = 0;
      renderAscend();
      if (settings.autoSearchOnAscend) P.startSearch();
    } else if (!asc && wasAscending) {
      P.stopSearch();
      if (panel) panel.style.display = "none";
    }
    wasAscending = asc;
  }

  function hookReincarnate() {
    var origMakeSeed = Game.makeSeed;
    Game.makeSeed = function () {
      if (P.forceNextSeed) {
        var s = P.forceNextSeed;
        P.forceNextSeed = null;
        return s;
      }
      return origMakeSeed.apply(this, arguments);
    };

    var origReincarnate = Game.Reincarnate;
    Game.Reincarnate = function (bypass) {
      if (bypass && Game.OnAscend && settings.applyOnReincarnate && search.running && !P.pendingSeed) {
        Game.Prompt(
          "<id FtHoFSearching><h3>Seed search still running</h3><div class=\"block\">FtHoF Planner has tested " + Beautify(search.tested) + " seeds without a match yet.</div>",
          [
            ["Keep searching", "Game.ClosePrompt();"],
            ["Reincarnate with a random seed", "Game.ClosePrompt();FtHoFPlanner.stopSearch();Game.Reincarnate(1);"],
          ]
        );
        return;
      }
      var applied = null;
      if (bypass && Game.OnAscend && settings.applyOnReincarnate && P.pendingSeed) {
        applied = P.forceNextSeed = P.pendingSeed;
      }
      var out = origReincarnate.apply(this, arguments);
      P.forceNextSeed = null;
      if (applied && Game.seed === applied) {
        Game.Notify("FtHoF Planner", "Started this run with seed <b>" + esc(applied) + "</b>.", [22, 11], 6);
        P.pendingSeed = null;
      }
      return out;
    };
  }

  /* ---------------- register ---------------- */

  Game.registerMod("fthof planner", {
    init: function () {
      injectStyle();
      hookReincarnate();
      Game.registerHook("logic", function () {
        if (Game.T % 5 !== 0) return;
        var M = getGrimoire();
        if (M) updateGrimoireUI(M);
      });
      setInterval(watchAscension, 250);
      Game.Notify("FtHoF Planner loaded", "Predictions are shown under Force the Hand of Fate in the Grimoire.", [22, 11], 4);
    },
    save: function () {
      return JSON.stringify(settings);
    },
    load: function (str) {
      try {
        var data = JSON.parse(str);
        for (var k in settings) if (k in data) settings[k] = data[k];
        settings.filters = normalizeFilters(settings.filters);
        onSettingsChanged(false);
      } catch (e) {
        console.error("FtHoF Planner: could not load settings", e);
      }
    },
  });
})(typeof window !== "undefined" ? window : this);
