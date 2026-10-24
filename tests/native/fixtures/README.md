`playback.mp4` is a generated two-second H.264/YUV420 clip, 160×90 at 12 fps,
with no audio. It contains only FFmpeg's built-in test pattern:

```sh
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=12 -t 2 -c:v libx264 -pix_fmt yuv420p -movflags +faststart playback.mp4
```

`media_graph_smoke.py` also generates a temporary PCM WAV, then verifies native
WebKit can decode both files and advance playback using the packaged runtime.
