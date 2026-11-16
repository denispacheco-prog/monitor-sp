// ============================================================
// GAROA — o bichinho virtual do Monitor SP
//
// Fluxo de cada checagem:
//   buscar fontes (só dados, sem DOM)
//   → comparar com o estado salvo (funções puras: devolvem novo estado + eventos)
//   → anti-spam (cooldown, horário de silêncio, agrupamento)
//   → notificar + salvar + desenhar o humor
//
// O humor sai do ESTADO ATUAL (se vem chuva, o guarda-chuva fica aberto);
// as notificações saem das MUDANÇAS de estado.
// ============================================================
'use strict';

// ------------------------------------------------------------
// CONFIGURAÇÃO
// ------------------------------------------------------------
// Todos os repositórios em denispacheco-prog.github.io dividem o mesmo
// localStorage, então todas as chaves do bicho levam este prefixo.
const PREFIXO = 'monitor-sp:bicho:';
const LAT = -23.5505, LON = -46.6333;

const LIMIARES = {
  chuvaHoras: 2,          // olha a hora atual + as próximas 2
  chuvaProbLiga: 60,      // % — acima disso, "vem chuva"
  chuvaProbDesliga: 30,   // % — abaixo disso (e sem chuva prevista), "parou"
  chuvaMmLiga: 1.0,       // mm somados na janela — também liga
  chuvaMmDesliga: 0.2,    // mm somados na janela — precisa ficar abaixo para desligar
  tempHoras: 3,           // compara a temperatura de agora com a de daqui a 3h
  tempVariacao: 6,        // °C — dispara aviso
  tempVariacaoReset: 4,   // °C — rearma o aviso quando a variação cai abaixo disso
  calor: 30,              // °C — bichinho suando
  frio: 12,               // °C — bichinho tremendo
  arTosse: 2,             // índice em FAIXAS_AR a partir do qual ele tosse (Moderado)
  arConfirmacoes: 2,      // leituras seguidas na faixa nova antes de avisar
};

// De quanto em quanto tempo cada fonte é buscada (o relógio interno bate a cada 1 min)
const INTERVALOS = { clima: 15 * 60e3, ar: 30 * 60e3 };
const ESPERA_APOS_ERRO = 5 * 60e3;
const TICK = 60e3;

// Tempo mínimo entre duas notificações do mesmo tipo
const HORA = 60 * 60e3;
const COOLDOWN = { chuva: 2 * HORA, 'chuva-fim': 2 * HORA, temperatura: 3 * HORA, ar: 2 * HORA };

// Mesmas faixas do índice europeu usadas no painel (index.html → AQI_FAIXAS)
const FAIXAS_AR = [
  { max: 20,       label: 'Bom' },
  { max: 40,       label: 'Razoável' },
  { max: 60,       label: 'Moderado' },
  { max: 80,       label: 'Ruim' },
  { max: 100,      label: 'Muito ruim' },
  { max: Infinity, label: 'Extremamente ruim' },
];

// Códigos WMO de chuva/garoa/tempestade
const CODIGOS_CHUVA = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

// ------------------------------------------------------------
// PERSISTÊNCIA (localStorage pode falhar em aba anônima — sempre try/catch)
// ------------------------------------------------------------
function ler(chave, padrao) {
  try {
    const raw = localStorage.getItem(PREFIXO + chave);
    return raw ? JSON.parse(raw) : padrao;
  } catch (e) { return padrao; }
}
function gravar(chave, valor) {
  try { localStorage.setItem(PREFIXO + chave, JSON.stringify(valor)); } catch (e) {}
}

let estado      = ler('estado', {});          // { clima: {...}, ar: {...} }
let ultimaBusca = ler('ultima-busca', {});    // { clima: ts, ar: ts }
let config      = ler('config', { silencio: true, silencioDe: 23, silencioAte: 7 });
let diario      = ler('diario', []);          // últimos eventos, mais recente primeiro
let ultimaChecagem = ler('ultima-checagem', null);
const erros = {};                              // { fonte: ts do último erro } — só em memória
let previa = null;                             // humor forçado pela prévia (não salvo)

// ------------------------------------------------------------
// FONTES — só buscam e devolvem dados
// ------------------------------------------------------------
async function buscarJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally { clearTimeout(t); }
}

async function buscarClima() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + '&current=temperature_2m,precipitation,weather_code'
    + '&hourly=temperature_2m,precipitation_probability,precipitation'
    + '&timezone=America%2FSao_Paulo&forecast_days=2';
  const d = await buscarJSON(url);
  const h = d.hourly;

  // posição da hora corrente no array horário ("2026-11-16T14:00")
  let i = h.time.indexOf(d.current.time.slice(0, 13) + ':00');
  if (i < 0) i = 0;

  // janela de chuva: hora atual + próximas N
  let probMax = 0, mm = 0, horaChuva = null;
  for (let k = i; k <= i + LIMIARES.chuvaHoras && k < h.time.length; k++) {
    const p = h.precipitation_probability[k] ?? 0;
    const m = h.precipitation[k] ?? 0;
    probMax = Math.max(probMax, p);
    mm += m;
    if (!horaChuva && (p >= LIMIARES.chuvaProbLiga || m >= 0.5)) horaChuva = h.time[k].slice(11, 16);
  }

  const kFut = Math.min(i + LIMIARES.tempHoras, h.time.length - 1);
  return {
    temp: d.current.temperature_2m,
    tempFutura: h.temperature_2m[kFut],
    horaFutura: h.time[kFut].slice(11, 13) + 'h',
    probMax,
    mm: Math.round(mm * 10) / 10,
    horaChuva,
    chovendoAgora: (d.current.precipitation ?? 0) > 0 || CODIGOS_CHUVA.has(d.current.weather_code),
  };
}

async function buscarAr() {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}`
    + '&current=european_aqi&timezone=America%2FSao_Paulo';
  const d = await buscarJSON(url);
  const aqi = Math.round(d.current.european_aqi);
  return { aqi, faixa: FAIXAS_AR.findIndex(f => aqi <= f.max) };
}

// ------------------------------------------------------------
// COMPARAÇÕES — funções puras: (estado anterior, leitura) → { estado, eventos }
// Na primeira leitura (sem estado anterior) só registra a referência, sem eventos.
// ------------------------------------------------------------
function compararClima(antes, l) {
  const eventos = [];
  const liga = l.chovendoAgora || l.probMax >= LIMIARES.chuvaProbLiga || l.mm >= LIMIARES.chuvaMmLiga;
  const desliga = !l.chovendoAgora && l.probMax < LIMIARES.chuvaProbDesliga && l.mm < LIMIARES.chuvaMmDesliga;
  const delta = l.tempFutura - l.temp;
  const brusca = Math.abs(delta) >= LIMIARES.tempVariacao;

  if (!antes) {
    return { estado: { ...l, vemChuva: liga, variacaoBrusca: brusca }, eventos };
  }

  // Chuva — com histerese: liga e desliga em limiares diferentes para não ficar piscando
  let vemChuva = antes.vemChuva;
  if (!vemChuva && liga) {
    vemChuva = true;
    eventos.push({
      tipo: 'chuva', emoji: '🌧️',
      texto: l.chovendoAgora
        ? 'Começou a chover! Guarda-chuva na mão.'
        : `Chuva provável por volta das ${l.horaChuva || 'próximas horas'} (${l.probMax}%). Leva o guarda-chuva!`,
    });
  } else if (vemChuva && desliga) {
    vemChuva = false;
    eventos.push({ tipo: 'chuva-fim', emoji: '🌤️', texto: 'A chuva deu trégua. Pode guardar o guarda-chuva.' });
  }

  // Temperatura — avisa ao entrar na condição; rearma quando a variação diminui
  let variacaoBrusca = antes.variacaoBrusca;
  if (!variacaoBrusca && brusca) {
    variacaoBrusca = true;
    const graus = Math.round(Math.abs(delta));
    eventos.push({
      tipo: 'temperatura', emoji: delta < 0 ? '🥶' : '🥵',
      texto: `Vai ${delta < 0 ? 'esfriar' : 'esquentar'} ${graus}°C até as ${l.horaFutura} (de ${Math.round(l.temp)}° para ${Math.round(l.tempFutura)}°).`,
    });
  } else if (variacaoBrusca && Math.abs(delta) < LIMIARES.tempVariacaoReset) {
    variacaoBrusca = false;
  }

  return { estado: { ...l, vemChuva, variacaoBrusca }, eventos };
}

function compararAr(antes, l) {
  const eventos = [];
  if (!antes) return { estado: { aqi: l.aqi, faixa: l.faixa, pendente: null, contagem: 0 }, eventos };

  const novo = { aqi: l.aqi, faixa: antes.faixa, pendente: null, contagem: 0 };
  if (l.faixa !== antes.faixa) {
    // só confirma a faixa nova depois de N leituras seguidas nela
    novo.pendente = l.faixa;
    novo.contagem = antes.pendente === l.faixa ? antes.contagem + 1 : 1;
    if (novo.contagem >= LIMIARES.arConfirmacoes) {
      const piorou = l.faixa > antes.faixa;
      eventos.push({
        tipo: 'ar', emoji: piorou ? '😷' : '😮‍💨',
        texto: `O ar ${piorou ? 'piorou' : 'melhorou'}: ${FAIXAS_AR[antes.faixa].label} → ${FAIXAS_AR[l.faixa].label} (índice ${l.aqi}).`,
      });
      novo.faixa = l.faixa;
      novo.pendente = null;
      novo.contagem = 0;
    }
  }
  return { estado: novo, eventos };
}

const FONTES = [
  { id: 'clima', buscar: buscarClima, comparar: compararClima },
  { id: 'ar',    buscar: buscarAr,    comparar: compararAr },
];

// ------------------------------------------------------------
// ANTI-SPAM + NOTIFICAÇÕES
// ------------------------------------------------------------
function emSilencio(data = new Date()) {
  if (!config.silencio) return false;
  const h = data.getHours(), de = config.silencioDe, ate = config.silencioAte;
  return de > ate ? (h >= de || h < ate) : (h >= de && h < ate);   // atravessa a meia-noite ou não
}

function processarEventos(eventos) {
  const agora = Date.now();
  const cooldowns = ler('cooldowns', {});
  const silencio = emSilencio();
  const notificar = [];

  for (const e of eventos) {
    let motivo = null;
    if (silencio) motivo = 'silêncio';
    else if (cooldowns[e.tipo] && agora - cooldowns[e.tipo] < COOLDOWN[e.tipo]) motivo = 'repetido';
    else { notificar.push(e); cooldowns[e.tipo] = agora; }
    registrarNoDiario(e, motivo);
  }
  gravar('cooldowns', cooldowns);
  if (notificar.length) enviarNotificacao(notificar);
}

// Vários avisos na mesma checagem viram uma notificação só
function enviarNotificacao(eventos, { teste = false } = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const titulo = eventos.length === 1 ? `Garoa ${eventos[0].emoji}` : `Garoa — ${eventos.length} novidades`;
  const corpo = eventos.map(e => `${e.emoji} ${e.texto}`).join('\n');
  // tag por tipo: uma notificação nova do mesmo tipo substitui a anterior
  const tag = teste ? 'monitor-sp-bicho-teste'
    : 'monitor-sp-bicho-' + (eventos.length === 1 ? eventos[0].tipo : 'varios');
  try {
    const n = new Notification(titulo, { body: corpo, tag, renotify: true });
    n.onclick = () => { window.focus(); n.close(); };
    // "show" só dispara se o navegador/sistema realmente exibiu; "error" se recusou.
    // Se nenhum dos dois vier, o sistema operacional provavelmente engoliu a notificação.
    let exibida = false;
    n.onshow = () => { exibida = true; if (teste) mostrarAviso('✅ O navegador confirmou que exibiu a notificação.'); };
    n.onerror = () => mostrarAviso('❌ O navegador recusou a notificação (veja as permissões do site).');
    if (teste) setTimeout(() => {
      if (!exibida) mostrarAviso('⚠️ Sem confirmação de exibição. Confira se as notificações do navegador estão ligadas no Windows e se o "Não perturbe" está desligado.');
    }, 3000);
    return true;
  } catch (e) {
    // No Chrome Android o construtor não é permitido (exigiria service worker)
    mostrarAviso('Este navegador não deixa a página notificar sozinha. Os avisos ficam no diário.');
    return false;
  }
}

function registrarNoDiario(e, motivo) {
  diario.unshift({ ts: Date.now(), emoji: e.emoji, texto: e.texto, motivo });
  diario = diario.slice(0, 20);
  gravar('diario', diario);
}

// ------------------------------------------------------------
// CHECAGEM — o relógio interno bate a cada minuto e cada fonte decide se "venceu"
// ------------------------------------------------------------
let checando = false;
async function checar(forcar = false) {
  if (checando) return;
  checando = true;
  desenharStatus(true);
  try {
    const eventos = [];
    for (const fonte of FONTES) {
      const agora = Date.now();
      const venceu = agora - (ultimaBusca[fonte.id] || 0) >= INTERVALOS[fonte.id];
      if (!forcar && !venceu) continue;
      try {
        const leitura = await fonte.buscar();
        const r = fonte.comparar(estado[fonte.id], leitura);
        estado[fonte.id] = r.estado;
        eventos.push(...r.eventos);
        ultimaBusca[fonte.id] = agora;
        erros[fonte.id] = null;
      } catch (e) {
        console.warn(`[Garoa] falha ao buscar ${fonte.id}`, e);
        erros[fonte.id] = agora;
        // tenta de novo em ESPERA_APOS_ERRO, e não a cada minuto
        ultimaBusca[fonte.id] = agora - INTERVALOS[fonte.id] + ESPERA_APOS_ERRO;
      }
    }
    ultimaChecagem = Date.now();
    gravar('estado', estado);
    gravar('ultima-busca', ultimaBusca);
    gravar('ultima-checagem', ultimaChecagem);
    if (eventos.length) processarEventos(eventos);
  } finally {
    checando = false;
    desenhar();
  }
}

// ------------------------------------------------------------
// HUMOR — calculado do estado atual
// ------------------------------------------------------------
function calcularHumor() {
  const c = estado.clima, a = estado.ar;
  const acessorios = {
    chuva: !!c?.vemChuva,
    calor: c ? c.temp >= LIMIARES.calor : false,
    frio:  c ? c.temp <= LIMIARES.frio : false,
    tosse: a ? a.faixa >= LIMIARES.arTosse : false,
    dormindo: emSilencio(),
  };
  // expressão principal, por prioridade
  const principal = ['tosse', 'chuva', 'calor', 'frio', 'dormindo'].find(k => acessorios[k]) || 'feliz';
  return { principal, acessorios };
}

function fala(principal) {
  const c = estado.clima, a = estado.ar;
  const t = c ? `${Math.round(c.temp)}°C` : '';
  const ar = a ? FAIXAS_AR[a.faixa].label.toLowerCase() : '';
  if (!c && !a) return 'Acordando… deixa eu dar uma olhada na cidade.';
  switch (principal) {
    case 'tosse':    return `Cof, cof… o ar tá ${ar} hoje (índice ${a.aqi}).`;
    case 'chuva':    return c.chovendoAgora ? 'Tá chovendo! Ainda bem que eu trouxe o guarda-chuva.'
                                            : `Vem chuva por aí (${c.probMax}%). Guarda-chuva na mão!`;
    case 'calor':    return `Que calor, ${t}! Bebe água, hein.`;
    case 'frio':     return `Brrr, ${t}… cadê meu cachecol?`;
    case 'dormindo': return 'Zzz… (horário de silêncio: guardo os avisos pra depois)';
    default:         return `Tudo tranquilo em SP: ${t}${ar ? ` e ar ${ar}` : ''}.`;
  }
}

// Textos e acessórios usados pela prévia dos humores
const PREVIAS = {
  feliz:    { principal: 'feliz',    acessorios: {},                      texto: 'Tudo tranquilo em SP!' },
  chuva:    { principal: 'chuva',    acessorios: { chuva: true },         texto: 'Vem chuva por aí. Guarda-chuva na mão!' },
  tosse:    { principal: 'tosse',    acessorios: { tosse: true },         texto: 'Cof, cof… o ar tá ruim hoje.' },
  calor:    { principal: 'calor',    acessorios: { calor: true },         texto: 'Que calor! Bebe água, hein.' },
  frio:     { principal: 'frio',     acessorios: { frio: true },          texto: 'Brrr… cadê meu cachecol?' },
  dormindo: { principal: 'dormindo', acessorios: { dormindo: true },      texto: 'Zzz…' },
};

// ------------------------------------------------------------
// DESENHO DA PÁGINA
// ------------------------------------------------------------
const $ = id => document.getElementById(id);
const hora = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function desenhar() {
  desenharBicho();
  desenharLeituras();
  desenharStatus(false);
  desenharDiario();
  desenharBotaoNotif();
}

function desenharBicho() {
  const h = previa ? PREVIAS[previa] : calcularHumor();
  const svg = $('bicho');
  // remove classes antigas e aplica: humor-<principal> + acc-<acessório>
  svg.setAttribute('class', ['bicho', `humor-${h.principal}`,
    ...Object.keys(h.acessorios).filter(k => h.acessorios[k]).map(k => `acc-${k}`)].join(' '));
  $('fala').textContent = previa ? h.texto : fala(h.principal);
}

function desenharLeituras() {
  const c = estado.clima, a = estado.ar, partes = [];
  if (c) partes.push(`🌡️ ${Math.round(c.temp)}°C`, `🌧️ ${c.probMax}% nas próx. ${LIMIARES.chuvaHoras}h`);
  if (a) partes.push(`🍃 Ar ${FAIXAS_AR[a.faixa].label} (${a.aqi})`);
  $('leituras').innerHTML = partes.map(p => `<span class="chip">${p}</span>`).join('');
}

function desenharStatus(carregando) {
  const el = $('status'), ponto = $('status-ponto');
  if (carregando) { el.textContent = 'checando a cidade…'; ponto.className = 'ponto checando'; return; }
  if (!ultimaChecagem) { el.textContent = 'ainda não checou'; ponto.className = 'ponto'; return; }
  const falhas = FONTES.filter(f => erros[f.id]).map(f => f.id);
  const min = Math.round((Date.now() - ultimaChecagem) / 60e3);
  const quando = min < 1 ? 'agora há pouco' : `há ${min} min`;
  el.textContent = `última checagem às ${hora(ultimaChecagem)} (${quando})`
    + (falhas.length ? ` · falhou: ${falhas.join(', ')}` : '');
  // mais de 5 min sem checar = aba provavelmente congelada pelo navegador
  ponto.className = 'ponto ' + (falhas.length ? 'erro' : min > 5 ? 'parado' : 'vivo');
}

function desenharDiario() {
  const lista = $('diario');
  if (!diario.length) { lista.innerHTML = '<li class="vazio">Nada aconteceu ainda.</li>'; return; }
  lista.innerHTML = diario.map(d => {
    const data = new Date(d.ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const obs = d.motivo === 'silêncio' ? ' <em>(silêncio)</em>' : d.motivo === 'repetido' ? ' <em>(sem notificar: repetido)</em>' : ' <em>🔔</em>';
    return `<li><span class="diario-hora">${data} ${hora(d.ts)}</span> ${d.emoji} ${d.texto}${obs}</li>`;
  }).join('');
}

function desenharBotaoNotif() {
  const btn = $('btn-permissao');
  if (!('Notification' in window)) {
    btn.disabled = true; btn.textContent = 'Notificações indisponíveis';
    return;
  }
  const p = Notification.permission;
  btn.disabled = p !== 'default';
  btn.textContent = p === 'granted' ? '🔔 Notificações ativas'
                  : p === 'denied'  ? '🔕 Bloqueadas no navegador'
                  : '🔔 Ativar notificações';
}

let avisoTimer;
function mostrarAviso(msg) {
  const el = $('aviso');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ------------------------------------------------------------
// BOTÕES E CONFIGURAÇÕES
// ------------------------------------------------------------
async function pedirPermissao() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default') await Notification.requestPermission();
  desenharBotaoNotif();
  return Notification.permission === 'granted';
}

async function testarAlerta() {
  if (!(await pedirPermissao())) {
    mostrarAviso('Preciso de permissão para notificar. Libere nas configurações do site.');
    return;
  }
  // o teste ignora cooldown e horário de silêncio
  const ok = enviarNotificacao([{ tipo: 'teste', emoji: '🐣', texto: 'Oi! Sou o Garoa. É assim que eu vou te avisar das coisas.' }], { teste: true });
  if (ok) mostrarAviso('Alerta de teste enviado… aguardando confirmação do navegador.');
}

function iniciarConfig() {
  const chk = $('cfg-silencio'), de = $('cfg-de'), ate = $('cfg-ate');
  for (let h = 0; h < 24; h++) {
    const txt = String(h).padStart(2, '0') + 'h';
    de.add(new Option(txt, h));
    ate.add(new Option(txt, h));
  }
  chk.checked = config.silencio;
  de.value = config.silencioDe;
  ate.value = config.silencioAte;
  const salvar = () => {
    config = { silencio: chk.checked, silencioDe: +de.value, silencioAte: +ate.value };
    gravar('config', config);
    desenharBicho();
  };
  [chk, de, ate].forEach(el => el.addEventListener('change', salvar));
}

function iniciarPrevia() {
  document.querySelectorAll('[data-previa]').forEach(btn => {
    btn.addEventListener('click', () => {
      previa = btn.dataset.previa === 'real' ? null : btn.dataset.previa;
      desenharBicho();
    });
  });
}

// Usa o mesmo tema salvo pelo painel (só leitura)
function aplicarTema() {
  try { if (localStorage.getItem('monitor-sp-tema') === 'dark') document.body.classList.add('dark-theme'); } catch (e) {}
}

// ------------------------------------------------------------
// INICIALIZAÇÃO
// ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  aplicarTema();
  iniciarConfig();
  iniciarPrevia();
  $('btn-permissao').addEventListener('click', pedirPermissao);
  $('btn-testar').addEventListener('click', testarAlerta);
  $('btn-checar').addEventListener('click', () => checar(true));

  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) $('nota-celular').hidden = false;

  desenhar();     // mostra o último estado salvo enquanto busca
  checar();
  // Abas em segundo plano têm timers limitados a ~1x/min — por isso o tick é de 1 min
  setInterval(() => checar(), TICK);
  // ao voltar para a aba, checa na hora o que estiver vencido
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checar(); });
});
