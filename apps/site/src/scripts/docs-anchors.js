// Feedback for the link icon next to a docs heading: a click copies the link, the icon turns into a check mark,
// a small "Link copied" tag appears and the heading is highlighted. Without it the click only moved the page to a
// heading that was already in view, so nothing seemed to happen. Plain JavaScript, inlined into every docs page.
(() => {
  const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  const timers = new WeakMap();

  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest(".sl-anchor-link") : null;
    if (!link) return;
    const wrapper = link.closest(".sl-heading-wrapper");
    const heading = wrapper && wrapper.firstElementChild;
    const icon = link.querySelector(".sl-anchor-icon");
    if (!wrapper || !heading || !icon) return;

    // The browser still follows the link (the address bar gets the #hash); copying is on top of that.
    const url = new URL(link.getAttribute("href"), location.href).href;
    try {
      navigator.clipboard.writeText(url).catch(() => {});
    } catch {}

    // Restart the highlight even when the same heading is clicked again.
    heading.classList.remove("is-linked");
    void heading.offsetWidth;
    heading.classList.add("is-linked");

    // The tag flips to the left when the icon is close to the right edge of the screen.
    link.classList.toggle("is-flip", link.getBoundingClientRect().right + 112 > innerWidth);
    if (!icon.dataset.idle) icon.dataset.idle = icon.innerHTML;
    icon.innerHTML = CHECK;
    link.classList.remove("is-copied");
    void link.offsetWidth;
    link.classList.add("is-copied");

    let status = wrapper.querySelector(".sl-anchor-status");
    if (!status) {
      status = document.createElement("span");
      status.className = "sl-anchor-status sr-only";
      status.setAttribute("role", "status");
      wrapper.append(status);
    }
    status.textContent = "";
    requestAnimationFrame(() => (status.textContent = "Link copied"));

    clearTimeout(timers.get(link));
    timers.set(link, setTimeout(() => {
      link.classList.remove("is-copied");
      icon.innerHTML = icon.dataset.idle;
      heading.classList.remove("is-linked");
      status.textContent = "";
    }, 2000));
  });
})();
