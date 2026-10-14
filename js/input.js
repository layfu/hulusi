window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  var state;
  var stageEl;
  var saveTimer;

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
      slurStart: null,
      graceEdit: -1,
      defaults: { octave: 0, dur: 'quarter', dotted: false },
      undo: [],
      redo: []
    };

    stageEl = document.getElementById('pages');
    bindMeta();
    bindScale();
    bindToolbar();
    bindKeyboard();
    bindSvg();
    bindFile();
    render();
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

  // ---------- 渲染与状态显示 ----------

  function render() {
    var sel = state.mode === 'edit' ? state.sel : -1;
    var target = state.mode === 'append' ? state.song.notes.length - 1 : -1;
    var info = HLS.render.mount(stageEl, state.song, sel, target,
      state.slurStart, state.graceEdit, true);
    updateScaleUI(info);
    updateStatus();
    updateMetaInputs();
    updateToolbarActive();
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
      if (state.graceEdit >= 0) {
        el.textContent = '正在设置倚音：按 1–7 选音，↑↓ 调八度，点别处结束';
      } else if (state.slurStart != null) {
        el.textContent = '连音线：已选起点（橙色框），请点击要连接的另一个音符';
      } else if (state.mode === 'edit' && state.sel >= 0) {
        el.textContent = '正在编辑第 ' + (state.sel + 1) + ' 个音符（点空白处可继续添加）';
      } else {
        el.textContent = '正在添加新音符 · 共 ' + state.song.notes.length + ' 个';
      }
    }
    var u = $('[data-act="undo"]');
    var r = $('[data-act="redo"]');
    if (u) u.disabled = state.undo.length === 0;
    if (r) r.disabled = state.redo.length === 0;
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

    var tgt = targetNote();
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
    if (state.graceEdit >= 0 && state.song.notes[state.graceEdit] &&
        state.song.notes[state.graceEdit].grace) {
      if (pitch === 0) return; // 倚音不能是休止
      var gi = state.graceEdit;
      commit(function () { state.song.notes[gi].grace.pitch = pitch; });
      return;
    }
    if (state.mode === 'edit' && state.sel >= 0 && state.sel < state.song.notes.length) {
      var idx = state.sel;
      commit(function () { state.song.notes[idx].pitch = pitch; });
    } else {
      commit(function () {
        state.song.notes.push(HLS.model.makeNote(
          pitch, state.defaults.octave, state.defaults.dur, state.defaults.dotted));
      });
    }
  }

  function setDuration(dur) {
    if (!HLS.model.DURS[dur]) return;
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () { state.song.notes[idx].dur = dur; });
    } else {
      state.defaults.dur = dur;
      updateToolbarActive();
      HLS.toast('新音符时值：' + HLS.model.DURS[dur].label);
    }
  }

  function octaveBy(delta) {
    if (state.graceEdit >= 0 && state.song.notes[state.graceEdit] &&
        state.song.notes[state.graceEdit].grace) {
      var gi = state.graceEdit;
      commit(function () {
        var g = state.song.notes[gi].grace;
        g.octave = clamp(g.octave + delta, -1, 1);
      });
      return;
    }
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () {
        var n = state.song.notes[idx];
        n.octave = clamp(n.octave + delta, -2, 2);
      });
    } else {
      state.defaults.octave = clamp(state.defaults.octave + delta, -2, 2);
      updateToolbarActive();
    }
  }

  function octaveSet(v) {
    if (state.graceEdit >= 0 && state.song.notes[state.graceEdit] &&
        state.song.notes[state.graceEdit].grace) {
      var gi = state.graceEdit;
      commit(function () { state.song.notes[gi].grace.octave = v; });
      return;
    }
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () { state.song.notes[idx].octave = v; });
    } else {
      state.defaults.octave = v;
      updateToolbarActive();
    }
  }

  function toggleDot() {
    if (state.mode === 'edit' && state.sel >= 0) {
      var idx = state.sel;
      commit(function () { state.song.notes[idx].dotted = !state.song.notes[idx].dotted; });
    } else {
      state.defaults.dotted = !state.defaults.dotted;
      updateToolbarActive();
    }
  }

  function toggleOrn(key) {
    if (key === 'slur') { toggleSlur(); return; }
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
          n.grace = { pitch: n.pitch >= 7 ? 1 : n.pitch + 1, octave: n.octave || 0 };
        }
      });
      return;
    }
    commit(function () {
      var n = state.song.notes[idx];
      if (n.orn.hasOwnProperty(key)) n.orn[key] = !n.orn[key];
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

  function del() {
    var idx = targetIndex();
    if (idx < 0) return;
    commit(function () {
      var removed = state.song.notes[idx];
      state.song.notes.splice(idx, 1);
      state.song.notes.forEach(function (n) { if (n.slurTo === removed.id) n.slurTo = null; });
      if (state.slurStart === removed.id) state.slurStart = null;
      state.graceEdit = -1;
      if (state.mode === 'edit') {
        state.sel = Math.min(idx, state.song.notes.length - 1);
        if (state.sel < 0) state.mode = 'append';
      }
    });
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
      case 'key-down': cycleKey(-1); break;
      case 'key-up': cycleKey(1); break;
      case 'timesig-cycle': cycleTimeSig(); break;
    }
  }

  function doFile(kind) {
    switch (kind) {
      case 'print': HLS.exporters.print(); break;
      case 'pdf': HLS.exporters.pdf(); break;
      case 'png': HLS.exporters.png(state.song); break;
      case 'save':
        HLS.storage.downloadJSON(state.song);
        HLS.toast('已保存到文件');
        break;
      case 'open':
        $('#file-input').click();
        break;
      case 'new':
        if (state.song.notes.length && !window.confirm('确定要清空当前乐谱吗？')) return;
        commit(function () {
          state.song = HLS.model.makeSong();
          state.mode = 'append';
          state.sel = -1;
          state.slurStart = null;
          state.graceEdit = -1;
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
      HLS.render.mount(stageEl, state.song,
        state.mode === 'edit' ? state.sel : -1,
        state.mode === 'append' ? state.song.notes.length - 1 : -1,
        state.slurStart, state.graceEdit);
    });
    var a = $('#meta-author');
    if (a) a.addEventListener('input', function () {
      state.song.author = this.value; scheduleSave();
      HLS.render.mount(stageEl, state.song,
        state.mode === 'edit' ? state.sel : -1,
        state.mode === 'append' ? state.song.notes.length - 1 : -1,
        state.slurStart, state.graceEdit);
    });
    var tp = $('#meta-tempo');
    if (tp) tp.addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      if (isNaN(v)) return;
      state.song.tempo = clamp(v, 20, 300); scheduleSave();
      HLS.render.mount(stageEl, state.song, -1,
        state.mode === 'append' ? state.song.notes.length - 1 : -1,
        state.slurStart, state.graceEdit);
    });
  }

  function bindScale() {
    var af = $('#autofit-btn');
    if (af) af.addEventListener('click', autoFit);
    var af2 = $('#autofit2-btn');
    if (af2) af2.addEventListener('click', autoFit2);
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
        e.target.closest('[data-note],[data-dur],[data-orn],[data-act],[data-file]');
      if (!el) return;
      if (el.hasAttribute('data-note')) { addNote(+el.getAttribute('data-note')); return; }
      if (el.hasAttribute('data-dur')) { setDuration(el.getAttribute('data-dur')); return; }
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
      var gidx = t && t.getAttribute ? t.getAttribute('data-grace') : null;
      if (gidx !== null && gidx !== undefined && gidx !== '') {
        state.graceEdit = off + (+gidx);
        state.mode = 'edit';
        state.sel = off + (+gidx);
        render();
        return;
      }
      var idx = t && t.getAttribute ? t.getAttribute('data-index') : null;
      state.graceEdit = -1;
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

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      var k = e.key;

      if (/^[0-7]$/.test(k)) { e.preventDefault(); addNote(+k); return; }
      if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); del(); return; }
      if (k === 'ArrowUp') { e.preventDefault(); octaveBy(1); return; }
      if (k === 'ArrowDown') { e.preventDefault(); octaveBy(-1); return; }
      if (k === 'Escape') { e.preventDefault(); toAppend(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) {
        e.preventDefault(); redo(); return;
      }
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
