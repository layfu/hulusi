window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  var state;
  var stageEl;
  var saveTimer;
  var autoScrollReady = false;

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function normalize(song) {
    if (!song || !Array.isArray(song.notes)) return null;
    var base = HLS.model.makeNote();
    var legacySlur = song.notes.map(function (n) { return !!n.slur; });
    song.notes.forEach(function (n) {
      n.pitch = (typeof n.pitch === 'number') ? n.pitch : 1;
      n.octave = n.octave || 0;
      n.dur = n.dur || 'quarter';
      n.dotted = !!n.dotted;
      n.lineBreak = !!n.lineBreak;
      n.pageBreak = !!n.pageBreak;
      n.slurTo = (typeof n.slurTo === 'number') ? n.slurTo : null;
      delete n.slur;
      n.repeatStart = !!n.repeatStart;
      n.repeatEnd = !!n.repeatEnd;
      n.orn = Object.assign({}, base.orn, n.orn || {});
      // 兼容旧数据：orn.grace 布尔 → note.grace 对象
      if (n.orn.grace) {
        delete n.orn.grace;
        if (!n.grace) {
          n.grace = { pitch: n.pitch >= 7 ? 1 : n.pitch + 1, octave: n.octave || 0 };
        }
      }
      if (n.grace) {
        n.grace = {
          pitch: (n.grace.pitch >= 0 ? n.grace.pitch : 1),
          octave: n.grace.octave || 0
        };
      } else {
        n.grace = null;
      }
    });
    HLS.model.syncIds(song);
    // 兼容旧数据：slur=true 表示连到下一个音符
    song.notes.forEach(function (n, i) {
      if (legacySlur[i] && n.slurTo == null && i + 1 < song.notes.length) {
        n.slurTo = song.notes[i + 1].id;
      }
    });
    if (!song.key) song.key = '1=C';
    if (!song.timeSig) song.timeSig = '4/4';
    if (!song.tempo) song.tempo = 60;
    if (!song.scale || song.scale <= 0) song.scale = 1;
    return song;
  }

  function init() {
    var saved = normalize(HLS.storage.load());
    state = {
      song: saved || HLS.model.makeSong(),
      sel: -1,
      mode: 'append',
      step: 'pitch',
      slurStart: null,
      graceEdit: -1,
      building: false,
      brush: false,
      brushForm: null,
      defaults: { octave: 0, dur: 'quarter', dotted: false },
      kxShift: 0,
      undo: [],
      redo: []
    };

    stageEl = document.getElementById('pages');
    bindMeta();
    bindScale();
    bindMenu();
    bindToolbar();
    bindKeyboard();
    bindSvg();
    bindFile();
    bindPreview();
    bindHelp();
    render();
    autoScrollReady = true; // 初次加载不自动跳到底部，用户开始编辑后才跟随

    // 屏幕尺寸变化（旋转、地址栏收起等）后重算编辑视图比例
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    });
  }

  // 「写法 / 音区 / 时值」按钮上的图案，会跟随当前音符同步变化
  var previewKey = null;
  var previewLabelsDone = false;
  var OCT_REP = { 'octave-down': -1, 'octave-mid': 0, 'octave-up': 1 };

  function updatePreviews() {
    var sel = '[data-form],[data-dur],[data-act="dot"],' +
      '[data-act="octave-down"],[data-act="octave-mid"],[data-act="octave-up"]';
    if (!previewLabelsDone) {
      previewLabelsDone = true;
      $all(sel).forEach(function (b) {
        var lab = (b.textContent || '').trim();
        if (lab) { b.setAttribute('title', lab); b.setAttribute('aria-label', lab); }
      });
    }
    var node = (state.mode === 'edit' && state.sel >= 0) ? state.song.notes[state.sel] : null;
    var last = state.song.notes.length ? state.song.notes[state.song.notes.length - 1] : null;
    var pitch = node ? node.pitch : (last ? last.pitch : 5);
    var oct = node ? (node.octave || 0) : (state.defaults.octave || 0);
    var dur = node ? node.dur : state.defaults.dur;
    var dotted = node ? !!node.dotted : !!state.defaults.dotted;
    var key = pitch + ':' + oct + ':' + dur + ':' + dotted;
    if (key === previewKey) return;
    previewKey = key;

    $all('[data-form]').forEach(function (b) {
      b.innerHTML = HLS.render.formPreview(b.getAttribute('data-form'), pitch, oct, dur, dotted);
    });
    $all('[data-act="octave-down"],[data-act="octave-mid"],[data-act="octave-up"]').forEach(function (b) {
      b.innerHTML = HLS.render.notePreview(pitch, OCT_REP[b.getAttribute('data-act')], 'quarter', false);
    });
    $all('[data-dur]').forEach(function (b) {
      b.innerHTML = HLS.render.notePreview(pitch, oct, b.getAttribute('data-dur'), false);
    });
    $all('[data-act="dot"]').forEach(function (b) {
      b.innerHTML = HLS.render.notePreview(pitch, oct, dur, true);
    });
  }

  // ---------- 状态与提交 ----------

  function commit(fn) {
    state.undo.push(JSON.stringify(state.song));
    if (state.undo.length > 300) state.undo.shift();
    state.redo.length = 0;
    fn();
    afterChange();
  }

  function afterChange() { render(); scheduleSave(); }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { HLS.storage.save(state.song); }, 400);
  }

  function targetIndex() {
    if (state.mode === 'edit' && state.sel >= 0 && state.sel < state.song.notes.length) {
      return state.sel;
    }
    return state.song.notes.length - 1;
  }

  function targetNote() {
    var i = targetIndex();
    return i >= 0 ? state.song.notes[i] : null;
  }

  // 光标状态：给“正在编辑的音符”画实心框，给“下一个音的位置”画闪烁竖线
  function cursorArgs() {
    var editing = state.mode === 'edit' && state.sel >= 0 &&
      !(state.building && state.step === 'pitch');
    var sel = editing ? state.sel : -1;
    var target = -1;
    if (!editing &&
        (state.mode === 'append' || (state.building && state.step === 'pitch'))) {
      target = state.song.notes.length - 1;
    }
    var graceHL = (state.step === 'grace' && state.mode === 'edit' && state.sel >= 0 &&
      state.song.notes[state.sel] && state.song.notes[state.sel].grace) ? state.sel : -1;
    return { sel: sel, target: target, grace: graceHL };
  }

  // 手机编辑视图的独立放大比例（不影响打印）：目标字号约 26px
  var TARGET_VIEW_FONT = 26;
  function phoneViewScale() {
    if (!window.matchMedia || !window.matchMedia('(max-width: 900px)').matches) return null;
    var stage = document.querySelector('.stage');
    var w = stage ? stage.clientWidth : window.innerWidth;
    var svgW = Math.max(200, w - 28); // 纸张内宽 ≈ 谱面区宽 - 纸张左右内边距
    var vs = TARGET_VIEW_FONT * 880 / (30 * svgW); // numFont=30 / 基准宽 880
    if (vs < 1) vs = 1;
    return Math.min(3, Math.max(vs, state.song.scale || 1));
  }

  function remount() {
    var c = cursorArgs();
    HLS.render.mount(stageEl, state.song, c.sel, c.target,
      state.slurStart, c.grace, true, phoneViewScale());
  }

  // ---------- 渲染与状态显示 ----------

  function render() {
    if (state.step === 'grace' && !hasGrace()) state.step = 'pitch';
    document.body.setAttribute('data-step', state.step || 'pitch');
    var c = cursorArgs();
    var finfo = HLS.render.fitInfo(state.song); // 按打印比例算分页/是否放得下
    HLS.render.mount(stageEl, state.song, c.sel, c.target,
      state.slurStart, c.grace, true, phoneViewScale());
    updateScaleUI(finfo);
    updateStatus();
    updateKeyHint();
    updateMetaInputs();
    updatePreviews();
    updateToolbarActive();
    document.body.classList.toggle('ready-finish', readyToFinish());
    updateDockPos();
    scrollActiveIntoView();
  }

  // 走到最后一步（④ 写法 / ⑤ 倚音）：此时再点一下，本音就完成上屏，
  // 光标随即变成闪动竖线、移到下一个音的位置 —— 这正是需要提示的时机
  function readyToFinish() {
    if (state.step !== 'form' && state.step !== 'grace') return false;
    return targetNote() != null;
  }

  // 手机端：让悬浮「继续添加」始终浮在谱面区右下角（避开底部工具栏与状态栏）
  function updateDockPos() {
    var dock = document.getElementById('append-dock');
    var stage = document.querySelector('.stage');
    if (!dock || !stage) return;
    if (window.matchMedia && window.matchMedia('(min-width: 901px)').matches) {
      dock.style.bottom = '';
      return;
    }
    var rect = stage.getBoundingClientRect();
    if (rect.height < 1) return; // 舞台隐藏时（菜单展开）不计算
    var bottom = Math.round(window.innerHeight - rect.bottom) + 12;
    dock.style.bottom = (bottom > 12 ? bottom : 12) + 'px';
  }

  // 把当前正在输入的音符滚动到可见处（手机端在谱子区里滚，桌面端滚窗口）
  function scrollActiveIntoView() {
    if (!autoScrollReady) return;
    var idx = (state.mode === 'edit' && state.sel >= 0)
      ? state.sel : (state.song.notes.length - 1);
    if (idx < 0) return;
    var pages = stageEl.querySelectorAll('.page');
    var el = null;
    for (var i = 0; i < pages.length; i++) {
      var off = parseInt(pages[i].getAttribute('data-offset'), 10) || 0;
      var local = idx - off;
      if (local < 0) continue;
      var r = pages[i].querySelector('.hit[data-index="' + local + '"]');
      if (r) { el = r; break; }
    }
    if (!el) return;
    var stage = document.querySelector('.stage');
    if (!stage) return;
    var box = el.getBoundingClientRect();
    var scrollable = stage.scrollHeight - stage.clientHeight > 2;
    if (scrollable) {
      var sr = stage.getBoundingClientRect();
      var m = 28;
      if (box.top < sr.top + m || box.bottom > sr.bottom - m) {
        var top = stage.scrollTop + (box.top - sr.top) - (stage.clientHeight - box.height) / 2;
        stage.scrollTop = Math.max(0, top);
      }
    } else {
      var vh = window.innerHeight;
      if (box.top < 0 || box.bottom > vh) {
        var y = window.scrollY + box.top - vh / 2 + box.height / 2;
        window.scrollTo(0, Math.max(0, y));
      }
    }
  }

  function updateScaleUI(info) {
    var s = state.song.scale || 1;
    var sv = $('#scale-val');
    if (sv) sv.textContent = Math.round(s * 100) + '%';
    var fs = $('#fit-status');
    if (fs && info) {
      if (info.fits) { fs.textContent = '✓ ' + info.pages + ' 页内'; fs.className = 'fit-status ok'; }
      else { fs.textContent = '⚠ 超出 ' + info.pages + ' 页，请调小'; fs.className = 'fit-status over'; }
    }
  }

  function updateStatus() {
    var el = $('#status-text');
    if (el) {
      if (state.slurStart != null) {
        el.textContent = '连音线：已选起点（橙色框），请点击要连接的另一个音符';
      } else {
        var stepTxt = {
          pitch: '① 点数字 1–7 输入音符', octave: '② 可选：调这个音的音区',
          dur: '③ 可选：调这个音的时值', form: '④ 可选：点一下套用写法',
          grace: '⑤ 选「倚音」的音高（小音符）'
        }[state.step] || '';
        var where = '';
        if (state.building) {
          // 回到①时，上一个音已输完，显示的是“即将输入的下一个”
          var num = (state.step === 'pitch')
            ? (state.song.notes.length + 1)
            : (state.sel + 1);
          where = '（正在输入第 ' + num + ' 个音符）';
        } else if (state.mode === 'edit' && state.sel >= 0) {
          where = '（编辑第 ' + (state.sel + 1) + ' 个）';
        }
        el.textContent = stepTxt + ' ' + where;
      }
    }
    var pt = $('#pitch-title');
    if (pt) {
      pt.textContent = (state.step === 'grace')
        ? '选「倚音」的音高（小音符）'
        : '① 音符（点数字加一个）';
    }
    var u = $('[data-act="undo"]');
    var r = $('[data-act="redo"]');
    if (u) u.disabled = state.undo.length === 0;
    if (r) r.disabled = state.redo.length === 0;
  }

  // 状态栏键盘提示：显示当前持续时值 / 预置八度
  function updateKeyHint() {
    var el = $('#key-hint');
    if (!el) return;
    var d = HLS.model.DURS[state.defaults.dur];
    var txt = (d ? d.label : '四分') + (state.defaults.dotted ? '·附点' : '');
    var s = state.kxShift || 0;
    if (s !== 0) txt += (s > 0 ? '，升' + s + '个八度' : '，降' + (-s) + '个八度');
    el.textContent = '键盘：当前时值 ' + txt +
      '；音符 qwertyu 低音 · 1234567 中音 · 890-=iop 高音 · p 倍高音1 · ` 休止';
  }

  function updateMetaInputs() {
    var t = $('#meta-title'), a = $('#meta-author'), tp = $('#meta-tempo');
    if (t && document.activeElement !== t) t.value = state.song.title || '';
    if (a && document.activeElement !== a) a.value = state.song.author || '';
    if (tp && document.activeElement !== tp) tp.value = state.song.tempo || 60;
    var k = $('#key-val'); if (k) k.textContent = state.song.key;
    var ts = $('#timesig-val'); if (ts) ts.textContent = state.song.timeSig;
  }

  function updateToolbarActive() {
    var ctx = (state.mode === 'edit' && state.sel >= 0) ? state.song.notes[state.sel] : null;
    var dur = ctx ? ctx.dur : state.defaults.dur;
    var oct = ctx ? ctx.octave : state.defaults.octave;
    var dot = ctx ? ctx.dotted : state.defaults.dotted;

    $all('[data-dur]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-dur') === dur);
    });
    $all('[data-act="dot"]').forEach(function (b) {
      b.classList.toggle('active', !!dot);
    });

    var ind = $('#octave-ind');
    if (ind) {
      ind.textContent = oct === 0 ? '中音' : (oct > 0 ? '高音 +' + oct : '低音 ' + oct);
    }
    $all('[data-act="octave-down"]').forEach(function (b) { b.classList.toggle('active', oct < 0); });
    $all('[data-act="octave-mid"]').forEach(function (b) { b.classList.toggle('active', oct === 0); });
    $all('[data-act="octave-up"]').forEach(function (b) { b.classList.toggle('active', oct > 0); });
    var activePitch = null;
    if (state.step === 'grace' && ctx && ctx.grace) {
      activePitch = ctx.grace.pitch;
    } else if (ctx) {
      activePitch = ctx.pitch;
    }
    $all('[data-note]').forEach(function (b) {
      b.classList.toggle('active', activePitch != null && (+b.getAttribute('data-note') === activePitch));
    });

    var tgt = targetNote();
    var curForm = tgt ? formKeysOf(tgt).join(',') : null;
    $all('[data-form]').forEach(function (b) {
      var keys = b.getAttribute('data-form');
      var norm = keys ? keys.split(',').filter(Boolean).sort().join(',') : '';
      b.classList.toggle('active', tgt != null && norm === curForm);
    });
    $all('[data-act="brush"]').forEach(function (b) {
      b.classList.toggle('active', !!state.brush);
    });

    $all('[data-orn]').forEach(function (b) {
      var key = b.getAttribute('data-orn');
      var on = false;
      if (tgt) {
        if (key === 'slur') on = (state.slurStart != null && tgt.id === state.slurStart);
        else if (key === 'repeatStart' || key === 'repeatEnd') on = !!tgt[key];
        else if (key === 'grace') on = !!tgt.grace;
        else on = !!(tgt.orn && tgt.orn[key]);
      }
      b.classList.toggle('active', on);
    });
  }

  // ---------- 编辑动作 ----------

  function addNote(pitch) {
    if (state.step === 'grace') {
      if (pitch === 0) return; // 倚音不能是休止
      var gi = (state.mode === 'edit' && state.sel >= 0) ? state.sel : state.song.notes.length - 1;
      if (gi < 0 || !state.song.notes[gi].grace) return;
      commit(function () {
        state.song.notes[gi].grace.pitch = pitch;
        state.step = 'pitch'; // 倚音音高选完，回到“选音符”输入下一个
      });
      return;
    }
    if (state.mode === 'edit' && state.sel >= 0 &&
        state.sel < state.song.notes.length && !state.building) {
      // 修改已选（较早的）音符的音高
      var idx = state.sel;
      commit(function () {
        state.song.notes[idx].pitch = pitch;
        state.step = 'octave';
      });
    } else {
      // 追加新音符并立即上屏，进入“构建中”：随后的音区/时值/写法都在改它
      commit(function () {
        var n = HLS.model.makeNote(
          pitch, state.defaults.octave, state.defaults.dur, state.defaults.dotted);
        if (state.brush && state.brushForm) applyForm(n, state.brushForm);
        state.song.notes.push(n);
        state.sel = state.song.notes.length - 1;
        state.mode = 'edit';
        state.building = true;
        state.step = 'octave';
      });
      flashNoteAt(state.song.notes.length - 1);
    }
  }

  // 上屏动效：给刚添加的音符加一次性入场动画
  function flashNoteAt(idx) {
    if (idx < 0) return;
    var pages = stageEl.querySelectorAll('.page');
    var g = null;
    for (var i = 0; i < pages.length; i++) {
      var off = parseInt(pages[i].getAttribute('data-offset'), 10) || 0;
      var local = idx - off;
      if (local < 0) continue;
      var hit = pages[i].querySelector('.hit[data-index="' + local + '"]');
      if (hit && hit.parentNode) { g = hit.parentNode; break; }
    }
    if (!g) return;
    g.classList.remove('note-enter');
    void g.getBoundingClientRect(); // 强制重排，保证动画能重播
    g.classList.add('note-enter');
    setTimeout(function () { g.classList.remove('note-enter'); }, 760);
  }

  function setDuration(dur) {
    if (!HLS.model.DURS[dur]) return;
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () {
        state.song.notes[idx].dur = dur;
        state.step = 'form';
      });
    } else {
      state.defaults.dur = dur;
      state.step = 'form';
      render();
    }
  }

  function octaveBy(delta) {
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () {
        var n = state.song.notes[idx];
        n.octave = clamp(n.octave + delta, -2, 2);
        state.step = 'dur';
      });
    } else {
      state.defaults.octave = clamp(state.defaults.octave + delta, -2, 2);
      state.step = 'dur';
      render();
    }
  }

  function octaveSet(v) {
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () {
        state.song.notes[idx].octave = v;
        state.step = 'dur';
      });
    } else {
      state.defaults.octave = v;
      state.step = 'dur';
      render();
    }
  }

  function toggleDot() {
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () {
        state.song.notes[idx].dotted = !state.song.notes[idx].dotted;
        state.step = 'form';
      });
    } else {
      state.defaults.dotted = !state.defaults.dotted;
      state.step = 'form';
      render();
    }
  }

  function toggleOrn(key) {
    if (key === 'slur') { toggleSlur(); return; }
    if (key === 'slurDel') { removeSlur(); return; }
    var idx = targetIndex();
    if (idx < 0) { HLS.toast('请先添加音符'); return; }
    if (key === 'repeatStart' || key === 'repeatEnd') {
      commit(function () {
        var n = state.song.notes[idx];
        n[key] = !n[key];
      });
      return;
    }
    if (key === 'grace') {
      commit(function () {
        var n = state.song.notes[idx];
        if (n.grace) {
          n.grace = null;
          if (state.graceEdit === idx) state.graceEdit = -1;
        } else {
          n.grace = defaultGrace(n);
        }
      });
      return;
    }
    commit(function () {
      var n = state.song.notes[idx];
      if (n.orn.hasOwnProperty(key)) n.orn[key] = !n.orn[key];
    });
  }

  // ---------- 「写法」一键组合 ----------
  var ORN_KEYS = ['up', 'down', 'single', 'double', 'triple', 'breath', 'da', 'bo', 'trill'];

  function defaultGrace(n) {
    // 默认取下方邻音（葫芦丝常见），可再点小音符自由改
    return { pitch: n.pitch > 1 ? n.pitch - 1 : 7, octave: n.octave || 0 };
  }

  function formKeysOf(note) {
    var keys = [];
    for (var i = 0; i < ORN_KEYS.length; i++) {
      if (note.orn && note.orn[ORN_KEYS[i]]) keys.push(ORN_KEYS[i]);
    }
    if (note.grace) keys.push('grace');
    return keys.sort();
  }

  function applyForm(note, keys) {
    var i;
    for (i = 0; i < ORN_KEYS.length; i++) note.orn[ORN_KEYS[i]] = false;
    note.grace = null;
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'grace') note.grace = defaultGrace(note);
      else if (note.orn.hasOwnProperty(k)) note.orn[k] = true;
    }
  }

  function applyFormToTarget(formStr) {
    var keys = formStr ? formStr.split(',') : [];
    var idx = targetIndex();
    if (idx < 0) {
      if (state.brush) {
        state.brushForm = keys.slice();
        state.step = 'pitch';
        render();
        HLS.toast('写法已记住，输入音符就带上');
      } else {
        HLS.toast('请先添加音符');
      }
      return;
    }
    commit(function () {
      applyForm(state.song.notes[idx], keys);
      if (state.brush) state.brushForm = keys.slice();
      // 带倚音的写法 → 进入“选倚音音高”这一步；否则这个音完成，回到选音符
      state.step = (keys.indexOf('grace') >= 0) ? 'grace' : 'pitch';
    });
  }

  function toggleBrush() {
    if (state.brush) {
      state.brush = false; state.brushForm = null;
    } else {
      var t = targetNote();
      state.brush = true;
      state.brushForm = t ? formKeysOf(t) : [];
    }
    render();
    HLS.toast(state.brush ? '已开启「沿用此写法」：之后输入的音自动带上' : '已关闭沿用');
  }

  function toggleMore() {
    var open = document.body.classList.toggle('more-open');
    var btn = document.querySelector('[data-act="more"]');
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '收起更多符号 ▴' : '更多符号 ▾（单独加 / 自由组合）';
    }
    updateDockPos();
  }

  // ---------- 快捷键帮助 ----------
  function openHelp() {
    var el = $('#help');
    if (!el) return;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('help-open');
    var c = $('#help-close');
    if (c) c.focus();
  }

  function closeHelp() {
    var el = $('#help');
    if (!el || !el.classList.contains('open')) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('help-open');
  }

  function toggleHelp() {
    var el = $('#help');
    if (!el) return;
    if (el.classList.contains('open')) closeHelp(); else openHelp();
  }

  function bindHelp() {
    var close = $('#help-close');
    if (close) close.addEventListener('click', closeHelp);
    var el = $('#help');
    if (el) el.addEventListener('click', function (e) { if (e.target === el) closeHelp(); });
    document.addEventListener('keydown', function (e) {
      if (!document.body.classList.contains('help-open')) return;
      if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
    });
  }

  function findNoteById(id) {
    var arr = state.song.notes;
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; }
    return null;
  }

  // 连音线：先点起点音符 → 点「连音线」→ 再点终点音符 → 点「连音线」完成
  function toggleSlur() {
    var t = targetNote();
    if (!t) { HLS.toast('请先添加音符'); return; }

    if (state.slurStart != null) {
      if (state.slurStart === t.id) { state.slurStart = null; render(); return; }
      var startId = state.slurStart;
      commit(function () {
        var s = findNoteById(startId);
        if (s) s.slurTo = t.id;
      });
      state.slurStart = null;
      HLS.toast('已加连音线');
      return;
    }

    if (t.slurTo != null) {
      var id = t.id;
      commit(function () { var s = findNoteById(id); if (s) s.slurTo = null; });
      HLS.toast('已去掉连音线');
      return;
    }

    state.slurStart = t.id;
    render();
    HLS.toast('已标记起点，请点击要连接的另一个音符');
  }

  // 删除连音线：选中的音符无论是起点还是终点，都去掉与它相连的线
  function removeSlur() {
    if (state.slurStart != null) {
      state.slurStart = null;
      render();
      HLS.toast('已取消连音线起点');
      return;
    }
    var t = targetNote();
    if (!t) { HLS.toast('请先选中音符'); return; }
    var involved = (t.slurTo != null) ||
      state.song.notes.some(function (n) { return n.slurTo === t.id; });
    if (!involved) { HLS.toast('这个音符没有连音线'); return; }
    var id = t.id;
    commit(function () {
      state.song.notes.forEach(function (n) { if (n.slurTo === id) n.slurTo = null; });
      var self = findNoteById(id);
      if (self) self.slurTo = null;
    });
    HLS.toast('已删除连音线');
  }

  function del() {
    var idx = targetIndex();
    if (idx < 0) { HLS.toast('没有可删除的音符'); return; }
    HLS.confirm('确定删除第 ' + (idx + 1) + ' 个音符吗？', '删除', function () {
      doDelete(idx);
    });
  }

  function doDelete(idx) {
    commit(function () {
      var removed = state.song.notes[idx];
      state.song.notes.splice(idx, 1);
      state.song.notes.forEach(function (n) { if (n.slurTo === removed.id) n.slurTo = null; });
      if (state.slurStart === removed.id) state.slurStart = null;
      state.graceEdit = -1;
      state.building = false;
      if (state.mode === 'edit') {
        state.sel = Math.min(idx, state.song.notes.length - 1);
        if (state.sel < 0) state.mode = 'append';
      }
    });
    HLS.toast('已删除，可点「撤销」恢复');
  }

  function toggleLineBreak() {
    var idx = targetIndex();
    if (idx < 0) { HLS.toast('请先添加音符'); return; }
    commit(function () { state.song.notes[idx].lineBreak = !state.song.notes[idx].lineBreak; });
  }

  function toAppend() {
    state.mode = 'append';
    state.sel = -1;
    state.slurStart = null;
    state.graceEdit = -1;
    state.building = false;
    state.step = 'pitch';
    render();
  }

  function cycleKey(dir) {
    var i = HLS.model.KEYS.indexOf(state.song.key);
    if (i < 0) i = 0;
    i = (i + dir + HLS.model.KEYS.length) % HLS.model.KEYS.length;
    commit(function () { state.song.key = HLS.model.KEYS[i]; });
  }

  function cycleTimeSig() {
    var i = HLS.model.TIME_SIGS.indexOf(state.song.timeSig);
    if (i < 0) i = 0;
    i = (i + 1) % HLS.model.TIME_SIGS.length;
    commit(function () { state.song.timeSig = HLS.model.TIME_SIGS[i]; });
  }

  var STEP_ORDER = ['pitch', 'octave', 'dur', 'form', 'grace'];
  function hasGrace() {
    var t = targetNote();
    return !!(t && t.grace);
  }
  function stepNext() {
    var i = STEP_ORDER.indexOf(state.step), n = STEP_ORDER.length;
    for (var k = 1; k <= n; k++) {
      var s = STEP_ORDER[(i + k) % n];
      if (s === 'grace' && !hasGrace()) continue; // 没有倚音就跳过这一步
      state.step = s; break;
    }
    render();
  }
  function stepPrev() {
    var i = STEP_ORDER.indexOf(state.step), n = STEP_ORDER.length;
    for (var k = 1; k <= n; k++) {
      var s = STEP_ORDER[(i - k + n * 2) % n];
      if (s === 'grace' && !hasGrace()) continue;
      state.step = s; break;
    }
    render();
  }

  function doAction(act) {
    switch (act) {
      case 'octave-down': octaveBy(-1); break;
      case 'octave-up': octaveBy(1); break;
      case 'octave-mid': octaveSet(0); break;
      case 'dot': toggleDot(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'delete': del(); break;
      case 'linebreak': toggleLineBreak(); break;
      case 'append': toAppend(); break;
      case 'step-prev': stepPrev(); break;
      case 'step-next': stepNext(); break;
      case 'brush': toggleBrush(); break;
      case 'more': toggleMore(); break;
      case 'help': toggleHelp(); break;
      case 'key-down': cycleKey(-1); break;
      case 'key-up': cycleKey(1); break;
      case 'timesig-cycle': cycleTimeSig(); break;
    }
  }

  function doFile(kind) {
    switch (kind) {
      case 'print': HLS.exporters.print(); break;
      case 'pdf': HLS.exporters.pdf(); break;
      case 'preview': openPreview(); break;
      case 'save':
        HLS.storage.downloadJSON(state.song);
        HLS.toast('已保存到文件');
        break;
      case 'open':
        if (state.song.notes.length) {
          HLS.confirm('打开文件会替换当前乐谱，确定继续吗？', '打开', function () {
            $('#file-input').click();
          });
        } else {
          $('#file-input').click();
        }
        break;
      case 'new':
        if (!state.song.notes.length) { HLS.toast('当前已经是空乐谱'); return; }
        HLS.confirm('确定要清空当前乐谱吗？清空后可点「撤销」恢复。', '清空', function () {
          commit(function () {
            state.song = HLS.model.makeSong();
            state.mode = 'append';
            state.sel = -1;
            state.slurStart = null;
            state.graceEdit = -1;
            state.building = false;
            state.step = 'pitch';
          });
        });
        break;
    }
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.song));
    state.song = JSON.parse(state.undo.pop());
    normalize(state.song);
    state.slurStart = null;
    state.graceEdit = -1;
    state.building = false;
    clampSel();
    afterChange();
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.song));
    state.song = JSON.parse(state.redo.pop());
    normalize(state.song);
    state.slurStart = null;
    state.graceEdit = -1;
    state.building = false;
    clampSel();
    afterChange();
  }

  function clampSel() {
    if (state.sel >= state.song.notes.length) state.sel = state.song.notes.length - 1;
    if (state.sel < 0 && state.mode === 'edit') state.mode = 'append';
  }

  // ---------- 事件绑定 ----------

  function bindMeta() {
    var t = $('#meta-title');
    if (t) t.addEventListener('input', function () {
      state.song.title = this.value; scheduleSave();
      remount();
    });
    var a = $('#meta-author');
    if (a) a.addEventListener('input', function () {
      state.song.author = this.value; scheduleSave();
      remount();
    });
    var tp = $('#meta-tempo');
    if (tp) tp.addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      if (isNaN(v)) return;
      state.song.tempo = clamp(v, 20, 300); scheduleSave();
      remount();
    });
  }

  function bindScale() {
    var af = $('#autofit-btn');
    if (af) af.addEventListener('click', autoFit);
    var af2 = $('#autofit2-btn');
    if (af2) af2.addEventListener('click', autoFit2);
  }

  // 手机端「菜单」：底部工具栏的按钮控制 曲谱信息 + 文件操作的展开/收起
  function toggleMenu(open) {
    document.body.classList.toggle('menu-open', open);
    var a = $('#menu-button'), b = $('#menu-toggle');
    if (a) {
      a.setAttribute('aria-expanded', open ? 'true' : 'false');
      a.textContent = open ? '✕ 关闭菜单' : '☰ 菜单';
    }
    if (b) {
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.textContent = open ? '✕ 关闭' : '☰ 菜单';
    }
    updateDockPos();
  }

  function bindMenu() {
    var mb = $('#menu-button');
    var mt = $('#menu-toggle');
    function onClick() {
      toggleMenu(!document.body.classList.contains('menu-open'));
    }
    if (mb) mb.addEventListener('click', onClick);
    if (mt) mt.addEventListener('click', onClick);
  }

  function autoFit() {
    if (!state.song.notes.length) { HLS.toast('请先输入音符'); return; }
    state.song.notes.forEach(function (n) { n.pageBreak = false; });
    var s = HLS.render.fitScale(state.song);
    state.song.scale = s;
    render();
    scheduleSave();
    HLS.toast('已调到最大字号 ' + Math.round(s * 100) + '%' +
      (s <= 0.4 ? '（这个长度放不下 1 页）' : ''));
  }

  function autoFit2() {
    if (state.song.notes.length < 2) { HLS.toast('请先输入足够的音符'); return; }
    var res = HLS.render.fitScale2(state.song);
    if (res.splitIndex < 0) { HLS.toast('这个长度放不下 2 页'); return; }
    state.song.notes.forEach(function (n, i) { n.pageBreak = (i === res.splitIndex); });
    state.song.scale = res.scale;
    render();
    scheduleSave();
    HLS.toast('已分 2 页，字号 ' + Math.round(res.scale * 100) + '%');
  }

  function bindToolbar() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest &&
        e.target.closest('[data-note],[data-dur],[data-orn],[data-form],[data-act],[data-file]');
      if (!el) return;
      if (el.hasAttribute('data-note')) { addNote(+el.getAttribute('data-note')); return; }
      if (el.hasAttribute('data-dur')) { setDuration(el.getAttribute('data-dur')); return; }
      if (el.hasAttribute('data-form')) { applyFormToTarget(el.getAttribute('data-form')); return; }
      if (el.hasAttribute('data-orn')) { toggleOrn(el.getAttribute('data-orn')); return; }
      if (el.hasAttribute('data-act')) { doAction(el.getAttribute('data-act')); return; }
      if (el.hasAttribute('data-file')) { doFile(el.getAttribute('data-file')); return; }
    });
  }

  function bindSvg() {
    stageEl.addEventListener('click', function (e) {
      var t = e.target;
      var pageEl = (t && t.closest) ? t.closest('.page') : null;
      var off = pageEl ? (parseInt(pageEl.getAttribute('data-offset'), 10) || 0) : 0;
      var idx = t && t.getAttribute ? t.getAttribute('data-index') : null;
      state.graceEdit = -1;
      state.building = false;
      if (idx !== null && idx !== undefined && idx !== '') {
        state.mode = 'edit';
        state.sel = off + (+idx);
      } else {
        state.mode = 'append';
        state.sel = -1;
        state.slurStart = null;
      }
      render();
    });
  }

  // ---------- 键盘快速输入 ----------
  // 音符键：e.code → [pitch, octave]
  var NOTE_KEYS = {
    KeyQ: [1, -1], KeyW: [2, -1], KeyE: [3, -1], KeyR: [4, -1],
    KeyT: [5, -1], KeyY: [6, -1], KeyU: [7, -1],
    Digit1: [1, 0], Digit2: [2, 0], Digit3: [3, 0], Digit4: [4, 0],
    Digit5: [5, 0], Digit6: [6, 0], Digit7: [7, 0],
    Digit8: [1, 1], Digit9: [2, 1], Digit0: [3, 1], Minus: [4, 1],
    Equal: [5, 1], KeyI: [6, 1], KeyO: [7, 1],
    KeyP: [1, 2],
    Backquote: [0, 0]
  };

  // 时值预置键：e.code → { dur, dotted }
  var DUR_KEYS = {
    KeyZ: { dur: 'dur32', dotted: false },
    KeyX: { dur: 'sixteenth', dotted: false },
    KeyC: { dur: 'eighth', dotted: false },
    KeyV: { dur: 'quarter', dotted: false },
    KeyB: { dur: 'half', dotted: false },
    KeyN: { dur: 'half', dotted: true },
    KeyM: { dur: 'whole', dotted: false }
  };

  // 时值组合键（按左右区分的修饰键）→ { dur, dotted }
  var MOD_DUR = {
    rightAlt:   { dur: 'half', dotted: false },
    rightShift: { dur: 'half', dotted: true },
    rightCtrl:  { dur: 'whole', dotted: false },
    leftCtrl:   { dur: 'dur32', dotted: false },
    leftShift:  { dur: 'sixteenth', dotted: false },
    leftAlt:    { dur: 'quarter', dotted: false }
  };

  var mods = {
    leftCtrl: false, rightCtrl: false, leftShift: false,
    rightShift: false, leftAlt: false, rightAlt: false
  };

  function trackMods(e, down) {
    switch (e.code) {
      case 'ControlLeft': mods.leftCtrl = down; break;
      case 'ControlRight': mods.rightCtrl = down; break;
      case 'ShiftLeft': mods.leftShift = down; break;
      case 'ShiftRight': mods.rightShift = down; break;
      case 'AltLeft': mods.leftAlt = down; break;
      case 'AltRight': mods.rightAlt = down; break;
    }
  }

  function activeModDur() {
    if (mods.rightAlt) return MOD_DUR.rightAlt;
    if (mods.rightShift) return MOD_DUR.rightShift;
    if (mods.rightCtrl) return MOD_DUR.rightCtrl;
    if (mods.leftCtrl) return MOD_DUR.leftCtrl;
    if (mods.leftShift) return MOD_DUR.leftShift;
    if (mods.leftAlt) return MOD_DUR.leftAlt;
    return null;
  }

  // 在谱面末尾（I 光标处）直接落一个完整音符；八度 = 音符键八度 + 预置偏移
  function placeNote(pitch, octave, dur, dotted) {
    var d = dur || state.defaults.dur || 'quarter';
    var dot = (dotted === undefined) ? !!state.defaults.dotted : !!dotted;
    var oct = pitch === 0 ? 0 : clamp((octave || 0) + (state.kxShift || 0), -2, 2);
    commit(function () {
      var n = HLS.model.makeNote(pitch, oct, d, dot);
      if (state.brush && state.brushForm) applyForm(n, state.brushForm);
      state.song.notes.push(n);
      state.mode = 'append';
      state.sel = -1;
      state.slurStart = null;
      state.graceEdit = -1;
      state.building = false;
      state.step = 'pitch';
      state.kxShift = 0;
    });
    flashNoteAt(state.song.notes.length - 1);
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var dlg = document.getElementById('dialog');
      if (dlg && dlg.classList.contains('open')) return; // 对话框打开时不响应打谱快捷键
      if (document.body.classList.contains('preview-open')) return; // 打印预览打开时同理
      if (document.body.classList.contains('help-open')) return; // 帮助面板打开时同理
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      trackMods(e, true);

      // 撤销 / 重做（重做用 Ctrl+Shift+Z，因 z/y 已用作时值/音符键）
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }

      var nk = NOTE_KEYS[e.code];
      var dk = DUR_KEYS[e.code];
      var hasMod = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
      var mod = e.metaKey ? null : activeModDur();

      // 组合键：左右修饰键 + 音符键 → 一次落谱，带指定时值（不改持续时值）
      if (nk && mod && !e.repeat) {
        e.preventDefault();
        placeNote(nk[0], nk[1], mod.dur, mod.dotted);
        return;
      }

      // 音符键：用持续时值 / 附点直接落谱
      if (nk && !hasMod && !e.repeat) {
        e.preventDefault();
        placeNote(nk[0], nk[1]);
        return;
      }

      // 时值预置键：持续生效
      if (dk && !hasMod) {
        e.preventDefault();
        state.defaults.dur = dk.dur;
        state.defaults.dotted = dk.dotted;
        state.step = 'pitch';
        render();
        return;
      }

      if (!hasMod) {
        // 预置八度：f 降一个八度、g 升一个八度（作用于下一个音符）
        if (e.code === 'KeyF') { e.preventDefault(); state.kxShift = clamp(state.kxShift - 1, -4, 4); render(); return; }
        if (e.code === 'KeyG') { e.preventDefault(); state.kxShift = clamp(state.kxShift + 1, -4, 4); render(); return; }
        // 附点开关：持续生效
        if (e.code === 'Period' || e.code === 'Comma') {
          e.preventDefault();
          state.defaults.dotted = !state.defaults.dotted;
          render();
          return;
        }
      }

      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); del(); return; }
      if (e.key === 'Escape') { e.preventDefault(); toAppend(); return; }
    });

    document.addEventListener('keyup', function (e) { trackMods(e, false); });
    window.addEventListener('blur', function () {
      mods.leftCtrl = mods.rightCtrl = mods.leftShift =
        mods.rightShift = mods.leftAlt = mods.rightAlt = false;
    });
  }

  // ---------- 打印预览 ----------
  function openPreview() {
    var el = $('#preview'), body = $('#preview-pages');
    if (!el || !body) return;
    if (!state.song.notes.length) { HLS.toast('请先输入音符'); return; }
    // 按打印比例渲染（不带手机编辑放大、保留页眉），不显示光标/选中框
    HLS.render.mount(body, state.song, -1, -1, null, -1, false);
    el.hidden = false;
    document.body.classList.add('preview-open');
    var pb = $('#preview-print');
    if (pb) pb.focus();
  }

  function closePreview() {
    var el = $('#preview');
    if (!el || el.hidden) return;
    el.hidden = true;
    document.body.classList.remove('preview-open');
    var body = $('#preview-pages');
    if (body) body.innerHTML = '';
  }

  function bindPreview() {
    var close = $('#preview-close');
    var print = $('#preview-print');
    if (close) close.addEventListener('click', closePreview);
    if (print) print.addEventListener('click', function () { window.print(); });
    document.addEventListener('keydown', function (e) {
      if (!document.body.classList.contains('preview-open')) return;
      if (e.key === 'Escape') { e.preventDefault(); closePreview(); }
    });
  }

  function bindFile() {
    var fi = $('#file-input');
    if (fi) fi.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      HLS.storage.importJSON(f, function (err, song) {
        if (err) { HLS.toast('打开失败：文件格式不正确'); return; }
        var s = normalize(song);
        if (!s) { HLS.toast('打开失败：文件格式不正确'); return; }
        commit(function () { state.song = s; });
        toAppend();
        HLS.toast('已打开乐谱');
      });
      this.value = '';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.HLS);
