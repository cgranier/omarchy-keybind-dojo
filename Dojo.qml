import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Keybind Dojo: a fullscreen quiz over the keybindings you actually have.
// "Press it" shows what a binding does and waits for the chord; "Name it"
// shows the chord and asks what it does. Global binds are suspended while the
// dojo is open (see bin/dojo-submap) so the chords reach the quiz.
Item {
  id: root

  property var shell: null
  property var manifest: null

  property bool opened: false
  property string phase: "loading"   // loading | ask | reveal | summary | empty
  property string mode: "press"      // press | name
  property var cards: []
  property var stats: ({})
  property var card: null
  property var choices: []
  property var asked: []
  property int roundLength: 10
  property int roundCorrect: 0
  property int streak: 0
  property int bestStreak: 0
  property bool lastCorrect: false
  property string feedback: ""
  property int heldMods: 0
  property int pickedChoice: -1
  property var missed: []

  readonly property string pluginId: (manifest && manifest.id) || "cgranier.dojo"
  readonly property string submapScript: String(Qt.resolvedUrl("bin/dojo-submap")).replace(/^file:\/\//, "")
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/omarchy-dojo"
  readonly property var progress: Model.progress(cards, stats)

  readonly property string fontFamily: Style.font.menuFamily
  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color dim: Qt.darker(foreground, 1.6)
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  readonly property color good: Color.menu.selectedText
  readonly property var borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))

  // ---- Lifecycle, as the shell drives it --------------------------------
  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = ({}) }
    if (payload.mode === "name" || payload.mode === "press") mode = payload.mode

    opened = true
    phase = "loading"
    heldMods = 0
    Quickshell.execDetached(["bash", submapScript, "enter"])
    bindsProcess.running = true
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    if (!opened) return
    opened = false
    Quickshell.execDetached(["bash", submapScript, "leave"])
    saveStats()
  }

  function dismiss() {
    close()
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
  }

  function toggle() {
    if (opened) dismiss()
    else open("{}")
  }

  Component.onDestruction: if (opened) Quickshell.execDetached(["bash", submapScript, "leave"])

  // ---- Round flow ---------------------------------------------------------
  function startRound() {
    asked = []
    missed = []
    roundCorrect = 0
    streak = 0
    if (cards.length === 0) { phase = "empty"; return }
    nextCard()
  }

  function nextCard() {
    if (asked.length >= Math.min(roundLength, cards.length)) { phase = "summary"; saveStats(); return }
    card = Model.pickCard(cards, stats, asked, Math.random)
    asked = asked.concat([card.id])
    choices = mode === "name" ? Model.choicesFor(card, cards, 4, Math.random) : []
    pickedChoice = -1
    feedback = ""
    phase = "ask"
  }

  function answer(correct, note) {
    lastCorrect = correct
    feedback = note || ""
    stats = Model.recordAnswer(stats, card.id, correct, Date.now())
    if (correct) {
      roundCorrect += 1
      streak += 1
      bestStreak = Math.max(bestStreak, streak)
    } else {
      streak = 0
      missed = missed.concat([card])
    }
    phase = "reveal"
    if (correct) advanceTimer.restart()
  }

  function switchMode() {
    mode = mode === "press" ? "name" : "press"
    startRound()
  }

  function handleChord(chordId) {
    if (phase === "ask" && mode === "press") {
      if (chordId === card.id) { answer(true, ""); return }
      var other = Model.cardById(cards, chordId)
      answer(false, other ? "That one is “" + other.description + "”" : "Nothing is bound to that")
      return
    }
    // After a miss, pressing the right chord is how you move on: the point is
    // for your hands to do it once correctly.
    if (phase === "reveal" && !lastCorrect && chordId === card.id) nextCard()
  }

  function choose(index) {
    if (phase !== "ask" || mode !== "name" || index < 0 || index >= choices.length) return
    pickedChoice = index
    var right = choices[index].id === card.id
    answer(right, right ? "" : "That one is " + Model.keycaps(choices[index]).join(" + "))
  }

  function handleKey(event) {
    var mods = Model.pressModmask({
      shift: !!(event.modifiers & Qt.ShiftModifier), ctrl: !!(event.modifiers & Qt.ControlModifier),
      alt: !!(event.modifiers & Qt.AltModifier), meta: !!(event.modifiers & Qt.MetaModifier)
    })

    if (Model.isModifierKey(event.key, event.nativeScanCode)) return
    if (mods === 0) { handleControl(event); return }

    var chord = Model.pressChordId({
      key: event.key, scanCode: event.nativeScanCode,
      shift: !!(mods & Model.MOD_SHIFT), ctrl: !!(mods & Model.MOD_CTRL),
      alt: !!(mods & Model.MOD_ALT), meta: !!(mods & Model.MOD_SUPER)
    })
    if (chord !== "") handleChord(chord)
  }

  // Bare keys never appear on a card, so they are free to drive the dojo.
  function handleControl(event) {
    if (event.key === Qt.Key_Escape) { dismiss(); return }
    if (event.key === Qt.Key_Tab) { switchMode(); return }
    var forward = event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter
    if (phase === "summary") { if (forward) startRound(); return }
    if (phase === "reveal") { if (forward) nextCard(); return }
    if (phase !== "ask") return
    if (forward) { answer(false, "Skipped"); return }
    if (mode === "name" && event.key >= Qt.Key_1 && event.key <= Qt.Key_4) choose(event.key - Qt.Key_1)
  }

  // The lit keycaps follow Qt's modifier state, corrected for the key in this
  // very event (Qt reports the state from just before it). Rebuilding from the
  // event each time means a missed release can't leave a keycap stuck.
  function trackModifiers(event, down) {
    var mods = Model.pressModmask({
      shift: !!(event.modifiers & Qt.ShiftModifier), ctrl: !!(event.modifiers & Qt.ControlModifier),
      alt: !!(event.modifiers & Qt.AltModifier), meta: !!(event.modifiers & Qt.MetaModifier)
    })
    var bit = Model.modifierBit({ key: event.key, scanCode: event.nativeScanCode })
    if (bit !== 0) mods = down ? (mods | bit) : (mods & ~bit)
    heldMods = mods
  }

  function saveStats() {
    if (Object.keys(stats).length === 0) return
    pendingWrite = Model.serializeStats(stats)
    if (!writeProcess.running) flushWrite()
  }

  // ---- Wiring -------------------------------------------------------------
  IpcHandler {
    target: "cgranier.dojo"
    function isOpen(): string { return root.opened ? "true" : "false" }
    function progress(): string { return JSON.stringify(root.progress) }
    function state(): string {
      return JSON.stringify({ phase: root.phase, mode: root.mode, card: root.card ? root.card.id : "",
        asked: root.asked.length, correct: root.roundCorrect, streak: root.streak, cards: root.cards.length,
        lastCorrect: root.lastCorrect, feedback: root.feedback })
    }
  }

  // If something else changes the submap (the SUPER+ESCAPE hatch, a config
  // reload), global binds are live again — get out of the way rather than sit
  // on top of the screen swallowing keys.
  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (root.opened && event.name === "submap" && String(event.data) !== "cgranier_dojo" && root.phase !== "loading") root.dismiss()
    }
  }

  Process {
    id: bindsProcess
    running: false
    // Bounded: the bind list is whatever the config declares; four megabytes
    // is far more than any real one, and the cap keeps the shell's memory ours.
    command: ["timeout", "10", "sh", "-c", 'hyprctl binds -j | head -c 4000000']
    stdout: StdioCollector { id: bindsStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var binds = []
      try { binds = JSON.parse(String(bindsStdout.text || "[]")) } catch (e) { binds = [] }
      root.cards = Model.cardsFromBinds(binds)
      root.startRound()
    }
  }

  // The stats file is never opened by the shell: bin/dojo-state checks the
  // directory chain, refuses links, FIFOs and oversized files, and writes
  // atomically. Writes are serialised; one made while another runs waits.
  readonly property string stateScript: String(Qt.resolvedUrl("bin/dojo-state")).replace(/^file:\/\//, "")
  property string pendingWrite: ""

  function flushWrite() {
    if (pendingWrite === "") return
    writeProcess.command = ["timeout", "10", "/usr/bin/python3", stateScript, "write", stateDir + "/stats.json", pendingWrite]
    pendingWrite = ""
    writeProcess.running = true
  }

  Process {
    id: readProcess
    running: true
    command: ["timeout", "10", "/usr/bin/python3", root.stateScript, "read", root.stateDir + "/stats.json"]
    stdout: StdioCollector { id: readOut; waitForEnd: true }
    onExited: function(exitCode) { root.stats = Model.parseStats(exitCode === 0 ? readOut.text : "{}") }
  }

  Process {
    id: writeProcess
    running: false
    command: []
    onExited: root.flushWrite()
  }

  // Walk away mid-round and the dojo closes itself, well before the
  // screensaver or lock would find it holding the keyboard with the global
  // binds suspended.
  Timer {
    id: idleTimer
    interval: 90000
    repeat: false
    running: root.opened
    onTriggered: root.dismiss()
  }

  Timer {
    id: advanceTimer
    interval: 650
    repeat: false
    onTriggered: if (root.opened && root.phase === "reveal" && root.lastCorrect) root.nextCard()
  }

  // ---- Surface ------------------------------------------------------------
  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "cgranier-dojo"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle { anchors.fill: parent; color: Color.menu.scrim }
    MouseArea { anchors.fill: parent; onClicked: root.dismiss() }

    BorderSurface {
      id: cardSurface
      width: Math.min(Style.space(620), panel.width - Style.gapsOut * 2)
      height: Math.min(body.implicitHeight + Style.spacing.panelPadding * 2 + Style.space(8), panel.height - Style.gapsOut * 2)
      radius: Style.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: keyCatcher.forceActiveFocus() }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          idleTimer.restart()
          root.trackModifiers(event, true)
          if (!event.isAutoRepeat) root.handleKey(event)
          event.accepted = true
        }
        Keys.onReleased: function(event) {
          root.trackModifiers(event, false)
          event.accepted = true
        }
      }

      Column {
        id: body
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.leftMargin: cardSurface.contentLeftInset
        anchors.rightMargin: cardSurface.contentRightInset
        anchors.topMargin: cardSurface.contentTopInset
        spacing: Style.space(18)

        // Header: title, mode, round progress.
        Item {
          width: parent.width
          implicitHeight: title.implicitHeight

          DojoText { id: title; text: "KEYBIND DOJO"; color: root.dim; font.pixelSize: Style.font.caption; font.letterSpacing: 2 }

          Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(14)
            DojoText { text: "PRESS IT"; font.pixelSize: Style.font.caption; font.letterSpacing: 2; color: root.mode === "press" ? root.foreground : root.dim }
            DojoText { text: "NAME IT"; font.pixelSize: Style.font.caption; font.letterSpacing: 2; color: root.mode === "name" ? root.foreground : root.dim }
          }

          DojoText {
            anchors.right: parent.right
            visible: root.phase === "ask" || root.phase === "reveal"
            text: root.asked.length + " / " + Math.min(root.roundLength, root.cards.length) + (root.streak > 1 ? "  ·  streak " + root.streak : "")
            color: root.dim
            font.pixelSize: Style.font.caption
          }
        }

        DojoText {
          visible: root.phase === "loading" || root.phase === "empty"
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: root.phase === "loading" ? "Reading your keybindings…" : "No keybindings with descriptions were found."
          color: root.dim
        }

        // ---- Press it ----
        Column {
          visible: (root.phase === "ask" || root.phase === "reveal") && root.mode === "press" && root.card
          width: parent.width
          spacing: Style.space(20)

          DojoText {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: root.card ? root.card.description : ""
            font.pixelSize: Style.font.display
            wrapMode: Text.WordWrap
          }

          // While asking: the modifiers you are holding light up. After
          // answering: the real chord, colored by how it went.
          Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(8)
            height: Style.space(44)

            Repeater {
              model: root.phase === "reveal" && root.card ? Model.keycaps(root.card) : Model.modNames(root.heldMods)
              Keycap {
                required property var modelData
                label: modelData
                tone: root.phase === "reveal" ? (root.lastCorrect ? root.good : root.urgent) : root.foreground
              }
            }

            DojoText {
              visible: root.phase === "ask" && root.heldMods === 0
              anchors.verticalCenter: parent.verticalCenter
              text: "press the shortcut"
              color: root.dim
            }
          }
        }

        // ---- Name it ----
        Column {
          visible: (root.phase === "ask" || root.phase === "reveal") && root.mode === "name" && root.card
          width: parent.width
          spacing: Style.space(16)

          Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(8)
            Repeater {
              model: root.card ? Model.keycaps(root.card) : []
              Keycap { required property var modelData; label: modelData; tone: root.foreground; large: true }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: root.choices

              CursorSurface {
                id: option
                required property var modelData
                required property int index
                readonly property bool isAnswer: root.card && modelData.id === root.card.id
                readonly property bool revealed: root.phase === "reveal"

                width: parent.width
                implicitHeight: optionText.implicitHeight + Style.space(16)
                foreground: root.foreground
                hasCursor: revealed && (isAnswer || index === root.pickedChoice)
                opacity: revealed && !isAnswer && index !== root.pickedChoice ? 0.45 : 1.0

                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.choose(option.index) }

                DojoText {
                  id: optionNumber
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(12)
                  anchors.verticalCenter: parent.verticalCenter
                  text: String(option.index + 1)
                  color: root.dim
                }

                DojoText {
                  id: optionText
                  anchors.left: optionNumber.right
                  anchors.right: parent.right
                  anchors.leftMargin: Style.space(14)
                  anchors.rightMargin: Style.space(12)
                  anchors.verticalCenter: parent.verticalCenter
                  text: option.modelData.description
                  elide: Text.ElideRight
                  color: !option.revealed ? root.foreground
                    : option.isAnswer ? root.good
                    : option.index === root.pickedChoice ? root.urgent : root.foreground
                }
              }
            }
          }
        }

        DojoText {
          visible: root.phase === "reveal" && root.feedback !== ""
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: root.feedback
          color: root.urgent
          wrapMode: Text.WordWrap
        }

        // ---- Summary ----
        Column {
          visible: root.phase === "summary"
          width: parent.width
          spacing: Style.space(14)

          DojoText {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: root.roundCorrect + " of " + root.asked.length
            font.pixelSize: Style.font.display
          }

          DojoText {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: Model.rank(root.progress.solid, root.progress.total) + "  ·  " + root.progress.solid + " solid, "
              + root.progress.seen + " seen of " + root.progress.total + (root.bestStreak > 1 ? "  ·  best streak " + root.bestStreak : "")
            color: root.dim
          }

          Column {
            visible: root.missed.length > 0
            width: parent.width
            spacing: Style.space(8)

            DojoText { text: "WORTH ANOTHER LOOK"; color: root.dim; font.pixelSize: Style.font.caption; font.letterSpacing: 2 }

            Repeater {
              model: root.missed.slice(0, 5)

              Item {
                required property var modelData
                width: parent.width
                implicitHeight: Style.space(30)

                DojoText {
                  anchors.left: parent.left
                  anchors.right: caps.left
                  anchors.rightMargin: Style.space(12)
                  anchors.verticalCenter: parent.verticalCenter
                  text: modelData.description
                  elide: Text.ElideRight
                }

                Row {
                  id: caps
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(4)
                  Repeater {
                    model: Model.keycaps(modelData)
                    Keycap { required property var modelData; label: modelData; tone: root.foreground; small: true }
                  }
                }
              }
            }
          }
        }

        DojoText {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          color: root.dim
          font.pixelSize: Style.font.caption
          text: root.phase === "summary" ? "enter another round  ·  tab switch mode  ·  esc leave"
            : root.phase === "reveal" && !root.lastCorrect && root.mode === "press" ? "press it to continue  ·  space next  ·  esc leave"
            : root.phase === "reveal" ? "space next  ·  esc leave"
            : root.mode === "name" ? "1–4 answer  ·  space skip  ·  tab switch mode  ·  esc leave"
            : "space skip  ·  tab switch mode  ·  esc leave"
        }
      }
    }
  }

  component DojoText: Text {
    textFormat: Text.PlainText
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
  }

  component Keycap: Rectangle {
    property string label: ""
    property color tone: root.foreground
    property bool large: false
    property bool small: false
    readonly property int padX: small ? Style.space(7) : large ? Style.space(16) : Style.space(12)

    anchors.verticalCenter: parent ? parent.verticalCenter : undefined
    implicitWidth: Math.max(implicitHeight, capText.implicitWidth + padX * 2)
    implicitHeight: capText.implicitHeight + (small ? Style.space(6) : large ? Style.space(18) : Style.space(12))
    radius: Math.max(2, Style.cornerRadius)
    color: Qt.rgba(tone.r, tone.g, tone.b, 0.08)
    border.width: Math.max(1, Style.space(1))
    border.color: Qt.rgba(tone.r, tone.g, tone.b, 0.55)

    Text {
      id: capText
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: parent.label
      color: parent.tone
      font.family: root.fontFamily
      font.pixelSize: parent.small ? Style.font.caption : parent.large ? Style.font.heading : Style.font.body
      font.bold: true
    }
  }
}
