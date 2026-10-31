# Atelier

A Command Code mod that turns the agent into a creative studio. Describe what you want, and it designs images, records voiceovers and cuts videos on your machine, checks each result with real measurements, and shows finished work in a live gallery.

## What it can make

| Engine | Makes | Runs on | Cost |
|---|---|---|---|
| `design` | Posters, social posts, slides, thumbnails, video stills (PNG) | Headless Chrome renders the agent's HTML and CSS at exact pixels | Free |
| `voice` | Voiceovers (M4A) | macOS `say` voices, encoded with ffmpeg | Free |
| `video` | Reels and videos (MP4) from stills, motion, crossfades, voiceover and music | ffmpeg | Free |
| `motion` | Animated HTML and CSS rendered to MP4 video | Headless Chrome renders the animation frame by frame, encoded with ffmpeg | Free |
| `fal-image` | AI images | fal.ai (needs `FAL_KEY`) | Paid, asks first |

Every output gets a measured review: black or frozen frames, silences, loudness, true peak, image size and blank renders. Images and video also come back with a small preview the agent can look at.

## Requirements

- macOS with Google Chrome (or Edge or Chromium, or set `ATELIER_CHROME`)
- ffmpeg on `PATH`

## Install

For every project, from the private repo:

```bash
cmd mods add -g git@github.com:aliarain/atelier.git
```

From a local checkout:

```bash
cmd mods add -g ~/Documents/Projects/atelier
```

For one run only:

```bash
cmd --mod ~/Documents/Projects/atelier
```

Remove it with `cmd mods remove -g atelier`. Then ask for something: "Make a square Instagram post for my bakery's spring menu", or "Make a 15 second vertical reel with a voiceover about our launch".

## Tools the agent gets

| Tool | Does |
|---|---|
| `atelier_engines` | Lists engines, whether each works here, and their input schemas |
| `atelier_create` | Runs one job and waits; returns outputs, review and preview |
| `atelier_review` | Measures any image, video or audio file |
| `atelier_jobs` | Lists jobs for this chat or the whole project |
| `atelier_present` | Marks finished work as delivered and opens the gallery |

`/atelier` opens the Atelier pane and the gallery. In the desktop app the gallery opens inside the workbench as a mod view; elsewhere it opens in your browser.

The gallery shows every job as a tile and updates live. Filter buttons (All, Images, Videos, Audio) appear once there is more than one kind of work. Each tile has three actions: Variant asks the agent for another take on the same brief, Show in Finder reveals the output files, and Mark shown records the job as delivered.

## Where things go

Jobs and outputs live in the project under `.atelier/` (`jobs/<id>.json`, `out/<id>/`). A paid job interrupted mid-run becomes `uncertain` and is never re-run without asking.

## Develop

```bash
pnpm test        # 201 tests, real Chrome, say and ffmpeg runs included
pnpm typecheck   # needs a built Command Code checkout at ../commandcode
```
