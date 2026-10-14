window.HLS = window.HLS || {};

(function (HLS) {
  'use strict';

  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function printScore() {
    window.print();
  }

  function exportPdf() {
    toast('打印窗口里把“目标”选为“另存为 PDF”；若仍有网址/页码，取消勾选“页眉和页脚”');
    setTimeout(function () { window.print(); }, 400);
  }

  function exportPng(song) {
    var svgStr = HLS.render.buildSvg(song, -1, -1);
    var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var scale = 2;
      var w = img.width || 880;
      var h = img.height || 600;
      var canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (b) {
        if (!b) { toast('导出图片失败'); return; }
        HLS.storage.download(b, HLS.storage.safeName(song, 'png'));
        toast('已导出图片');
      }, 'image/png');
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('导出图片失败'); };
    img.src = url;
  }

  HLS.toast = toast;
  HLS.exporters = {
    print: printScore,
    pdf: exportPdf,
    png: exportPng
  };
})(window.HLS);
