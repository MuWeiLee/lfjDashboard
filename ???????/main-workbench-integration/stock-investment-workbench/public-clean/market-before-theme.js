function placeMarketBeforeTheme() {
  const nav = document.querySelector('.nav');
  const order = ['market', 'emotion', 'themes', 'screen', 'review'];
  if (nav) {
    order.forEach((name) => {
      const item = nav.querySelector(`[data-view="${name}"]`);
      if (item) nav.appendChild(item);
    });
  }
  order.forEach((name, index) => {
    const label = document.querySelector(`[data-view="${name}"] > span`);
    if (label) label.textContent = String(index + 1).padStart(2, '0');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', placeMarketBeforeTheme);
} else {
  placeMarketBeforeTheme();
}
