'use strict';
/* ritmo — lógica da janela principal.
   Config (rotina, horários) vem de config.json; estado (tarefas, hábitos, sessões) de estado.json.
   No app, os dois ficam em %APPDATA%\ritmo. Aberto num navegador comum, usa localStorage. */

const TAURI = window.__TAURI__;

/* ---------------- ponte com o Rust ---------------- */
const ponte = {
  async ler(nome) {
    if (TAURI) return TAURI.core.invoke('ler_arquivo', { nome });
    try { return localStorage.getItem('ritmo.' + nome) } catch { return null }
  },
  async salvar(nome, conteudo) {
    if (TAURI) return TAURI.core.invoke('salvar_arquivo', { nome, conteudo });
    try { localStorage.setItem('ritmo.' + nome, conteudo) } catch { }
  },
  agendar(chave, quandoMs, titulo, corpo) { if (TAURI) TAURI.core.invoke('agendar', { chave, quandoMs: Math.round(quandoMs), titulo, corpo }) },
  cancelar(chave) { if (TAURI) TAURI.core.invoke('cancelar', { chave }) },
  autostart(ligar) { return TAURI ? TAURI.core.invoke('autostart', ligar === undefined ? {} : { ligar }) : Promise.resolve(false) },
  widget(mostrar) { return TAURI ? TAURI.core.invoke('widget', mostrar === undefined ? {} : { mostrar }) : Promise.resolve(false) },
  abrirPasta() { if (TAURI) TAURI.core.invoke('abrir_pasta') },
  emitir(ev, dados) { if (TAURI) TAURI.event.emit(ev, dados) },
  ouvir(ev, fn) { if (TAURI) TAURI.event.listen(ev, e => fn(e.payload)) },
};

/* ---------------- utilidades ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const chaveDe = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dataDe = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) };
const somaDias = (k, n) => { const d = dataDe(k); d.setDate(d.getDate() + n); return chaveDe(d) };
const hoje = () => chaveDe(new Date());
const minDe = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m };
const agoraMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() };
const tsDe = (k, hhmm) => { const d = dataDe(k); d.setMinutes(minDe(hhmm)); return d.getTime() };
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}` };
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const uid = () => Math.random().toString(36).slice(2, 10);
const dataLonga = k => dataDe(k).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('ativo'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('ativo'), 2200) }

/* ---------------- config ---------------- */
let CONFIG;
const cor = ctx => CONFIG.contextos[ctx]?.cor || '#9ca3af';
const nomeCtx = ctx => CONFIG.contextos[ctx]?.nome || ctx;

function validarConfig(c) {
  const erros = [];
  if (!c.contextos || !c.rotinas || !c.semana) throw new Error('faltam "contextos", "rotinas" ou "semana"');
  for (let d = 0; d < 7; d++) {
    const L = c.semana[d];
    if (!Array.isArray(L)) { erros.push(`semana.${d} não é uma lista`); continue }
    L.forEach((x, i) => {
      if (!/^\d\d:\d\d$/.test(x.ini) || !/^\d\d:\d\d$/.test(x.fim)) erros.push(`semana.${d}[${i}]: horário inválido`);
      if (!c.contextos[x.ctx]) erros.push(`semana.${d}[${i}]: contexto "${x.ctx}" não existe`);
      if (x.rotina && !c.rotinas[x.rotina]) erros.push(`semana.${d}[${i}]: rotina "${x.rotina}" não existe`);
    });
  }
  (c.habitos || []).forEach(h => { if (!c.rotinas[h]) erros.push(`hábito "${h}" não é uma rotina`) });
  (c.eventos || []).forEach((x, i) => {
    if (!/^\d{4}-\d\d-\d\d$/.test(x.data)) erros.push(`eventos[${i}]: data inválida (use AAAA-MM-DD)`);
    if (!/^\d\d:\d\d$/.test(x.ini) || !/^\d\d:\d\d$/.test(x.fim)) erros.push(`eventos[${i}]: horário inválido`);
    if (!c.contextos[x.ctx]) erros.push(`eventos[${i}]: contexto "${x.ctx}" não existe`);
    if (x.rotina && !c.rotinas[x.rotina]) erros.push(`eventos[${i}]: rotina "${x.rotina}" não existe`);
  });
  if (erros.length) throw new Error(erros.slice(0, 4).join('; '));
  c.presets ??= { '25/5': [25, 5, 15], '50/10': [50, 10, 20] };
  c.habitos ??= [];
  c.checklistNoite ??= [];
  c.eventos ??= [];
  return c;
}
const exemplo = async () => (await fetch('config.exemplo.json')).text();

async function carregarConfig() {
  let txt = await ponte.ler('config.json');
  if (!txt) { txt = await exemplo(); await ponte.salvar('config.json', txt) }
  try { CONFIG = validarConfig(JSON.parse(txt)); $('#aviso').innerHTML = '' }
  catch (e) {
    CONFIG = validarConfig(JSON.parse(await exemplo()));
    $('#aviso').innerHTML = `<div class="aviso"><b>Seu config.json tem um erro</b>, usando o exemplo por enquanto: ${esc(e.message)}</div>`;
  }
}

/* ---------------- estado ---------------- */
let S;
const PADRAO = () => ({ dias: {}, tarefas: [], sessoes: [], inbox: [], youtube: [], timer: null, ultimo: {}, volume: 0.4, lembretes: true, ciclosGpu: [] });
async function carregarEstado() {
  let e = null;
  try { e = JSON.parse(await ponte.ler('estado.json') || 'null') } catch { }
  S = Object.assign(PADRAO(), e || {});
}
function salvar() { ponte.salvar('estado.json', JSON.stringify(S)).catch(err => toast('Erro ao salvar: ' + err)) }
function dia(k) { return S.dias[k] ??= { habitos: {}, campos: {}, lazer: {}, checklist: {}, fechado: false } }
// Blocos da semana-tipo mais os eventos com data daquele dia, em ordem de horário.
function blocosDe(k) {
  const ev = CONFIG.eventos.filter(e => e.data === k);
  const L = CONFIG.semana[dataDe(k).getDay()];
  return ev.length ? [...L, ...ev].sort((a, b) => minDe(a.ini) - minDe(b.ini)) : L;
}
function blocoAtual() {
  const L = blocosDe(hoje()), n = agoraMin();
  return { atual: L.find(x => minDe(x.ini) <= n && n < minDe(x.fim)), prox: L.find(x => minDe(x.ini) > n) };
}
// O que não foi feito passa para hoje e conta quantas vezes foi adiado.
function migrar() {
  const h = hoje(); let mudou = false;
  for (const t of S.tarefas) if (!t.feito && !t.descartada && t.dia < h) { t.dia = h; t.migracoes = (t.migracoes || 0) + 1; mudou = true }
  if (mudou) salvar();
}
const novaTarefa = (texto, ctx, diaK, top = false) => ({ id: uid(), texto, ctx, dia: diaK, feito: false, top, migracoes: 0 });

/* ---------------- navegação ---------------- */
let aba = 'hoje', diaVista;
document.querySelectorAll('[data-aba]').forEach(bt => bt.onclick = () => irPara(bt.dataset.aba));
function irPara(a) {
  aba = a;
  document.querySelectorAll('[data-aba]').forEach(x => x.classList.toggle('ativo', x.dataset.aba === a));
  document.querySelectorAll('.pagina').forEach(x => x.classList.toggle('ativo', x.id === a));
  render();
}
function render() { ({ hoje: renderHoje, foco: renderFoco, semana: renderSemana, fechamento: renderFechamento, sistema: renderSistema, ajustes: renderAjustes })[aba](); enviarMini() }
const opcoesCtx = sel => Object.entries(CONFIG.contextos).map(([k, c]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');
const pilulaCtx = ctx => `<span class="pilula"><span class="ponto" style="background:${cor(ctx)}"></span>${esc(nomeCtx(ctx))}</span>`;

/* ================= HOJE ================= */
function saudacao() { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite' }
function renderHoje() {
  const k = diaVista, ehHoje = k === hoje(), D = dia(k), n = agoraMin();
  let hero = '';
  if (ehHoje) {
    const { atual, prox } = blocoAtual(), T = S.timer;
    if (T && T.fase !== 'registro') {
      hero = `<div class="agora"><div class="rotulo">${T.fase === 'foco' ? 'em foco' : 'pausa'}${T.pausado ? ' · pausado' : ''}</div>
        <h3><span data-vivo="timer">${mmss(restante())}</span> · ${esc(T.fase === 'foco' ? T.tarefa : 'levante, água, olhe longe')}</h3>
        <div class="linha"><button class="btn peq" data-act="irFoco">Abrir foco</button></div></div>`;
    } else if (atual) {
      const ini = minDe(atual.ini), fim = minDe(atual.fim), pct = Math.round((n - ini) / (fim - ini) * 100);
      hero = `<div class="agora"><div class="rotulo">agora</div><h3>${esc(atual.titulo)}</h3>
        <div class="linha">${pilulaCtx(atual.ctx)}<span class="muted peq">${atual.ini}–${atual.fim} · faltam ${fim - n} min</span>
          ${atual.foco ? `<button class="btn peq pri" data-act="focarCtx" data-ctx="${atual.ctx}">Começar foco</button>` : ''}
          ${atual.rotina ? `<button class="btn peq pri" data-act="abrirRotina" data-r="${atual.rotina}">Abrir roteiro</button>` : ''}</div>
        <div class="prog"><div style="width:${pct}%"></div></div>
        <div class="depois">${prox ? `Depois: <b>${prox.ini}</b> ${esc(prox.titulo)}` : 'Último bloco do dia.'}</div>
        ${atual.lazer && gpuOcupada() ? `<div class="aviso" style="margin:12px 0 0">${esc(textoGpuOcupada())}: jogar agora disputa a GPU com ele. Dá para mandar o próximo treino para a máquina Linux.</div>` : ''}</div>`;
    } else if (prox) {
      hero = `<div class="agora"><div class="rotulo">livre agora</div><h3>Próximo: ${esc(prox.titulo)}</h3><div class="depois">às ${prox.ini}</div></div>`;
    }
  }

  const blocos = blocosDe(k).map((x, i) => {
    const passado = ehHoje && minDe(x.fim) <= n, agora = ehHoje && minDe(x.ini) <= n && n < minDe(x.fim);
    let acoes = '';
    if (x.rotina) {
      const st = D.habitos[x.rotina];
      acoes = `<button class="btn peq fantasma" data-act="abrirRotina" data-r="${x.rotina}">Abrir</button>
        <span class="marca-hab"><button class="${st === 'completo' ? 'on-completo' : ''}" data-act="habito" data-r="${x.rotina}" data-v="completo" title="Feito">✓</button><button class="${st === 'minimo' ? 'on-minimo' : ''}" data-act="habito" data-r="${x.rotina}" data-v="minimo" title="Mínimo: ${esc(CONFIG.rotinas[x.rotina].minimo || '')}">½</button></span>`;
    } else if (x.foco) acoes = `<button class="btn peq fantasma" data-act="focarCtx" data-ctx="${x.ctx}">Focar</button>`;
    else if (x.lazer) acoes = `<button class="btn peq ${D.lazer[i] ? '' : 'fantasma'}" data-act="lazer" data-i="${i}">${D.lazer[i] ? 'aconteceu ✓' : 'aconteceu?'}</button>`;
    return `<div class="bloco ${passado ? 'passado' : ''} ${agora ? 'agora-b' : ''}">
      <span class="hora">${x.ini} – ${x.fim}</span>
      <span class="trilho"><span class="ponto" style="background:${cor(x.ctx)}"></span></span>
      <div class="corpo"><span class="tit" title="${esc(x.titulo)}">${esc(x.titulo)}</span><span class="acoes-bloco">${acoes}</span></div></div>`;
  }).join('');

  const tarefas = S.tarefas.filter(t => t.dia === k && !t.descartada).sort((a, b) => (a.feito - b.feito) || (b.top - a.top));
  const nTop = tarefas.filter(t => t.top && !t.feito).length;
  const lista = tarefas.map(t => {
    const decidir = t.migracoes >= 3 && !t.feito;
    return `<div class="tarefa ${t.feito ? 'feito' : ''}">
      <button class="caixa ${t.feito ? 'on' : ''}" data-act="feito" data-id="${t.id}" aria-label="feito"></button>
      <button class="estrela ${t.top ? 'on' : ''}" data-act="top" data-id="${t.id}" title="Prioridade do dia">★</button>
      <div class="txt">${esc(t.texto)} <span class="ponto" style="background:${cor(t.ctx)};width:7px;height:7px;margin-left:2px"></span>
        ${decidir ? `<div><span class="adiada">Adiada ${t.migracoes}×. Decida:</span><div class="decidir">
          <button class="btn peq" data-act="focarTarefa" data-id="${t.id}">Focar agora</button><button class="btn peq" data-act="quebrar" data-id="${t.id}">Quebrar</button><button class="btn peq" data-act="descartar" data-id="${t.id}">Descartar</button></div></div>`
        : t.migracoes ? `<span class="muted peq">· adiada ${t.migracoes}×</span>` : ''}</div>
      ${decidir || t.feito ? '' : `<button class="btn peq fantasma" data-act="focarTarefa" data-id="${t.id}" title="Focar nesta tarefa">▶</button>`}
    </div>`;
  }).join('') || '<div class="vazio">Nada por aqui. O que faz o dia valer?</div>';

  $('#hoje').innerHTML = `
    <div class="cabeca"><div><h1>${ehHoje ? saudacao() : DIAS[dataDe(k).getDay()][0].toUpperCase() + DIAS[dataDe(k).getDay()].slice(1)}</h1>
      <p>${DIAS[dataDe(k).getDay()]}, ${dataLonga(k)}</p></div>
      <div class="acoes"><button class="btn" data-act="diaAnt">‹</button>${ehHoje ? '' : '<button class="btn" data-act="diaHoje">Hoje</button>'}<button class="btn" data-act="diaProx">›</button></div></div>
    <div class="grade">
      <div>${hero}<div class="cartao"><h2>Agenda</h2><div class="tempo">${blocos}</div></div></div>
      <div><div class="cartao"><h2>Tarefas <span class="extra muted">${nTop}/3 ★</span></h2>${lista}
          <form id="novaTarefa" class="linha" style="margin-top:14px;flex-wrap:nowrap">
            <input id="ntTexto" placeholder="Nova tarefa…"><select id="ntCtx" style="width:130px">${opcoesCtx(S.ultimo.ctx)}</select>
            <button class="btn pri">+</button></form></div>
        ${S.inbox.length ? `<div class="cartao"><h2>Anotado durante o foco</h2><div class="peq muted">${S.inbox.length} item(ns) esperando triagem em <a href="#" data-act="irFechamento">Fechar o dia</a>.</div></div>` : ''}
      </div></div>`;
  $('#novaTarefa').onsubmit = e => {
    e.preventDefault(); const tx = $('#ntTexto').value.trim(); if (!tx) return;
    S.tarefas.push(novaTarefa(tx, $('#ntCtx').value, k)); S.ultimo.ctx = $('#ntCtx').value;
    salvar(); renderHoje(); $('#ntTexto').focus();
  };
}

/* ================= FOCO ================= */
let AC = null, ruido = null;
function audio() { AC ??= new AudioContext(); if (AC.state === 'suspended') AC.resume(); return AC }
function tom(f, t0, dur) {
  const ac = audio(), o = ac.createOscillator(), g = ac.createGain();
  o.type = 'sine'; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + 0.05);
}
function sino(tipo) {
  try {
    const t = audio().currentTime;
    if (tipo === 'inicio') { tom(660, t, 0.6); tom(880, t + 0.18, 0.9) }
    else { tom(880, t, 0.6); tom(660, t + 0.22, 0.6); tom(523, t + 0.44, 1.3) }
  } catch (e) { console.warn(e) }
}
function iniciarRuido(tipo) {
  pararRuido();
  const ac = audio(), len = ac.sampleRate * 6, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; if (tipo === 'marrom') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5 } else d[i] = w * 0.5 }
  const diff = d[len - 1] - d[0]; for (let i = 0; i < len; i++) d[i] -= diff * i / (len - 1); // emenda sem estalo
  const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
  let no = src;
  if (tipo === 'chuva') {
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
    src.connect(hp); hp.connect(lp); no = lp;
  }
  const g = ac.createGain(); g.gain.value = S.volume; no.connect(g).connect(ac.destination); src.start();
  ruido = { src, g };
}
function pararRuido() { if (ruido) { try { ruido.src.stop() } catch { } ruido = null } }
function idYoutube(s) { s = String(s).trim(); const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/); return m ? m[1] : (/^[\w-]{11}$/.test(s) ? s : null) }
function iniciarSom(som) {
  pararSom();
  if (som === 'marrom' || som === 'chuva') iniciarRuido(som);
  if (som === 'youtube' && S.youtube.length) {
    const id = S.youtube[Math.floor(Math.random() * S.youtube.length)];
    $('#yt').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&loop=1&playlist=${id}&rel=0" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    $('#yt').classList.add('ativo');
  }
}
function pararSom() { pararRuido(); $('#yt').innerHTML = ''; $('#yt').classList.remove('ativo') }

function restante() { const T = S.timer; return !T ? 0 : T.pausado ? T.restante : T.fimTs - Date.now() }
function agendarTimer() {
  const T = S.timer;
  if (T && !T.pausado && (T.fase === 'foco' || T.fase === 'pausa'))
    ponte.agendar('timer', T.fimTs, T.fase === 'foco' ? 'Bloco de foco concluído' : 'Pausa acabou',
      T.fase === 'foco' ? `Registre o que saiu de: ${T.tarefa}` : 'Hora de voltar.');
  else ponte.cancelar('timer');
}
function iniciarFoco(dados) {
  const ms = CONFIG.presets[dados.preset][0] * 60000;
  S.timer = { ...dados, fase: 'foco', iniTs: Date.now(), fimTs: Date.now() + ms, duracaoMs: ms, pausado: false, ciclo: S.timer?.ciclo || 0 };
  S.ultimo = { ...S.ultimo, ...dados }; salvar();
  sino('inicio'); iniciarSom(dados.som); agendarTimer(); render();
}
function iniciarPausa() {
  const T = S.timer, [, curta, longa] = CONFIG.presets[T.preset];
  T.ciclo = (T.ciclo || 0) + 1;
  const ms = (T.ciclo % 4 === 0 ? longa : curta) * 60000;
  Object.assign(T, { fase: 'pausa', fimTs: Date.now() + ms, duracaoMs: ms, pausado: false });
  salvar(); agendarTimer(); render();
}
function registrarSessao(resultado, minutos) {
  const T = S.timer;
  S.sessoes.push({ dia: chaveDe(new Date(T.iniTs)), ini: T.iniTs, minutos, ctx: T.ctx, tarefa: T.tarefa, passo: T.passo, resultado });
}
function pausarRetomar() {
  const T = S.timer; if (!T || T.fase === 'registro') return;
  if (T.pausado) { T.fimTs = Date.now() + T.restante; T.pausado = false; if (T.fase === 'foco') iniciarSom(T.som) }
  else { T.restante = T.fimTs - Date.now(); T.pausado = true; pararSom() }
  salvar(); agendarTimer(); render();
}
function encerrar() {
  const T = S.timer; if (!T) return;
  if (T.fase === 'foco') {
    const min = Math.round((T.duracaoMs - restante()) / 60000);
    if (min >= 5 && confirm(`Registrar ${min} min deste bloco?`)) registrarSessao('(encerrado antes do fim)', min);
  }
  S.timer = null; pararSom(); salvar(); agendarTimer(); render();
}
function verificarTimer() {
  const T = S.timer; if (!T || T.pausado || T.fase === 'registro') return;
  if (Date.now() < T.fimTs) return;
  sino('fim');
  if (T.fase === 'foco') { T.fase = 'registro'; pararSom(); salvar(); irPara('foco') }
  else { S.timer = null; salvar(); render() }
}

const CIRC = 2 * Math.PI * 140;
let formFoco = null; // escolhas do formulário antes de começar
function renderFoco() {
  const T = S.timer, U = S.ultimo || {};
  formFoco ??= { preset: U.preset || '25/5', som: U.som || 'marrom' };
  const tarefasHoje = S.tarefas.filter(t => t.dia === hoje() && !t.feito && !t.descartada);
  const sess = S.sessoes.filter(s => s.dia === hoje());
  const minHoje = sess.reduce((a, s) => a + s.minutos, 0);
  let palco;
  if (!T) {
    const seg = (nome, ops, sel) => `<div class="segmentos" data-seg="${nome}">${ops.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === sel ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    palco = `<div class="cartao"><h2>Novo bloco</h2>
      <form id="formFoco">
        <label class="rot">Tarefa (uma só)</label>
        <input id="fTarefa" list="dlTarefas" value="${esc(U.tarefa || '')}" placeholder="Ex.: escrever a seção de resultados">
        <datalist id="dlTarefas">${tarefasHoje.map(t => `<option value="${esc(t.texto)}">`).join('')}</datalist>
        <label class="rot">Primeiro passo concreto, o que você faz no minuto 1</label>
        <input id="fPasso" placeholder="Ex.: abrir o arquivo e listar os 3 números da tabela">
        <div class="linha" style="gap:18px;margin-top:4px;align-items:flex-end">
          <div><label class="rot">Contexto</label><select id="fCtx" style="width:150px">${opcoesCtx(U.ctx)}</select></div>
          <div><label class="rot">Duração</label>${seg('preset', Object.keys(CONFIG.presets).map(p => [p, p]), formFoco.preset)}</div>
          <div><label class="rot">Som</label>${seg('som', [['nenhum', 'Sino'], ['marrom', 'Ruído'], ['chuva', 'Chuva'], ['youtube', 'YouTube']], formFoco.som)}</div>
        </div>
        <label class="rot">Volume do ruído</label><input type="range" id="fVol" min="0" max="1" step="0.05" value="${S.volume}" style="max-width:240px">
        ${formFoco.som === 'youtube' && !S.youtube.length ? '<p class="peq" style="color:var(--alerta)">Sua lista do YouTube está vazia. Adicione vídeos em Ajustes.</p>' : ''}
        <div class="linha" style="margin-top:18px"><button class="btn pri" id="fIniciar" disabled>Começar</button>
          <span class="peq muted">Só começa com tarefa e primeiro passo escritos.</span></div>
      </form></div>`;
  } else if (T.fase === 'registro') {
    palco = `<div class="cartao"><div class="foco-palco">
      <div class="anel"><svg viewBox="0 0 300 300"><circle class="fundo" cx="150" cy="150" r="140"/><circle class="frente" cx="150" cy="150" r="140" stroke-dasharray="${CIRC}" stroke-dashoffset="0"/></svg>
        <div class="centro"><div class="tempo-g">✓</div><div class="fase">bloco concluído</div></div></div>
      <div class="intencao"><b>${esc(T.tarefa)}</b></div>
      <form id="formReg" class="linha" style="width:100%;max-width:520px;flex-wrap:nowrap"><input id="rTexto" placeholder="O que saiu deste bloco? (uma linha)" autofocus><button class="btn pri">Registrar e pausar</button></form>
    </div></div>`;
  } else {
    palco = `<div class="cartao"><div class="foco-palco">
      <div class="anel ${T.fase}"><svg viewBox="0 0 300 300"><circle class="fundo" cx="150" cy="150" r="140"/><circle class="frente" data-vivo="anel" cx="150" cy="150" r="140" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - restante() / T.duracaoMs)}"/></svg>
        <div class="centro"><div class="tempo-g" data-vivo="timer">${mmss(restante())}</div><div class="fase">${T.fase === 'foco' ? 'foco' : 'pausa'}${T.pausado ? ' · pausado' : ''}</div></div></div>
      ${T.fase === 'foco' ? `<div class="intencao"><b>${esc(T.tarefa)}</b><span>1º passo: ${esc(T.passo)}</span></div>` : '<div class="intencao"><span>Levante, beba água, olhe para longe.</span></div>'}
      <div class="linha">${T.fase === 'foco' ? `<button class="btn" data-act="pausar">${T.pausado ? 'Retomar' : 'Pausar'}</button>` : ''}
        <button class="btn" data-act="encerrar">${T.fase === 'foco' ? 'Encerrar' : 'Pular pausa'}</button></div>
      ${T.fase === 'foco' ? `<form id="formDistr" style="width:100%;max-width:520px;margin-top:22px"><input id="dTexto" placeholder="Lembrou de algo? Anote aqui e volte (Enter)"></form>` : ''}
    </div></div>`;
  }
  $('#foco').innerHTML = `<div class="cabeca"><div><h1>Foco</h1><p>Uma tarefa, um primeiro passo, um bloco.</p></div></div>
    <div class="grade"><div>${palco}</div><div>
      <div class="cartao"><h2>Hoje <span class="extra muted">${Math.floor(minHoje / 60)}h${pad(minHoje % 60)}</span></h2>
        ${sess.slice().reverse().map(s => `<div class="tarefa"><span class="ponto" style="background:${cor(s.ctx)}"></span>
          <div class="txt"><b>${esc(s.tarefa)}</b><div class="peq muted">${s.minutos} min · ${esc(s.resultado)}</div></div></div>`).join('') || '<div class="vazio">Nenhum bloco ainda.</div>'}
      </div></div></div>`;

  const f = $('#formFoco');
  if (f) {
    const ok = () => $('#fIniciar').disabled = !($('#fTarefa').value.trim() && $('#fPasso').value.trim());
    $('#fTarefa').oninput = ok; $('#fPasso').oninput = ok; ok();
    f.querySelectorAll('[data-seg]').forEach(g => g.onclick = e => {
      const v = e.target.closest('button')?.dataset.v; if (!v) return;
      const tarefa = $('#fTarefa').value, passo = $('#fPasso').value;
      formFoco[g.dataset.seg] = v; renderFoco(); $('#fTarefa').value = tarefa; $('#fPasso').value = passo; $('#fTarefa').dispatchEvent(new Event('input'));
    });
    $('#fVol').oninput = e => { S.volume = +e.target.value; if (ruido) ruido.g.gain.value = S.volume; salvar() };
    f.onsubmit = e => {
      e.preventDefault();
      iniciarFoco({ ctx: $('#fCtx').value, tarefa: $('#fTarefa').value.trim(), passo: $('#fPasso').value.trim(), preset: formFoco.preset, som: formFoco.som });
    };
  }
  const r = $('#formReg');
  if (r) r.onsubmit = e => { e.preventDefault(); registrarSessao($('#rTexto').value.trim() || '—', Math.round(S.timer.duracaoMs / 60000)); iniciarPausa() };
  const dz = $('#formDistr');
  if (dz) dz.onsubmit = e => { e.preventDefault(); const v = $('#dTexto').value.trim(); if (v) { S.inbox.push({ texto: v, ts: Date.now() }); salvar(); $('#dTexto').value = ''; toast('Anotado. De volta ao foco.') } };
}

/* ================= SEMANA ================= */
const inicioDaSemana = k => somaDias(k, -((dataDe(k).getDay() + 6) % 7));
function renderSemana() {
  const h = hoje(), seg = inicioDaSemana(h), dias7 = [...Array(7)].map((_, i) => somaDias(seg, i));
  const linhas = CONFIG.habitos.map(r => {
    let pts = 0;
    const cels = dias7.map(k => {
      const st = S.dias[k]?.habitos[r]; if (st) pts++;
      return `<td><span class="cel ${st || (k > h ? 'futuro' : '')} ${k === h ? 'hoje' : ''}" title="${st || ''}"></span></td>`;
    }).join('');
    return `<tr><td>${esc(CONFIG.rotinas[r].nome)}</td>${cels}<td class="muted"><b style="color:var(--ink)">${pts}</b>/7</td></tr>`;
  }).join('');
  const horas = {};
  for (const s of S.sessoes) if (s.dia >= seg && s.dia <= dias7[6]) horas[s.ctx] = (horas[s.ctx] || 0) + s.minutos / 60;
  let lazerFeito = 0, lazerPlan = 0;
  dias7.forEach(k => blocosDe(k).forEach((x, i) => { if (x.lazer) { lazerPlan++; if (S.dias[k]?.lazer[i]) lazerFeito++ } }));
  const medida = (ctx, rotulo, v, meta, fmt) => `<div class="medida"><div class="topo"><span class="ponto" style="background:${cor(ctx)}"></span>${rotulo}<b>${fmt}</b></div>
    <div class="barra"><div style="width:${meta ? Math.min(100, v / meta * 100) : 0}%;background:${cor(ctx)}"></div></div></div>`;
  const metas = Object.entries(CONFIG.contextos).filter(([, c]) => c.metaHoras)
    .map(([k, c]) => medida(k, `${esc(c.nome)}, foco registrado`, horas[k] || 0, c.metaHoras, `${(horas[k] || 0).toFixed(1)} / ${c.metaHoras} h`)).join('');
  const outros = Object.entries(horas).filter(([k]) => !CONFIG.contextos[k]?.metaHoras)
    .map(([k, v]) => `<div class="linha peq muted" style="margin-bottom:4px"><span class="ponto" style="background:${cor(k)}"></span>${esc(nomeCtx(k))}: ${v.toFixed(1)} h de foco</div>`).join('');
  const ctxLazer = Object.keys(CONFIG.contextos).find(k => CONFIG.contextos[k].metaBlocos);
  const metaL = ctxLazer ? CONFIG.contextos[ctxLazer].metaBlocos : 0;
  $('#semana').innerHTML = `<div class="cabeca"><div><h1>Semana</h1><p>${dataLonga(seg)} a ${dataLonga(dias7[6])}</p></div></div>
    <div class="grade"><div class="cartao"><h2>Hábitos</h2>
      <table class="habitos"><tr><th></th>${dias7.map(k => `<th>${DIAS[dataDe(k).getDay()].slice(0, 3)}</th>`).join('')}<th></th></tr>${linhas}</table>
      <p class="peq muted" style="margin-bottom:0">Meio círculo é o mínimo, e conta. A soma é x de 7, não sequência: um dia ruim não zera nada.</p></div>
    <div><div class="cartao"><h2>Equilíbrio</h2>${metas}
      ${ctxLazer ? medida(ctxLazer, 'Lazer que aconteceu', lazerFeito, metaL, `${lazerFeito} / ${metaL}`) + `<p class="peq muted" style="margin-top:-6px">De ${lazerPlan} blocos planejados. Lazer abaixo da meta também é alerta.</p>` : ''}
      ${outros}${gpuSemana(seg, somaDias(dias7[6], 1))}</div></div></div>`;
}

/* ================= FECHAR O DIA ================= */
function renderFechamento() {
  const k = hoje(), D = dia(k), amanha = somaDias(k, 1);
  const pend = S.tarefas.filter(t => t.dia === k && !t.feito && !t.descartada);
  const topAm = S.tarefas.filter(t => t.dia === amanha && t.top && !t.descartada);
  const rotExame = CONFIG.fechamento?.rotina;
  const st = rotExame && D.habitos[rotExame];
  $('#fechamento').innerHTML = `<div class="cabeca"><div><h1>Fechar o dia</h1><p>Cinco minutos para dormir sem pendência na cabeça.</p></div>
      ${D.fechado ? '<div class="acoes"><span class="pilula" style="color:var(--ok)">dia fechado ✓</span></div>' : ''}</div>
    <div class="grade"><div>
      ${CONFIG.checklistNoite.length ? `<div class="cartao"><h2>Checklist da noite</h2>${CONFIG.checklistNoite.map((c, i) => `<div class="tarefa"><button class="caixa ${D.checklist[i] ? 'on' : ''}" data-act="check" data-i="${i}"></button><div class="txt">${esc(c)}</div></div>`).join('')}</div>` : ''}
      ${rotExame ? `<div class="cartao"><h2>${esc(CONFIG.rotinas[rotExame].nome)} ${st ? `<span class="extra" style="color:${st === 'completo' ? 'var(--ok)' : 'var(--meio)'}">${st === 'completo' ? 'feito' : 'mínimo'}</span>` : ''}</h2>
        <div class="linha"><button class="btn pri" data-act="abrirRotina" data-r="${rotExame}">Começar</button><button class="btn" data-act="habito" data-r="${rotExame}" data-v="minimo">Só o mínimo hoje</button></div>
        <p class="peq muted" style="margin-bottom:0">As respostas ficam só neste computador.</p></div>` : ''}
      <div class="cartao"><h2>Três prioridades de amanhã</h2>
        <form id="formTop">${[0, 1, 2].map(i => `<input id="top${i}" style="margin-bottom:8px" value="${esc(topAm[i]?.texto || '')}" placeholder="Prioridade ${i + 1}">`).join('')}
        <button class="btn pri" style="margin-top:6px">Fechar o dia</button></form></div>
    </div><div>
      <div class="cartao"><h2>Pendências de hoje <span class="extra muted">${pend.length}</span></h2>
        ${pend.map(t => `<div class="tarefa"><span class="ponto" style="background:${cor(t.ctx)}"></span><div class="txt">${esc(t.texto)}${t.migracoes ? ` <span class="peq muted">· adiada ${t.migracoes}×</span>` : ''}</div><button class="btn peq fantasma" data-act="descartar" data-id="${t.id}">descartar</button></div>`).join('') || '<div class="vazio">Nada pendente.</div>'}
        ${pend.length ? '<p class="peq muted" style="margin-bottom:0">O que você não descartar passa sozinho para amanhã.</p>' : ''}</div>
      <div class="cartao"><h2>Anotado durante o foco <span class="extra muted">${S.inbox.length}</span></h2>
        ${S.inbox.map((x, i) => `<div class="tarefa"><div class="txt">${esc(x.texto)}</div><button class="btn peq" data-act="inboxTarefa" data-i="${i}">→ amanhã</button><button class="btn peq fantasma" data-act="inboxDel" data-i="${i}">apagar</button></div>`).join('') || '<div class="vazio">Vazio.</div>'}</div>
    </div></div>`;
  $('#formTop').onsubmit = e => {
    e.preventDefault();
    topAm.forEach(t => t.top = false);
    [0, 1, 2].map(i => $('#top' + i).value.trim()).forEach(tx => {
      if (!tx) return;
      const ex = S.tarefas.find(t => t.dia === amanha && t.texto === tx && !t.descartada);
      if (ex) ex.top = true; else S.tarefas.push(novaTarefa(tx, S.ultimo.ctx || Object.keys(CONFIG.contextos)[0], amanha, true));
    });
    D.fechado = true; if (rotExame) D.habitos[rotExame] ??= 'minimo';
    salvar(); renderFechamento(); toast('Dia fechado. Bom descanso.');
  };
}

/* ================= SISTEMA ================= */
// Amostras chegam do Rust a cada 2 s pelo evento "sistema". Guardamos os últimos 10 min.
const SIS = { ultima: null, emUsoLongo: false, hist: [] };
const GB = b => (b / 1024 ** 3).toFixed(1).replace('.', ',');
const fmt1 = v => v.toFixed(1).replace('.', ',');
function gpuOcupada() { const g = SIS.ultima?.gpus[0]; return !!g && (SIS.emUsoLongo || g.uso >= 50) }
function textoGpuOcupada() {
  const g = SIS.ultima.gpus[0], quem = g.processos.map(p => p.nome).join(', ');
  return `GPU em ${g.uso}%${quem ? ` (${quem})` : ''}`;
}
function gpuSemana(ini, fimExcl) {
  const a = dataDe(ini).getTime(), b = dataDe(fimExcl).getTime();
  const ms = S.ciclosGpu.reduce((t, c) => t + Math.max(0, Math.min(c.fimMs, b) - Math.max(c.inicioMs, a)), 0);
  if (!ms && !SIS.ultima?.gpus.length) return '';
  return `<div class="linha peq muted" style="margin-top:10px">GPU ocupada no PC (treinos longos já encerrados): <b style="color:var(--ink)">${fmt1(ms / 3.6e6)} h</b></div>`;
}
const dur = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)}` : `${m} min` };

let hoverSpark = {}; // índice sob o mouse, por gráfico, para sobreviver às re-renderizações
function spark(id, valores, max, rotulo, fmtV) {
  const W = 600, H = 64, n = valores.length;
  if (n < 2) return `<div class="spark-caixa"><div class="r">${rotulo}</div><div class="vazio">Juntando amostras…</div></div>`;
  const x = i => i / (n - 1) * W, y = v => H - 4 - (v / max) * (H - 8);
  const pts = valores.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const h = hoverSpark[id];
  const marca = h != null && h < n ? `<line class="cruz" x1="${x(h)}" x2="${x(h)}" y1="0" y2="${H}"/><circle class="marcador" cx="${x(h)}" cy="${y(valores[h])}" r="4"/>` : '';
  const dica = h != null && h < n ? `<div class="dica" style="left:${x(h) / W * 100}%">${fmtV(valores[h])} · há ${fmt1((n - 1 - h) * 2 / 60)} min</div>` : '';
  return `<div class="spark-caixa"><div class="r">${rotulo}<b>${fmtV(valores[n - 1])}</b></div>
    <svg class="spark" data-spark="${id}" data-n="${n}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line class="base" x1="0" x2="${W}" y1="${H - 4}" y2="${H - 4}"/>
      <polygon class="area" points="0,${H - 4} ${pts} ${W},${H - 4}"/><polyline class="linha-s" points="${pts}" vector-effect="non-scaling-stroke"/>${marca}
    </svg>${dica}</div>`;
}
document.addEventListener('mousemove', e => {
  const s = e.target.closest?.('[data-spark]');
  const ativo = Object.keys(hoverSpark)[0];
  if (!s) { if (ativo) { hoverSpark = {}; if (aba === 'sistema') renderSistema() } return }
  const r = s.getBoundingClientRect(), n = +s.dataset.n;
  const i = Math.round((e.clientX - r.left) / r.width * (n - 1));
  if (hoverSpark[s.dataset.spark] !== i) { hoverSpark = { [s.dataset.spark]: i }; renderSistema() }
});

function renderSistema() {
  const A = SIS.ultima;
  if (!A) {
    $('#sistema').innerHTML = `<div class="cabeca"><div><h1>Sistema</h1><p>${TAURI ? 'Esperando a primeira leitura…' : 'O monitor funciona no app instalado.'}</p></div></div>`;
    return;
  }
  const tile = (r, v, extra = '', pct, alertaEm = 101) => `<div class="tile"><div class="r">${r}</div><div class="v">${v}${extra ? ` <small>${extra}</small>` : ''}</div>${pct != null ? `<div class="barra"><div style="width:${Math.min(100, pct)}%;background:${pct >= alertaEm ? 'var(--alerta)' : 'var(--acento)'}"></div></div>` : ''}</div>`;
  const gpus = A.gpus.map((g, gi) => {
    const hv = SIS.hist.map(h => h.gpus[gi]).filter(Boolean);
    return `<div class="cartao"><h2>${esc(g.nome)}<span class="estado-gpu ${gi === 0 && SIS.emUsoLongo ? 'ativo' : ''}">${gi === 0 && SIS.emUsoLongo ? '● em uso longo, aviso quando parar' : ''}</span></h2>
      <div class="tiles">
        ${tile('Uso', `${g.uso}%`, `memória ${g.usoMemoria}%`, g.uso)}
        ${tile('VRAM', `${GB(g.vramUsada)}`, `/ ${GB(g.vramTotal)} GB`, g.vramTotal ? g.vramUsada / g.vramTotal * 100 : 0, 95)}
        ${g.temperatura != null ? tile('Temperatura', `${g.temperatura} °C`, '', g.temperatura, 83) : ''}
        ${g.potenciaW != null ? tile('Potência', `${Math.round(g.potenciaW)} W`, g.limiteW ? `/ ${Math.round(g.limiteW)} W` : '', g.limiteW ? g.potenciaW / g.limiteW * 100 : null) : ''}
        ${g.clockSm != null ? tile('Clock', `${g.clockSm}`, `MHz · mem ${g.clockMemoria ?? '–'}`) : ''}
        ${g.ventoinha != null ? tile('Ventoinha', `${g.ventoinha}%`) : ''}
      </div>
      ${spark('uso' + gi, hv.map(h => h.uso), 100, 'Uso da GPU, últimos 10 min', v => `${v}%`)}
      ${spark('vram' + gi, hv.map(h => h.vramUsada / 1024 ** 3), g.vramTotal / 1024 ** 3, 'VRAM, últimos 10 min', v => `${fmt1(v)} GB`)}
      <h2 style="margin-top:4px">Processos de computação</h2>
      ${g.processos.map(p => `<div class="tarefa"><span class="ponto" style="background:var(--acento)"></span><div class="txt">${esc(p.nome)} <span class="peq muted">pid ${p.pid}${p.vram != null ? ` · ${GB(p.vram)} GB` : ''}</span></div></div>`).join('') || '<div class="vazio">Nenhum treino ou cálculo usando a GPU agora.</div>'}
      ${g.outrosProcessos ? `<div class="peq muted" style="margin-top:6px">+ ${g.outrosProcessos} outros programas com contexto na GPU (janelas, navegadores…)</div>` : ''}
      ${g.uso < 5 && g.vramTotal && g.vramUsada / g.vramTotal > 0.7 && g.processos.length ? `<div class="aviso" style="margin:12px 0 0">A GPU está parada (${g.uso}%), mas ${GB(g.vramUsada)} GB de VRAM estão ocupados e ${esc(g.processos.map(p => `${p.nome} (pid ${p.pid})`).join(', '))} segue aberto. Pode ser um treino ou kernel parado segurando memória.</div>` : ''}
    </div>`;
  }).join('') || `<div class="cartao"><h2>GPU</h2><div class="vazio">Nenhuma GPU NVIDIA encontrada${A.gpuErro ? `: ${esc(A.gpuErro)}` : ''}.</div></div>`;
  const ciclos = S.ciclosGpu.slice(-6).reverse().map(c => `<div class="tarefa"><div class="txt">${new Date(c.inicioMs).toLocaleString('pt-BR', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} → ${new Date(c.fimMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
    <span class="peq muted">· ${dur(c.fimMs - c.inicioMs)}${c.processos.length ? ` · ${esc(c.processos.join(', '))}` : ''}</span></div></div>`).join('');
  $('#sistema').innerHTML = `<div class="cabeca"><div><h1>Sistema</h1><p>Leitura a cada 2 s. Quando a GPU passa 10 min ocupada e depois fica 5 min parada, chega um aviso.</p></div></div>
    <div class="grade"><div>${gpus}</div><div>
      <div class="cartao"><h2>CPU e memória</h2><div class="tiles" style="grid-template-columns:1fr 1fr">
        ${tile('CPU', `${Math.round(A.cpu)}%`, '', A.cpu)}
        ${tile('RAM', `${GB(A.ramUsada)}`, `/ ${Math.round(A.ramTotal / 1024 ** 3)} GB`, A.ramUsada / A.ramTotal * 100, 92)}</div>
        ${spark('cpu', SIS.hist.map(h => h.cpu), 100, 'CPU, últimos 10 min', v => `${Math.round(v)}%`)}</div>
      <div class="cartao"><h2>Discos</h2>${A.discos.map(d => `<div class="medida"><div class="topo">${esc(d.ponto)}<b>${GB(d.livre)} GB livres</b></div>
        <div class="barra"><div style="width:${(1 - d.livre / d.total) * 100}%;background:${d.livre / d.total < 0.1 ? 'var(--alerta)' : 'var(--acento)'}"></div></div></div>`).join('')}</div>
      <div class="cartao"><h2>Treinos longos detectados</h2>${ciclos || '<div class="vazio">Nenhum ainda. Aparecem aqui quando a GPU fica 10 min ou mais ocupada e depois para.</div>'}</div>
    </div></div>`;
}
ponte.ouvir('sistema', ([amostra, emUsoLongo]) => {
  SIS.ultima = amostra; SIS.emUsoLongo = emUsoLongo;
  SIS.hist.push(amostra); if (SIS.hist.length > 300) SIS.hist.shift();
  if (aba === 'sistema') renderSistema();
});
ponte.ouvir('gpu-ciclo', c => { S.ciclosGpu.push(c); if (S.ciclosGpu.length > 200) S.ciclosGpu.shift(); salvar(); if (aba === 'sistema') renderSistema() });

/* ================= AJUSTES ================= */
let autostartLigado = null;
function renderAjustes() {
  if (autostartLigado === null) ponte.autostart().then(v => { autostartLigado = v; if (aba === 'ajustes') renderAjustes() }).catch(() => autostartLigado = false);
  $('#ajustes').innerHTML = `<div class="cabeca"><div><h1>Ajustes</h1><p>Rotina, horários e textos ficam no config.json.</p></div></div>
    <div class="grade"><div>
      <div class="cartao"><h2>App</h2>
        <div class="ajuste"><div class="txt">Abrir junto com o Windows<small>Abre só o widget; a janela principal fica na bandeja.</small></div>
          <button class="chave ${autostartLigado ? 'on' : ''}" data-act="autostart" ${TAURI ? '' : 'disabled'}></button></div>
        <div class="ajuste"><div class="txt">Lembretes das rotinas<small>Notificação no início de cada bloco com roteiro (oração, leitura, revisão…).</small></div>
          <button class="chave ${S.lembretes ? 'on' : ''}" data-act="lembretes"></button></div>
      </div>
      <div class="cartao"><h2>Rotina (config.json)</h2>
        <div class="ajuste"><div class="txt">Pasta de dados<small>%APPDATA%\\ritmo: config.json e estado.json</small></div><button class="btn" data-act="abrirPasta" ${TAURI ? '' : 'disabled'}>Abrir</button></div>
        <div class="ajuste"><div class="txt">Recarregar config<small>Depois de editar o config.json.</small></div><button class="btn" data-act="recarregar">Recarregar</button></div>
        <div class="ajuste"><div class="txt">Importar config…<small>Substitui o config.json por um arquivo seu.</small></div><label class="btn">Escolher<input type="file" id="impConfig" accept=".json" hidden></label></div>
        <div class="ajuste"><div class="txt">Voltar ao exemplo<small>Sobrescreve o config.json com a rotina de exemplo.</small></div><button class="btn" data-act="configExemplo">Restaurar</button></div>
      </div></div><div>
      <div class="cartao"><h2>YouTube no foco</h2>
        <p class="peq muted" style="margin-top:0">Cole links de vídeos longos de música ou ambiente. O app sorteia um a cada bloco e toca num cantinho, sem abrir o site.</p>
        <form id="formYt" class="linha" style="flex-wrap:nowrap"><input id="ytUrl" placeholder="https://www.youtube.com/watch?v=…"><button class="btn">Adicionar</button></form>
        ${S.youtube.map((id, i) => `<div class="tarefa"><div class="txt peq">${id}</div><button class="btn peq fantasma" data-act="ytDel" data-i="${i}">remover</button></div>`).join('')}
      </div>
      <div class="cartao"><h2>Backup</h2>
        <div class="linha"><button class="btn" data-act="exportar">Exportar dados</button><label class="btn">Importar dados<input type="file" id="impEstado" accept=".json" hidden></label></div></div>
    </div></div>`;
  $('#formYt').onsubmit = e => {
    e.preventDefault(); const id = idYoutube($('#ytUrl').value);
    if (!id) return toast('Não reconheci o link.');
    if (!S.youtube.includes(id)) S.youtube.push(id); salvar(); renderAjustes();
  };
  $('#impConfig').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const txt = await f.text();
    try { validarConfig(JSON.parse(txt)) } catch (err) { return alert('Config inválido: ' + err.message) }
    await ponte.salvar('config.json', txt); await carregarConfig(); agendarAncora(); toast('Config importado.'); render();
  };
  $('#impEstado').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!confirm('Substituir todos os dados atuais pelo arquivo?')) return; S = Object.assign(PADRAO(), d); salvar(); toast('Dados importados.'); render() }
    catch { alert('Arquivo inválido.') }
  };
}

/* ================= ROTINAS GUIADAS ================= */
let M = null; // { r, k, i, fimTs }
function abrirRotina(r, k) { M = { r, k, i: 0, fimTs: null }; renderModal(); $('#fundoModal').classList.add('ativo') }
function fecharModal() { M = null; $('#fundoModal').classList.remove('ativo'); render() }
function renderModal() {
  const R = CONFIG.rotinas[M.r], p = R.passos[M.i], D = dia(M.k), ult = M.i === R.passos.length - 1;
  const campos = D.campos[M.r] ??= {};
  let c = '';
  if (p.t === 'texto') c = `${p.titulo ? `<h4>${esc(p.titulo)}</h4>` : ''}<div class="texto-passo">${esc(p.corpo)}</div>`;
  if (p.t === 'timer') c = `<h4>${esc(p.titulo || 'Tempo')}</h4>${p.dica ? `<div class="texto-passo" style="font-size:15px">${esc(p.dica)}</div>` : ''}
    <div class="tempo-modal" id="mTimer">${M.fimTs ? mmss(M.fimTs - Date.now()) : `${pad(p.min)}:00`}</div>
    <div class="linha" style="justify-content:center">${M.fimTs ? '' : `<button class="btn" data-m="timer">Iniciar ${p.min} min</button>`}</div>`;
  if (p.t === 'campo') c = `<label class="rot" style="font-size:15px;color:var(--ink)">${esc(p.rotulo)}</label><textarea id="mCampo">${esc(campos[M.i] || '')}</textarea>`;
  if (p.t === 'lista_do_dia') { const nome = p.porDia[dataDe(M.k).getDay()]; c = `<h4>${esc(p.titulo || '')} ${esc(nome)}</h4><div class="texto-passo">${(p.listas[nome] || []).map((x, i) => `${i + 1}. ${esc(x)}`).join('\n')}</div>` }
  if (p.t === 'contador') { const n = campos[M.i] || 0; c = `<h4>${esc(p.rotulo)}: ${n} de ${p.alvo}</h4><div class="contas">${[...Array(p.alvo)].map((_, i) => `<span class="conta ${i < n ? 'on' : ''}"></span>`).join('')}</div><div class="linha"><button class="btn" data-m="mais">+1</button><button class="btn fantasma" data-m="menos">−1</button></div>` }
  if (p.t === 'copiar') c = `<h4>Pronto</h4><p class="muted">Copie e leve para onde precisar.</p><button class="btn" data-m="copiar">Copiar como texto</button>`;
  $('#modal').innerHTML = `<div class="topo-modal"><h3>${esc(R.nome)}</h3><button class="btn peq fantasma" data-m="fechar">✕</button></div>
    <div class="passos">${R.passos.map((_, i) => `<span class="${i <= M.i ? 'on' : ''}"></span>`).join('')}</div>
    ${R.minimo ? `<p class="minimo-nota">Versão mínima: ${esc(R.minimo)}</p>` : ''}${c}
    <div class="rodape-modal">${M.i > 0 ? '<button class="btn fantasma" data-m="ant">‹ Voltar</button>' : ''}<span style="flex:1"></span>
      ${R.minimo ? '<button class="btn" data-m="minimo">Concluir no mínimo</button>' : ''}
      ${ult ? '<button class="btn pri" data-m="completo">Concluir</button>' : '<button class="btn pri" data-m="prox">Próximo ›</button>'}</div>`;
  $('#mCampo')?.focus();
}
function guardarCampo() {
  const el = $('#mCampo'); if (!el || !M) return;
  const p = CONFIG.rotinas[M.r].passos[M.i], D = dia(M.k);
  D.campos[M.r][M.i] = el.value;
  if (p.tarefaEmDias !== undefined && el.value.trim()) {
    const txt = (p.prefixoTarefa || '') + el.value.trim();
    if (!S.tarefas.some(t => t.texto === txt && !t.descartada)) S.tarefas.push(novaTarefa(txt, p.ctxTarefa || S.ultimo.ctx || Object.keys(CONFIG.contextos)[0], somaDias(M.k, p.tarefaEmDias), true));
  }
  salvar();
}
$('#modal').addEventListener('click', e => {
  const a = e.target.closest('[data-m]')?.dataset.m; if (!a || !M) return;
  const R = CONFIG.rotinas[M.r], D = dia(M.k);
  guardarCampo();
  if (a === 'fechar') return fecharModal();
  if (a === 'prox') { M.i++; M.fimTs = null }
  if (a === 'ant') { M.i--; M.fimTs = null }
  if (a === 'timer') { M.fimTs = Date.now() + R.passos[M.i].min * 60000; sino('inicio') }
  if (a === 'mais' || a === 'menos') { const cc = D.campos[M.r]; cc[M.i] = Math.max(0, Math.min(R.passos[M.i].alvo, (cc[M.i] || 0) + (a === 'mais' ? 1 : -1))); salvar() }
  if (a === 'copiar') {
    const txt = R.passos.map((p, i) => p.t === 'campo' ? `## ${p.rotulo}\n${D.campos[M.r][i] || ''}` : '').filter(Boolean).join('\n\n');
    navigator.clipboard.writeText(txt).then(() => toast('Copiado.'), () => prompt('Copie:', txt));
  }
  if (a === 'completo' || a === 'minimo') {
    let v = a;
    // Rotina com contador: completa só se bateu o alvo.
    R.passos.forEach((p, i) => { if (p.t === 'contador' && v === 'completo' && (D.campos[M.r][i] || 0) < p.alvo) v = 'minimo' });
    D.habitos[M.r] = v; salvar(); return fecharModal();
  }
  renderModal();
});
$('#fundoModal').addEventListener('mousedown', e => { if (e.target.id === 'fundoModal') { guardarCampo(); fecharModal() } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && M) { guardarCampo(); fecharModal() } });

/* ================= AÇÕES ================= */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el || el.closest('#modal')) return;
  e.preventDefault();
  const a = el.dataset.act, t = S.tarefas.find(x => x.id === el.dataset.id);
  const diaAcao = aba === 'hoje' ? diaVista : hoje(), D = dia(diaAcao);
  switch (a) {
    case 'diaAnt': diaVista = somaDias(diaVista, -1); break;
    case 'diaProx': diaVista = somaDias(diaVista, 1); break;
    case 'diaHoje': diaVista = hoje(); break;
    case 'irFoco': return irPara('foco');
    case 'irFechamento': return irPara('fechamento');
    case 'abrirRotina': return abrirRotina(el.dataset.r, diaAcao);
    case 'habito': D.habitos[el.dataset.r] = D.habitos[el.dataset.r] === el.dataset.v ? undefined : el.dataset.v; agendarAncora(); break;
    case 'lazer': D.lazer[el.dataset.i] = !D.lazer[el.dataset.i]; break;
    case 'feito': t.feito = !t.feito; break;
    case 'top': {
      const n = S.tarefas.filter(x => x.dia === t.dia && x.top && !x.feito && !x.descartada).length;
      if (!t.top && n >= 3) return toast('Já são 3 prioridades. Tire uma antes.');
      t.top = !t.top; break;
    }
    case 'descartar': if (!confirm(`Descartar "${t.texto}"?`)) return; t.descartada = true; break;
    case 'quebrar': {
      const p = prompt('Quebre em partes menores, separadas por ;', ''); if (!p) return;
      p.split(';').map(s => s.trim()).filter(Boolean).forEach(s => S.tarefas.push(novaTarefa(s, t.ctx, t.dia)));
      t.descartada = true; break;
    }
    case 'focarTarefa': S.ultimo = { ...S.ultimo, tarefa: t.texto, ctx: t.ctx }; salvar(); return irPara('foco');
    case 'focarCtx': S.ultimo = { ...S.ultimo, ctx: el.dataset.ctx, tarefa: '' }; salvar(); return irPara('foco');
    case 'pausar': return pausarRetomar();
    case 'encerrar': return encerrar();
    case 'check': dia(hoje()).checklist[el.dataset.i] = !dia(hoje()).checklist[el.dataset.i]; break;
    case 'inboxTarefa': { const x = S.inbox.splice(+el.dataset.i, 1)[0]; S.tarefas.push(novaTarefa(x.texto, S.ultimo.ctx || Object.keys(CONFIG.contextos)[0], somaDias(hoje(), 1))); break }
    case 'inboxDel': S.inbox.splice(+el.dataset.i, 1); break;
    case 'ytDel': S.youtube.splice(+el.dataset.i, 1); break;
    case 'autostart': try { autostartLigado = await ponte.autostart(!autostartLigado) } catch (err) { toast('Não consegui mudar: ' + err) } break;
    case 'lembretes': S.lembretes = !S.lembretes; agendarAncora(); break;
    case 'abrirPasta': ponte.abrirPasta(); return;
    case 'recarregar': await carregarConfig(); agendarAncora(); toast('Config recarregado.'); break;
    case 'configExemplo': if (!confirm('Sobrescrever seu config.json pela rotina de exemplo?')) return; await ponte.salvar('config.json', await exemplo()); await carregarConfig(); break;
    case 'exportar': {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
      const l = document.createElement('a'); l.href = URL.createObjectURL(blob); l.download = `ritmo-backup-${hoje()}.json`; l.click(); return;
    }
    default: return;
  }
  salvar(); render();
});
$('#btnWidget').onclick = () => TAURI ? ponte.widget() : toast('O widget funciona no app instalado.');

/* ================= LEMBRETES E WIDGET ================= */
// Próximo bloco de hoje com roteiro, ainda não marcado: notificação nativa no horário.
function agendarAncora() {
  if (!S.lembretes) return ponte.cancelar('ancora');
  const k = hoje(), D = dia(k), n = agoraMin();
  const b = blocosDe(k).find(x => x.rotina && minDe(x.ini) > n && !D.habitos[x.rotina]);
  if (b) ponte.agendar('ancora', tsDe(k, b.ini), b.titulo, `${b.ini}–${b.fim}${CONFIG.rotinas[b.rotina].minimo ? ' · mínimo: ' + CONFIG.rotinas[b.rotina].minimo : ''}`);
  else ponte.cancelar('ancora');
}
function enviarMini() {
  if (!TAURI || !CONFIG) return;
  const { atual, prox } = blocoAtual(), T = S.timer;
  const bl = x => x && { ini: x.ini, fim: x.fim, titulo: x.titulo, cor: cor(x.ctx) };
  ponte.emitir('mini', {
    timer: T && { fase: T.fase, tarefa: T.tarefa, passo: T.passo, fimTs: T.fimTs, pausado: T.pausado, restante: T.restante, duracaoMs: T.duracaoMs },
    atual: bl(atual), prox: bl(prox),
  });
}
ponte.ouvir('mini-acao', a => {
  if (a === 'pausar') pausarRetomar();
  if (a === 'encerrar') encerrar();
  if (a === 'pedir') enviarMini();
});
ponte.ouvir('alarme', chave => { if (chave === 'timer') verificarTimer(); if (chave === 'ancora') setTimeout(agendarAncora, 1500) });
ponte.ouvir('navegar', a => irPara(a));

/* ================= RELÓGIO ================= */
let ultimoMin = -1, ultimoDia;
function tick() {
  const d = new Date();
  $('#relogio').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  verificarTimer();
  const T = S.timer;
  document.title = T && T.fase !== 'registro' ? `${mmss(restante())} · ritmo` : 'ritmo';
  document.querySelectorAll('[data-vivo=timer]').forEach(x => x.textContent = mmss(restante()));
  const anel = document.querySelector('[data-vivo=anel]');
  if (anel && T) anel.setAttribute('stroke-dashoffset', CIRC * (1 - restante() / T.duracaoMs));
  if (M?.fimTs) {
    const mt = $('#mTimer'), r = M.fimTs - Date.now();
    if (mt) mt.textContent = mmss(r);
    if (r <= 0) { M.fimTs = null; sino('fim'); renderModal() }
  }
  if (hoje() !== ultimoDia) {
    if (diaVista === ultimoDia) diaVista = hoje();
    ultimoDia = hoje(); $('#dataLateral').textContent = `${DIAS[d.getDay()]}, ${dataLonga(ultimoDia)}`;
    migrar(); agendarAncora(); render();
  }
  const m = agoraMin();
  if (m !== ultimoMin) {
    ultimoMin = m;
    if (aba === 'hoje' && !M && !document.activeElement?.matches('input,textarea,select')) renderHoje();
    enviarMini();
  }
}

(async function iniciar() {
  await carregarConfig();
  await carregarEstado();
  diaVista = ultimoDia = hoje();
  $('#dataLateral').textContent = `${DIAS[new Date().getDay()]}, ${dataLonga(hoje())}`;
  migrar(); render(); agendarTimer(); agendarAncora(); tick();
  setInterval(tick, 500);
})();
