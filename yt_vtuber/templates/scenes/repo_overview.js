// Scene template: repository overview.
// Receives validated payload data only. Text is written with textContent so a
// payload can never inject markup.
window.SCENE_TEMPLATES = window.SCENE_TEMPLATES || {};
window.SCENE_TEMPLATES.repo_overview = function (root, p, ctx) {
  const card = el("div", "card");
  card.appendChild(el("h2", null, p.repo));
  card.appendChild(el("div", "sub", p.tagline));

  const pills = el("div", "pillrow");
  pills.appendChild(el("span", "pill", p.language));
  pills.appendChild(el("span", "pill", p.license));
  card.appendChild(pills);

  const ul = el("ul", "bullets");
  // Bullets reveal one at a time across the scene, so a still frame still
  // reads as a designed layout rather than a half-drawn animation.
  const shown = ctx.reveal(p.bullets.length);
  p.bullets.forEach(function (b, i) {
    const li = el("li", null, b);
    li.style.visibility = i < shown ? "visible" : "hidden";
    ul.appendChild(li);
  });
  card.appendChild(ul);
  root.appendChild(card);
};
