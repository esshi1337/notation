// WebKitGTK and WKWebView draw overlay scrollbar thumbs in a compositor layer
// above all page content, including menus and modal dialogs in the top layer.
// style.css hides the thumbs of scrollers underneath an open menu or dialog,
// but only where scrollbars overlay: classic scrollbars are ordinary content
// and already paint beneath those surfaces.
export function markOverlayScrollbars(root: HTMLElement = document.documentElement): boolean {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-200px;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden';
  root.append(probe);
  const overlay = probe.offsetWidth - probe.clientWidth === 0;
  probe.remove();
  root.dataset.scrollbars = overlay ? 'overlay' : 'classic';
  return overlay;
}
