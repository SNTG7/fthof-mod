// Checks the mod's predictions against the game's own seedrandom + a literal copy of the cast code.
// Usage: node test/verify.js [path/to/original/main.js]
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const core = require("../main.js");

const mainJs = process.argv[2] || path.join(__dirname, "../../fthof-planner-main/originals/2.05b/main.js");
const src = fs.readFileSync(mainJs, "utf8");
// Works on both the formatted copies in originals/ and the game's shipped (unformatted) main.js.
const start = src.search(/\(function ?\(a, ?b, ?c, ?d, ?e, ?f\) ?\{/);
const endMatch = /\}\)\(this, ?\[\], ?Math, ?256, ?6, ?52\);/.exec(src);
if (start < 0 || !endMatch || endMatch.index < start) throw new Error("seedrandom not found in " + mainJs);
const end = endMatch.index + endMatch[0].length;

const ctx = vm.createContext({ navigator: { plugins: [] }, screen: {} });
vm.runInContext(src.slice(start, end), ctx);

// Literal copy of the game path: castSpell -> shimmer initFunc -> win/fail.
vm.runInContext(
  `
  function choose(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function gameCast(seed, spellsCastTotal, failChance, season, dragonflight, buildingsOwned) {
    Math.seedrandom(seed + "/" + spellsCastTotal);
    var force;
    if (Math.random() < 1 - failChance) {
      if (season == "valentines" || season == "easter") Math.random();
      Math.random(); Math.random();
      var choices = [];
      choices.push("frenzy", "multiply cookies");
      if (!dragonflight) choices.push("click frenzy");
      if (Math.random() < 0.1) choices.push("cookie storm", "cookie storm", "blab");
      if (buildingsOwned >= 10 && Math.random() < 0.25) choices.push("building special");
      if (Math.random() < 0.15) choices = ["cookie storm drop"];
      if (Math.random() < 0.0001) choices.push("free sugar lump");
      force = choose(choices);
    } else {
      if (season == "valentines" || season == "easter") Math.random();
      Math.random(); Math.random();
      var choices = [];
      choices.push("clot", "ruin cookies");
      if (Math.random() < 0.1) choices.push("cursed finger", "blood frenzy");
      if (Math.random() < 0.003) choices.push("free sugar lump");
      if (Math.random() < 0.1) choices = ["blab"];
      force = choose(choices);
    }
    Math.seedrandom();
    return force;
  }
  `,
  ctx
);

let checks = 0;
let failures = 0;
function expectEq(a, b, what) {
  checks++;
  if (a !== b) {
    failures++;
    if (failures <= 10) console.log("MISMATCH", what, a, b);
  }
}

// 1) Raw PRNG stream.
for (let i = 0; i < 2000; i++) {
  const seed = core.randomSeed() + "/" + Math.floor(Math.random() * 5000);
  const mine = core.seededRandom(seed);
  vm.runInContext(`Math.seedrandom(${JSON.stringify(seed)})`, ctx);
  for (let k = 0; k < 12; k++) expectEq(mine(), vm.runInContext("Math.random()", ctx), "prng " + seed);
}

// 2) Full cast outcomes under different conditions.
const seasons = ["", "easter", "valentines", "christmas", "halloween"];
const counts = {};
for (let i = 0; i < 20000; i++) {
  const seed = core.randomSeed();
  const index = Math.floor(Math.random() * 3000);
  const season = seasons[i % seasons.length];
  const dragonflight = i % 7 === 0;
  const buildings = i % 11 === 0 ? 5 : 500;
  const failChance = [0.15, 0.165, 0.3, 0.45, 0.5, 0.95][i % 6];
  const expected = ctx.gameCast(seed, index, failChance, season, dragonflight, buildings);
  const outcome = core.castOutcome(core.castRolls(seed, index), {
    seasonRoll: season === "easter" || season === "valentines",
    dragonflight,
    buildings10: buildings >= 10,
  });
  const got = core.resolve(outcome, failChance);
  counts[got] = (counts[got] || 0) + 1;
  expectEq(got, expected, `cast ${seed}/${index} ${season} df=${dragonflight} b=${buildings} fc=${failChance}`);
}

// 3) Backfire threshold agrees with direct evaluation.
for (let i = 0; i < 5000; i++) {
  const roll = Math.random();
  const base = [0.15, 0.165, 0.015][i % 3];
  const th = core.backfireThreshold(roll, base);
  for (let n = 0; n < 8; n++) expectEq(roll >= 1 - (base + 0.15 * n), n >= th, "threshold");
}

// 4) Seed search speed on the default filter (Click Frenzy + Building Special in 2 casts within 10).
const filter = { n: 10, k: 2, stack: 0, req: { "click frenzy": 1, "building special": 1 } };
const searchCtx = { start: 0, baseFail: 0.15, env: { seasonRoll: false, dragonflight: false, buildings10: true }, filters: [filter] };
const t0 = Date.now();
let tested = 0,
  matched = 0;
while (Date.now() - t0 < 1000) {
  tested++;
  if (core.seedMatches(core.randomSeed(), searchCtx)) matched++;
}

console.log("outcome distribution (20k casts):", counts);
console.log(`search: ${tested} seeds/s, ${((matched / tested) * 100).toFixed(2)}% match CF+BS double cast within 10`);
console.log(failures ? `FAILED ${failures}/${checks}` : `OK ${checks} checks`);
process.exit(failures ? 1 : 0);
