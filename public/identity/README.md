# Notation identity assets

Except for the locally authored Git icons described below, these SVGs are
exported from the approved version-one proposal in the user's
[Notation Figma file](https://www.figma.com/design/r7uyQu21129ujQ3mcZ4Avi/-BRAND--Notation?node-id=17-22).
The Figma exports include the original Notation mark and the centered custom icon set.

The numeric filename prefix identifies the source view: 0 = dark editor,
1 = Settings, 2 = application menu, 3 = command palette, 4 = light editor.
The remaining filename is Figma's asset identifier. Keep the original SVG
geometry and intrinsic dimensions intact; size and center the containing
element instead of rewriting paths or applying independent axis scaling.
Checkbox marks and the light-theme Save glyph use these same exports as CSS
masks so their foreground can follow the control's contrast and system colors.

`git-dark.svg` and `git-light.svg` are locally authored for Notation, not
Figma exports. They use an 18 × 18 canvas, 1.125px rounded strokes, and the
same dark (`#C8C8C8`) and light (`#30302F`) colors as the exported icon set.

Source Sans 3 and IBM Plex Mono are bundled through the existing Fontsource packages.
The desktop launcher icon in `src-tauri/icons/icon.svg` embeds the original
mark on the application's dark rounded tile; `icon.png` is its raster export.
