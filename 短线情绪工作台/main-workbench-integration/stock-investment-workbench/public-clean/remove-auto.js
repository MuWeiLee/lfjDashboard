function removeAutomaticOpportunityView() {
  const dashboardNav = document.querySelector('[data-view="dashboard"]');
  const dashboardView = document.querySelector('#view-dashboard');
  const nav = document.querySelector('[data-view="automation"]');
  const view = document.querySelector('#view-automation');
  const dashboardEntry = document.querySelector('.auto-dashboard-entry');

  if (dashboardEntry) {
    const arrow = dashboardEntry.nextElementSibling;
    dashboardEntry.remove();
    if (arrow?.tagName === 'EM') arrow.remove();
  }
  document.querySelectorAll('[data-go="automation"]').forEach((element) => element.remove());
  const dashboardWasActive = dashboardNav?.classList.contains('active') || dashboardView?.classList.contains('active');
  dashboardNav?.remove();
  dashboardView?.classList.remove('active');
  dashboardView?.setAttribute('aria-hidden', 'true');
  nav?.remove();
  view?.remove();

  if (dashboardWasActive) {
    document.querySelector('[data-view="market"]')?.classList.add('active');
    document.querySelector('#view-market')?.classList.add('active');
    const title = document.querySelector('#page-title');
    if (title) title.textContent = 'AI市场研判';
  }

  const order = ['market', 'emotion', 'themes', 'screen', 'review'];
  order.forEach((name, index) => {
    const label = document.querySelector(`[data-view="${name}"] > span`);
    if (label) label.textContent = String(index + 1).padStart(2, '0');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', removeAutomaticOpportunityView);
} else {
  removeAutomaticOpportunityView();
}
