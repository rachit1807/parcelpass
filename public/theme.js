try {
  document.documentElement.dataset.theme = localStorage.getItem('parcelpass-theme') || 'dark';
  if (localStorage.getItem('parcelpass-motion') === 'paused') document.documentElement.dataset.motion = 'paused';
} catch {}
