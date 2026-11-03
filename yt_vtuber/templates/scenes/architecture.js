// Scene template: vertical architecture / flow diagram.
window.SCENE_TEMPLATES = window.SCENE_TEMPLATES || {};
window.SCENE_TEMPLATES.architecture = function (root, p, ctx) {
  const card = el("div", "card");
  card.appendChild(el("h2", null, p.title));

  const flow = el("div", "flow");
  const shown = ctx.reveal(p.nodes.length);
  p.nodes.forEach(function (n, i) {
    if (i > 0) {
      const a = el("div", "arrow", "↓" + (p.edge_label && i === 1 ? "  " + p.edge_label : ""));
      a.style.visibility = i < shown ? "visible" : "hidden";
      flow.appendChild(a);
    }
    const node = el("div", "node");
    node.appendChild(el("span", "name", n[0]));
    node.appendChild(el("span", "note", n[1]));
    node.style.visibility = i < shown ? "visible" : "hidden";
    flow.appendChild(node);
  });
  card.appendChild(flow);
  root.appendChild(card);
};
