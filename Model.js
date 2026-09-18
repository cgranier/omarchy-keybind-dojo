// Pure logic for Keybind Dojo: turning `hyprctl binds -j` into quiz cards,
// matching pressed chords, picking what to ask next, and keeping score.
// No QML imports, so it runs under node for tests.

var MOD_SHIFT = 1
var MOD_CTRL = 4
var MOD_ALT = 8
var MOD_SUPER = 64
var MOD_ORDER = [[MOD_SUPER, "SUPER"], [MOD_CTRL, "CTRL"], [MOD_ALT, "ALT"], [MOD_SHIFT, "SHIFT"]]

// Hyprland key names the quiz can ask for, mapped to the label shown on the
// keycap. Media keys, mouse buttons, and switches are left out: they are not
// chords worth drilling, and some (power, lid) are not safe to ask for.
var NAMED_KEYS = {
  RETURN: "RETURN", ENTER: "RETURN", SPACE: "SPACE", TAB: "TAB", BACKSPACE: "BACKSPACE", DELETE: "DELETE",
  LEFT: "LEFT", RIGHT: "RIGHT", UP: "UP", DOWN: "DOWN", HOME: "HOME", END: "END",
  PAGE_UP: "PGUP", PRIOR: "PGUP", PAGE_DOWN: "PGDN", NEXT: "PGDN", PRINT: "PRINT",
  COMMA: ",", PERIOD: ".", SLASH: "/", MINUS: "-", EQUAL: "=", SEMICOLON: ";", APOSTROPHE: "'",
  BRACKETLEFT: "[", BRACKETRIGHT: "]", BACKSLASH: "\\", GRAVE: "`"
}

function modNames(modmask) {
  var names = []
  for (var i = 0; i < MOD_ORDER.length; i++) if (modmask & MOD_ORDER[i][0]) names.push(MOD_ORDER[i][1])
  return names
}

// Canonical key id used for matching: "A".."Z", "0".."9", "F1".."F12", or a
// NAMED_KEYS name. Empty when the key is not something the quiz can ask for.
function canonicalKey(key) {
  var value = String(key || "").trim()
  if (value === "") return ""
  var upper = value.toUpperCase()
  if (/^[A-Z0-9]$/.test(upper)) return upper
  if (/^F([1-9]|1[0-2])$/.test(upper)) return upper
  if (upper === "ESCAPE") return ""   // reserved: leaves the dojo
  if (NAMED_KEYS[upper] !== undefined) {
    // Collapse aliases (ENTER -> RETURN, PRIOR -> PAGE_UP) onto one id.
    if (upper === "ENTER") return "RETURN"
    if (upper === "PRIOR") return "PAGE_UP"
    if (upper === "NEXT") return "PAGE_DOWN"
    return upper
  }
  return ""
}

function keyLabel(canonical) {
  return NAMED_KEYS[canonical] !== undefined ? NAMED_KEYS[canonical] : canonical
}

// Hyprland's Lua config provider reports `code:N` binds with an empty key.
// For the numbered families ("Switch to workspace 3") the description gives
// the digit away: N, with 10 living on the 0 key.
function inferDigitKey(description) {
  var match = /(?:^|\s)(\d{1,2})$/.exec(String(description || "").trim())
  if (!match) return ""
  var n = parseInt(match[1], 10)
  if (n >= 1 && n <= 9) return String(n)
  if (n === 10) return "0"
  return ""
}

function chordId(modmask, canonical) {
  return modNames(modmask).concat([canonical]).join("+")
}

// Quiz cards from raw binds. A card needs a description, a modifier (bare
// keys are the dojo's own controls), and a key we can both show and detect.
// Two binds on one chord (e.g. a press and a release variant) become one
// card carrying the first description.
function cardsFromBinds(binds) {
  var cards = []
  var seen = {}
  for (var i = 0; i < (binds || []).length; i++) {
    var bind = binds[i] || {}
    if (String(bind.submap || "") !== "") continue
    if (bind.mouse === true || bind.catch_all === true) continue
    var description = String(bind.description || "").trim()
    if (description === "") continue
    var modmask = (Number(bind.modmask) || 0) & (MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_SUPER)
    if (modmask === 0) continue

    var rawKey = String(bind.key || "")
    var inferred = false
    if (rawKey === "") {
      rawKey = inferDigitKey(description)
      inferred = rawKey !== ""
    }
    var key = canonicalKey(rawKey)
    if (key === "") continue

    var id = chordId(modmask, key)
    if (seen[id]) continue
    seen[id] = true
    cards.push({ id: id, modmask: modmask, key: key, mods: modNames(modmask), keyLabel: keyLabel(key),
      description: description, inferred: inferred })
  }
  return cards
}

function keycaps(card) {
  return card.mods.concat([card.keyLabel])
}

// ---- Reading a key press -------------------------------------------------
// `press` is a plain object the QML side builds from a KeyEvent:
//   { key: Qt key int, scanCode: native scancode, shift/ctrl/alt/meta: bool }
// QT maps the Qt::Key values this needs, so the logic stays testable.
var QT = {
  A: 0x41, Z: 0x5a, ZERO: 0x30, NINE: 0x39, F1: 0x01000030, F12: 0x0100003b,
  named: {
    0x01000004: "RETURN", 0x01000005: "RETURN", 0x20: "SPACE", 0x01000001: "TAB", 0x01000002: "TAB",
    0x01000003: "BACKSPACE", 0x01000007: "DELETE", 0x01000012: "LEFT", 0x01000014: "RIGHT",
    0x01000013: "UP", 0x01000015: "DOWN", 0x01000010: "HOME", 0x01000011: "END",
    0x01000016: "PAGE_UP", 0x01000017: "PAGE_DOWN", 0x01000009: "PRINT",
    0x2c: "COMMA", 0x2e: "PERIOD", 0x2f: "SLASH", 0x2d: "MINUS", 0x3d: "EQUAL", 0x3b: "SEMICOLON",
    0x27: "APOSTROPHE", 0x5b: "BRACKETLEFT", 0x5d: "BRACKETRIGHT", 0x5c: "BACKSLASH", 0x60: "GRAVE"
  },
  modifiers: [0x01000020, 0x01000021, 0x01000022, 0x01000023, 0x01001103, 0x01000024, 0x01000025]
}

// With SHIFT held, Qt reports the shifted symbol ("!" for "1", "<" for ","),
// so position-stable keys are read from the evdev scancode (+8) instead.
var SCANCODES = {
  10: "1", 11: "2", 12: "3", 13: "4", 14: "5", 15: "6", 16: "7", 17: "8", 18: "9", 19: "0",
  20: "MINUS", 21: "EQUAL", 34: "BRACKETLEFT", 35: "BRACKETRIGHT", 47: "SEMICOLON", 48: "APOSTROPHE",
  49: "GRAVE", 51: "BACKSLASH", 59: "COMMA", 60: "PERIOD", 61: "SLASH"
}

// Physical modifier keys by scancode (evdev + 8). Layout options remap what a
// modifier *means* — with shift:both_capslock_cancel, releasing Shift arrives
// as Caps Lock — but not where it sits, so position is what gets trusted.
var MODIFIER_SCANCODES = {
  50: MOD_SHIFT, 62: MOD_SHIFT, 37: MOD_CTRL, 105: MOD_CTRL, 64: MOD_ALT, 108: MOD_ALT, 133: MOD_SUPER, 134: MOD_SUPER
}

var QT_MODIFIER_BITS = {
  0x01000020: MOD_SHIFT, 0x01000021: MOD_CTRL, 0x01000023: MOD_ALT, 0x01000022: MOD_SUPER,
  0x01000053: MOD_SUPER, 0x01000054: MOD_SUPER
}

// Which modifier a key event is for, or 0. Scancode first, Qt key as the
// fallback for keyboards that report something unusual.
function modifierBit(press) {
  var byPosition = MODIFIER_SCANCODES[press.scanCode]
  if (byPosition !== undefined) return byPosition
  return QT_MODIFIER_BITS[Number(press.key) || 0] || 0
}

function isModifierKey(qtKey, scanCode) {
  if (MODIFIER_SCANCODES[scanCode] !== undefined) return true
  return QT.modifiers.indexOf(qtKey) !== -1
}

function pressModmask(press) {
  return (press.shift ? MOD_SHIFT : 0) | (press.ctrl ? MOD_CTRL : 0) | (press.alt ? MOD_ALT : 0) | (press.meta ? MOD_SUPER : 0)
}

function pressKey(press) {
  var key = Number(press.key) || 0
  if (SCANCODES[press.scanCode] !== undefined) return SCANCODES[press.scanCode]
  if (key >= QT.A && key <= QT.Z) return String.fromCharCode(key)
  if (key >= QT.ZERO && key <= QT.NINE) return String.fromCharCode(key)
  if (key >= QT.F1 && key <= QT.F12) return "F" + (key - QT.F1 + 1)
  return QT.named[key] || ""
}

// The chord id for a press, or "" while only modifiers are down or the key is
// one the dojo doesn't know.
function pressChordId(press) {
  if (isModifierKey(Number(press.key) || 0, press.scanCode)) return ""
  var key = pressKey(press)
  if (key === "") return ""
  return chordId(pressModmask(press), key)
}

function cardById(cards, id) {
  for (var i = 0; i < (cards || []).length; i++) if (cards[i].id === id) return cards[i]
  return null
}

// ---- Choosing what to ask ------------------------------------------------
// Weight per card: never-seen cards and ones you miss come up more, ones you
// have nailed fade (never to zero, so they still resurface).
function cardWeight(stat) {
  if (!stat || !stat.seen) return 3
  var accuracy = stat.correct / stat.seen
  return 0.4 + (1 - accuracy) * 4 + (stat.seen < 3 ? 1 : 0)
}

// `random` is a function returning [0,1); injected so tests are deterministic.
function pickCard(cards, stats, excludeIds, random) {
  var pool = []
  var total = 0
  for (var i = 0; i < (cards || []).length; i++) {
    if (excludeIds && excludeIds.indexOf(cards[i].id) !== -1) continue
    var weight = cardWeight(stats ? stats[cards[i].id] : null)
    pool.push({ card: cards[i], weight: weight })
    total += weight
  }
  if (pool.length === 0) return null
  var roll = random() * total
  for (var p = 0; p < pool.length; p++) {
    roll -= pool[p].weight
    if (roll < 0) return pool[p].card
  }
  return pool[pool.length - 1].card
}

// Multiple-choice options for "name it": the right card plus decoys, shuffled.
// Decoys prefer cards sharing the same modifiers, which are the ones people
// actually confuse.
function choicesFor(card, cards, count, random) {
  var near = []
  var far = []
  for (var i = 0; i < (cards || []).length; i++) {
    var other = cards[i]
    if (other.id === card.id || other.description === card.description) continue
    if (other.modmask === card.modmask) near.push(other)
    else far.push(other)
  }
  var decoys = shuffle(near, random).concat(shuffle(far, random)).slice(0, Math.max(0, count - 1))
  return shuffle([card].concat(decoys), random)
}

function shuffle(list, random) {
  var result = list.slice()
  for (var i = result.length - 1; i > 0; i--) {
    var j = Math.floor(random() * (i + 1))
    var swap = result[i]
    result[i] = result[j]
    result[j] = swap
  }
  return result
}

// ---- Keeping score -------------------------------------------------------
function recordAnswer(stats, cardId, correct, nowMs) {
  var next = {}
  for (var key in stats || {}) next[key] = stats[key]
  var stat = next[cardId] || { seen: 0, correct: 0, last: 0 }
  next[cardId] = { seen: stat.seen + 1, correct: stat.correct + (correct ? 1 : 0), last: nowMs || 0 }
  return next
}

function parseStats(raw) {
  try {
    var doc = JSON.parse(String(raw || "{}"))
    var cards = doc && doc.cards
    return cards && typeof cards === "object" ? cards : {}
  } catch (e) {
    return {}
  }
}

function serializeStats(stats) {
  return JSON.stringify({ version: 1, cards: stats || {} }, null, 2) + "\n"
}

// The cards you get wrong most, among those asked at least twice.
function weakest(cards, stats, limit) {
  var rows = []
  for (var i = 0; i < (cards || []).length; i++) {
    var stat = stats ? stats[cards[i].id] : null
    if (!stat || stat.seen < 2 || stat.correct === stat.seen) continue
    rows.push({ card: cards[i], seen: stat.seen, correct: stat.correct, accuracy: stat.correct / stat.seen })
  }
  rows.sort(function(a, b) { return a.accuracy - b.accuracy || b.seen - a.seen })
  return rows.slice(0, limit)
}

function progress(cards, stats) {
  var seen = 0
  var solid = 0
  for (var i = 0; i < (cards || []).length; i++) {
    var stat = stats ? stats[cards[i].id] : null
    if (!stat || !stat.seen) continue
    seen += 1
    if (stat.seen >= 3 && stat.correct / stat.seen >= 0.8) solid += 1
  }
  return { total: (cards || []).length, seen: seen, solid: solid }
}

function rank(solid, total) {
  if (total === 0) return "No bindings found"
  var share = solid / total
  if (share >= 0.9) return "Black belt"
  if (share >= 0.6) return "Brown belt"
  if (share >= 0.35) return "Green belt"
  if (share >= 0.1) return "Yellow belt"
  return "White belt"
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MOD_SHIFT: MOD_SHIFT, MOD_CTRL: MOD_CTRL, MOD_ALT: MOD_ALT, MOD_SUPER: MOD_SUPER, QT: QT,
    modNames: modNames, canonicalKey: canonicalKey, keyLabel: keyLabel, inferDigitKey: inferDigitKey,
    chordId: chordId, cardsFromBinds: cardsFromBinds, keycaps: keycaps, isModifierKey: isModifierKey, modifierBit: modifierBit,
    pressModmask: pressModmask, pressKey: pressKey, pressChordId: pressChordId, cardById: cardById,
    cardWeight: cardWeight, pickCard: pickCard, choicesFor: choicesFor, shuffle: shuffle,
    recordAnswer: recordAnswer, parseStats: parseStats, serializeStats: serializeStats,
    weakest: weakest, progress: progress, rank: rank
  }
}
