<div align="center">

# Live Code Dashboard

**Watch Claude Code work, live.** Every file it reads, every line it changes, what it costs, how close you are to your limits, all in one dashboard on your second screen, with a **Stream Deck** plugin and **Philips Hue** lights built in.

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%99%A5-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/CNLynx)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4)
![Claude Code](https://img.shields.io/badge/Claude%20Code-mod-d97757)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

[English](#english) · [Deutsch](#deutsch)

![The dashboard while Claude edits a file](docs/dashboard.png)

</div>

---

## English

### What it does

#### Live code view
The change Claude is making right now, typed out line by line with syntax colors, and under it a short note on *what it is for* ("Caches API answers for ten minutes so switching cities stays instant"). Reads, searches and commands show up too, one after another, so you never miss a step.

![Live code view](docs/live-view.gif)

#### Limits & costs at a glance
Context window, 5-hour and 7-day limits with a live reset countdown and a projection of when you would hit them, session cost as a stock-style chart (red going up, green going down), tokens, lines changed, files, tool calls, errors. Tiles turn yellow and red at thresholds you choose, and a chime plays when a limit resets.

#### Every tile opens up
Click any tile for exact numbers and charts you can hover, or pop it out into its own **frameless window** (minimal or detailed) that remembers its place and screen.

| Session cost, turn by turn | 5-hour limit over time |
|---|---|
| ![Cost tile opened](docs/tile-cost.gif) | ![Limit tile opened](docs/tile-limit.gif) |

#### And more
- **Talk back:** send Claude a message, stop it, or answer its questions straight from the dashboard.
- **Several chats at once:** pick a chat, or the *Wall* to see all of them side by side; a *Report* sums up the day and week by project.
- **Sound & voice:** a chime when a task is done, and optionally the summary read aloud with Edge's free natural voices (one voice per chat if you like).
- **It thinks with you:** a calm "thinking" view while Claude thinks longer, a terminal animation while commands run, and an alarm when Claude seems stuck.

### Stream Deck

![Stream Deck: live status, then a question answered with one key](docs/streamdeck.gif)


The plugin turns a 15-key Stream Deck into a Claude console:

| Row | Keys |
|---|---|
| top | your chats (switch with a press), ⌂ back |
| middle | what Claude does now, turn time, context, 5-hour limit, cost |
| bottom | three prompt keys ("Go on", "Test it", "Sum up"; editable), ■ stop, open the dashboard |

When Claude asks something, the keys turn into the question and its answers: answer with one press. When a task is done, the deck glows. The setup installs it automatically when the Stream Deck app is on your PC (confirm once in the Stream Deck app). Edit the prompt keys in `~/.claude/live-code-deck.json`.

### Philips Hue

Your lights answer what the dashboard shows:

- **Done:** a short mint glow, then back to how the light was.
- **Question:** the lights breathe violet until you answer.
- **Stuck:** a red flare.

Each light keeps its own brightness, lights that are off stay off, and everything goes back to its previous state. **Setup:** dashboard → ⚙ Settings → 💡 Lights → **Pair bridge**, then press the round button on your Hue Bridge. Pick the lights and colors there.

![Pairing a Hue Bridge](docs/settings-lights.png)

### Install (one click)

You need **Windows 10/11**, **[Claude Code](https://claude.com/claude-code)** and **[Node.js](https://nodejs.org)**. Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/CNLynx/Live-Code-Dashboard/main/install.ps1 | iex
```

That installs the mod, adds a **Live Code Dashboard** shortcut to the Start menu and desktop, sets up the Stream Deck plugin (if you have one) and opens the dashboard. Restart Claude Code once; from then on the dashboard starts together with Claude.

<details>
<summary>Or install by hand</summary>

At the prompt of a Claude Code session:

```
/plugin install live-code --marketplace CNLynx/Live-Code-Dashboard
```

(`y` to add the marketplace, then pick a scope.) Or from a shell:

```bash
claude plugin install live-code --marketplace CNLynx/Live-Code-Dashboard
```

Then, in Claude Code, type `/live-code-setup` for the shortcuts and the Stream Deck plugin.
</details>

### Updating

In Claude Code: `/plugin` → *Marketplaces* → **cnlynx** → enable **auto-update**, and new versions arrive by themselves. Or update by hand:

```bash
claude plugin marketplace update cnlynx
claude plugin update live-code@cnlynx
```

The dashboard shows **"→ vX.Y.Z available"** next to its version when there is a newer one. After an update the dashboard server and the Stream Deck plugin are swapped for the new version on the next start of Claude.

### Make it yours, live, by prompting

The dashboard is plain HTML, CSS and JavaScript, and it **reloads itself the moment a file changes**: no restart, no blank flash, the new version fades in over the old. So you can simply ask Claude, in Claude Code:

> *"In the Live Code dashboard, make the cost tile blue and add a tile for the average turn time."*

and watch the change appear while Claude is still typing:

![The dashboard restyling itself the moment its file changes](docs/live-reload.gif)

This works in Claude Code (terminal, desktop app, IDE), not in the claude.ai chat, since Claude needs to edit the files on your PC. Tip: fork this repository first and install from your fork, so an update does not overwrite your changes.

### Good to know

- **Privacy:** everything stays on your PC. The dashboard listens on `127.0.0.1:4477` only. Nothing is sent anywhere, except the Hue commands to your own bridge and a once-every-6-hours look at this repository's version number.
- **Tokens:** the "what it is for" notes are written by Claude Haiku: about one small call per action, roughly 1% of what the chats themselves cost.
- **Files it keeps:** `~/.claude/live-code-*` (feeds, settings, Hue key) and `%LOCALAPPDATA%\live-code-dashboard` (window profile, WebView2 files).
- **Browser:** the dashboard opens as an app window in Microsoft Edge (for its natural voices); Chrome works too.
- **Uninstall:** `claude plugin uninstall live-code@cnlynx`, then delete the shortcuts and the files above.

### Support

If Live Code saves you time, you can support its development: **[♥ Sponsor on GitHub](https://github.com/sponsors/CNLynx)**. Thank you!

---

## Deutsch

> Bilder und Animationen zu allen Funktionen: siehe [oben](#english).

### Was es kann

- **Live-Code-Ansicht:** Die Änderung, die Claude gerade macht, Zeile für Zeile getippt und farbig hervorgehoben. Darunter steht kurz, *wofür* sie ist.
- **Limits und Kosten auf einen Blick:**
  - Kontextfenster;
  - 5-Stunden- und 7-Tage-Limit mit Reset-Countdown und Prognose;
  - Session-Kosten als Kurve wie ein Aktienkurs;
  - Tokens, geänderte Zeilen, Dateien, Tool-Aufrufe und Fehler.

  Die Kacheln färben sich bei einstellbaren Schwellen gelb und rot. Ein Chime spielt, wenn ein Limit zurückgesetzt wird.
- **Jede Kachel lässt sich öffnen:** Ein Klick zeigt exakte Zahlen und Diagramme mit Hover-Details. Du kannst jede Kachel auch als eigenes, rahmenloses Fenster ausklinken (minimal oder detailliert). Position und Bildschirm werden gespeichert.
- **Zurückschreiben:** Du kannst Claude Nachrichten senden, es stoppen oder seine Fragen direkt im Dashboard beantworten.
- **Mehrere Chats:**
  - *Wall*: alle Chats nebeneinander;
  - *Report*: Tag und Woche pro Projekt.
- **Ton und Stimme:** Ein Chime, wenn eine Aufgabe fertig ist. Auf Wunsch liest eine natürliche Edge-Stimme die Zusammenfassung vor (gratis, auf Wunsch pro Chat eine eigene).
- **Animationen:**
  - eine eigene Ansicht, wenn Claude länger nachdenkt;
  - eine Terminal-Animation bei laufenden Befehlen;
  - ein Alarm, wenn Claude festzuhängen scheint.

### Stream Deck

Das Plugin macht aus einem Stream Deck mit 15 Tasten eine Claude-Konsole:
- **Oben:** deine Chats.
- **Mitte:** was Claude gerade tut, Zeit, Kontext, 5h-Limit und Kosten.
- **Unten:**
  - drei Prompt-Tasten („Weiter“, „Teste es“, „Fazit“, anpassbar in `~/.claude/live-code-deck.json`);
  - Stopp;
  - Dashboard öffnen.

Fragt Claude etwas, werden die Tasten zur Frage mit den Antworten, und du antwortest mit einem Tastendruck. Ist eine Aufgabe fertig, leuchtet das Deck. Das Setup installiert das Plugin automatisch, wenn die Stream-Deck-App da ist; du bestätigst einmal in der App.

### Philips Hue

- **Fertig:** ein kurzes, mintgrünes Aufleuchten.
- **Frage:** Die Lampen atmen violett, bis du antwortest.
- **Hängt fest:** rotes Aufblitzen.

Jede Lampe behält ihre Helligkeit, ausgeschaltete bleiben aus, und danach ist alles wie vorher. **Einrichten:** Dashboard → ⚙ Einstellungen → 💡 Lights → **Pair bridge**. Dann den runden Knopf auf der Hue Bridge drücken und dort Lampen und Farben wählen.

### Installation (ein Klick)

Du brauchst **Windows 10/11**, **[Claude Code](https://claude.com/claude-code)** und **[Node.js](https://nodejs.org)**. Öffne PowerShell und führe aus:

```powershell
irm https://raw.githubusercontent.com/CNLynx/Live-Code-Dashboard/main/install.ps1 | iex
```

Das Script:
1. installiert den Mod;
2. legt die Verknüpfung „Live Code Dashboard“ im Startmenü und auf dem Desktop an;
3. richtet das Stream-Deck-Plugin ein;
4. öffnet das Dashboard.

Starte Claude Code danach einmal neu. Ab dann startet das Dashboard zusammen mit Claude. Von Hand geht es so: in Claude Code `/plugin install live-code --marketplace CNLynx/Live-Code-Dashboard`, danach `/live-code-setup`.

### Updates

In Claude Code: `/plugin` → *Marketplaces* → **cnlynx** → **Auto-Update** einschalten. Von Hand geht es mit `claude plugin marketplace update cnlynx` und danach `claude plugin update live-code@cnlynx`. Gibt es eine neue Version, zeigt das Dashboard neben seiner Versionsnummer **„→ vX.Y.Z available“**.

### Live anpassen, per Prompt

Das Dashboard ist reines HTML, CSS und JavaScript. Es **lädt sich selbst neu, sobald sich eine Datei ändert**, ohne Neustart und ohne schwarzes Aufblitzen. Du kannst Claude in Claude Code also einfach sagen:

> *„Mach im Live-Code-Dashboard die Kosten-Kachel blau und füge eine Kachel für die durchschnittliche Turn-Zeit hinzu.“*

Die Änderung erscheint, während Claude noch tippt. Das geht in Claude Code (Terminal, Desktop-App, IDE), nicht im normalen claude.ai-Chat, weil Claude dafür Dateien auf deinem PC bearbeiten muss. Tipp: Forke das Repository und installiere von deinem Fork, dann überschreibt ein Update deine Änderungen nicht.

### Gut zu wissen

- **Datenschutz:** Alles bleibt auf deinem PC (`127.0.0.1:4477`). Nach aussen gehen nur:
  - die Hue-Befehle an deine eigene Bridge;
  - alle 6 Stunden ein Blick auf die Versionsnummer dieses Repos.
- **Tokens:** Die kurzen „Wofür“-Erklärungen schreibt Claude Haiku. Das kostet etwa 1 % dessen, was die Chats selbst kosten.
- **Deinstallieren:** `claude plugin uninstall live-code@cnlynx`, danach die Verknüpfungen löschen.

### Unterstützen

Wenn dir Live Code Zeit spart, kannst du die Weiterentwicklung unterstützen: **[♥ Auf GitHub sponsern](https://github.com/sponsors/CNLynx)**. Danke!

---

<div align="center">
Made by <a href="https://github.com/CNLynx">Lynx</a> · MIT License
</div>
