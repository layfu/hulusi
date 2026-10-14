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

  // 确认对话框：破坏性操作用大字按钮确认，避免误触
  var dlgEl, dlgMsg, dlgOk, dlgCancel, dlgOnOk, dlgReturn;

  function ensureDialog() {
    if (dlgEl) return dlgEl;
    dlgEl = document.getElementById('dialog');
    if (!dlgEl) return null;
    dlgMsg = document.getElementById('dialog-msg');
    dlgOk = document.getElementById('dialog-ok');
    dlgCancel = document.getElementById('dialog-cancel');
    dlgOk.addEventListener('click', function () { settle(true); });
    dlgCancel.addEventListener('click', function () { settle(false); });
    dlgEl.addEventListener('click', function (e) { if (e.target === dlgEl) settle(false); });
    document.addEventListener('keydown', function (e) {
      if (dlgEl.classList.contains('open') && e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    });
    return dlgEl;
  }

  function settle(ok) {
    if (!dlgEl) return;
    dlgEl.classList.remove('open');
    if (dlgReturn && dlgReturn.focus) dlgReturn.focus();
    dlgReturn = null;
    dlgEl.setAttribute('aria-hidden', 'true');
    var cb = dlgOnOk;
    dlgOnOk = null;
    if (ok && cb) cb();
  }

  function confirmDialog(msg, okLabel, onOk) {
    if (!ensureDialog()) { if (window.confirm(msg)) onOk(); return; }
    dlgMsg.textContent = msg;
    dlgOk.textContent = okLabel || '确定';
    dlgOnOk = onOk;
    dlgReturn = document.activeElement;
    dlgEl.setAttribute('aria-hidden', 'false');
    dlgEl.classList.add('open');
    dlgOk.focus();
  }

  function printScore() {
    window.print();
  }

  function exportPdf() {
    toast('打印窗口里把“目标”选为“另存为 PDF”；若仍有网址/页码，取消勾选“页眉和页脚”');
    setTimeout(function () { window.print(); }, 400);
  }

  HLS.toast = toast;
  HLS.confirm = confirmDialog;
  HLS.exporters = {
    print: printScore,
    pdf: exportPdf
  };
})(window.HLS);
