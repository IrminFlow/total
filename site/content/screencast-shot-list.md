# Shot list: ninety seconds, one real GSTR-1 export

This is a script for a screen recording that nobody has made yet. The site has a slot for it at
`/demo`, and the slot shows an honest placeholder until `NEXT_PUBLIC_DEMO_VIDEO_URL` points at a
real file.

Everything below is a real screen of the real app. The still frames in `smoke-out/shots/light/`
are what each shot should look like, so if the recording does not resemble the named PNG,
something has gone wrong before the camera rolled.

## Before recording

- Use the `Demo Traders` company, or seed a fresh one. It needs at least six sales invoices in
  the quarter, of which at least two are B2C and one is a credit note, or the return has nothing
  interesting in it.
- Light theme. It is the default and it reads better when the video is compressed.
- Window at 1440 by 900, which is what the still frames were taken at. Do not full-screen it:
  the sidebar accelerator letters get lost at the edge of a large display.
- Zero notifications. Quit anything that can put a banner over the recording.
- Record at 60fps with the cursor visible, and turn on the keystroke overlay if the recorder has
  one. The keyboard is the argument; a viewer who cannot see the keys just sees screens changing.
- No voiceover. Captions instead: a screen recording with a person talking over it gets watched
  at 1.5x with the sound off, and captions survive that.

## The shots

Ninety seconds total. Timings are cumulative and approximate; the cut points are not.

### 1. Gateway, at rest (0:00 to 0:06)

`gateway.png`. Open on the Gateway with the tiles showing cash, receivables, payables and GST,
and the day's entries below. Hold still for two seconds before touching anything. Let the red
accelerator letters register.

Caption: *Every menu item has one red letter.*

### 2. Press V (0:06 to 0:12)

Press `V`. Voucher entry opens. No mouse movement at all in this shot.

Caption: *V opens voucher entry from any screen.*

### 3. Enter one sales invoice (0:12 to 0:38)

`voucher-entry.png`. Press `F8` for sales. Then, without touching the mouse:

- Date field, type a shorthand date and press Enter.
- Party field, type three or four letters of a party name and let the picker narrow. Enter.
- Item, quantity, rate. Enter between each.
- The GST lines compute themselves. Do not scroll past this. Pause for a full second on the
  computed CGST and SGST lines so the viewer sees they were not typed.
- Enter to the accept bar, Enter to accept.

Caption: *The tax works itself out. Enter accepts.*

This is the longest shot and it carries the video. If it takes more than twenty-six seconds, the
typing is too slow, not the shot too long.

### 4. Day book confirms it landed (0:38 to 0:45)

`daybook.png`. Press `D`. The invoice just entered is the top row. Move the selection down one
row and back with the arrow keys so the amber cursor bar is visibly a cursor.

Caption: *Posted. Nothing to save.*

### 5. Open GSTR-1 (0:45 to 0:52)

`gstr1.png`. Press `1`. The return opens on the current period.

Caption: *GSTR-1, computed from those vouchers.*

### 6. The period pill (0:52 to 1:00)

Change the period to the full quarter. Let the figures repopulate on screen. Do not cut away
during the recompute: watching the numbers change in place is the proof that nothing is stored.

Caption: *No filing sheet. It is read from the books each time.*

### 7. Read down the sections (1:00 to 1:12)

Scroll slowly through the section table: B2B, B2C large, B2C small, credit and debit notes,
exports, nil rated, HSN summary, documents issued. Stop on the total row and hold for two
seconds.

Caption: *Every table the return needs.*

### 8. Export the JSON (1:12 to 1:22)

Press the **Export portal JSON** button. Let the confirmation appear. Then cut to Finder, or to
the Windows file explorer, showing the exported `.json` and the CSV summary sitting beside it in
`exports/`.

Caption: *The file the offline tool takes. And a CSV to read it with.*

If the export is blocked, the button says so and names the blocking issues. Do not record around
that. Fix the underlying data, and consider recording a second, ten-second clip of the blocked
state for the documentation, because it is a good screen.

### 9. Close on the folder (1:22 to 1:30)

Show `~/Documents/total` in Finder: the company folder, the SQLite file, the backups folder,
the exports folder. Hold for four seconds. No caption on this shot. The last thing on screen
should be the file, not a logo.

## Cutting notes

- No music.
- No title card at the front. The first frame is the app.
- One end card, four seconds: the wordmark, `devjindal.tech`, and nothing else.
- Export at 1920 by 1200, H.264, under 12 MB if possible. It is a marketing page, not a cinema.
- Also export a 3-second silent loop of shot 3 alone for the front page, if one is wanted there.

## After recording

1. Put the file somewhere with a stable URL. The public folder of this site is fine if it is
   under about 12 MB.
2. Set `NEXT_PUBLIC_DEMO_VIDEO_URL` to that URL, and `NEXT_PUBLIC_DEMO_VIDEO_POSTER` to a still
   frame from shot 5 if you have one.
3. The `/demo` page picks both up on the next deploy and the placeholder disappears.
