// Scene template: terminal / code demo with a deterministic typing effect.
window.SCENE_TEMPLATES = window.SCENE_TEMPLATES || {};
window.SCENE_TEMPLATES.terminal_demo = function (root, p, ctx) {
  const card = el("div", "card");
  card.appendChild(el("h2", null, p.title));

  const bar = el("div", "termbar");
  bar.appendChild(el("span", "dot"));
  bar.appendChild(el("span", "dot"));
  bar.appendChild(el("span", "dot"));
  bar.appendChild(el("span", null, "shell"));
  card.appendChild(bar);

  const term = el("div", "term");
  const total = p.lines.reduce(function (n, l) { return n + l[1].length; }, 0);
  // Characters typed is a pure function of scene progress.
  let budget = Math.round(ctx.progress * total * 1.15);
  p.lines.forEach(function (line) {
    const kind = line[0], text = line[1];
    const take = Math.max(0, Math.min(text.length, budget));
    budget -= text.length;
    if (take <= 0 && budget < 0) { return; }
    const row = el("span", "row " + kind);
    row.appendChild(document.createTextNode(text.slice(0, take)));
    if (take < text.length) {
      row.appendChild(el("span", "cursor", " "));
    }
    term.appendChild(row);
  });
  card.appendChild(term);
  root.appendChild(card);
};
