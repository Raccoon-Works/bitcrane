# Website clips

Short silent loops of the app for bitcrane.de (`website/vid/`), recorded from the browser
prototype in demo mode (`?demo&clip`), so they always show the current interface.

| Clip | Shows | Length |
|---|---|---|
| `save` | Edit `app.py` in the built-in editor, save; the folder watch uploads it and runs `pm2 restart webshop` | 10.5 s |
| `term` | The terminal opens below the files, `pm2 restart webshop` is typed and answers | 6.8 s |

Each clip exists for mac/win × light/dark × de/en (8 MP4 files plus a WebP poster each,
the poster being the finished last moment, also shown with reduced motion).

## Recording again

1. Start the prototype: `npx vite --port 5179` (restart it after changing app code, the
   scripts import the store module directly).
2. Record, for every platform/theme/language:
   `node rec-save.cjs mac light de` (frames go to `/tmp/bc/clip/raw-…`)
3. Encode with a common length per clip so light and dark loop in step:
   `python3 encode.py /tmp/bc/clip/raw-save-mac-light-de vid/save-mac-light-de.mp4 1600 25 10.5`
   (`6.8` for `term`).
4. Copy the MP4 and WebP files to `website/vid/` and rebuild the site.

5. Raise `CLIP_V` in `website/js/shots.js`: browsers keep the clips for 30 days
   (`.htaccess`), the new number makes them load the new files.

Chromium must run with `--force-device-scale-factor=2`, otherwise the screencast delivers
frames at single resolution.
