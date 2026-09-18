// Run with: node tests/model.test.js
const assert = require("assert")
const fs = require("fs")
const path = require("path")
const M = require("../Model.js")

const binds = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "binds.json"), "utf8"))
let passed = 0
function test(name, fn) { fn(); passed += 1; console.log("ok - " + name) }
// Deterministic "random": cycles through the given values.
function seq(values) { let i = 0; return () => values[i++ % values.length] }

test("cardsFromBinds keeps only askable, described, modified, default-submap chords", () => {
  const cards = M.cardsFromBinds(binds)
  assert.deepStrictEqual(cards.map((c) => c.id),
    ["SUPER+W", "SUPER+RETURN", "SUPER+SHIFT+B", "SUPER+B", "SUPER+3", "SUPER+SHIFT+0", "SUPER+CTRL+COMMA"])
  assert.strictEqual(cards[0].description, "Close window")            // first of a duplicate chord wins
  assert.deepStrictEqual(M.keycaps(cards[2]), ["SUPER", "SHIFT", "B"])
  assert.deepStrictEqual(M.keycaps(cards[6]), ["SUPER", "CTRL", ","])
  assert.strictEqual(cards[4].inferred, true)
  assert.strictEqual(cards[0].inferred, false)
})

test("inferDigitKey reads trailing numbers only", () => {
  assert.strictEqual(M.inferDigitKey("Switch to workspace 1"), "1")
  assert.strictEqual(M.inferDigitKey("Bar panel 10"), "0")
  assert.strictEqual(M.inferDigitKey("Bar panel 11"), "")
  assert.strictEqual(M.inferDigitKey("Expand window left"), "")
  assert.strictEqual(M.inferDigitKey("Window2"), "")
})

test("canonicalKey normalizes names and rejects what can't be asked", () => {
  assert.strictEqual(M.canonicalKey("w"), "W")
  assert.strictEqual(M.canonicalKey("Home"), "HOME")
  assert.strictEqual(M.canonicalKey("ENTER"), "RETURN")
  assert.strictEqual(M.canonicalKey("F9"), "F9")
  assert.strictEqual(M.canonicalKey("F13"), "")
  assert.strictEqual(M.canonicalKey("ESCAPE"), "")
  assert.strictEqual(M.canonicalKey("XF86PowerOff"), "")
  assert.strictEqual(M.canonicalKey("mouse:272"), "")
})

test("pressChordId matches presses to chords, shift-safe", () => {
  const Q = M.QT
  assert.strictEqual(M.pressChordId({ key: 0x57, scanCode: 25, meta: true }), "SUPER+W")
  assert.strictEqual(M.pressChordId({ key: 0x42, scanCode: 56, meta: true, shift: true }), "SUPER+SHIFT+B")
  // SHIFT+0 arrives from Qt as ")" (0x29); the scancode still says 0.
  assert.strictEqual(M.pressChordId({ key: 0x29, scanCode: 19, meta: true, shift: true }), "SUPER+SHIFT+0")
  assert.strictEqual(M.pressChordId({ key: 0x33, scanCode: 12, meta: true }), "SUPER+3")
  assert.strictEqual(M.pressChordId({ key: 0x2c, scanCode: 59, meta: true, ctrl: true }), "SUPER+CTRL+COMMA")
  assert.strictEqual(M.pressChordId({ key: 0x01000004, scanCode: 36, meta: true }), "SUPER+RETURN")
  assert.strictEqual(M.pressChordId({ key: Q.F1 + 8, scanCode: 75, alt: true }), "ALT+F9")
  assert.strictEqual(M.pressChordId({ key: 0x01000022, scanCode: 133, meta: true }), "")  // Meta alone
  assert.strictEqual(M.pressChordId({ key: 0x01000090, scanCode: 200, meta: true }), "")  // unknown key
  assert.strictEqual(M.pressChordId({ key: 0x20, scanCode: 65 }), "SPACE")                // bare key: a control
})

test("pickCard favours unseen and missed cards, honours exclusions", () => {
  const cards = M.cardsFromBinds(binds).slice(0, 3)
  const stats = { "SUPER+W": { seen: 10, correct: 10 }, "SUPER+RETURN": { seen: 4, correct: 0 } }
  assert.ok(M.cardWeight(stats["SUPER+RETURN"]) > M.cardWeight(null))
  assert.ok(M.cardWeight(null) > M.cardWeight(stats["SUPER+W"]))
  // weights: W 0.4, RETURN 4.4, B 3 -> total 7.8
  assert.strictEqual(M.pickCard(cards, stats, [], () => 0.01).id, "SUPER+W")
  assert.strictEqual(M.pickCard(cards, stats, [], () => 0.5).id, "SUPER+RETURN")
  assert.strictEqual(M.pickCard(cards, stats, [], () => 0.99).id, "SUPER+SHIFT+B")
  assert.strictEqual(M.pickCard(cards, stats, ["SUPER+RETURN", "SUPER+SHIFT+B"], () => 0.99).id, "SUPER+W")
  assert.strictEqual(M.pickCard(cards, stats, cards.map((c) => c.id), () => 0.5), null)
})

test("choicesFor includes the answer once and prefers same-modifier decoys", () => {
  const cards = M.cardsFromBinds(binds)
  const card = M.cardById(cards, "SUPER+W")
  const choices = M.choicesFor(card, cards, 4, seq([0.1, 0.7, 0.3, 0.9, 0.5]))
  assert.strictEqual(choices.length, 4)
  assert.strictEqual(choices.filter((c) => c.id === "SUPER+W").length, 1)
  assert.ok(choices.filter((c) => c.id !== "SUPER+W").every((c) => c.modmask === 64))
  assert.strictEqual(M.choicesFor(card, [card], 4, () => 0.5).length, 1)
})

test("stats round-trip and scoring", () => {
  let stats = {}
  stats = M.recordAnswer(stats, "SUPER+W", true, 100)
  stats = M.recordAnswer(stats, "SUPER+W", false, 200)
  stats = M.recordAnswer(stats, "SUPER+B", true, 300)
  assert.deepStrictEqual(stats["SUPER+W"], { seen: 2, correct: 1, last: 200 })
  assert.deepStrictEqual(M.parseStats(M.serializeStats(stats)), stats)
  assert.deepStrictEqual(M.parseStats("not json"), {})
  assert.deepStrictEqual(M.parseStats('{"version":1}'), {})

  const cards = M.cardsFromBinds(binds)
  const weak = M.weakest(cards, stats, 5)
  assert.deepStrictEqual(weak.map((w) => w.card.id), ["SUPER+W"])
  const solid = { "SUPER+B": { seen: 5, correct: 5, last: 1 } }
  assert.deepStrictEqual(M.progress(cards, solid), { total: 7, seen: 1, solid: 1 })
  assert.strictEqual(M.rank(0, 7), "White belt")
  assert.strictEqual(M.rank(1, 7), "Yellow belt")
  assert.strictEqual(M.rank(7, 7), "Black belt")
  assert.strictEqual(M.rank(0, 0), "No bindings found")
})

console.log("\n" + passed + " tests passed")
