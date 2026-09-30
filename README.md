# Silence Trimmer

Cuts the dead air out of a voice recording: long pauses, the gap before you
start talking, the minutes after you forgot to stop recording. It also works
out **who is speaking**, lets you download each person's speech on its own, and
charts each voice's **pitch, resonance, loudness and breathiness**.

The cut-off is chosen for each recording, so quiet words and soft phrase
endings are kept. Everything runs on your own computer; recordings are never
uploaded anywhere.

## Set it up (once)

You need an internet connection for this step only.

**Windows:** double-click **`Install Silence Trimmer.cmd`**. When it finishes
there is a **Silence Trimmer** shortcut on your desktop.

**Mac:** right-click **`Install Silence Trimmer.command`** and choose **Open**
(the first time, macOS blocks a plain double-click on files from the
internet). Then click **Open** again in the warning box.

Setup downloads about 160 MB and takes about 530 MB of disk. It all stays
inside this folder.

## Use it

1. Start it: the desktop shortcut on Windows, or double-click
   **`Start Silence Trimmer`** in this folder. A small window opens, and the app
   opens in your web browser.
2. Drop a recording onto the page, or click to choose one. MP3, M4A, WAV, and
   video files like MKV or MP4 all work.
3. Listen to the result on the page, then click **Download trimmed MP3**.

Keep the small window open while you use it. Close it to quit.

### Recordings and Live

The two tabs at the top switch between **Recordings** (files you've added or
recorded) and **Live** (recording from a microphone as you talk). Your recordings
are listed down the side in both.

### Two layouts: Card and Track

**Layout: Card / Track**, beside the tabs, works in both tabs and is remembered,
so Recordings and Live open in whichever you used last. Switching keeps the
recording you have open.

- **Card** walks through the results one section at a time. The bar pinned
  to the bottom of the window zooms the speaker timeline and every voice chart
  together: drag across any of them to zoom in on that stretch, or use **−** and
  **+**. The strip in the bar is the whole recording, and its box is the part
  you're looking at; drag the box, or scroll over the strip, to move along.
  **Whole** (or a double-click on a chart) zooms back out. While playing, the
  view moves along with the recording. Each chart's scale fits what's on screen,
  so zooming in shows the detail rather than a flat line.
- **Track** puts everything on one screen, like an audio editor: the
  speakers, pitch, resonance, loudness and breathiness stacked on a single
  timeline, with the numbers in a summary column beside it. Click to play from
  a moment, drag across the tracks to zoom in (double-click to see the whole
  recording again), and drag the box in the strip above, or scroll over it, to
  move along. Hover to
  read every value at that moment. Tick **Show voice** on a second speaker to
  compare two voices; each keeps its own colour. Space bar plays and pauses.

### Pitch floor and ceiling

Type a **floor** and/or **ceiling** in hertz next to **Pitch** (in either tab) to
mark a target range, like the "hot lava" line in voice-training pitch trackers:
each is drawn as a red dashed line, the side past it is shaded, and the voice
figures add how much of the voiced time fell below the floor or above the
ceiling. Leave a box empty for none. The setting is shared by every page.

### Record live

Open the **Live** tab, pick a microphone, and click **Start recording**. Pitch,
resonance, loudness and breathiness appear about a quarter of a second after you
say something. Who said it follows a moment later (speakers appear after the
first 10 seconds): until then the newest speech is drawn in grey as "Not sure
yet", and it takes on the speaker's colour once it is matched. The full grouping
re-runs every few seconds, so a label can change once there is more to go on;
when it does, the measurements are simply recoloured, not measured again. Type
over a name to rename someone; the name carries into the saved recording.

A new voice only becomes a new speaker once the grouping has kept it apart from
everyone else twice running, with a couple of seconds of speech; until then it
stays grey. Speakers are numbered 1, 2, 3 in the order they were confirmed, and
if one turns out to be someone already known, the numbers close up again.

The **Close-up** at the top shows the last 5, 10, 20 or 30 seconds, like a pitch
tracker (**Show** picks pitch, resonance, loudness or breathiness). Below it,
**1 min / 2 min / 5 min / Whole session** sets how much the other charts show.
Both scroll smoothly. **Scale** sets the value axis: **Fit what's on screen**
follows the voice, so it moves as the view scrolls; **Steady: whole session so
far** keeps each chart's range still (it only widens if a voice goes further);
**Steady: pitch range I set** holds pitch between two numbers of your choosing.

To record more than one input at once, click **+ Add another input**: say a
second microphone, or one program's sound. They are mixed together to work out
who is speaking, and the saved file keeps the mix as its first track plus each
input as a track of its own. Each input is also measured on its own. When
someone is the only voice on an input (you on your microphone, a friend on
Discord), that input is theirs: their turns are read off it, so when you talk
over each other both of you are marked; their voice is measured on it, so the
other voice doesn't blur their pitch; and their **Download** in Recordings is cut
from it, with nobody else in it. On a four-minute call this marked 95% of the
talking-over as both people (the mix alone managed a quarter to 40%), and put
97% of the rest to the right person. Two people sharing one microphone are
still told apart by voice, as usual.

**A program's sound:** the input list also
offers programs, like Discord, Zoom, a browser or a game. Only that program is
recorded (along with any helper programs it runs), not the rest of the computer
and not the microphone, and you still hear it as usual. A program shows up once
it has made a sound; click **↻ Refresh the list** if one is missing. A browser
is recorded as a whole, not one tab. Some things record as silence: streaming
services that protect their video (Netflix and the like), and the odd game that
takes over the sound device. If Windows is set to turn other sounds down during
calls (Sound settings → More sound settings → Communications), that lowering is
recorded too. Needs Windows 10 version 2004 or later.

**On a Mac (macOS 13 or later): experimental, not yet tested.** Apps with windows
are listed the same way. macOS treats this as screen recording, so the first
time it asks for permission; allow **Terminal** (it starts Silence Trimmer) under
System Settings → Privacy & Security → Screen & System Audio Recording, then quit
Terminal and start again. If you try it, please run
**`tools/Check Mac app audio.command`** first (right-click → Open the first
time), with something playing in the app you want to record, and send back the
`mac-app-audio-check.txt` it writes in this folder. If you installed before this
was added, run **Install Silence Trimmer.command** again to add what it needs.

Click **Stop and save** and the full recording (M4A, or FLAC if you chose it;
several inputs in FLAC are saved as an MKA file) goes into **Your recordings** and
is trimmed like any other. It is ready in moments, because the voiceprints and
voice measurements made while recording are kept with it, instead of being
worked out again. The page then
offers the trimmed MP3 or M4A and the full recording to download. **Discard**
throws the recording away instead. If the app is closed mid-recording, the part
recorded so far is saved the next time it starts, as "Recovered live".

To try it without a microphone, choose one of the **Replay** options: it plays a
saved recording at normal speed as if it were live. A recording made from several
inputs is replayed with its tracks, as it was recorded.

### Downloads

Every recording offers the trimmed file as MP3 or M4A, and the full, untrimmed
recording as it was added.

### Your recordings

Every recording you process is saved, with its settings and speaker names, and
listed in the sidebar (on a narrow window, under **Your recordings** at the top).
Click one to pick up where you left off, instantly; **New recording** takes you
back to the drop zone. If you drop in a file you've already done, it opens the
saved result instead of redoing it. Saves copied into the `library` folder from
another computer show up in the list within a few seconds. The page's address includes the recording, so refreshing the
browser keeps you on it.

They're kept in the **`library`** folder inside this folder, including a copy of
each original (it's needed to re-cut or pull out one speaker later), so a long
recording can take up some space. **Delete** removes one and everything made from
it.

### Who's speaking

Each speaker gets a row on a timeline of the trimmed recording; click anywhere
on it to jump there. Type a name over "Speaker 1" to rename someone. **Play** and
**Download** give you just that person's speech.

If you know how many people spoke, choose it under **Number of speakers**. The
app still groups the voices its own way first, then merges the speakers who talk
least into whoever they sound most like until that many are left (so a few
seconds of crosstalk can't take a real person's place). It updates in about a
second without interrupting playback, and names stay with the right voices:
merge two people and split them again, and both get their names back.

### Voice

Pick a speaker to chart their pitch, resonance, loudness and breathiness,
measured on their speech only. The charts share the trimmed recording's
timeline with **Who's speaking**, lined up underneath it: gaps are where someone
else is talking, a line follows what's playing, and clicking any chart plays
from that moment. Resonance also has a summary of where each of its three
parts usually sits. Hover over a chart to read exact values; every value is also
listed in a table underneath.

### Also remove coughs and other sounds

Tick **Also remove coughs, clicks and other sounds that aren't speech** to cut
audible sounds that the speech detector says aren't anyone talking. Quiet
speech is still protected, but if a word goes missing, untick it.

### If it cut too much or too little

Open **How the cut-off was chosen** at the bottom. It lists every cut-off it
tried, how much each would keep, and how much audible sound each would remove.
Click any row to re-cut the file at that level and listen again.

## How it chooses the cut-off

A fixed cut-off only suits one microphone setup. A mic that mutes itself
between phrases (as some headset software does) sits near digital silence, so
the usual -40 dB setting cuts off quiet words. In a noisy room, the same
setting keeps too much.

So the app measures each recording. The loudness of every 50 ms splits into two
groups, background and voice. A sound counts as *audible* if it is clearly
above the background (by 6 dB) and within 30 dB of the voice. The app tries
every cut-off from -25 dB down in 1 dB steps and uses the most aggressive one
that removes no audible sound. Stretches that are quieter than that for at
least 0.8 seconds are removed, with 0.15 seconds of padding kept either side.

## How it tells speakers apart

It runs the same method as the widely used pyannote 3.1 speaker-diarization
pipeline, with the same two models: one finds where speech is and where the
speaker changes, the other turns each stretch of speech into a voiceprint, and
matching voiceprints are grouped into one person. Two people whose voiceprints
come out very alike are merged, and tiny "speakers" who never say anything
longer than 0.8 seconds are folded into whoever they sound most like.

It is good at clearly different voices and less sure with similar ones, or
with one person using very different voices (voice practice, impressions).
When the count comes out wrong, setting **Number of speakers** fixes it.

## Troubleshooting

- **Windows says "An Application Control policy has blocked this file."**
  Smart App Control can block a newly installed file the first time it runs.
  Close the window and start the app again; it usually works on the second try.
- **The page says it lost contact.** The small window was closed. Start the app
  again.
- **Setup fails.** Check your internet connection and run the installer again;
  it picks up where it left off.

## Uninstall

Delete this folder, and the desktop shortcut on Windows. Nothing else was
installed. This also deletes your saved recordings (the `library` folder), so
download anything you want to keep first.

## For the curious

Python app in `silence_trimmer/`: `appaudio.py` records one program's sound on Windows (`appaudio_mac.py` on a Mac, untested), `core.py` picks the cut-off and cuts, `live.py` runs the
speaker and voice analysis on live input,
`speakers.py` identifies speakers, `sources.py` puts speakers on inputs of their own, `voice.py` measures voices, and `server.py`
is the local web page (it listens on `127.0.0.1` only). Versions are pinned for
reproducible installs: uv in `scripts/uv-env.*`, Python in `.python-version`,
packages in `uv.lock`, and the two bundled models by SHA-256 in `models.py`.
FFmpeg comes from the `imageio-ffmpeg` package.

Speaker identification is a port of pyannote.audio's pipeline to ONNX Runtime
and numpy, so no PyTorch is needed. It was checked frame for frame against the
PyTorch pipeline and matched exactly. The models, bundled in
`silence_trimmer/models/`, are pyannote **segmentation-3.0** (MIT) and the
**WeSpeaker ResNet34-LM** voiceprint model (CC BY 4.0), re-exported by
`tools/export_embedding.py`. Licences and attribution are in
`THIRD_PARTY_NOTICES.md`.

Run from a terminal with `uv run python -m silence_trimmer`
(`--port N`, `--no-browser`).

## Licence: non-commercial use only

Silence Trimmer's own code is under the **PolyForm Noncommercial License 1.0.0**
(`LICENSE.md`): free for personal use, study, research, hobby projects and
non-profit organisations; not for commercial use.

It measures voices with **openSMILE** by audEERING GmbH, installed as the
`opensmile` Python package. openSMILE's own licence, the audEERING Research
License, also allows non-commercial use only; commercial use of openSMILE, or
of features extracted with it, needs a licence from audEERING. The bundled
speaker models are under MIT and CC BY 4.0. Details and attribution are in
`THIRD_PARTY_NOTICES.md`.
