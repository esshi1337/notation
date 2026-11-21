// macOS WebKit does not focus a button when it is clicked. Controls here keep
// their key handling on the clicked button (Escape and arrows on a dropdown,
// arrows on tabs and segmented options), so without focus those keys go to
// whatever was focused before. This makes focus follow a pointer click on a
// button in every engine; where the engine already focused it, nothing
// happens. Two cases are left alone: a control that cancels the press to keep
// focus elsewhere (formatting buttons, list options), and a click whose own
// handlers moved focus (into a menu, dialog or field).
export function focusButtonsOnClick(root: Document = document): () => void {
  let pressCancelled = false;
  let focusMoved = false;
  // Read in the bubble phase, after the control's own press handlers ran.
  const press = (event: Event) => { pressCancelled = event.type === 'pointerdown' ? event.defaultPrevented : pressCancelled || event.defaultPrevented; };
  const beforeClick = () => { focusMoved = false; };
  const focusin = () => { focusMoved = true; };
  const click = (event: MouseEvent) => {
    const cancelled = pressCancelled;
    pressCancelled = false;
    // detail is 0 for keyboard activation and script clicks, which manage focus themselves.
    if (cancelled || focusMoved || event.detail === 0) return;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled || !button.isConnected || button.closest('[inert]') || root.activeElement === button) return;
    button.focus({ preventScroll: true });
  };
  root.addEventListener('pointerdown', press);
  root.addEventListener('mousedown', press);
  root.addEventListener('click', beforeClick, true);
  root.addEventListener('focusin', focusin);
  root.addEventListener('click', click);
  return () => {
    root.removeEventListener('pointerdown', press);
    root.removeEventListener('mousedown', press);
    root.removeEventListener('click', beforeClick, true);
    root.removeEventListener('focusin', focusin);
    root.removeEventListener('click', click);
  };
}
