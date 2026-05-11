function getActiveActionButton() {
  const el = document.activeElement;
  if (!el) return null;
  if (el.tagName === "BUTTON") return el;
  if (typeof el.classList?.contains === "function" && el.classList.contains("btn")) return el;
  return null;
}

export function wrapWithActiveButtonLock(fn, onFinally) {
  if (typeof fn !== "function") return fn;
  return async function wrappedAction(...args) {
    const btn = getActiveActionButton();
    let spinner = null;
    let locked = false;
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      spinner = document.createElement("span");
      spinner.innerHTML = '<svg viewBox="0 0 50 50" style="width:14px;height:14px;animation:spin 1s linear infinite;margin-right:6px;display:inline-block;vertical-align:middle;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.4 31.4" opacity="0.8"></circle></svg>';
      btn.prepend(spinner);
      locked = true;
    }
    try {
      return await fn(...args);
    } finally {
      if (locked && btn) {
        btn.disabled = false;
        if (spinner && spinner.parentNode === btn) btn.removeChild(spinner);
      }
      if (typeof onFinally === "function") onFinally();
    }
  };
}
