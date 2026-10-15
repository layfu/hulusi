window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  var DURS = {
    whole:     { label: '全音符', beats: 4,     underlines: 0 },
    half:      { label: '二分',   beats: 2,     underlines: 0 },
    quarter:   { label: '四分',   beats: 1,     underlines: 0 },
    eighth:    { label: '八分',   beats: 0.5,   underlines: 1 },
    sixteenth: { label: '十六分', beats: 0.25,  underlines: 2 },
    dur32:     { label: '三十二分', beats: 0.125, underlines: 3 }
  };

  var KEYS = ['1=C', '1=♯C', '1=D', '1=♭E', '1=E', '1=F',
              '1=♯F', '1=G', '1=♭A', '1=A', '1=♭B', '1=B'];

  var TIME_SIGS = ['4/4', '3/4', '2/4', '6/8', '3/8'];

  var nextNoteId = 1;

  function makeNote(pitch, octave, dur, dotted) {
    return {
      id: nextNoteId++,
      pitch: pitch === undefined ? 1 : pitch,
      octave: octave || 0,
      dur: dur || 'quarter',
      dotted: !!dotted,
      lineBreak: false,
      pageBreak: false,
      orn: {
        up: false, down: false,
        single: false, double: false, triple: false,
        breath: false, da: false, bo: false, trill: false
      },
      grace: null,
      slurTo: null,
      repeatStart: false,
      repeatEnd: false
    };
  }

  // 为旧数据补齐/校正 id，并同步计数器，保证 id 唯一
  function syncIds(song) {
    if (!song || !Array.isArray(song.notes)) return;
    var max = 0;
    song.notes.forEach(function (n) {
      if (typeof n.id === 'number' && n.id > max) max = n.id;
    });
    song.notes.forEach(function (n) {
      if (typeof n.id !== 'number') n.id = ++max;
    });
    if (max >= nextNoteId) nextNoteId = max + 1;
  }

  function makeSong() {
    return {
      title: '',
      author: '',
      key: '1=C',
      timeSig: '4/4',
      tempo: 60,
      scale: 1,
      notes: []
    };
  }

  function beatsOf(n) {
    var d = DURS[n.dur];
    var b = d ? d.beats : 1;
    return n.dotted ? b * 1.5 : b;
  }

  function underlinesOf(n) {
    var d = DURS[n.dur];
    return d ? d.underlines : 0;
  }

  // 增时线数量：按实际时值（含附点）取整拍后，每多一拍一条横线
  // 例：四分=0，二分=1，二分附点(3拍)=2，全音符=3
  function dashesOf(n) {
    var wholeBeats = Math.floor(beatsOf(n) + 1e-6);
    return wholeBeats >= 1 ? wholeBeats - 1 : 0;
  }

  // 是否需要画附点：仅当实际时值为非整数拍时（如附点四分 1.5、附点八分 0.75）
  // 整拍的“附点二分/附点全音符”改用增时线表示，不再画点
  function hasAugDot(n) {
    if (!n.dotted) return false;
    var eff = beatsOf(n);
    if (eff < 1) return true;
    return Math.abs(eff - Math.round(eff)) > 1e-6;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  HLS.model = {
    DURS: DURS,
    KEYS: KEYS,
    TIME_SIGS: TIME_SIGS,
    makeNote: makeNote,
    makeSong: makeSong,
    syncIds: syncIds,
    beatsOf: beatsOf,
    underlinesOf: underlinesOf,
    dashesOf: dashesOf,
    hasAugDot: hasAugDot,
    clone: clone,
    esc: esc
  };
})(window.HLS);
