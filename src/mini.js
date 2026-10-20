'use strict';
/* Widget sempre visível. Recebe o estado da janela principal pelo evento "mini"
   e conta o tempo sozinho, para não depender do ritmo da janela principal escondida. */
const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}` };
let E = null;

const restante = T => T.pausado ? T.restante : T.fimTs - Date.now();
const linhaBloco = (rot, b) => b
  ? `<div class="agenda"><span class="ponto" style="background:${b.cor}"></span><span class="m">${rot}</span><span class="l">${b.ini} ${esc(b.titulo)}</span></div>`
  : '';
const botoes = extra => `<span class="botoes" data-tauri-drag-region>${extra}<button data-a="abrir" title="Abrir o ritmo">↗</button><button data-a="fechar" title="Ocultar widget">✕</button></span>`;

function render() {
  const raiz = document.getElementById('raiz');
  if (!E) { raiz.innerHTML = `<div class="topo"><span class="m">conectando…</span>${botoes('')}</div>`; return }
  const T = E.timer;
  if (T && (T.fase === 'foco' || T.fase === 'pausa')) {
    const r = restante(T), pct = Math.min(100, (1 - r / T.duracaoMs) * 100);
    raiz.innerHTML = `<div class="topo" data-tauri-drag-region><div class="tempo" data-tauri-drag-region>${mmss(r)}</div>
        <div class="info" data-tauri-drag-region><div class="fase ${T.fase}">${T.fase}${T.pausado ? ' · pausado' : ''}</div>
        <div class="l"><b>${T.fase === 'foco' ? esc(T.tarefa) : 'levante, água, olhe longe'}</b></div></div>
        ${botoes(T.fase === 'foco' ? `<button data-a="pausar" title="${T.pausado ? 'Retomar' : 'Pausar'}">${T.pausado ? '▶' : '❚❚'}</button>` : '')}</div>
      <div class="prog ${T.fase}"><div style="width:${pct}%"></div></div>
      ${T.fase === 'foco' ? `<div class="l m" data-tauri-drag-region>1º passo: ${esc(T.passo)}</div>` : ''}
      ${linhaBloco('depois', E.prox)}`;
  } else if (T && T.fase === 'registro') {
    raiz.innerHTML = `<div class="topo"><div class="info" data-tauri-drag-region><div class="fase">bloco concluído</div>
      <div class="l grande">${esc(T.tarefa)}</div></div>${botoes('')}</div>
      <div class="m">Registre o que saiu na janela principal.</div>`;
  } else {
    const a = E.atual;
    raiz.innerHTML = `<div class="topo" data-tauri-drag-region><div class="info" data-tauri-drag-region><div class="fase">${a ? `agora · até ${a.fim}` : 'livre agora'}</div>
      <div class="l grande">${a ? esc(a.titulo) : '—'}</div></div>${botoes('')}</div>
      ${linhaBloco('depois', E.prox)}`;
  }
}

document.addEventListener('click', e => {
  const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
  if (a === 'abrir') invoke('mostrar_principal');
  else if (a === 'fechar') invoke('widget', { mostrar: false });
  else emit('mini-acao', a);
});
listen('mini', e => { E = e.payload; render() });
emit('mini-acao', 'pedir');
render();
setInterval(() => { if (E?.timer && !E.timer.pausado) render() }, 1000);
