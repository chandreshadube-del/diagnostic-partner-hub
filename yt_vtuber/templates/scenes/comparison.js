// Scene template: two-column comparison table.
window.SCENE_TEMPLATES = window.SCENE_TEMPLATES || {};
window.SCENE_TEMPLATES.comparison = function (root, p, ctx) {
  const card = el("div", "card");
  card.appendChild(el("h2", null, p.title));

  const table = el("table", "cmp");
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", null, ""));
  hr.appendChild(el("th", null, p.left_label));
  hr.appendChild(el("th", null, p.right_label));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  const shown = ctx.reveal(p.rows.length);
  p.rows.forEach(function (row, i) {
    const tr = el("tr");
    tr.appendChild(el("td", "lead", row[0]));
    tr.appendChild(el("td", "left", row[1]));
    tr.appendChild(el("td", "right", row[2]));
    tr.style.visibility = i < shown ? "visible" : "hidden";
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  card.appendChild(table);
  root.appendChild(card);
};
