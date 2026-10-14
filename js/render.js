window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  var esc = HLS.model.esc;

  var G = {
    W: 880,
    padX: 12,
    contentW: 856,
    headerH: 138,
    lineH: 140,
    baseline: 84,
    numFont: 30,
    numW: 30,
    beatW: 34,
    dashW: 34,
    dotR: 3.2,
    scale: 1
  };

  var BASE_W = 880;
  var BASE_PAD = 12;
  // A4 打印：纸张留白由 .paper 的 padding（4mm）提供，内容区约 202mm × 289mm
  var PAGE_W_MM = 202;
  var PAGE_H_MM = 289;
  var PAGE_UNITS = BASE_W * PAGE_H_MM / PAGE_W_MM; // 一页高度（基准单位）

  // 字号比例 s：放大字号 → 每行音符变少、行数变多；缩小则相反
  function applyScale(s) {
    if (!s || s <= 0) s = 1;
    G.scale = s;
    G.W = BASE_W / s;
    G.padX = BASE_PAD / s;
    G.contentW = (BASE_W - 2 * BASE_PAD) / s;
  }

  // 独立 SVG 需要自带样式（导出 / 打印用），作用域限定在 .scoresvg
  var SVG_STYLE =
    '.scoresvg, .scoresvg *{ font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Arial,sans-serif; }' +
    '.scoresvg .num{ font-size:30px; font-weight:600; fill:#1b1a17; }' +
    '.scoresvg .h-title{ font-size:34px; font-weight:700; fill:#1b1a17; }' +
    '.scoresvg .h-author{ font-size:18px; font-weight:500; fill:#4a463f; }' +
    '.scoresvg .h-meta{ font-size:20px; font-weight:600; fill:#1b1a17; }' +
    '.scoresvg .h-page{ font-size:24px; font-weight:700; fill:#000000; letter-spacing:1px; }' +
    '.scoresvg .barline{ stroke:#1b1a17; stroke-width:1.6; }' +
    '.scoresvg .dash{ stroke:#1b1a17; stroke-width:2.6; stroke-linecap:round; }' +
    '.scoresvg .uline{ stroke:#1b1a17; stroke-width:1.8; }' +
    '.scoresvg .odot, .scoresvg .augdot{ fill:#1b1a17; }' +
    '.scoresvg .sym-glide{ fill:none; stroke:#1b1a17; stroke-width:1.8; }' +
    '.scoresvg .sym-glide-head{ fill:#1b1a17; }' +
    '.scoresvg .sym-lab{ font-size:16px; font-weight:600; fill:#1b1a17; }' +
    '.scoresvg .sym-grace{ font-size:19px; font-weight:600; fill:#1b1a17; }' +
    '.scoresvg .sym-grace-slash{ stroke:#1b1a17; stroke-width:1.6; }' +
    '.scoresvg .sym-bo{ stroke:#1b1a17; stroke-width:1.8; }' +
    '.scoresvg .slur{ fill:none; stroke:#1b1a17; stroke-width:1.6; }' +
    '.scoresvg .repeatbar{ stroke:#1b1a17; stroke-width:1.8; }' +
    '.scoresvg .repeatdot{ fill:#1b1a17; }' +
    '.scoresvg .selbox{ fill:rgba(43,111,72,0.13); stroke:#2b6f48; stroke-width:2; }' +
    '.scoresvg .insertcaret{ fill:#2b6f48; animation:hlsCaret 1.1s step-end infinite; }' +
    '@keyframes hlsCaret{ 0%,49%{opacity:1} 50%,100%{opacity:0.1} }' +
    '.scoresvg .pendbox{ fill:rgba(156,90,18,0.16); stroke:#9c5a12; stroke-width:2; }' +
    '.scoresvg .graceedbox{ fill:rgba(156,90,18,0.16); stroke:#9c5a12; stroke-width:2; }';

  function noteWidth(n) {
    var d = HLS.model.dashesOf(n);
    var base = d > 0 ? G.numW + d * G.dashW : G.numW;
    var w = Math.max(base, HLS.model.beatsOf(n) * G.beatW);
    if (n.dotted) w += 10;
    return w + 12;
  }

  // 开始反复记号、倚音都要在音符前留出空位，避免与左侧竖线/记号重叠
  var REPEAT_LEAD = 14;
  var GRACE_LEAD = 12;
  function leadOf(n) {
    var lead = 0;
    if (n.repeatStart) lead += REPEAT_LEAD;
    if (n.grace && n.pitch !== 0) lead += GRACE_LEAD;
    return lead;
  }

  function layout(song, headerH) {
    if (headerH === undefined) headerH = G.headerH;
    var notes = song.notes;
    var ts = String(song.timeSig || '4/4').split('/');
    var mBeats = (+ts[0]) * 4 / (+ts[1] || 4);
    if (!isFinite(mBeats) || mBeats <= 0) mBeats = 4;

    // 第一遍：算出每个音符的拍位、小节号、是否小节起、宽度
    var info = [];
    var idToMeasure = {};
    var measureWidth = {};
    var acc = 0;
    var mi = 0;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var startsMeasure = false;
      if (acc >= mBeats - 1e-6) { startsMeasure = true; acc = 0; mi++; }
      var w = noteWidth(n);
      info.push({
        note: n, w: w, beatPos: acc, measureIndex: mi,
        startsMeasure: startsMeasure, lineBreak: !!n.lineBreak
      });
      idToMeasure[n.id] = mi;
      measureWidth[mi] = (measureWidth[mi] || 0) + w;
      acc += HLS.model.beatsOf(n);
    }

    // 连音线跨小节时，把相关小节“锁”在一起，避免被换行拆断
    var link = {};
    song.notes.forEach(function (nd) {
      if (nd.slurTo == null) return;
      var ms = idToMeasure[nd.id];
      var me = idToMeasure[nd.slurTo];
      if (ms == null || me == null || ms === me) return;
      var lo = Math.min(ms, me), hi = Math.max(ms, me);
      for (var m = lo + 1; m <= hi; m++) link[m] = true;
    });

    var place = [];
    var bars = [];
    var lineIndex = 0;
    var x = G.padX;
    var lineHasNote = false;

    function baselineOf(li) { return headerH + li * G.lineH + G.baseline; }

    // 第二遍：以「小节（被连音线锁住的相邻小节合并）/ 强制换行」为单位成组排布
    var gi = 0;
    var N = notes.length;
    while (gi < N) {
      var gj = gi;
      var gw = info[gi].w + leadOf(info[gi].note);
      while (gj + 1 < N) {
        var nx = info[gj + 1];
        if (nx.lineBreak) break;
        var locked = nx.startsMeasure && link[nx.measureIndex];
        if (nx.startsMeasure && !locked) break;
        if (locked && gw + (measureWidth[nx.measureIndex] || 0) > G.contentW) break; // 过长则仍断开，避免溢出
        // 放不下就换行：允许小节被拆到下一行（大字号/窄屏时避免音符被裁掉）
        if (gw + nx.w + leadOf(nx.note) > G.contentW) break;
        gw += nx.w + leadOf(nx.note);
        gj++;
      }

      if (info[gi].lineBreak && lineHasNote) {
        lineIndex++; x = G.padX; lineHasNote = false;
      }

      if (lineHasNote && x + gw > G.padX + G.contentW) {
        lineIndex++; x = G.padX; lineHasNote = false;
      }

      for (var k = gi; k <= gj; k++) {
        var it = info[k];
        var by = baselineOf(lineIndex);
        var lead = leadOf(it.note);
        if (it.startsMeasure && x > G.padX + 0.5) bars.push({ x: x, by: by });
        x += lead;
        place.push({
          i: k, x: x, by: by, w: it.w, note: it.note, lead: lead,
          beatPos: it.beatPos, startsMeasure: it.startsMeasure
        });
        x += it.w;
        lineHasNote = true;
      }
      gi = gj + 1;
    }

    var totalLines = lineIndex + 1;

    // 按小节换行时，在每个（非末）行的末尾补一条小节线
    if (totalLines > 1) {
      for (var li = 0; li < totalLines - 1; li++) {
        var lastP = null;
        for (var p = 0; p < place.length; p++) {
          if (Math.abs(place[p].by - baselineOf(li)) < 1e-6) lastP = place[p];
        }
        if (!lastP) continue;
        var ni = lastP.i + 1;
        if (info[ni] && info[ni].startsMeasure) {
          bars.push({ x: lastP.x + lastP.w, by: lastP.by });
        }
      }
    }

    // 反复记号：‖: 画在所选音符左侧（空位之前），:‖ 画在所选音符右侧
    var repeats = [];
    for (var rp = 0; rp < place.length; rp++) {
      var rn = place[rp].note;
      if (rn.repeatStart) {
        repeats.push({ x: place[rp].x - (place[rp].lead || 0), by: place[rp].by, type: 'start' });
      }
      if (rn.repeatEnd) repeats.push({ x: place[rp].x + place[rp].w, by: place[rp].by, type: 'end' });
    }

    return {
      place: place,
      bars: bars,
      repeats: repeats,
      height: headerH + totalLines * G.lineH + 30
    };
  }

  function header(song, pageInfo) {
    var s = '';
    var title = song.title || '葫芦丝曲谱';
    s += '<text class="h-title" x="' + (G.W / 2) + '" y="42" text-anchor="middle">' +
      esc(title) + '</text>';
    if (song.author) {
      s += '<text class="h-author" x="' + (G.W / 2) + '" y="72" text-anchor="middle">' +
        esc(song.author) + '</text>';
    }
    if (pageInfo && pageInfo.total > 1) {
      var label = '第 ' + (pageInfo.index + 1) + ' 页　/　共 ' + pageInfo.total + ' 页';
      s += '<text class="h-page" x="' + (G.W / 2) + '" y="100" text-anchor="middle">' +
        esc(label) + '</text>';
    }
    var meta = (song.key || '1=C') + '　' + (song.timeSig || '4/4') + '　♩=' + (song.tempo || 60);
    s += '<text class="h-meta" x="' + G.padX + '" y="124">' + esc(meta) + '</text>';
    return s;
  }

  // 插入光标：竖条，表示“下一个音从这里开始”
  function caretMark(xRight, by) {
    return '<rect class="insertcaret" x="' + xRight + '" y="' + (by - 44) +
      '" width="4" height="66" rx="2"/>';
  }

  function noteGroup(p, song, sel, target, pending, graceEdit) {
    var n = p.note, x = p.x, by = p.by, w = p.w;
    var cx = x + G.numW / 2;
    var out = '<g class="note">';

    if (p.i === sel) {
      // 正在编辑这个音符：实心高亮框
      out += '<rect class="selbox" x="' + (x - 4) + '" y="' + (by - 46) +
        '" width="' + (w + 6) + '" height="72" rx="9"/>';
    } else if (p.i === target) {
      // 准备在它后面插入下一个音符：闪烁光标
      out += caretMark(x + w + 3, by);
    }
    if (pending && n.id === pending) {
      out += '<rect class="pendbox" x="' + (x - 4) + '" y="' + (by - 46) +
        '" width="' + (w + 6) + '" height="72" rx="9"/>';
    }

    var d = HLS.model.dashesOf(n);
    var u = HLS.model.underlinesOf(n);

    // 增时线
    if (d > 0) {
      var sx = x + G.numW + 6;
      for (var k = 0; k < d; k++) {
        var dx = sx + k * G.dashW + 5;
        out += '<line class="dash" x1="' + dx + '" y1="' + (by - 10) +
          '" x2="' + (dx + G.dashW - 14) + '" y2="' + (by - 10) + '"/>';
      }
    }

    // 音符数字
    var digit = n.pitch === 0 ? '0' : String(n.pitch);
    out += '<text class="num" x="' + cx + '" y="' + by +
      '" text-anchor="middle">' + digit + '</text>';

    // 附点
    if (HLS.model.hasAugDot(n)) {
      var dotx = x + G.numW + (d > 0 ? d * G.dashW : 0) + 8;
      out += '<circle class="augdot" cx="' + dotx + '" cy="' + (by - 10) +
        '" r="' + G.dotR + '"/>';
    }

    // 减时线（连写成组，见 beams()）

    // 高低八度点
    if (n.pitch !== 0) {
      var i;
      if (n.octave > 0) {
        for (i = 0; i < n.octave; i++) {
          out += '<circle class="odot" cx="' + cx + '" cy="' + (by - 31 - i * 9) +
            '" r="' + G.dotR + '"/>';
        }
      } else if (n.octave < 0) {
        var lowBase = u > 0 ? (by + 16 + (u - 1) * 6) : (by + 11);
        for (i = 0; i < -n.octave; i++) {
          out += '<circle class="odot" cx="' + cx + '" cy="' + (lowBase + i * 9) +
            '" r="' + G.dotR + '"/>';
        }
      }
    }

    var octTop = Math.max(0, n.octave);
    var sym = HLS.symbols.draw(n, {
      x: x, w: w, cx: cx, by: by, octTop: octTop,
      numW: G.numW, dashW: G.dashW
    });
    out += sym.html;
    p.ornTop = sym.top;

    // 命中区域（最上层）
    out += '<rect class="hit" data-index="' + p.i + '" x="' + (x - 4) + '" y="' +
      (by - 48) + '" width="' + (w + 8) + '" height="' + (74 + octTop * 9) +
      '" fill="transparent"/>';

    // 倚音：正在选它的音高时高亮
    if (n.grace && n.pitch !== 0 && p.i === graceEdit) {
      var ggx = cx - 13, ggy = by - 22;
      out += '<rect class="graceedbox" x="' + (ggx - 12) + '" y="' + (ggy - 30) +
        '" width="24" height="40" rx="7"/>';
    }

    out += '</g>';
    return out;
  }

  // 连音线：像中括号——顶部一条水平线，两端向下弯钩，弧度较小
  function slurArc(x1, x2, y0, h) {
    if (x2 <= x1 + 4) return '';
    var yTop = y0 - h;
    var r = Math.min(h * 0.6, 9);
    if (x2 - x1 < 2 * r + 4) r = Math.max(2, (x2 - x1 - 4) / 2);
    var d = 'M' + x1 + ' ' + y0 +
      ' Q' + x1 + ' ' + yTop + ' ' + (x1 + r) + ' ' + yTop +
      ' L' + (x2 - r) + ' ' + yTop +
      ' Q' + x2 + ' ' + yTop + ' ' + x2 + ' ' + y0;
    return '<path class="slur" d="' + d + '"/>';
  }

  // 括号高度：较小，随跨度略增；端部圆弧半径小
  function slurH(x1, x2, y0, by) {
    var span = x2 - x1;
    var h = Math.max(13, Math.min(24, span * 0.07));
    var maxRise = (y0 - by) + 76; // lineTop = by - 84，留 8 余量
    if (h > maxRise) h = Math.max(9, maxRise);
    return h;
  }

  function isBeatStart(p, unit) {
    if (p.startsMeasure) return true;
    var bp = (p.beatPos || 0) / unit;
    return Math.abs(bp - Math.round(bp)) < 1e-6;
  }

  function beamUnit(song) {
    var ts = String(song.timeSig || '4/4').split('/');
    var num = +ts[0] || 4, den = +ts[1] || 4;
    if (den === 8) return (num % 3 === 0) ? 1.5 : 1; // 3/8、6/8 按附点四分拍
    if (den === 2) return 2;
    return 1;
  }

  function beamLine(first, last, level) {
    var y = first.by + 9 + level * 6;
    return '<line class="uline" x1="' + (first.x + 2) + '" y1="' + y +
      '" x2="' + (last.x + G.numW - 2) + '" y2="' + y + '"/>';
  }

  // 减时线连写成组：同一拍内相邻的带线音符共用一条连续横线
  function beams(place, unit) {
    var s = '';
    var n = place.length;
    var i = 0;
    while (i < n) {
      if (HLS.model.underlinesOf(place[i].note) <= 0) { i++; continue; }
      var j = i;
      while (j + 1 < n) {
        var q = place[j + 1];
        if (q.by !== place[j].by) break;
        if (HLS.model.underlinesOf(q.note) <= 0) break;
        if (place[j].note.pitch === 0 || q.note.pitch === 0) break; // 休止符不与音符连组
        if (isBeatStart(q, unit)) break;
        j++;
      }
      s += beamLine(place[i], place[j], 0);
      // 二级线：组内连续 u>=2 的子段
      var k = i;
      while (k <= j) {
        if (HLS.model.underlinesOf(place[k].note) >= 2) {
          var m = k;
          while (m + 1 <= j && HLS.model.underlinesOf(place[m + 1].note) >= 2) m++;
          s += beamLine(place[k], place[m], 1);
          k = m + 1;
        } else {
          k++;
        }
      }
      i = j + 1;
    }
    return s;
  }

  // 连音线：按 id 找到起止音符，可跨过中间音符；跨行时在行尾/行首续接
  // 弧线整体排在所跨音符所有装饰符号的上方，避免重叠
  function slurs(song, place) {
    var byId = {};
    var i;
    for (i = 0; i < place.length; i++) byId[place[i].note.id] = place[i];
    var s = '';
    for (i = 0; i < song.notes.length; i++) {
      var n = song.notes[i];
      if (n.slurTo == null) continue;
      var a = byId[n.id];
      var b = byId[n.slurTo];
      if (!a || !b || a === b) continue;
      // 统一为从左到右 / 从上到下
      var p1 = a, p2 = b;
      if (p1.by > p2.by || (p1.by === p2.by && p1.x > p2.x)) { p1 = b; p2 = a; }
      var x1 = p1.x + G.numW / 2;
      var x2 = p2.x + G.numW / 2;
      if (p1.by === p2.by) {
        var top = Infinity;
        for (var k = p1.i; k <= p2.i; k++) {
          var pp = place[k];
          if (pp && pp.ornTop != null) top = Math.min(top, pp.ornTop);
        }
        if (!isFinite(top)) top = p1.by - 30;
        var y0 = top - 12;
        s += slurArc(x1, x2, y0, slurH(x1, x2, y0, p1.by));
      } else {
        var ya = (p1.ornTop != null ? p1.ornTop : p1.by - 30) - 12;
        var yb = (p2.ornTop != null ? p2.ornTop : p2.by - 30) - 12;
        var xr = G.padX + G.contentW;
        s += slurArc(x1, xr, ya, slurH(x1, xr, ya, p1.by));
        s += slurArc(G.padX, x2, yb, slurH(G.padX, x2, yb, p2.by));
      }
    }
    return s;
  }

  function repeatSign(r) {
    var x = r.x, by = r.by;
    var top = by - 40, bot = by + 22;
    var s = '';
    var bx1, bx2, dx;
    if (r.type === 'start') { bx1 = x - 3; bx2 = x + 2; dx = x + 9; }
    else { bx1 = x - 2; bx2 = x + 3; dx = x - 9; }
    s += '<line class="repeatbar" x1="' + bx1 + '" y1="' + top + '" x2="' + bx1 + '" y2="' + bot + '"/>';
    s += '<line class="repeatbar" x1="' + bx2 + '" y1="' + top + '" x2="' + bx2 + '" y2="' + bot + '"/>';
    s += '<circle class="repeatdot" cx="' + dx + '" cy="' + (by - 13) + '" r="2.6"/>';
    s += '<circle class="repeatdot" cx="' + dx + '" cy="' + (by - 3) + '" r="2.6"/>';
    return s;
  }

  function buildContent(song, sel, target, pending, graceEdit, guide, pageInfo) {
    applyScale(song.scale);
    var compact = !!(pageInfo && pageInfo.compact); // 手机编辑视图：去掉标题页眉，把空间留给音符
    var headerH = compact ? 0 : G.headerH;
    var L = layout(song, headerH);
    var parts = ['<style>' + SVG_STYLE + '</style>'];
    if (!compact) parts.push(header(song, pageInfo));

    var bi, ri;
    for (bi = 0; bi < L.bars.length; bi++) {
      var b = L.bars[bi];
      var skip = false;
      for (ri = 0; ri < L.repeats.length; ri++) {
        if (Math.abs(L.repeats[ri].by - b.by) < 1e-6 &&
            Math.abs(L.repeats[ri].x - b.x) < 2.5) { skip = true; break; }
      }
      if (skip) continue;
      parts.push('<line class="barline" x1="' + b.x + '" y1="' + (b.by - 40) +
        '" x2="' + b.x + '" y2="' + (b.by + 22) + '"/>');
    }

    for (ri = 0; ri < L.repeats.length; ri++) {
      parts.push(repeatSign(L.repeats[ri]));
    }

    parts.push(beams(L.place, beamUnit(song)));

    var pi;
    for (pi = 0; pi < L.place.length; pi++) {
      parts.push(noteGroup(L.place[pi], song, sel, target, pending, graceEdit));
    }

    // 空谱：在起始位置显示插入光标
    if (guide && L.place.length === 0) {
      parts.push(caretMark(G.padX + 2, headerH + G.baseline));
    }

    parts.push(slurs(song, L.place));

    // 不再绘制“第1页到此”参考线，避免单页/多页显示不一致

    var guideY = PAGE_UNITS / G.scale;
    return {
      content: parts.join(''), W: G.W, H: L.height,
      guideY: guideY, fits: L.height <= guideY + 1
    };
  }

  function subSong(song, notes) {
    return {
      title: song.title, author: song.author, key: song.key,
      timeSig: song.timeSig, tempo: song.tempo, scale: song.scale,
      notes: notes
    };
  }

  // 按 pageBreak 标记把音符切分为多页
  function splitPages(song) {
    var segs = [];
    var cur = [], start = -1;
    for (var i = 0; i < song.notes.length; i++) {
      var n = song.notes[i];
      if (n.pageBreak && cur.length) {
        segs.push({ notes: cur, offset: start });
        cur = []; start = -1;
      }
      if (start < 0) start = i;
      cur.push(n);
    }
    if (cur.length) segs.push({ notes: cur, offset: start });
    if (!segs.length) segs.push({ notes: [], offset: 0 });
    return segs;
  }

  // 预览图竖直方向绕「数字中心」对称取景：
  // 无论上下有八度点/增时线/符号，数字始终落在预览正中 → 各按钮里的数字在同一水平面
  function previewVB(by, minY, maxY, padY) {
    var cy = by - 11;                     // 数字视觉中心（基线 by 上移约 11）
    var top = minY - padY, bot = maxY + padY;
    var half = Math.max(cy - top, bot - cy);
    return { vy: cy - half, vh: 2 * half };
  }

  // 单音符「写法」预览图（用于工具栏按钮）
  var FP_STYLE =
    '.formpic{ display:block; }' +
    '.formpic text{ font-family:"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif; }' +
    '.formpic .fin{ font-size:30px; font-weight:600; fill:currentColor; }' +
    '.formpic .sym-lab{ font-size:16px; font-weight:600; fill:currentColor; }' +
    '.formpic .sym-glide{ fill:none; stroke:currentColor; stroke-width:1.8; }' +
    '.formpic .sym-glide-head{ fill:currentColor; }' +
    '.formpic .sym-grace{ font-size:19px; font-weight:600; fill:currentColor; }' +
    '.formpic .sym-grace-slash{ stroke:currentColor; stroke-width:1.6; }' +
    '.formpic .sym-bo{ stroke:currentColor; stroke-width:1.8; }' +
    '.formpic .odot{ fill:currentColor; }' +
    '.formpic .dash{ stroke:currentColor; stroke-width:2.4; stroke-linecap:round; }' +
    '.formpic .uline{ stroke:currentColor; stroke-width:1.8; }';

  function formPreview(formStr, pitch, octave, dur, dotted) {
    pitch = (typeof pitch === 'number') ? pitch : 5;
    octave = octave || 0;
    dur = dur || 'quarter';
    dotted = !!dotted;

    var marks = {
      whole: { beats: 4, u: 0 }, half: { beats: 2, u: 0 }, quarter: { beats: 1, u: 0 },
      eighth: { beats: 0.5, u: 1 }, sixteenth: { beats: 0.25, u: 2 }
    };
    var info = marks[dur] || marks.quarter;
    var dashes = info.beats >= 2 ? Math.round(info.beats - 1) : 0;
    var u = info.u;
    var numW = 26, dashW = 20;
    var contentW = numW + dashes * dashW + (dotted ? 9 : 0);
    var leftPad = 18, rightPad = 12;
    var W = leftPad + contentW + rightPad;
    var by = 90;
    var cx = leftPad + numW / 2;

    var keys = formStr ? formStr.split(',').filter(Boolean) : [];
    var note = {
      pitch: pitch, octave: octave, dur: dur, dotted: dotted,
      orn: { up: false, down: false, single: false, double: false, triple: false,
             breath: false, da: false, bo: false, trill: false },
      grace: null
    };
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'grace') note.grace = { pitch: (pitch > 1 ? pitch - 1 : 7), octave: octave };
      else if (note.orn.hasOwnProperty(k)) note.orn[k] = true;
    }
    var octTop = Math.max(0, octave);
    var sym = HLS.symbols.draw(note, {
      x: cx - numW / 2, w: numW, cx: cx, by: by, octTop: octTop, numW: numW, dashW: dashW
    });

    var out = '<text class="fin" x="' + cx + '" y="' + by + '" text-anchor="middle">' +
      (pitch === 0 ? '0' : String(pitch)) + '</text>';
    var kk;
    if (dashes > 0) {
      var sx = cx + numW / 2 + 4;
      for (kk = 0; kk < dashes; kk++) {
        var dx = sx + kk * dashW;
        out += '<line class="dash" x1="' + dx + '" y1="' + (by - 9) +
          '" x2="' + (dx + dashW - 8) + '" y2="' + (by - 9) + '"/>';
      }
    }
    if (dotted) out += '<circle class="odot" cx="' + (cx + numW / 2 + 6) + '" cy="' + (by - 9) + '" r="3"/>';
    if (u > 0) {
      for (kk = 0; kk < u; kk++) {
        out += '<line class="uline" x1="' + (cx - numW / 2) + '" y1="' + (by + 8 + kk * 6) +
          '" x2="' + (cx + numW / 2) + '" y2="' + (by + 8 + kk * 6) + '"/>';
      }
    }
    if (pitch !== 0) {
      var d;
      if (octave > 0) {
        for (d = 0; d < octave; d++) out += '<circle class="odot" cx="' + cx + '" cy="' + (by - 28 - d * 8) + '" r="3"/>';
      } else if (octave < 0) {
        var baseY = by + 16 + u * 6;
        for (d = 0; d < -octave; d++) out += '<circle class="odot" cx="' + cx + '" cy="' + (baseY + d * 8) + '" r="3"/>';
      }
    }
    out += sym.html;

    // 竖直方向按内容收紧，预览里的音符/符号才会显得更大
    var minY = by - 22;                                   // 数字上沿
    if (octave > 0) minY = Math.min(minY, by - 31 - (octave - 1) * 8);
    if (dashes > 0 || dotted) minY = Math.min(minY, by - 12);
    minY = Math.min(minY, sym.top);
    var maxY = by + 6;
    if (u > 0) maxY = Math.max(maxY, by + 8 + (u - 1) * 6 + 3);
    if (octave < 0) {
      var lb = by + 16 + u * 6;
      maxY = Math.max(maxY, lb + (-octave - 1) * 8 + 3);
    }
    // 写法预览竖直方向按内容紧凑取景（音符总在最下方，视觉上自然对齐），四周留一点边距
    var padY = 6;
    var vy = minY - padY;
    var vh = (maxY + padY) - vy;

    return '<svg class="formpic" viewBox="0 ' + vy + ' ' + W + ' ' + vh + '" aria-hidden="true">' +
      '<style>' + FP_STYLE + '</style>' + out + '</svg>';
  }

  // 单音符预览（音高/八度/时值），用于音区、时值按钮
  function notePreview(pitch, octave, dur, dotted) {
    pitch = (typeof pitch === 'number') ? pitch : 5;
    octave = octave || 0;
    var marks = {
      whole: { beats: 4, u: 0 }, half: { beats: 2, u: 0 }, quarter: { beats: 1, u: 0 },
      eighth: { beats: 0.5, u: 1 }, sixteenth: { beats: 0.25, u: 2 }
    };
    var info = marks[dur] || marks.quarter;
    var dashes = info.beats >= 2 ? Math.round(info.beats - 1) : 0;
    var u = info.u;
    var numW = 26, dashW = 20;
    var contentW = numW + dashes * dashW + (dotted ? 9 : 0);
    var W = Math.max(72, contentW + 12);
    var by = 72;
    var cx = (W - contentW) / 2 + numW / 2;
    var out = '<text class="fin" x="' + cx + '" y="' + by + '" text-anchor="middle">' +
      (pitch === 0 ? '0' : String(pitch)) + '</text>';
    var k;
    if (dashes > 0) {
      var sx = cx + numW / 2 + 4;
      for (k = 0; k < dashes; k++) {
        var dx = sx + k * dashW;
        out += '<line class="dash" x1="' + dx + '" y1="' + (by - 9) +
          '" x2="' + (dx + dashW - 8) + '" y2="' + (by - 9) + '"/>';
      }
    }
    if (dotted) {
      out += '<circle class="odot" cx="' + (cx + numW / 2 + 6) + '" cy="' + (by - 9) + '" r="3"/>';
    }
    if (u > 0) {
      for (k = 0; k < u; k++) {
        out += '<line class="uline" x1="' + (cx - numW / 2) + '" y1="' + (by + 8 + k * 6) +
          '" x2="' + (cx + numW / 2) + '" y2="' + (by + 8 + k * 6) + '"/>';
      }
    }
    if (pitch !== 0) {
      var d;
      if (octave > 0) {
        for (d = 0; d < octave; d++) out += '<circle class="odot" cx="' + cx + '" cy="' + (by - 28 - d * 8) + '" r="3"/>';
      } else if (octave < 0) {
        var baseY = by + 16 + u * 6;
        for (d = 0; d < -octave; d++) out += '<circle class="odot" cx="' + cx + '" cy="' + (baseY + d * 8) + '" r="3"/>';
      }
    }
    // 竖直方向按内容收紧，预览才会尽量大
    var minY = by - 22;
    if (octave > 0) minY = Math.min(minY, by - 31 - (octave - 1) * 8);
    if (dashes > 0 || dotted) minY = Math.min(minY, by - 12);
    var maxY = by + 6;
    if (u > 0) maxY = Math.max(maxY, by + 8 + (u - 1) * 6 + 3);
    if (octave < 0) {
      var lb = by + 16 + u * 6;
      maxY = Math.max(maxY, lb + (-octave - 1) * 8 + 3);
    }
    var vb = previewVB(by, minY, maxY, 5);

    return '<svg class="formpic" viewBox="0 ' + vb.vy + ' ' + W + ' ' + vb.vh + '" aria-hidden="true">' +
      '<style>' + FP_STYLE + '</style>' + out + '</svg>';
  }

  function mount(container, song, sel, target, pending, graceEdit, guide, viewScale) {
    if (sel === undefined) sel = -1;
    if (target === undefined) target = -1;
    var segs = splitPages(song);
    container.innerHTML = '';
    var anyNotFit = false;
    var firstInfo = null;
    for (var p = 0; p < segs.length; p++) {
      var seg = segs[p];
      var off = seg.offset, len = seg.notes.length;
      var sub = subSong(song, seg.notes);
      if (viewScale) sub.scale = viewScale; // 屏幕编辑视图可用独立比例，不影响打印
      var lsel = (sel >= off && sel < off + len) ? sel - off : -1;
      var ltgt = (target >= off && target < off + len) ? target - off : -1;
      var lgr = (graceEdit >= off && graceEdit < off + len) ? graceEdit - off : -1;
      var r = buildContent(sub, lsel, ltgt, pending, lgr, guide !== false,
        { index: p, total: segs.length, compact: !!viewScale });

      var page = document.createElement('div');
      page.className = 'paper page';
      page.setAttribute('data-offset', off);
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'scoresvg');
      svg.setAttribute('viewBox', '0 0 ' + r.W + ' ' + r.H);
      svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
      svg.innerHTML = r.content;
      page.appendChild(svg);
      container.appendChild(page);

      if (!r.fits) anyNotFit = true;
      if (p === 0) firstInfo = r;
    }
    return { pages: segs.length, fits: !anyNotFit, H: firstInfo ? firstInfo.H : 0 };
  }

  // 按打印比例 song.scale 计算分页与“是否放得下”（与屏幕编辑比例无关）
  function fitInfo(song) {
    var segs = splitPages(song);
    var anyNotFit = false;
    for (var p = 0; p < segs.length; p++) {
      var sub = subSong(song, segs[p].notes);
      var r = buildContent(sub, -1, -1, null, -1, false, { index: p, total: segs.length });
      if (!r.fits) anyNotFit = true;
    }
    applyScale(song.scale); // 复位全局比例，避免影响后续渲染
    return { pages: segs.length, fits: !anyNotFit };
  }

  // 打印后该比例下乐谱的高度（mm）
  function printedHeight(song, s) {
    applyScale(s);
    var L = layout(song);
    return L.height * PAGE_W_MM * s / BASE_W;
  }

  // 在 [lo, hi] 内二分，找“仍能放进一页”的最大字号比例（铺满一页）
  function fitScale(song) {
    var lo = 0.4, hi = 2.0;
    if (printedHeight(song, lo) > PAGE_H_MM) { applyScale(song.scale); return lo; }
    for (var it = 0; it < 28; it++) {
      var mid = (lo + hi) / 2;
      if (printedHeight(song, mid) <= PAGE_H_MM) lo = mid; else hi = mid;
    }
    applyScale(song.scale);
    // 向下取到整百分比，确保不会跨过换行台阶
    return Math.floor(lo * 100) / 100;
  }

  // 可作为分页点的音符索引（小节起点）
  function measureStarts(song) {
    var ts = String(song.timeSig || '4/4').split('/');
    var mBeats = (+ts[0]) * 4 / (+ts[1] || 4);
    if (!isFinite(mBeats) || mBeats <= 0) mBeats = 4;
    var starts = [], acc = 0;
    for (var i = 0; i < song.notes.length; i++) {
      if (i > 0 && acc >= mBeats - 1e-6) { acc = 0; starts.push(i); }
      acc += HLS.model.beatsOf(song.notes[i]);
    }
    return starts;
  }

  // 自动分两页：同一字号下，两页都能放下，且高度尽量均衡（各自尽量满）
  function fitScale2(song) {
    var notes = song.notes;
    var starts = measureStarts(song);
    if (notes.length < 2 || !starts.length) {
      applyScale(song.scale);
      return { scale: song.scale || 1, splitIndex: -1 };
    }
    function h1Of(k, s) { return printedHeight(subSong(song, notes.slice(0, k)), s); }
    function h2Of(k, s) { return printedHeight(subSong(song, notes.slice(k)), s); }
    // 该比例下是否存在可行切分：h1 随 k 递增、h2 随 k 递减
    function exists(s) {
      var loI = 0, hiI = starts.length - 1, best = -1;
      while (loI <= hiI) {
        var mi = (loI + hiI) >> 1, k = starts[mi];
        if (h1Of(k, s) <= PAGE_H_MM) { best = k; loI = mi + 1; } else hiI = mi - 1;
      }
      if (best < 0) return false;
      return h2Of(best, s) <= PAGE_H_MM;
    }
    var lo = 0.4, hi = 2.0;
    if (!exists(lo)) { applyScale(song.scale); return { scale: lo, splitIndex: -1 }; }
    for (var it = 0; it < 22; it++) {
      var mid = (lo + hi) / 2;
      if (exists(mid)) lo = mid; else hi = mid;
    }
    var s = Math.floor(lo * 100) / 100;
    // 在该比例下挑最均衡、且两页都放得下的切分点
    var best = -1, bestDiff = Infinity;
    for (var ci = 0; ci < starts.length; ci++) {
      var k = starts[ci];
      var h1 = h1Of(k, s), h2 = h2Of(k, s);
      if (h1 <= PAGE_H_MM && h2 <= PAGE_H_MM) {
        var d = Math.abs(h1 - h2);
        if (d < bestDiff) { bestDiff = d; best = k; }
      }
    }
    applyScale(song.scale);
    return { scale: s, splitIndex: best };
  }

  HLS.render = {
    mount: mount, G: G,
    applyScale: applyScale, fitScale: fitScale, fitScale2: fitScale2,
    printedHeight: printedHeight, fitInfo: fitInfo,
    formPreview: formPreview, notePreview: notePreview
  };
})(window.HLS);
