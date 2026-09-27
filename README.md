# Heather Music Hub

**MP3 → automatic music analysis → generated Piano Tiles chart → playable rhythm game.**

A mobile-first browser rhythm game. You pick one song, it is analyzed entirely on your device,
and a chart is generated that follows its beats, accents, melody and sections.

## Running

No build step and no dependencies.

- **Desktop:** open `index.html` in Chrome, Edge, Firefox or Safari.
- **Phone:** serve the folder and open it from the phone, e.g. `py -m http.server 8000`
  in this folder, then visit `http://<your-PC-IP>:8000` on the same Wi-Fi. Any static host
  (GitHub Pages, Netlify, …) works too.

## Play modes

Each song gets four charts: **Vertical** Normal / Hard and **Horizontal** Normal / Hard.

**Vertical** (portrait) is Piano Tiles / SuperStar style: tiles fall down four lanes toward the
line.

| Note | Looks like | What to do |
| --- | --- | --- |
| Tap | Tile tinted by lane (cyan, blue, violet, pink) | Tap its lane as it reaches the line. |
| Hold | Tile with a long glowing tail | Press and keep holding until the tail ends. Other lanes can keep coming meanwhile. |
| Flick | Orange tile with arrows | Touch it and swipe (any direction). A plain tap only scores GOOD. |
| Double | Two tiles with a white outline, joined by light | Tap both at once. |

**Horizontal** (landscape) is Arcaea style: notes come toward you on a 3D track, and flicks work
like Phigros swipes. Turn the phone sideways; the game waits for landscape and pauses if you
turn back.

| Note | Looks like | What to do |
| --- | --- | --- |
| Floor tap / hold / flick | Slabs on the 4 floor lanes | As above, tapping the lower part of the screen. |
| Arc | Cyan or pink ribbon in the air | Put a finger on the glowing ring where the ribbon meets the dashed line and slide along with it. Its sideways path follows the melody. Every half beat you stay on it scores. While an arc is running, floor notes come on the other side for your other hand. |
| Sky note | Gold bar floating in the air | Tap it in the upper part of the screen when it reaches the dashed line. |

Keyboard: `D F J K` (or arrow keys) play the lanes, `Space`/`Esc` pauses. In horizontal
mode on a computer, use the mouse for arcs and sky notes.

**Scoring.** Tap, flick and sky notes count once, holds twice (the press and the release), and
arcs once per half-beat tick. Perfect / Great / Good / Miss windows are ±45 / 90 / 135 ms.
Score = 900,000 × accuracy + 100,000 × (max combo ÷ total), so a flawless run is 1,000,000.

## Records and rewards

These are modeled on Arcaea, Phigros and SuperStar, and are saved on the device (`js/progress.js`).

- **Clear gauge** (top-left while playing): fills with every hit and drains on misses. End at 70% or more to clear, which takes about 85% of notes hit. Otherwise the result is *Track Lost*.
- **Clear types:** Clear, Full Combo (no misses) and All Perfect.
- **Grades by score:** AP, SS 980k, S 950k, A 900k, B 800k, C 700k, F.
- **Chart level:** each chart gets a level (about 5–7 on Normal, 8–10 on Hard) from its density, bursts, arcs and sky notes.
- **Rating:** a play rates its chart level at 950,000, level + 1 at 980,000 and level + 2 at 1,000,000. Your rating is the average of your 10 best chart ratings, like Arcaea's Potential or Phigros' RKS.
- **Rewards:**
  - Every play gives EXP toward your player level.
  - Clears give coins, scaled by grade and chart level.
  - Bonuses for a first clear, first Full Combo, first All Perfect, a new best and each level up.
  - 17 achievements pay coins; *Pure Memory* unlocks the Gold skin and *Rising Star* the Nebula theme.
- **Shop** (Rewards tab): tile skins (Aurora, Ivory, Sakura, Ember, Prism, Gold) and stage themes (Song colors, Ocean, Sunset, Forest, Midnight, Nebula).
- **Records tab:** level, rating, totals, the best score and clear type for each song's four charts, and your last 12 plays. *Save backup* / *Restore backup* moves everything to another device as a JSON file.

The **Guide** tab explains everything above, with separate instructions for phone and computer.

### iPhone app (home screen, works offline)

An iPhone can only install a web app from an https address, so the app is hosted free on
GitHub Pages. Only the game code goes online: `.gitignore` keeps the `Songs` folder out, and
on the phone your songs are stored inside the app.

1. **Put the code on GitHub** (GitHub Desktop): *File → Add local repository*, choose this folder.
   When it offers to create a repository here, do that, and leave the README and .gitignore
   templates off. Commit, then click **Publish repository** and untick "Keep this code private".
   Free GitHub Pages needs a public repository.
2. **Turn on Pages:** on github.com, open the repository → *Settings → Pages* → Source
   "Deploy from a branch", branch `main`, folder `/ (root)` → Save. After a minute the app is
   at `https://<your-username>.github.io/<repository-name>/`.
3. **Install:** open that address in Safari on the iPhone → Share → **Add to Home Screen**.
4. **Add your songs:** copy `Songs/Heather Music Hub songs.hmhpack` (made by the build script
   below) to iCloud Drive, e.g. by uploading it at icloud.com. On the phone, open Heather Music
   Hub from the home screen → **Import song pack** → pick the file. All songs land in My Songs
   with their titles, stay in the app, and play offline. You can also add single files with
   **Add songs**.

The songs never go to GitHub: the Pages site is public, and `.gitignore` keeps the `Songs`
folder (including the pack) out of the repository.

Songs added in Safari don't appear in the home-screen app (iOS keeps their storage separate),
so add them from inside the installed app. To remove a song, tap × and then **Remove**.
After changing the code, push to GitHub and bump `VERSION` in `sw.js`; the phone picks up the
update the next time the app is opened.

### Cloud library (songs shared between computer and phone)

The website itself never contains songs. The songs live in a **second, private** GitHub
repository that only you can open (`js/cloud.js`). Set it up once from the **Cloud library** card
on the Play tab:

1. Create a private repository for the songs, e.g. `heather-music-hub-songs` (github.com/new →
   *Private*).
2. Create a fine-grained access token (github.com → Settings → Developer settings →
   Fine-grained tokens). Set *Repository access* to *Only select repositories* and pick the songs
   repository. Under *Repository permissions*, set *Contents* to *Read and write*. Keep a copy of
   the token (password manager, Notes) so you can paste it on the phone too.
3. On each device, open the app → **Cloud library → Set up**. Enter `your-username/heather-music-hub-songs`
   and the token, then tap **Connect**.

After that:

- Songs you add on any device (**Add songs** or **Import song pack**) upload automatically into
  the repository's `songs/` folder.
- Every connected device lists them. Tap one to download it, or tap **Download all**; downloaded
  songs play offline.
- The app checks for new songs each time you open it, and **Sync now** checks right away.
- Removing a song with × only removes it from that device, so it stays in the cloud. To delete it
  everywhere, delete the file from the repository on github.com.
- The app refuses to connect to a public repository.
- The token is stored only in that browser and sent only to api.github.com. It can only touch the
  songs repository.
- Best scores, coins and unlocks still stay per device. Use Records → Save backup / Restore backup
  to move them.

### My Songs (the `Songs` folder)

Put audio files (MP3, M4A, WAV, …) in `Songs/`, then run:

```
py tools/build_library.py
```

This packs each song into `Songs/library/`, writes `Songs/library.js`, and builds the phone
song pack `Songs/Heather Music Hub songs.hmhpack` (every song in one file). The home screen then
lists them under **My Songs**. The page analyzes them in the background, one at a time, and
pauses while you play. After that, tapping a song goes straight to difficulty selection.
Rerun the script whenever you add, remove or replace songs. Titles come from the file's tags,
or from the filename when there are none.

Why the packing step: a page opened by double-click can't read a folder or fetch local files,
but it can load script files. Charts and best scores are identical to uploading the same file,
because both paths hash the same bytes.

### Song parts

Every song also has **Part 1** and **Part 2** under it in My Songs, and a Full song / Part 1 /
Part 2 switch on the chart screen:

- **Part 1** runs from the start to the end of the first chorus.
- **Part 2** runs from right after the first chorus to the end.

The chorus is found automatically: it is the section type that is loudest, repeats, and runs
longest. The split is the end of its first appearance, snapped to a bar line and kept between
20% and 80% of the song.

A part plays the same charts as the full song, trimmed to the part. The music starts a couple of
seconds before the part with a count-in. Each part has its own best scores and records.

No MP3 handy? The home screen has a "generated demo tune" button that synthesizes a song in
the browser and runs it through the same pipeline.

## How it works

| File | Role |
| --- | --- |
| `js/analyzer.js` | Audio analysis, run in a Web Worker (built from a Blob, so it also works from `file://`). |
| `js/chart.js` | Deterministic chart generation for the four charts. |
| `js/audio.js` | Decoding, playback and the song clock. |
| `js/game.js` | Judging, scoring and effects, plus the vertical and the 3D horizontal renderers. |
| `js/app.js` | Screen flow: Upload → Analysis → Difficulty → Gameplay → Results. |

**Analysis** (`analyzer.js`): mono mixdown → ~22 kHz → 1024-pt STFT (hop ≈ 11.6 ms).
From each frame it computes:
- Spectral flux (full / low / high band): the onset envelope.
- RMS: loudness and silence.
- Peak-interpolated chroma.
- A harmonic-sum melody pitch estimate (MIDI 45–84).

Then:
- **Onsets:** adaptive-threshold peak picking with sub-frame refinement.
- **Tempo:** autocorrelation of the onset envelope with a log-normal prior around 120 BPM.
- **Beats:** dynamic-programming beat tracker (Ellis 2007). Gaps are filled and the grid extended over all non-silent audio.
- **Downbeats:** the 4/4 phase with the most low-frequency attack energy.
- **Sections:** checkerboard novelty on a bar-level self-similarity matrix (chroma + energy + density), snapped to 4-bar phrases. Repeats are labeled A/B/C… and each section gets an energy level.
- **Key:** Krumhansl–Schmuckler (shown as an estimate).

**Chart generation** (`chart.js`):
1. Build a 16th-note grid from the beats. Normal uses 8ths, Hard uses 16ths. Off-beat positions need a real detected onset.
2. Score each grid point by onset strength plus a metrical bonus (downbeat > beat > 8th > 16th).
3. In each section, greedily take the strongest points up to a density budget. The budget scales with the section's energy and is capped by the difficulty's max notes/sec. Points closer than the difficulty's **minimum gap** are rejected (190 / 115 ms vertical, 200 / 125 ms horizontal). Long empty stretches are filled with on-beat notes.
4. **Arcs** (horizontal): beats where the melody is clearly pitched are grouped into phrases of 2–4 beats (Normal) or 2–8 beats (Hard), covering about 30% / 45% of the song. Each arc's sideways position follows the smoothed pitch (low = left), with a speed limit so it can be followed. Arcs alternate sides, and floor notes during an arc move to the other half.
5. **Holds:** notes whose pitch keeps sounding, or that have a beat or more of continuing sound before the next note, become holds. Songs without sung notes (rap, EDM) also get holds on strong beats, so roughly 10–13% of notes are holds. Other lanes keep going during a hold (Normal keeps only on-beat notes), never in the held lane.
6. **Lanes:** each note's pitch is ranked within a moving window, so higher notes go further right and the tiles follow the melody contour. Then fast same-lane repeats, long single-lane runs and awkward jumps are fixed.
7. **Accents:** the biggest hits (crashes, section starts) become flicks, and snare/clap/hat hits become sky notes on the horizontal track. Strong beats get doubles (never three at once). Hard horizontal also ends some arcs with a sky note.
8. **Speed:** scroll speed ramps up section by section ("SPEED UP" cue). Positions come from the integral of speed, so notes never jump when the speed changes.

Same file + difficulty + variation number ⇒ identical chart. The seed is a hash of the file bytes
and no unseeded randomness is used. "Chart variation" on the difficulty screen gives a
different, still deterministic, arrangement.

**Sync** (`audio.js`, `game.js`): the song plays through Web Audio. The song clock comes from
`AudioContext.getOutputTimestamp()` (what is reaching the speakers now), with
`currentTime − outputLatency` as the fallback. A slow correction loop locks it to
`performance.now()` so motion is smooth but never drifts. Tile positions are a pure function
of that clock. Taps are judged at the song time of the input event's own timestamp, not the
next frame's. A tap 135–200 ms early counts as a miss.

The results screen reports your average timing offset and can apply it as an **audio offset**,
e.g. for Bluetooth headphones. You can also set it by hand on the difficulty screen.

## Notes & limits

- Tempo can come out as half or double on very fast songs (e.g. a 174 BPM track may read as
  87). The chart is still aligned to the beat, because the grid subdivides it.
- Time signature is assumed to be 4/4 for downbeats and sections.
- Pitch tracking follows the most prominent pitched line, so it works best on songs with a
  clear lead. It only affects lane choice, not timing.
- iOS: if you hear nothing, check the silent switch.
