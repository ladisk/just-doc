/* just-doc: Plotly plots follow the light or dark look of the page.
   just-doc serves this after plotly.min.js at /_lib/plotly.min.js, so a page needs nothing else.
   A plot gets a default template with a transparent background and text and grid colours that
   suit the page background (page.css variables when present). Colours that the page sets in its
   own layout win, and a template the page sets is left alone. When the system switches between
   light and dark, the plots are drawn again with the new colours. Plots are responsive (they follow
   the width of the page) unless the page sets config.responsive itself. */
(function () {
  const P = typeof window !== 'undefined' && window.Plotly;
  if (!P || P.__justDocTheme) return;
  P.__justDocTheme = true;

  // whether the page background is dark: the first background colour up from <body>
  function isDark() {
    for (let el = document.body; el; el = el.parentElement) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || +m[3] > 0)) return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255 < 0.5;
    }
    return false;
  }

  function template() {
    const dark = isDark(), css = getComputedStyle(document.documentElement);
    const v = (name, light, darkValue) => css.getPropertyValue(name).trim() || (dark ? darkValue : light);
    const fg = v('--fg', '#1f2328', '#e6edf3'), grid = v('--line', '#d0d7de', '#30363d'), muted = v('--muted', '#656d76', '#8d96a0');
    const axis = { color: fg, gridcolor: grid, linecolor: muted, zerolinecolor: muted, tickcolor: muted };
    const axis3 = Object.assign({ backgroundcolor: 'rgba(0,0,0,0)', showbackground: false }, axis);
    return { layout: {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: fg },
      xaxis: axis, yaxis: axis, scene: { xaxis: axis3, yaxis: axis3, zaxis: axis3 },
      polar: { bgcolor: 'rgba(0,0,0,0)', angularaxis: axis, radialaxis: axis },
      legend: { bgcolor: 'rgba(0,0,0,0)' },
      modebar: { bgcolor: 'rgba(0,0,0,0)', color: muted, activecolor: fg },
    } };
  }

  const themed = new Set();   // the plots that got this template
  function wrap(name) {
    const orig = P[name];
    if (typeof orig !== 'function') return;
    P[name] = function (gd, data, layout, config) {
      const el = typeof gd === 'string' ? document.getElementById(gd) : gd;
      // newPlot(gd, {data, layout, config}) or newPlot(gd, data, layout, config)
      const fig = data && !Array.isArray(data) && typeof data === 'object' ? data : null;
      let lay = fig ? fig.layout : layout;
      if (!lay || lay.template === undefined || (el && themed.has(el) && lay.template && lay.template.__justDoc)) {
        lay = Object.assign({}, lay, { template: Object.assign(template(), { __justDoc: true }) });
        if (el) themed.add(el);
      } else if (el) themed.delete(el);
      // a plot follows the width of the window (the comment panel narrows the page) unless the page says otherwise
      const conf = Object.assign({ responsive: true }, fig ? fig.config : config);
      const args = fig ? [gd, Object.assign({}, fig, { layout: lay, config: conf })] : [gd, data, lay, conf];
      return orig.apply(this, args);
    };
  }
  ['newPlot', 'react', 'plot'].forEach(wrap);

  function redraw() {
    for (const el of themed) {
      if (!el.isConnected) { themed.delete(el); continue; }
      P.relayout(el, { template: Object.assign(template(), { __justDoc: true }) });
    }
  }
  // page.css changes its colours at the same moment; read them a moment later
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(redraw, 50));
})();
