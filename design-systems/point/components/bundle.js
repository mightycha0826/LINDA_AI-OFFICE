/* @ds-bundle: {"format":4,"namespace":"Point","components":[]} */
(function () {
  var GRAYS = [
    { ink: '#141A24', muted: '#5A6474', row: '#F0F2F6', track: '#D7DDE6', control: '#8690A0' },
    { ink: '#111111', muted: '#5C5C5C', row: '#F3F3F3', track: '#DADADA', control: '#8A8A8A' },
    { ink: '#1C1915', muted: '#655F56', row: '#F5F3EF', track: '#E0DBD2', control: '#928B80' }
  ];
  var DARKS = [
    { bg: '#1B1E24', surface: '#23272E', row: '#2B3038', track: '#3A404A', control: '#7A8292', ink: '#EEF1F5', muted: '#A3ABB8' },
    { bg: '#1E1E1E', surface: '#262626', row: '#2E2E2E', track: '#3D3D3D', control: '#808080', ink: '#F2F2F2', muted: '#A8A8A8' },
    { bg: '#1F1D1A', surface: '#272522', row: '#302D29', track: '#403C37', control: '#857E74', ink: '#F3EFE9', muted: '#ADA69B' }
  ];
  var COMBOS = [["코발트와 주황", "#2F45D8", "#F27A0A", 1], ["파랑과 하늘", "#2F6BEA", "#66BBE4", 0], ["에메랄드와 호박", "#00804F", "#F2A900", 2], ["남보라와 분홍", "#5B45E0", "#E83E7A", 1], ["다홍과 남색", "#F04A1A", "#22329C", 1], ["청록과 주황", "#0A6767", "#F27A0A", 2], ["남색과 라임", "#22329C", "#8DBF1F", 0], ["자주와 호박", "#842467", "#F2A900", 2], ["초록과 라임", "#167835", "#8DBF1F", 1], ["하늘과 다홍", "#1E9BD7", "#F04A1A", 0]];
  var ERROR = '#E5342B';
  var W = [255, 255, 255], K = [0, 0, 0];
  function rgb(h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  function hex(c) { return '#' + c.map(function (v) { return Math.round(v).toString(16).padStart(2, '0'); }).join('').toUpperCase(); }
  function mix(a, b, t) { return a.map(function (v, i) { return v + (b[i] - v) * t; }); }
  function lum(c) { var l = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; }
  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  // 반올림한 hex에서도 기준을 넘도록 0.03 여유
  function push(c, on, min, to) { var t = 0; while (t < 1 && ratio(mix(c, to, t), on) < min + 0.03) t += 0.02; return mix(c, to, t); }

  // index: 0-9, mode: 'light' | 'dark', opts.mute: 0-0.6 (dark only)
  function theme(index, mode, opts) {
    var combo = COMBOS[index] || COMBOS[0];
    var dark = mode === 'dark';
    var c1 = rgb(combo[1]), c2 = rgb(combo[2]), er = rgb(ERROR), P, k;
    if (!dark) {
      var g = GRAYS[combo[3]];
      P = { bg: W, surface: W, row: rgb(g.row), track: rgb(g.track), control: rgb(g.control), ink: rgb(g.ink), muted: rgb(g.muted) };
      P.control = push(P.control, P.row, 3, K);
    } else {
      var d = DARKS[combo[3]];
      P = {};
      for (k in d) P[k] = rgb(d[k]);
      P.muted = push(P.muted, P.row, 4.5, W);
      P.control = push(P.control, P.row, 3, W);
      var m = (opts && opts.mute) || 0;
      if (m) {
        var soften = function (c) { var v = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; return mix(mix(c, [v, v, v], m), P.bg, m * 0.4); };
        c1 = soften(c1); c2 = soften(c2);
      }
    }
    var to = dark ? W : K;
    function fit(c, on, min) { return push(c, on, min, to); }
    var p1 = c1;
    // 버튼 면: 흰 글자 4.5:1까지 어둡게. 다크에서는 흰 글자 4.5:1을 지키는 데까지 최대한 밝게
    var btn = push(c1, W, 4.5, K);
    if (dark) { var t = 0; while (t < 1 && ratio(mix(btn, W, t + 0.02), W) >= 4.53) t += 0.02; btn = mix(btn, W, t); }
    var icon = fit(c1, P.row, 3);
    var raised = mix(P.row, W, 0.08);
    return {
      'bg': hex(P.bg), 'surface': hex(P.surface), 'row': hex(P.row), 'track': hex(P.track), 'control': hex(P.control),
      'ink': hex(P.ink), 'ink-muted': hex(P.muted),
      'primary': hex(btn), 'on-primary': '#FFFFFF',
      'primary-mark': hex(fit(p1, P.bg, 3)), 'primary-text': hex(fit(p1, P.surface, 4.5)),
      'primary-icon': hex(icon), 'on-primary-icon': ratio(icon, W) >= 3 ? '#FFFFFF' : '#111111',
      'point': hex(c2), 'point-mark': hex(fit(c2, P.surface, 3)), 'point-icon': hex(fit(c2, P.row, 3)),
      'danger': hex(fit(er, P.row, 4.5)), 'danger-on-bg': hex(fit(er, P.bg, 4.5)), 'danger-line': hex(fit(er, P.row, 3)),
      'badge-bg': dark ? hex(mix(P.row, W, 0.06)) : '#FFFFFF',
      'toast-bg': dark ? hex(raised) : hex(P.ink),
      'toast-ink': dark ? hex(P.ink) : '#FFFFFF',
      'toast-action': dark ? hex(mix(P.row, W, 0.18)) : hex(mix(P.ink, W, 0.16)),
      'toast-icon': dark ? hex(fit(er, raised, 3)) : hex(push(er, P.ink, 3, W)),
      'toast-primary-icon': dark ? hex(fit(p1, raised, 3)) : hex(push(p1, P.ink, 3, W)),
      'focus': dark ? '#EEEEEE' : '#141414',
      'shadow-dock': '0 -1px 0 ' + hex(P.track)
    };
  }

  function apply(el, index, mode, opts) {
    var t = theme(index, mode, opts);
    for (var k in t) el.style.setProperty('--' + k, t[k]);
    el.setAttribute('data-theme', mode === 'dark' ? 'dark' : 'light');
    return t;
  }

  window.Point = window.Point || {};
  window.Point.COMBOS = COMBOS.map(function (c, i) { return { index: i, name: c[0], primary: c[1], point: c[2], gray: ['cool', 'neutral', 'warm'][c[3]] }; });
  window.Point.theme = theme;
  window.Point.apply = apply;
})();
