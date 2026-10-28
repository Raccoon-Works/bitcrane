/**
 * The three window buttons of the Mac, drawn by the prototype. In the app the
 * system draws the real ones on top (overlay title bar); this keeps the space.
 */
export function TrafficLights() {
  return (
    <div className="traffic" aria-hidden="true" data-tauri-drag-region>
      <span className="tl tl-close" />
      <span className="tl tl-min" />
      <span className="tl tl-max" />
    </div>
  );
}
