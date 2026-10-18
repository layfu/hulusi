window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  var state;
  var stageEl;
  var saveTimer = null;
  var saveStateEl;
  var autoScrollReady = false;
  var previewReturn = null;

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---------- 数据兼容 ----------

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

  // ---------- 初始化 ----------

  function init() {
    var raw = HLS.storage.load();
    var saved = null;
    try { saved = normalize(raw); } catch (e) { saved = null; }
    state = {
      song: saved || HLS.model.makeSong(),
      sel: -1,
      mode: 'append',        // append：在末尾写；edit：正在改某个音；insert：在第 N 个音后插入
      view: 'notes',         // notes / octave / dur / form / more
      insertAt: null,        // insert 模式：下一个新音插到这个下标
      insertForm: null,      // insert 模式里这一轮沿用哪套吹法（整轮有效）
      slurStart: null,
      gracePick: false,
      graceTarget: -1,       // 正在选哪个音的倚音音高（可能是插到中间的新音）
      building: false,       // edit 模式中：这个音是刚写好的（改设置会同时记住给下一个音）
      brush: false,
      brushForm: null,
      pendingForm: null,     // 写谱模式里，给“下一个音”预选的吹法（一次性的）
      defaults: { octave: 0, dur: 'quarter', dotted: false },
      kxShift: 0,
      undo: [],
      redo: []
    };

    stageEl = document.getElementById('pages');
    saveStateEl = document.getElementById('save-state');

    bindMeta();
    bindMenu();
    bindToolbar();
    bindKeyboard();
    bindSvg();
    bindFile();
    bindPreview();
    bindHelp();
    render();
    setSaveState(saved ? 'saved' : 'idle');
    autoScrollReady = true;

    // 屏幕尺寸变化（旋转、地址栏收起等）后重算编辑视图比例
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    });

    // 关闭页面前把还在防抖计时里的修改立刻写入
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }

  // ---------- 保存 ----------

  function setSaveState(kind) {
    if (!saveStateEl) return;
    var labels = {
      idle: '自动保存已开启',
      saving: '正在保存…',
      saved: '已自动保存',
      error: '保存失败'
    };
    saveStateEl.textContent = labels[kind] || labels.idle;
    saveStateEl.className = 'save-state' + (kind === 'idle' ? '' : ' ' + kind);
    saveStateEl.title = kind === 'error'
      ? '无法自动保存，请点「存到文件」备份'
      : '每次修改都会自动保存在这台设备';
  }

  function doSave() {
    saveTimer = null;
    var ok = HLS.storage.save(state.song);
    setSaveState(ok ? 'saved' : 'error');
  }

  function scheduleSave() {
    setSaveState('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 400);
  }

  function flushSave() {
    if (saveTimer == null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    HLS.storage.save(state.song);
  }

  // ---------- 上下文 ----------

  function contextNote() {
    if (state.mode === 'edit' && state.sel >= 0 && state.sel < state.song.notes.length) {
      return state.song.notes[state.sel];
    }
    return null;
  }

  function targetIndex() {
    var c = contextNote();
    if (c) return state.sel;
    return state.song.notes.length - 1;
  }

  function targetNote() {
    var i = targetIndex();
    return i >= 0 ? state.song.notes[i] : null;
  }

  function clearGracePick() {
    state.gracePick = false;
    state.graceTarget = -1;
  }

  function graceTargetNote() {
    var i = state.graceTarget;
    if (i == null || i < 0 || i >= state.song.notes.length) return null;
    return state.song.notes[i];
  }

  function isPhone() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
  }

  // 屏幕编辑视图的独立比例：手机上放大到约 26px 字，桌面至少 100%，避免
  // 「自动一页」把编辑视图也缩得很小。打印仍用 song.scale。
  function editViewScale() {
    var printScale = state.song.scale || 1;
    var stage = document.querySelector('.stage');
    var w = stage ? stage.clientWidth : 0;
    if (!w) w = window.innerWidth;
    var phone = isPhone();
    // 纸张左右内边距：手机 14px×2，桌面 26px×2；再留一点余量
    var svgW = Math.max(200, w - (phone ? 28 : 52));
    var vs = 26 * 880 / (30 * svgW);
    if (vs < 1) vs = 1;
    return Math.min(phone ? 3 : 2, Math.max(vs, printScale));
  }

  // ---------- 渲染 ----------

  function cursorArgs() {
    var notes = state.song.notes;
    var editing = state.mode === 'edit' && state.sel >= 0 && state.sel < notes.length;
    var inserting = state.mode === 'insert' && state.insertAt != null;
    var sel = editing ? state.sel : -1;
    var target = -1;
    if (inserting) target = state.insertAt - 1;
    else if (!editing && notes.length) target = notes.length - 1;
    var grace = state.gracePick ? state.graceTarget : -1;
    return { sel: sel, target: target, grace: grace };
  }

  function renderScore() {
    var c = cursorArgs();
    HLS.render.mount(stageEl, state.song, c.sel, c.target,
      state.slurStart, c.grace, true, editViewScale(), isPhone());
  }

  function render() {
    renderScore();
    updateMetaInputs();
    updatePadUI();
    updateStatus();
    scrollActiveIntoView();
  }

  function refreshPad() {
    updatePadUI();
    updateStatus();
  }

  // 把当前正在输入的音符滚动到可见处（手机端在谱面区里滚，桌面端滚窗口）
  function scrollActiveIntoView() {
    if (!autoScrollReady) return;
    var notes = state.song.notes;
    var idx;
    if (state.mode === 'insert' && state.insertAt != null) idx = state.insertAt - 1;
    else if (state.mode === 'edit' && state.sel >= 0) idx = state.sel;
    else idx = notes.length - 1;
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
    if (stage.clientHeight < 1) return; // 菜单展开/预览遮挡时不滚动
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

  // ---------- 写法与标签 ----------

  var ORN_KEYS = ['up', 'down', 'single', 'double', 'triple', 'breath', 'da', 'bo', 'trill'];
  var FORM_LABELS = {
    up: '上滑', down: '下滑', single: '吐', double: '吐库', triple: '吐吐库',
    breath: '吸气', da: '打音', bo: '波音', trill: '颤音', grace: '倚音'
  };
  var FORM_ORDER = ['up', 'down', 'single', 'double', 'triple', 'breath', 'da', 'bo', 'trill', 'grace'];

  function defaultGrace(n) {
    // 默认取下方邻音（葫芦丝常见），可再点小音符自由改。
    // 1 的下方邻音是低一个八度的 7，而不是同八度的 7。
    if (n.pitch > 1) return { pitch: n.pitch - 1, octave: n.octave || 0 };
    return { pitch: 7, octave: (n.octave || 0) - 1 };
  }

  function formKeysOf(note) {
    var keys = [];
    for (var i = 0; i < ORN_KEYS.length; i++) {
      if (note.orn && note.orn[ORN_KEYS[i]]) keys.push(ORN_KEYS[i]);
    }
    if (note.grace) keys.push('grace');
    return keys.sort();
  }

  function formNorm(keys) {
    return (keys || []).slice().sort().join(',');
  }

  function formLabel(keys) {
    if (!keys || !keys.length) return '素音';
    return keys.slice().sort(function (a, b) {
      var ia = FORM_ORDER.indexOf(a), ib = FORM_ORDER.indexOf(b);
      if (ia < 0) ia = 99;
      if (ib < 0) ib = 99;
      return ia - ib;
    }).map(function (k) { return FORM_LABELS[k] || k; }).join('+');
  }

  function applyForm(note, keys) {
    var i;
    var oldGrace = note.grace
      ? { pitch: note.grace.pitch, octave: note.grace.octave || 0 }
      : null;
    for (i = 0; i < ORN_KEYS.length; i++) note.orn[ORN_KEYS[i]] = false;
    note.grace = null;
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      // 重新选“倚音”时保留原来小音符的音高，不要重置成默认邻音
      if (k === 'grace') note.grace = oldGrace || defaultGrace(note);
      else if (note.orn.hasOwnProperty(k)) note.orn[k] = true;
    }
  }

  function currentFormKeys() {
    var c = contextNote();
    if (c) return formKeysOf(c);
    if (state.mode === 'insert') {
      if (state.brush && state.brushForm) return state.brushForm.slice();
      if (state.insertForm) return state.insertForm.slice();
      return [];
    }
    if (state.brush && state.brushForm) return state.brushForm.slice();
    if (state.pendingForm) return state.pendingForm.slice();
    return [];
  }

  function octaveLabel(oct) {
    if (!oct) return '中音';
    if (oct > 1) return '倍高音';
    if (oct === 1) return '高音';
    if (oct < -1) return '倍低音';
    return '低音';
  }

  function durLabel(dur, dotted) {
    var d = HLS.model.DURS[dur] || HLS.model.DURS.quarter;
    return (dotted ? '附点' : '') + d.label;
  }

  // ---------- 面板文字 ----------

  function padText() {
    var notes = state.song.notes;
    if (state.slurStart != null) {
      return { title: '连音线', sub: '已选起点，请点另一个音' };
    }
    if (state.gracePick) {
      var gt = graceTargetNote();
      var g = gt && gt.grace;
      return {
        title: '选倚音音高',
        sub: g ? '小音符 ' + g.pitch + '，点数字改' : '点数字选小音符'
      };
    }
    var pen = octaveLabel(state.defaults.octave) + ' · ' +
      durLabel(state.defaults.dur, state.defaults.dotted) + ' · ' +
      formLabel(currentFormKeys());
    if (state.mode === 'insert' && state.insertAt != null) {
      var at = state.insertAt;
      var ititle;
      if (at <= 0) ititle = '在最前面插入';
      else if (at >= notes.length) ititle = '在末尾插入';
      else ititle = '在第 ' + at + ' 个音后插入';
      return { title: ititle, sub: '下一个：' + pen };
    }
    var c = contextNote();
    if (c) {
      var idx = state.sel + 1;
      var sub = octaveLabel(c.octave) + ' · ' + durLabel(c.dur, c.dotted) +
        ' · ' + formLabel(formKeysOf(c));
      return {
        title: (state.building ? '第 ' : '改第 ') + idx + ' 个音',
        sub: (state.building ? '✓ 已写好 · ' : '') + sub
      };
    }
    return {
      title: notes.length ? '写第 ' + (notes.length + 1) + ' 个音' : '写第一个音',
      sub: pen
    };
  }

  function updateStatus() {
    var el = $('#status-text');
    if (!el) return;
    var txt;
    if (state.kxShift) {
      txt = '键盘：下一个音' + (state.kxShift > 0 ? '升 ' : '降 ') +
        Math.abs(state.kxShift) + ' 个八度';
    } else if (state.slurStart != null) {
      txt = '连音线：已选起点，请点另一个音';
    } else if (state.gracePick) {
      txt = '选倚音的音高后自动完成';
    } else if (state.view !== 'notes') {
      var tail = state.mode === 'insert' ? '继续插入'
        : (state.mode === 'edit' ? '回到改音' : '继续写');
      txt = state.view === 'more'
        ? '点符号；点「音符」' + tail
        : '选好后点「音符」' + tail;
    } else if (state.mode === 'insert') {
      txt = '点数字插入；点「继续写」回末尾';
    } else if (state.mode === 'edit' && state.sel >= 0) {
      txt = state.building ? '已写好，点数字写下一个' : '改完点「继续写」回到末尾';
    } else {
      txt = state.song.notes.length ? '点数字继续写' : '点数字 1–7，开始写谱';
    }
    el.textContent = txt;
  }

  function updateMetaInputs() {
    var t = $('#meta-title'), a = $('#meta-author'), tp = $('#meta-tempo');
    if (t && document.activeElement !== t) t.value = state.song.title || '';
    if (a && document.activeElement !== a) a.value = state.song.author || '';
    if (tp && document.activeElement !== tp) tp.value = state.song.tempo || 60;
    var k = $('#key-val'); if (k) k.textContent = state.song.key;
    var ts = $('#timesig-val'); if (ts) ts.textContent = state.song.timeSig;
  }

  // ---------- 预览图 ----------

  var previewKey = null;
  var OCT_REP = { 'octave-down': -1, 'octave-mid': 0, 'octave-up': 1 };

  function updatePreviews() {
    var c = contextNote();
    var notes = state.song.notes;
    var last = notes.length ? notes[notes.length - 1] : null;
    var gnote = state.gracePick ? graceTargetNote() : null;
    var display = c || gnote;
    var pitch = display ? display.pitch : (last ? last.pitch : 5);
    var oct = display ? (display.octave || 0) : (state.defaults.octave || 0);
    var dur = display ? display.dur : state.defaults.dur;
    var dotted = display ? !!display.dotted : !!state.defaults.dotted;
    var key = pitch + ':' + oct + ':' + dur + ':' + dotted;
    if (key === previewKey) return;
    previewKey = key;

    $all('[data-form]').forEach(function (b) {
      var ic = b.querySelector('.ic');
      if (!ic) return;
      ic.innerHTML = HLS.render.formPreview(b.getAttribute('data-form'), pitch, oct, dur, dotted);
    });
    $all('[data-act="octave-down"],[data-act="octave-mid"],[data-act="octave-up"]').forEach(function (b) {
      var ic = b.querySelector('.ic');
      if (!ic) return;
      ic.innerHTML = HLS.render.notePreview(
        pitch, OCT_REP[b.getAttribute('data-act')], 'quarter', false);
    });
    $all('[data-dur]').forEach(function (b) {
      var ic = b.querySelector('.ic');
      if (!ic) return;
      ic.innerHTML = HLS.render.notePreview(pitch, oct, b.getAttribute('data-dur'), false);
    });
    $all('[data-act="dot"]').forEach(function (b) {
      var ic = b.querySelector('.ic');
      if (!ic) return;
      ic.innerHTML = HLS.render.notePreview(pitch, oct, dur, true);
    });
  }

  // ---------- 面板刷新 ----------

  function setTabVal(sel, text) {
    var el = $(sel);
    if (!el) return;
    el.textContent = text;
    el.title = text;
  }

  function setDisabled(sel, disabled) {
    var el = $(sel);
    if (el) el.disabled = !!disabled;
  }

  function updatePadUI() {
    document.body.setAttribute('data-view', state.view);
    document.body.setAttribute('data-mode', state.mode);

    var c = contextNote();
    var notes = state.song.notes;
    var gnote = state.gracePick ? graceTargetNote() : null;
    var display = c || gnote;
    var oct = display ? (display.octave || 0) : (state.defaults.octave || 0);
    var dur = display ? display.dur : state.defaults.dur;
    var dotted = display ? !!display.dotted : !!state.defaults.dotted;
    var fkeys = display ? formKeysOf(display) : currentFormKeys();
    var curFormNorm = formNorm(fkeys);

    // 页签
    $all('.pad-tab').forEach(function (b) {
      var on = b.getAttribute('data-view') === state.view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    setTabVal('#tab-note', state.gracePick ? '改倚音' : (state.mode === 'insert' ? '插入' : (c ? '改音高' : '写谱')));
    setTabVal('#tab-octave', octaveLabel(oct));
    setTabVal('#tab-dur', durLabel(dur, dotted));
    setTabVal('#tab-form', formLabel(fkeys));

    // 顶部：正在写/改第几个音
    var pt = padText();
    var titleEl = $('#pad-title'), subEl = $('#pad-sub');
    if (titleEl) titleEl.textContent = pt.title;
    if (subEl) subEl.textContent = pt.sub;

    // 上一个/下一个音符
    var showNav = state.mode === 'edit' && notes.length > 0 && !state.gracePick;
    var prev = $('#prev-note'), next = $('#next-note');
    if (prev) {
      prev.hidden = !showNav;
      prev.disabled = showNav && state.sel <= 0;
    }
    if (next) {
      next.hidden = !showNav;
      next.disabled = false;
    }

    // 继续写
    var ab = $('#append-btn');
    var showAppend = state.mode === 'edit' || state.mode === 'insert' || state.gracePick;
    if (ab) {
      ab.hidden = !showAppend;
      ab.textContent = state.gracePick ? '取消' : '继续写';
      ab.classList.toggle('is-cancel', !!state.gracePick);
    }

    // 操作按钮状态（插入中不允许删除 / 打开符号，避免删错、改错）
    var inserting = state.mode === 'insert';
    setDisabled('[data-act="undo"]', !state.undo.length);
    setDisabled('[data-act="redo"]', !state.redo.length);
    setDisabled('[data-act="delete"]', !notes.length || inserting);
    setDisabled('[data-act="more"]', inserting);
    setDisabled('#insert-btn', state.mode === 'edit' && (state.gracePick || state.slurStart != null));

    var insertBtn = $('#insert-btn');
    if (insertBtn) {
      insertBtn.classList.toggle('active', inserting);
      insertBtn.setAttribute('aria-pressed', inserting ? 'true' : 'false');
      insertBtn.textContent = inserting ? '插入中' : '＋ 插入';
    }

    var moreBtn = $('#more-btn');
    if (moreBtn) {
      moreBtn.classList.toggle('active', state.view === 'more');
      moreBtn.setAttribute('aria-pressed', state.view === 'more' ? 'true' : 'false');
      moreBtn.textContent = (state.mode === 'edit' || state.mode === 'insert') ? '更多' : '更多符号';
    }

    var brushBtn = $('#brush-btn'), brushState = $('#brush-state');
    if (brushBtn) {
      brushBtn.classList.toggle('active', !!state.brush);
      brushBtn.setAttribute('aria-pressed', state.brush ? 'true' : 'false');
    }
    if (brushState) brushState.textContent = state.brush ? '开' : '关';

    // 各选项的选中态
    $all('[data-dur]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-dur') === dur);
    });
    $all('[data-act="dot"]').forEach(function (b) {
      b.classList.toggle('active', dotted);
    });
    $all('[data-act="octave-down"]').forEach(function (b) {
      b.classList.toggle('active', oct < 0);
    });
    $all('[data-act="octave-mid"]').forEach(function (b) {
      b.classList.toggle('active', oct === 0);
    });
    $all('[data-act="octave-up"]').forEach(function (b) {
      b.classList.toggle('active', oct > 0);
    });
    $all('[data-form]').forEach(function (b) {
      var ks = b.getAttribute('data-form');
      var norm = ks ? ks.split(',').filter(Boolean).sort().join(',') : '';
      b.classList.toggle('active', norm === curFormNorm);
    });

    var tgt = targetNote();
    $all('[data-orn]').forEach(function (b) {
      var key = b.getAttribute('data-orn');
      var on = false;
      if (tgt) {
        if (key === 'slur') on = state.slurStart != null && tgt.id === state.slurStart;
        else if (key === 'repeatStart' || key === 'repeatEnd') on = !!tgt[key];
        else if (key === 'grace') on = !!tgt.grace;
        else on = !!(tgt.orn && tgt.orn[key]);
      }
      b.classList.toggle('active', on);
    });
    $all('[data-act="linebreak"]').forEach(function (b) {
      b.classList.toggle('active', !!(tgt && tgt.lineBreak));
    });

    var activePitch = null;
    var gnote = state.gracePick ? graceTargetNote() : null;
    if (gnote && gnote.grace) activePitch = gnote.grace.pitch;
    else if (c) activePitch = c.pitch;
    $all('[data-note]').forEach(function (b) {
      b.classList.toggle('active', activePitch != null &&
        (+b.getAttribute('data-note') === activePitch));
    });

    updatePreviews();
  }

  // ---------- 写音符 ----------

  // 在 insertAt 处插入一个新音；插完光标停在它后面，继续点数字会继续往后插。
  function insertPitchAtCursor(pitch) {
    var notes = state.song.notes;
    var at = clamp(state.insertAt == null ? notes.length : state.insertAt, 0, notes.length);
    var d = state.defaults;
    var form = state.brush ? (state.brushForm || []) : (state.insertForm || null);
    state.kxShift = 0;
    commit(function () {
      var n = HLS.model.makeNote(pitch, pitch === 0 ? 0 : d.octave, d.dur, d.dotted);
      if (form) applyForm(n, form);
      state.song.notes.splice(at, 0, n);
      state.insertAt = at + 1;
      state.mode = 'insert';
      state.sel = -1;
      state.building = false;
      state.view = 'notes';
      state.slurStart = null;
      var grace = !!(form && form.indexOf('grace') >= 0);
      state.gracePick = grace;
      state.graceTarget = grace ? at : -1;
    });
    flashNoteAt(at);
  }

  function inputPitch(pitch) {
    if (state.gracePick) { setGracePitch(pitch); return; }

    if (state.mode === 'insert' && state.insertAt != null) {
      insertPitchAtCursor(pitch);
      return;
    }

    var c = contextNote();
    if (c && !state.building) {
      // 正在修改一个旧音符：只改它的音高
      if (c.pitch === pitch) return;
      var idx = state.sel;
      commit(function () {
        state.song.notes[idx].pitch = pitch;
      });
      return;
    }

    // 在末尾新增：用当前“笔”的设置
    var d = state.defaults;
    var form = state.brush ? (state.brushForm || []) : (state.pendingForm || null);
    state.kxShift = 0;
    commit(function () {
      var n = HLS.model.makeNote(pitch, pitch === 0 ? 0 : d.octave, d.dur, d.dotted);
      if (form) applyForm(n, form);
      state.song.notes.push(n);
      state.sel = state.song.notes.length - 1;
      state.mode = 'edit';
      state.building = true;
      state.view = 'notes';
      state.pendingForm = null;
      var grace = !!(form && form.indexOf('grace') >= 0);
      state.gracePick = grace;
      state.graceTarget = grace ? state.song.notes.length - 1 : -1;
      state.slurStart = null;
    });
    flashNoteAt(state.song.notes.length - 1);
  }

  function setGracePitch(pitch) {
    if (!pitch) return; // 倚音不能是休止
    var notes = state.song.notes;
    var idx = state.graceTarget;
    if (idx == null || idx < 0 || idx >= notes.length) return;
    var t = notes[idx];
    if (!t || !t.grace) return;
    if (t.grace.pitch === pitch) {
      clearGracePick();
      state.view = 'notes';
      render();
      return;
    }
    commit(function () {
      notes[idx].grace.pitch = pitch;
      clearGracePick();
      state.view = 'notes';
    });
  }

  function placeNote(pitch, octave, dur, dotted) {
    // 电脑键盘：默认接在末尾；在「插入」状态里插到插入点
    var d = dur || state.defaults.dur || 'quarter';
    var dot = (dotted === undefined) ? !!state.defaults.dotted : !!dotted;
    var oct = pitch === 0 ? 0 : clamp((octave || 0) + (state.kxShift || 0), -2, 2);
    var inserting = state.mode === 'insert' && state.insertAt != null;
    var form = state.brush ? (state.brushForm || [])
      : (inserting ? (state.insertForm || null) : (state.pendingForm || null));
    var at = inserting ? clamp(state.insertAt, 0, state.song.notes.length) : -1;
    var idx = inserting ? at : state.song.notes.length;
    commit(function () {
      var n = HLS.model.makeNote(pitch, oct, d, dot);
      if (form) applyForm(n, form);
      if (inserting) {
        state.song.notes.splice(at, 0, n);
        state.insertAt = at + 1;
        state.mode = 'insert';
      } else {
        state.song.notes.push(n);
        state.mode = 'append';
        state.insertAt = null;
        state.insertForm = null;
        state.pendingForm = null;
      }
      state.sel = -1;
      state.building = false;
      state.slurStart = null;
      state.view = 'notes';
      state.kxShift = 0;
      var grace = !!(form && form.indexOf('grace') >= 0);
      state.gracePick = grace;
      state.graceTarget = grace ? idx : -1;
    });
    flashNoteAt(idx);
  }

  function setOctave(v) {
    v = clamp(v, -2, 2);
    state.kxShift = 0;
    var c = contextNote();
    if (c) {
      if (c.octave === v && (!state.building || state.defaults.octave === v)) return;
      var idx = state.sel;
      var wasBuilding = state.building;
      commit(function () {
        state.song.notes[idx].octave = v;
        if (wasBuilding) state.defaults.octave = v;
      });
    } else {
      if (state.defaults.octave === v) return;
      state.defaults.octave = v;
      refreshPad();
    }
  }

  function setDuration(dur) {
    if (!HLS.model.DURS[dur]) return;
    var c = contextNote();
    if (c) {
      if (c.dur === dur && (!state.building || state.defaults.dur === dur)) return;
      var idx = state.sel;
      var wasBuilding = state.building;
      commit(function () {
        state.song.notes[idx].dur = dur;
        if (wasBuilding) state.defaults.dur = dur;
      });
    } else {
      if (state.defaults.dur === dur) return;
      state.defaults.dur = dur;
      refreshPad();
    }
  }

  function toggleDot() {
    var c = contextNote();
    if (c) {
      var idx = state.sel;
      var wasBuilding = state.building;
      var next = !c.dotted;
      commit(function () {
        state.song.notes[idx].dotted = next;
        if (wasBuilding) state.defaults.dotted = next;
      });
    } else {
      state.defaults.dotted = !state.defaults.dotted;
      refreshPad();
    }
  }

  function applyFormToTarget(formStr) {
    var keys = formStr ? formStr.split(',').filter(Boolean) : [];
    var c = contextNote();
    if (!c) {
      if (state.mode === 'insert') {
        // 插入模式：这一轮插入都沿用这个吹法
        state.insertForm = keys.slice();
        if (state.brush) state.brushForm = keys.slice();
        refreshPad();
        HLS.toast('插入音：' + formLabel(keys));
        return;
      }
      // 写谱模式：没写音符前选的吹法，留给“下一个音”
      state.pendingForm = keys.slice();
      if (state.brush) state.brushForm = keys.slice();
      refreshPad();
      HLS.toast('下一个音：' + formLabel(keys));
      return;
    }
    var idx = state.sel;
    var wasBuilding = state.building;
    var hasGrace = keys.indexOf('grace') >= 0;
    var sameForm = formNorm(formKeysOf(c)) === formNorm(keys);
    // 已经是这个写法：只重新进入倚音选音高，不再产生一次“撤销”
    if (sameForm) {
      if (hasGrace) {
        state.view = 'notes';
        state.gracePick = true;
        state.graceTarget = idx;
        render();
      }
      return;
    }
    commit(function () {
      applyForm(state.song.notes[idx], keys);
      if (wasBuilding && state.brush) state.brushForm = keys.slice();
      state.view = hasGrace ? 'notes' : 'form';
      state.gracePick = hasGrace;
      state.graceTarget = hasGrace ? idx : -1;
    });
  }

  function toggleBrush() {
    if (state.brush) {
      state.brush = false;
      state.brushForm = null;
      HLS.toast('已关闭沿用吹法');
    } else {
      state.brush = true;
      state.brushForm = currentFormKeys();
      HLS.toast('之后新写的音都沿用「' + formLabel(state.brushForm) + '」');
    }
    refreshPad();
  }

  function toggleFormExtra() {
    var extra = $('#form-extra'), btn = $('#more-forms-btn');
    if (!extra || !btn) return;
    var show = extra.hidden;
    extra.hidden = !show;
    btn.textContent = show ? '收起更多吹法 ▴' : '更多吹法 ▾';
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    requestAnimationFrame(scrollActiveIntoView);
  }

  // ---------- 其他符号 ----------

  // 「更多符号」是对某个已有音符的编辑：还没选中时，自动选最后一个音，
  // 让横幅和绿色选框明确告诉老人“正在改哪一个音”。
  function ensureTargetSelected() {
    if (state.mode === 'edit' && state.sel >= 0 && state.sel < state.song.notes.length) return true;
    if (!state.song.notes.length) return false;
    state.mode = 'edit';
    state.sel = state.song.notes.length - 1;
    state.building = false;
    state.insertAt = null;
    state.insertForm = null;
    clearGracePick();
    return true;
  }

  function findNoteById(id) {
    var arr = state.song.notes;
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; }
    return null;
  }

  function toggleSlur() {
    if (!ensureTargetSelected()) { HLS.toast('请先添加音符'); return; }
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

  function removeSlur() {
    if (!state.slurStart && !ensureTargetSelected()) { HLS.toast('请先添加音符'); return; }
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

  function toggleOrn(key) {
    if (key === 'slur') { toggleSlur(); return; }
    if (key === 'slurDel') { removeSlur(); return; }
    if (!ensureTargetSelected()) { HLS.toast('请先添加音符'); return; }
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
          clearGracePick();
        } else {
          n.grace = defaultGrace(n);
          state.gracePick = true;
          state.graceTarget = idx;
          state.view = 'notes';
        }
      });
      return;
    }
    commit(function () {
      var n = state.song.notes[idx];
      if (n.orn.hasOwnProperty(key)) n.orn[key] = !n.orn[key];
    });
  }

  function toggleLineBreak() {
    if (!ensureTargetSelected()) { HLS.toast('请先添加音符'); return; }
    var idx = targetIndex();
    if (idx < 0) { HLS.toast('请先添加音符'); return; }
    commit(function () { state.song.notes[idx].lineBreak = !state.song.notes[idx].lineBreak; });
  }

  // ---------- 删除 / 导航 ----------

  function del() {
    if (state.mode === 'insert') {
      HLS.toast('插入中不能删除：先点「继续写」，或点一下那个音');
      return;
    }
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
      state.insertAt = null;
      state.insertForm = null;
      clearGracePick();
      state.building = false;
      state.view = 'notes';
      if (state.mode === 'edit') {
        state.sel = Math.min(idx, state.song.notes.length - 1);
        if (state.sel < 0) { state.mode = 'append'; state.sel = -1; }
      }
    });
    HLS.toast('已删除，可点「撤销」恢复');
  }

  function prevNote() {
    var notes = state.song.notes;
    if (!notes.length) return;
    if (state.mode === 'insert') {
      var at = state.insertAt == null ? notes.length : state.insertAt;
      state.insertAt = null;
      state.insertForm = null;
      state.mode = 'edit';
      state.sel = clamp(at - 1, 0, notes.length - 1);
      state.building = false;
      clearGracePick();
      render();
      return;
    }
    if (!(state.mode === 'edit' && state.sel >= 0)) {
      // 末尾光标按 ←：先选中最后一个音；再按才往前
      state.mode = 'edit';
      state.sel = notes.length - 1;
      state.building = false;
      clearGracePick();
      render();
      return;
    }
    if (state.sel <= 0) return;
    state.sel -= 1;
    state.building = false;
    clearGracePick();
    render();
  }

  function nextNote() {
    var notes = state.song.notes;
    if (!notes.length) return;
    if (state.mode === 'insert') {
      var at = state.insertAt == null ? notes.length : state.insertAt;
      state.insertAt = null;
      state.insertForm = null;
      if (at < notes.length) {
        state.mode = 'edit';
        state.sel = at;
        state.building = false;
        clearGracePick();
        render();
      } else {
        toAppend();
      }
      return;
    }
    var i = (state.mode === 'edit' && state.sel >= 0) ? state.sel : notes.length - 1;
    if (i >= notes.length - 1) { toAppend(); return; }
    state.mode = 'edit';
    state.sel = i + 1;
    state.building = false;
    clearGracePick();
    render();
  }

  function toAppend() {
    state.mode = 'append';
    state.sel = -1;
    state.insertAt = null;
    state.insertForm = null;
    state.slurStart = null;
    clearGracePick();
    state.building = false;
    state.view = 'notes';
    render();
  }

  // 选中一个旧音后点「插入」：把它的音区/长短/附点/吹法当成“笔”，
  // 光标停在它后面；接下来点的数字都插在这个位置。
  function enterInsert() {
    var n = contextNote();
    if (!n || state.mode !== 'edit') return;
    var i = state.sel;
    state.defaults.octave = n.octave || 0;
    state.defaults.dur = n.dur;
    state.defaults.dotted = !!n.dotted;
    state.insertForm = formKeysOf(n).slice();
    state.insertAt = i + 1;
    state.mode = 'insert';
    state.sel = -1;
    state.building = false;
    state.slurStart = null;
    state.kxShift = 0;
    clearGracePick();
    state.view = 'notes';
    render();
  }

  function resetPen() {
    state.defaults = { octave: 0, dur: 'quarter', dotted: false };
    state.brush = false;
    state.brushForm = null;
    state.pendingForm = null;
    state.insertAt = null;
    state.insertForm = null;
    state.kxShift = 0;
    clearGracePick();
    previewKey = null;
  }

  // ---------- 历史 ----------

  function commit(fn) {
    state.undo.push(JSON.stringify(state.song));
    if (state.undo.length > 300) state.undo.shift();
    state.redo.length = 0;
    fn();
    render();
    scheduleSave();
  }

  function clampSel() {
    var len = state.song.notes.length;
    if (state.mode === 'edit') {
      if (state.sel >= len) state.sel = len - 1;
      if (state.sel < 0) { state.mode = 'append'; state.sel = -1; }
    } else {
      state.sel = -1;
    }
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.song));
    state.song = JSON.parse(state.undo.pop());
    normalize(state.song);
    state.insertAt = null;
    state.insertForm = null;
    state.slurStart = null;
    clearGracePick();
    state.building = false;
    if (state.mode === 'insert') state.mode = 'append';
    state.view = 'notes';
    clampSel();
    render();
    scheduleSave();
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.song));
    state.song = JSON.parse(state.redo.pop());
    normalize(state.song);
    state.insertAt = null;
    state.insertForm = null;
    state.slurStart = null;
    clearGracePick();
    state.building = false;
    if (state.mode === 'insert') state.mode = 'append';
    state.view = 'notes';
    clampSel();
    render();
    scheduleSave();
  }

  // ---------- 调号 / 拍号 ----------

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

  // ---------- 动作分发 ----------

  function setView(v) {
    var views = ['notes', 'octave', 'dur', 'form', 'more'];
    if (views.indexOf(v) < 0) return;
    var next = (state.view === v && v !== 'notes') ? 'notes' : v;
    var wasGrace = state.gracePick;
    state.view = next;
    clearGracePick(); // 离开音符页签就取消“选倚音音高”
    if (wasGrace) render();
    else {
      refreshPad();
      requestAnimationFrame(scrollActiveIntoView);
    }
  }

  function doAction(act) {
    switch (act) {
      case 'octave-down': setOctave(-1); break;
      case 'octave-up': setOctave(1); break;
      case 'octave-mid': setOctave(0); break;
      case 'dot': toggleDot(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'delete': del(); break;
      case 'linebreak': toggleLineBreak(); break;
      case 'insert':
        if (state.mode === 'insert') toAppend();
        else enterInsert();
        break;
      case 'append':
        if (state.gracePick) { clearGracePick(); render(); }
        else toAppend();
        break;
      case 'prev-note': prevNote(); break;
      case 'next-note': nextNote(); break;
      case 'brush': toggleBrush(); break;
      case 'more': setView('more'); break;
      case 'more-forms': toggleFormExtra(); break;
      case 'help': toggleHelp(); break;
      case 'menu': toggleMenu(true); break;
      case 'key-down': cycleKey(-1); break;
      case 'key-up': cycleKey(1); break;
      case 'timesig-cycle': cycleTimeSig(); break;
    }
  }

  function doFile(kind) {
    switch (kind) {
      case 'print':
      case 'preview':
      case 'pdf':
        openPreview();
        break;
      case 'save':
        HLS.storage.downloadJSON(state.song);
        HLS.toast('已下载备份文件');
        toggleMenu(false);
        break;
      case 'open':
        if (state.song.notes.length) {
          HLS.confirm('打开作品会替换当前乐谱，确定继续吗？', '打开', function () {
            $('#file-input').click();
          });
        } else {
          $('#file-input').click();
        }
        break;
      case 'new':
        if (!state.song.notes.length) { HLS.toast('当前已经是空乐谱'); return; }
        HLS.confirm('确定要新建空白曲谱吗？新建后可点「撤销」恢复。', '新建', function () {
          resetPen();
          commit(function () {
            state.song = HLS.model.makeSong();
            state.mode = 'append';
            state.sel = -1;
            state.building = false;
            state.slurStart = null;
            state.insertAt = null;
            state.insertForm = null;
            clearGracePick();
            state.view = 'notes';
          });
          toggleMenu(false);
          HLS.toast('已新建空白曲谱');
        });
        break;
    }
  }

  // ---------- 菜单 ----------

  function toggleMenu(open) {
    var was = document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    var a = $('#menu-button'), b = $('#menu-toggle');
    if (a) a.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (b) {
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.textContent = open ? '✕ 关闭' : '☰ 菜单';
    }
    if (!open && document.activeElement && document.activeElement.blur) {
      var ae = document.activeElement;
      if (ae.closest && (ae.closest('.appbar') || ae.closest('.meta'))) ae.blur();
    }
    if (was && !open) requestAnimationFrame(render);
  }

  function bindMenu() {
    var mt = $('#menu-toggle');
    if (mt) mt.addEventListener('click', function () {
      toggleMenu(!document.body.classList.contains('menu-open'));
    });
  }

  // ---------- 使用说明 ----------

  function openHelp() {
    var el = $('#help');
    if (!el) return;
    toggleMenu(false);
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

  // ---------- 事件绑定 ----------

  function bindMeta() {
    var t = $('#meta-title');
    if (t) t.addEventListener('input', function () {
      state.song.title = this.value;
      scheduleSave();
      renderScore();
    });
    var a = $('#meta-author');
    if (a) a.addEventListener('input', function () {
      state.song.author = this.value;
      scheduleSave();
      renderScore();
    });
    var tp = $('#meta-tempo');
    if (tp) {
      tp.addEventListener('input', function () {
        var v = parseInt(this.value, 10);
        if (isNaN(v)) return;
        state.song.tempo = clamp(v, 20, 300);
        scheduleSave();
        renderScore();
      });
      tp.addEventListener('blur', function () {
        this.value = state.song.tempo || 60;
      });
    }
  }

  function bindToolbar() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest &&
        e.target.closest('[data-note],[data-dur],[data-orn],[data-form],[data-act],[data-file],[data-view]');
      if (!el) return;
      if (el.hasAttribute('data-note')) { inputPitch(+el.getAttribute('data-note')); return; }
      if (el.hasAttribute('data-dur')) { setDuration(el.getAttribute('data-dur')); return; }
      if (el.hasAttribute('data-form')) { applyFormToTarget(el.getAttribute('data-form')); return; }
      if (el.hasAttribute('data-orn')) { toggleOrn(el.getAttribute('data-orn')); return; }
      if (el.hasAttribute('data-view')) { setView(el.getAttribute('data-view')); return; }
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
      state.insertAt = null;
      state.insertForm = null;
      clearGracePick();
      state.building = false;
      if (idx !== null && idx !== undefined && idx !== '') {
        state.mode = 'edit';
        state.sel = off + (+idx);
        // 连音线选终点、或给某个音加符号时，保留当前页签，方便连续操作
      } else {
        state.mode = 'append';
        state.sel = -1;
        state.slurStart = null;
        state.view = 'notes';
      }
      render();
    });
  }

  // ---------- 键盘快速输入 ----------

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

  var DUR_KEYS = {
    KeyZ: { dur: 'dur32', dotted: false },
    KeyX: { dur: 'sixteenth', dotted: false },
    KeyC: { dur: 'eighth', dotted: false },
    KeyV: { dur: 'quarter', dotted: false },
    KeyB: { dur: 'half', dotted: false },
    KeyN: { dur: 'half', dotted: true },
    KeyM: { dur: 'whole', dotted: false }
  };

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

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var dlg = document.getElementById('dialog');
      if (dlg && dlg.classList.contains('open')) return;
      if (document.body.classList.contains('preview-open')) return;
      if (document.body.classList.contains('help-open')) return;
      if (document.body.classList.contains('menu-open')) {
        if (e.key === 'Escape') { e.preventDefault(); toggleMenu(false); }
        return;
      }
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      trackMods(e, true);

      // 撤销 / 重做（重做用 Ctrl+Shift+Z）
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (state.gracePick) { clearGracePick(); render(); }
        else toAppend();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        del();
        return;
      }

      var hasMod = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
      if (!hasMod && e.code === 'ArrowLeft') { e.preventDefault(); prevNote(); return; }
      if (!hasMod && e.code === 'ArrowRight') { e.preventDefault(); nextNote(); return; }

      var nk = NOTE_KEYS[e.code];
      var dk = DUR_KEYS[e.code];
      var mod = e.metaKey ? null : activeModDur();

      // 选倚音音高：数字键直接改小音符
      if (nk && state.gracePick) {
        e.preventDefault();
        if (!e.repeat) setGracePitch(nk[0]);
        return;
      }

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
        clearGracePick();
        state.view = 'notes';
        refreshPad();
        requestAnimationFrame(scrollActiveIntoView);
        return;
      }

      if (!hasMod) {
        // 预置八度：f 降一个八度、g 升一个八度（作用于下一个键盘音符）
        if (e.code === 'KeyF') {
          e.preventDefault();
          state.kxShift = clamp(state.kxShift - 1, -2, 2);
          refreshPad();
          return;
        }
        if (e.code === 'KeyG') {
          e.preventDefault();
          state.kxShift = clamp(state.kxShift + 1, -2, 2);
          refreshPad();
          return;
        }
        // 附点开关：持续生效
        if (e.code === 'Period' || e.code === 'Comma') {
          e.preventDefault();
          state.defaults.dotted = !state.defaults.dotted;
          refreshPad();
          return;
        }
      }
    });

    document.addEventListener('keyup', function (e) { trackMods(e, false); });
    window.addEventListener('blur', function () {
      mods.leftCtrl = mods.rightCtrl = mods.leftShift =
        mods.rightShift = mods.leftAlt = mods.rightAlt = false;
    });
  }

  // ---------- 文件 ----------

  function bindFile() {
    var fi = $('#file-input');
    if (fi) fi.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      HLS.storage.importJSON(f, function (err, song) {
        if (err) { HLS.toast('打开失败：文件格式不正确'); return; }
        var s = null;
        try { s = normalize(song); } catch (e2) { s = null; }
        if (!s) { HLS.toast('打开失败：文件格式不正确'); return; }
        resetPen();
        commit(function () {
          state.song = s;
          state.mode = 'append';
          state.sel = -1;
          state.building = false;
          state.slurStart = null;
          state.insertAt = null;
          state.insertForm = null;
          clearGracePick();
          state.view = 'notes';
        });
        toggleMenu(false);
        HLS.toast('已打开乐谱');
      });
      this.value = '';
    });
  }

  // ---------- 打印预览 ----------

  function renderPreview() {
    var body = $('#preview-pages');
    if (!body) return;
    HLS.render.mount(body, state.song, -1, -1, null, -1, false);
    // 每张纸外面套一个宽高比容器，屏幕预览才能按 A4 纸（含 4mm 留白）显示
    Array.prototype.slice.call(body.children).forEach(function (p) {
      if (!p.classList || !p.classList.contains('paper')) return;
      var frame = document.createElement('div');
      frame.className = 'page-frame';
      body.insertBefore(frame, p);
      frame.appendChild(p);
    });
    var info = HLS.render.fitInfo(state.song);
    var fit = $('#preview-fit');
    if (fit) {
      fit.textContent = info.fits
        ? '✓ ' + info.pages + ' 页内'
        : '⚠ 超出 ' + info.pages + ' 页';
      fit.className = 'preview-fit' + (info.fits ? '' : ' over');
    }
    var sc = $('#preview-scale');
    if (sc) sc.textContent = '字号 ' + Math.round((state.song.scale || 1) * 100) + '%';
  }

  function openPreview() {
    var el = $('#preview'), body = $('#preview-pages');
    if (!el || !body) return;
    if (!state.song.notes.length) { HLS.toast('请先输入音符'); return; }
    previewReturn = document.activeElement;
    toggleMenu(false);
    renderPreview();
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
    if (previewReturn && previewReturn.focus && document.contains(previewReturn)) {
      try { previewReturn.focus(); } catch (err) {}
    }
    previewReturn = null;
    requestAnimationFrame(scrollActiveIntoView);
  }

  function autoFit() {
    if (!state.song.notes.length) { HLS.toast('请先输入音符'); return; }
    state.song.notes.forEach(function (n) { n.pageBreak = false; });
    var s = HLS.render.fitScale(state.song);
    state.song.scale = s;
    renderScore();
    scheduleSave();
    renderPreview();
  }

  function autoFit2() {
    if (state.song.notes.length < 2) { HLS.toast('请先输入足够的音符'); return; }
    var res = HLS.render.fitScale2(state.song);
    if (res.splitIndex < 0) { HLS.toast('这个长度放不下 2 页'); return; }
    state.song.notes.forEach(function (n, i) { n.pageBreak = (i === res.splitIndex); });
    state.song.scale = res.scale;
    renderScore();
    scheduleSave();
    renderPreview();
  }

  function bindPreview() {
    var close = $('#preview-close');
    var print = $('#preview-print');
    var af = $('#preview-autofit');
    var af2 = $('#preview-autofit2');
    if (close) close.addEventListener('click', closePreview);
    if (print) print.addEventListener('click', function () { window.print(); });
    if (af) af.addEventListener('click', autoFit);
    if (af2) af2.addEventListener('click', autoFit2);
    document.addEventListener('keydown', function (e) {
      if (!document.body.classList.contains('preview-open')) return;
      if (e.key === 'Escape') { e.preventDefault(); closePreview(); }
    });
  }

  // 启动顺序：等基础样式表就绪后再初始化，避免在未套样式时测量宽度、排错版。
  var appStarted = false;
  function startApp() {
    if (appStarted) return;
    appStarted = true;
    init();
    if (window.HLSBoot && window.HLSBoot.done) {
      window.HLSBoot.done();
    } else {
      // 极端情况下启动脚本没跑到：至少别让启动画面一直盖着
      var boot = document.getElementById('boot-screen');
      if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
      document.documentElement.classList.remove('boot-lock');
      document.body.removeAttribute('aria-busy');
    }
  }

  function waitForCssThenStart() {
    if (window.__hlsCssReady) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startApp, { once: true });
      } else {
        startApp();
      }
      return;
    }
    document.addEventListener('hls:cssready', function () {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startApp, { once: true });
      } else {
        startApp();
      }
    }, { once: true });
  }

  waitForCssThenStart();
})(window.HLS);
