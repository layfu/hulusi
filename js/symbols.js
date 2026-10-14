window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  function esc(s) {
    return HLS.model.esc(s);
  }

  var ROW_GLIDE = 32;   // 滑音占用的竖直高度
  var ROW_TEXT = 19;    // 文字符号每行的竖直间距

  function arrowUp(tx, ty) {
    return '<polygon class="sym-glide-head" points="' +
      tx + ',' + ty + ' ' +
      (tx - 3) + ',' + (ty + 9) + ' ' +
      (tx - 9) + ',' + (ty + 3) + '"/>';
  }

  function arrowDown(tx, ty) {
    return '<polygon class="sym-glide-head" points="' +
      tx + ',' + ty + ' ' +
      (tx - 3) + ',' + (ty - 9) + ' ' +
      (tx - 9) + ',' + (ty - 3) + '"/>';
  }

  // baseY 为滑音的下沿（贴着音符 / 八度点上方）
  function glideUp(cx, baseY) {
    var x1 = cx - 15, y1 = baseY;
    var x2 = cx + 9,  y2 = baseY - 26;
    var mx = cx - 3,  my = baseY - 22;
    return '<path class="sym-glide" d="M' + x1 + ' ' + y1 +
      ' Q' + mx + ' ' + my + ' ' + x2 + ' ' + y2 + '"/>' + arrowUp(x2, y2);
  }

  function glideDown(cx, baseY) {
    var x1 = cx - 15, y1 = baseY - 26;
    var x2 = cx + 9,  y2 = baseY;
    var mx = cx - 3,  my = baseY - 4;
    return '<path class="sym-glide" d="M' + x1 + ' ' + y1 +
      ' Q' + mx + ' ' + my + ' ' + x2 + ' ' + y2 + '"/>' + arrowDown(x2, y2);
  }

  function grace(cx, by, g) {
    var gx = cx - 13, gy = by - 22;
    var s = '<text class="sym-grace" x="' + gx + '" y="' + gy +
      '" text-anchor="middle">' + g.pitch + '</text>';
    var i;
    if (g.octave > 0) {
      for (i = 0; i < g.octave; i++) {
        s += '<circle class="odot gdot" cx="' + gx + '" cy="' + (gy - 15 - i * 7) + '" r="2.2"/>';
      }
    } else if (g.octave < 0) {
      for (i = 0; i < -g.octave; i++) {
        s += '<circle class="odot gdot" cx="' + gx + '" cy="' + (gy + 6 + i * 7) + '" r="2.2"/>';
      }
    }
    s += '<line class="sym-grace-slash" x1="' + (gx - 7) + '" y1="' + (gy + 5) +
      '" x2="' + (gx + 7) + '" y2="' + (gy - 14) + '"/>';
    return s;
  }

  function boYin(cx, y) {
    var w = 6;
    var d = 'M' + (cx - 14) + ' ' + y +
      ' q' + w + ' -8 ' + (w * 2) + ' 0' +
      ' q' + w + ' -8 ' + (w * 2) + ' 0';
    return '<path class="sym-bo" d="' + d + '" fill="none"/>';
  }

  function breathMark(bx, by) {
    return '<text class="sym-lab sym-breath" x="' + bx + '" y="' +
      (by - 30) + '" text-anchor="middle">v</text>';
  }

  // 依此从音符上方逐行堆叠，保证各符号互不重叠
  // geom: { x, w, cx, by, octTop, numW, dashW }
  // 返回 { html, top }，top 为已用最高的 y（越小越高），供连音线避让
  function draw(note, geom) {
    var n = note.orn || {};
    var cx = geom.cx, by = geom.by;
    var octTop = geom.octTop || 0;
    var numW = geom.numW || 30, dashW = geom.dashW || 34;

    // 音符 + 高八度点所占的最高位置，装饰符号必须在其上方
    var noteTop = by - 30 - (octTop > 0 ? ((octTop - 1) * 9 + 6) : 0);
    var out = '';
    var y = noteTop;
    var top = noteTop;

    // 有倚音时，滑音整体右移，避免与左上的倚音挤在一起
    var gShift = (note.grace && note.pitch !== 0) ? 17 : 0;

    if (n.up) { out += glideUp(cx + gShift, y); top = Math.min(top, y - 26); y -= ROW_GLIDE; }
    if (n.down) { out += glideDown(cx + gShift, y); top = Math.min(top, y - 26); y -= ROW_GLIDE; }
    var hadGlide = !!(n.up || n.down);

    if (note.grace && note.pitch !== 0) {
      out += grace(cx, by, note.grace);
      top = Math.min(top, by - 38);
    }

    var labels = [];
    if (n.single) labels.push('吐');
    if (n.double) labels.push('吐库');
    if (n.triple) labels.push('吐吐库');
    if (n.da) labels.push('打');
    if (n.trill) labels.push('tr');

    // 有滑音时文字紧接其上方；无滑音时留出舒适间距
    var cy = hadGlide ? y : (noteTop - 14);
    var i;
    for (i = 0; i < labels.length; i++) {
      out += '<text class="sym-lab" x="' + cx + '" y="' + cy +
        '" text-anchor="middle">' + esc(labels[i]) + '</text>';
      top = Math.min(top, cy - 15);
      cy -= ROW_TEXT;
    }
    if (n.bo) {
      out += boYin(cx, cy - 4);
      top = Math.min(top, cy - 13);
    }

    // 吸气记号：无增时线时在音符右上方，有增时线时在横线右上方
    if (n.breath) {
      var d = HLS.model.dashesOf(note);
      var bx = d > 0 ? (geom.x + numW + d * dashW - 8) : (cx + 15);
      out += breathMark(bx, by);
      top = Math.min(top, by - 43);
    }

    return { html: out, top: top };
  }

  HLS.symbols = { draw: draw };
})(window.HLS);
