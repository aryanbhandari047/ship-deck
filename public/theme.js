'use strict';
// Applies the saved theme (More > Theme) before first paint; "system" follows the OS.
(function () {
  try {
    const t = localStorage.getItem('shipdeck.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch { /* storage blocked: follow the OS */ }
})();
