(() => {
  const canvas = document.getElementById('networkBg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1, points = [], raf = 0, last = 0;

  const palette = {
    line: 'rgba(215, 215, 215, 0.085)',
    dot: 'rgba(238, 238, 238, 0.36)',
    accent: 'rgba(118, 239, 135, 0.46)'
  };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    const density = w < 720 ? 23 : w < 1200 ? 38 : 54;
    points = Array.from({ length: density }, (_, i) => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - .5) * (reduced ? 0 : .23),
      vy: (Math.random() - .5) * (reduced ? 0 : .23),
      r: Math.random() < .12 ? 1.7 : .9 + Math.random() * .55,
      accent: i % 11 === 0
    }));
  }

  function tick(ts) {
    const dt = Math.min(32, ts - last || 16) / 16;
    last = ts;
    ctx.clearRect(0, 0, w, h);

    for (const p of points) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -30) p.x = w + 30;
      if (p.x > w + 30) p.x = -30;
      if (p.y < -30) p.y = h + 30;
      if (p.y > h + 30) p.y = -30;
    }

    const max = w < 720 ? 130 : 165;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      for (let j = i + 1; j < points.length; j++) {
        const b = points[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        if (dist < max) {
          ctx.strokeStyle = palette.line.replace('0.085', String(0.085 * (1 - dist / max)));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    for (const p of points) {
      ctx.fillStyle = p.accent ? palette.accent : palette.dot;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(tick);
  }

  addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { last = 0; raf = requestAnimationFrame(tick); }
  });
  resize();
  raf = requestAnimationFrame(tick);
})();
