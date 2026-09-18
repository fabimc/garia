// One overlay on top at a time. Escape, Tab, and focus restore all go through
// here so a sheet cannot leave the list focused behind it, and so closing one
// dialog does not close every other dialog at once.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack = [];
let trapBound = false;

function visibleFocusable(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) => {
    if (node.closest(".hidden")) return false;
    return node.getClientRects().length > 0;
  });
}

function bindTrap() {
  if (trapBound) return;
  trapBound = true;
  document.addEventListener("keydown", onKey, true);
}

function onKey(e) {
  const top = stack[stack.length - 1];
  if (!top) return;

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }

  if (e.key !== "Tab") return;
  const nodes = visibleFocusable(top.el);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function overlayOpen() {
  return stack.length > 0;
}

export function openOverlay(el, { focus, close } = {}) {
  if (!el) return;
  const existing = stack.findIndex((entry) => entry.el === el);
  if (existing >= 0) stack.splice(existing, 1);
  const lastFocus = document.activeElement;
  const entry = {
    el,
    lastFocus,
    close: () => {
      if (typeof close === "function") close();
      else closeOverlay(el);
    },
  };
  stack.push(entry);
  el.classList.remove("hidden");
  bindTrap();
  const target = focus || visibleFocusable(el)[0];
  setTimeout(() => target?.focus?.(), 50);
}

export function closeOverlay(el) {
  const i = stack.findIndex((entry) => entry.el === el);
  const lastFocus = i >= 0 ? stack[i].lastFocus : null;
  if (i >= 0) stack.splice(i, 1);
  el?.classList.add("hidden");
  if (stack.length) {
    const next = visibleFocusable(stack[stack.length - 1].el)[0];
    next?.focus?.({ preventScroll: true });
    return;
  }
  if (lastFocus && document.contains(lastFocus) && typeof lastFocus.focus === "function") {
    lastFocus.focus({ preventScroll: true });
  }
}

export function closeTopOverlay() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
