window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  var KEY = 'hulusi.song.v1';

  function save(song) {
    try {
      localStorage.setItem(KEY, JSON.stringify(song));
      return true;
    } catch (e) {
      return false;
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  function safeName(song, ext) {
    var base = (song.title && song.title.trim()) || '葫芦丝曲谱';
    base = base.replace(/[\\/:*?"<>|]/g, '_');
    return base + '.' + ext;
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function downloadJSON(song) {
    var blob = new Blob([JSON.stringify(song, null, 2)],
      { type: 'application/json;charset=utf-8' });
    download(blob, safeName(song, 'json'));
  }

  function importJSON(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var song = JSON.parse(reader.result);
        if (!song || !Array.isArray(song.notes)) throw new Error('bad');
        cb(null, song);
      } catch (e) {
        cb(e);
      }
    };
    reader.onerror = function () { cb(reader.error); };
    reader.readAsText(file, 'utf-8');
  }

  HLS.storage = {
    KEY: KEY,
    save: save,
    load: load,
    clear: clear,
    safeName: safeName,
    download: download,
    downloadJSON: downloadJSON,
    importJSON: importJSON
  };
})(window.HLS);
