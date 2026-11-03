/* Stage controller.
 *
 * The contract with the renderer is narrow and deliberate:
 *   window.__ready            resolves once the timeline and sprite sheet are loaded
 *   window.seekToTime(t)      paints the stage for time t, synchronously
 *   window.__layoutReport()   reports overflow / missing assets for the QC gate
 *
 * There is no animation loop and no transition anywhere, so a screenshot taken
 * after seekToTime(t) depends only on t.
 */
(function () {
  "use strict";

  window.el = function (tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  };

  let TL = null;
  let sprite = null;
  let spriteMeta = null;
  let lastT = -1;

  const sceneRoot = document.getElementById("scene");
  const captionLine = document.getElementById("caption-line");
  const avatarCanvas = document.getElementById("avatar");
  const avatarCtx = avatarCanvas.getContext("2d", { alpha: true });
  const poseLabel = document.getElementById("pose-label");
  const progressFill = document.getElementById("progress-fill");
  const sourceStrip = document.getElementById("source-strip");
  const daystamp = document.getElementById("daystamp");
  const eyebrow = document.getElementById("eyebrow");

  function loadJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) { throw new Error("cannot load " + url + ": " + r.status); }
      return r.json();
    });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("cannot load sprite " + url)); };
      img.src = url;
    });
  }

  function sceneAt(t) {
    for (let i = 0; i < TL.scenes.length; i++) {
      const s = TL.scenes[i];
      if (t >= s.start && t < s.end) { return s; }
    }
    return TL.scenes[TL.scenes.length - 1];
  }

  function captionAt(scene, t) {
    for (let i = 0; i < scene.captions.length; i++) {
      const c = scene.captions[i];
      if (t >= c.start && t < c.end) { return c; }
    }
    // Hold the last caption of the scene rather than blanking the band.
    return scene.captions.length ? scene.captions[scene.captions.length - 1] : null;
  }

  function anyWordActive(t) {
    const w = TL.words;
    for (let i = 0; i < w.length; i++) {
      if (t >= w[i].start && t < w[i].end) { return true; }
    }
    return false;
  }

  function drawAvatar(pose, mouth) {
    const frame = spriteMeta.frames[pose] && spriteMeta.frames[pose][mouth];
    avatarCtx.clearRect(0, 0, avatarCanvas.width, avatarCanvas.height);
    if (!frame) { return false; }
    avatarCtx.imageSmoothingEnabled = false;
    avatarCtx.drawImage(
      sprite, frame[0], frame[1], frame[2], frame[3],
      0, 0, avatarCanvas.width, avatarCanvas.height
    );
    return true;
  }

  function renderScene(scene, t) {
    const span = Math.max(scene.end - scene.start, 0.001);
    const progress = Math.min(Math.max((t - scene.start) / span, 0), 1);
    const ctx = {
      progress: progress,
      // Reveal n items evenly across the first 60% of the scene.
      reveal: function (n) {
        if (n <= 0) { return 0; }
        return Math.min(n, Math.floor(progress / 0.6 * n) + 1);
      }
    };
    sceneRoot.textContent = "";
    const fn = window.SCENE_TEMPLATES[scene.template];
    if (!fn) {
      throw new Error("unknown template " + scene.template);
    }
    fn(sceneRoot, scene.payload, ctx);
  }

  function renderCaption(scene, t) {
    const cap = captionAt(scene, t);
    captionLine.textContent = "";
    if (!cap) { return; }
    cap.words.forEach(function (w, i) {
      if (i > 0) { captionLine.appendChild(document.createTextNode(" ")); }
      const span = el("span", "w" + (t >= w.start ? " spoken" : ""), w.word);
      captionLine.appendChild(span);
    });
  }

  window.seekToTime = function (t) {
    if (!TL) { throw new Error("timeline not loaded"); }
    t = Math.min(Math.max(Number(t) || 0, 0), TL.duration);
    const scene = sceneAt(t);
    renderScene(scene, t);
    renderCaption(scene, t);

    const speaking = anyWordActive(t);
    // Deterministic 8 Hz mouth flap while a word is being spoken.
    const mouth = speaking ? (Math.floor(t * 8) % 2 === 0 ? "open" : "mid") : "closed";
    drawAvatar(scene.avatar_pose, mouth);
    poseLabel.textContent = scene.role + " / " + scene.avatar_pose;

    progressFill.style.width = (100 * t / TL.duration).toFixed(3) + "%";
    lastT = t;
    return t;
  };

  window.__layoutReport = function () {
    const problems = [];
    const card = sceneRoot.querySelector(".card");
    if (!card) {
      problems.push("no .card rendered");
    } else if (card.scrollHeight > card.clientHeight + 2) {
      problems.push("scene card overflows by " + (card.scrollHeight - card.clientHeight) + "px");
    }
    const term = sceneRoot.querySelector(".term");
    if (term && term.scrollHeight > term.clientHeight + 2) {
      problems.push("terminal overflows by " + (term.scrollHeight - term.clientHeight) + "px");
    }
    const capBox = document.getElementById("captions");
    if (captionLine.scrollHeight > capBox.clientHeight + 2) {
      problems.push("caption overflows band by " + (captionLine.scrollHeight - capBox.clientHeight) + "px");
    }
    sceneRoot.querySelectorAll("h2, .sub, .node .name").forEach(function (n) {
      if (n.scrollWidth > n.clientWidth + 2) {
        problems.push("clipped text: " + n.textContent.slice(0, 40));
      }
    });
    const spriteOk = !!sprite && sprite.naturalWidth > 0;
    if (!spriteOk) { problems.push("avatar sprite missing"); }
    return {
      t: lastT,
      problems: problems,
      spriteLoaded: spriteOk,
      stage: { w: document.getElementById("stage").offsetWidth,
               h: document.getElementById("stage").offsetHeight }
    };
  };

  window.__ready = loadJSON("timeline.json").then(function (tl) {
    TL = tl;
    eyebrow.textContent = tl.eyebrow || "AI & DEV TOOLS";
    daystamp.textContent = tl.daystamp || "";
    sourceStrip.textContent = (tl.source_strip || "");
    spriteMeta = tl.avatar.meta;
    return loadImage(tl.avatar.sheet);
  }).then(function (img) {
    sprite = img;
    window.seekToTime(0);
    document.body.setAttribute("data-ready", "1");
    return true;
  });
})();
