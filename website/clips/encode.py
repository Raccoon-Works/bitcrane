"""Turns recorded screencast frames into a looping MP4: cropped to the app window, constant
30 fps from the frame timestamps, and a short crossfade from the end back into the first frame."""
import json, subprocess, sys, os
raw, out, width = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1600
t = json.load(open(f'{raw}/times.json')); box = json.load(open(f'{raw}/box.json'))
ts = t['times']; end = t.get('end') or ts[0] + t['dur']
# Optional common length (all variants of a clip loop in step): the calm end is held longer.
if len(sys.argv) > 5: end = max(end, ts[0] + float(sys.argv[5]))
ts = [x for x in ts if x < end]
# The window sits on a plain page; crop just inside its border (device pixels are 2x CSS).
x, y = int(box['x'] * 2), int(box['y'] * 2)
w, h = int(box['width'] * 2) // 2 * 2, int(box['height'] * 2) // 2 * 2
lst = f'{raw}/list.txt'
with open(lst, 'w') as f:
    for i, tt in enumerate(ts):
        nxt = ts[i + 1] if i + 1 < len(ts) else end
        f.write(f"file 'f{i:05d}.jpg'\nduration {max(0.001, nxt - tt):.4f}\n")
    f.write(f"file 'f{len(ts) - 1:05d}.jpg'\n")
main = f'{raw}/main.mp4'
crop = f'crop={w}:{h}:{x}:{y},scale={width}:-2:flags=lanczos'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst,
                '-vf', f'{crop},fps=30,tpad=stop_mode=clone:stop_duration=3,format=yuv420p', *(['-t', sys.argv[5]] if len(sys.argv) > 5 else []),
                '-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', main], check=True)
dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', main], capture_output=True, text=True).stdout)
FADE = 0.45
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', main, '-loop', '1', '-t', str(FADE + 0.1), '-i', f'{raw}/f00000.jpg',
                '-filter_complex', f'[1:v]{crop},fps=30,format=yuv420p,settb=1/30,setsar=1[s];[0:v]fps=30,settb=1/30,setsar=1[m];[m][s]xfade=transition=fade:duration={FADE}:offset={dur - FADE:.3f},format=yuv420p[v]',
                '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', sys.argv[4] if len(sys.argv) > 4 else '25', '-preset', 'veryfast',
                '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], check=True)
# Poster: the last frame, when everything is done (also what reduced motion shows).
from PIL import Image
im = Image.open(f'{raw}/f{len(ts) - 1:05d}.jpg').crop((x, y, x + w, y + h))
im.resize((width, round(h * width / w)), Image.LANCZOS).save(out.replace('.mp4', '.webp'), quality=82)
print(out, os.path.getsize(out) // 1024, 'KB', f'{w}x{h} -> {width}', f'{dur:.1f}s')
