const SERVIDOR = location.protocol === "file:" || ["5500", "5501", "5502"].includes(location.port) ? "http://localhost:8000" : "";
const NS = "http://www.w3.org/2000/svg";
const ANEL = 2 * Math.PI * 50;
const FONTE = "11px 'JetBrains Mono', ui-monospace, monospace";
const RANK = { alerta: 0, off: 1, espera: 2, ok: 3 };
const VISTAS = {
  "visao-geral": ["Visão geral", "Resumo da rede em tempo real"],
  dispositivos: ["Dispositivos", "Acompanhe e gerencie cada sensor"],
  alertas: ["Alertas", "Ocorrências fora dos limites definidos"],
  configuracoes: ["Configurações", "Limites de alerta e exportação de dados"],
};

const estado = {
  dispositivos: [],
  alertas: { total: 0, ultimas_24h: 0, itens: [] },
  config: { limite_temp: 30, limite_umid: 30, offline_s: 8 },
  selecionado: null,
  janela: 300,
  filtro: "todos",
  busca: "",
  ordem: { campo: "nome", dir: 1 },
  vista: "visao-geral",
  gaveta: null,
  historico: [],
  historicoGaveta: [],
  carregado: false,
  erro: "",
  configPreenchida: false,
};

const $ = (id) => document.getElementById(id);
const $$ = (seletor) => [...document.querySelectorAll(seletor)];

function h(tag, atributos, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos || {})) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...filhos);
  return e;
}

function hs(tag, atributos, ...filhos) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(atributos || {})) e.setAttribute(k, v);
  e.append(...filhos);
  return e;
}

function num(v, casas = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

function lim(v) {
  return Number.isInteger(v) ? String(v) : num(v, 1);
}

function hora(seg, segundos = true) {
  const opcoes = { hour: "2-digit", minute: "2-digit" };
  if (segundos) opcoes.second = "2-digit";
  return new Date(seg * 1000).toLocaleTimeString("pt-BR", opcoes);
}

function dataHora(seg) {
  return new Date(seg * 1000).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ha(atraso) {
  if (atraso == null) return "sem leituras";
  if (atraso < 5) return "agora";
  if (atraso < 60) return `há ${atraso} s`;
  if (atraso < 3600) return `há ${Math.floor(atraso / 60)} min`;
  return `há ${Math.floor(atraso / 3600)} h`;
}

function alfa(cor, a) {
  return cor.length === 7 ? cor + a : cor;
}

async function api(caminho, opcoes = {}) {
  let r;
  try {
    r = await fetch(SERVIDOR + "/api" + caminho, {
      ...opcoes,
      headers: opcoes.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    throw new Error("Servidor indisponível. Execute: python app.py");
  }
  if (r.status === 204) return null;
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
  return dados;
}

let temporizadorAviso;
function aviso(texto) {
  const a = $("aviso");
  a.textContent = texto;
  a.classList.add("visivel");
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => a.classList.remove("visivel"), 3200);
}

function confirmar(texto, rotulo = "Remover") {
  const m = $("modal-confirmar");
  $("confirmar-texto").textContent = texto;
  $("confirmar-ok").textContent = rotulo;
  m.returnValue = "";
  return new Promise((resolver) => {
    m.addEventListener("close", () => resolver(m.returnValue === "sim"), { once: true });
    m.showModal();
  });
}

function statusDe(d) {
  if (d.temperatura == null) return { chave: "espera", rotulo: "Aguardando" };
  if (d.atraso >= estado.config.offline_s) return { chave: "off", rotulo: "Offline" };
  if (d.alerta) return { chave: "alerta", rotulo: "Atenção" };
  return { chave: "ok", rotulo: "Normal" };
}

function online(d) {
  const c = statusDe(d).chave;
  return c === "ok" || c === "alerta";
}

function selo(st) {
  return h("span", { class: "selo " + st.chave }, h("span", { class: "ponto" }), st.rotulo);
}

function sincronizar(pai, itens, chave, criar, atualizar) {
  const atuais = new Map([...pai.children].map((f) => [f.dataset.chave, f]));
  const vistos = new Set();
  itens.forEach((item, i) => {
    const k = String(chave(item));
    let no = atuais.get(k);
    if (!no) {
      no = criar(item);
      no.dataset.chave = k;
    }
    atualizar(no, item);
    vistos.add(k);
    if (pai.children[i] !== no) pai.insertBefore(no, pai.children[i] || null);
  });
  atuais.forEach((no, k) => {
    if (!vistos.has(k)) no.remove();
  });
}

function sparkline(valores) {
  const svg = hs("svg", { viewBox: "0 0 120 32", preserveAspectRatio: "none", class: "spark", "aria-hidden": "true" });
  if (valores.length < 2) return svg;
  const min = Math.min(...valores);
  const faixa = Math.max(...valores) - min || 1;
  const pontos = valores.map((v, i) => `${((i / (valores.length - 1)) * 120).toFixed(1)},${(29 - ((v - min) / faixa) * 26).toFixed(1)}`);
  svg.append(
    hs("polygon", { class: "spark-area", points: `0,32 ${pontos.join(" ")} 120,32` }),
    hs("polyline", { class: "spark-linha", points: pontos.join(" ") })
  );
  return svg;
}

function criarAnel(classe) {
  const valor = hs("circle", { class: "anel-valor", cx: 60, cy: 60, r: 50, transform: "rotate(-90 60 60)" });
  const svg = hs("svg", { class: classe, viewBox: "0 0 120 120", "aria-hidden": "true" }, hs("circle", { class: "anel-fundo", cx: 60, cy: 60, r: 50 }), valor);
  return { svg, valor };
}

function ajustarAnel(circulo, pct) {
  const p = Math.min(1, Math.max(0, pct));
  circulo.style.strokeDasharray = `${(ANEL * p).toFixed(1)} ${ANEL.toFixed(1)}`;
}

function paleta() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return { temp: v("--temp"), umid: v("--umid"), linha: v("--linha"), muted: v("--muted"), texto: v("--texto"), fundo: v("--elevada"), erro: v("--erro") };
}

function escala(valores, limite) {
  let min = Math.min(...valores);
  let max = Math.max(...valores);
  if (limite > min - 6 && limite < max + 6) {
    min = Math.min(min, limite);
    max = Math.max(max, limite);
  }
  const folga = Math.max((max - min) * 0.12, 1);
  min = Math.floor(min - folga);
  max = Math.ceil(max + folga);
  if (max - min < 4) max = min + 4;
  return [min, max];
}

function criarGrafico(canvas, vazio) {
  const g = { canvas, pontos: [], janela: 300, fim: 0, hover: null, vazio };
  canvas.addEventListener("pointermove", (e) => {
    g.hover = e.clientX - canvas.getBoundingClientRect().left;
    desenhar(g);
  });
  canvas.addEventListener("pointerleave", () => {
    g.hover = null;
    desenhar(g);
  });
  observador.observe(canvas);
  return g;
}

function desenhar(g) {
  const c = g.canvas;
  const w = c.clientWidth;
  const alt = c.clientHeight;
  if (!w || !alt) return;
  const dpr = window.devicePixelRatio || 1;
  const lw = Math.round(w * dpr);
  const lh = Math.round(alt * dpr);
  if (c.width !== lw || c.height !== lh) {
    c.width = lw;
    c.height = lh;
  }
  const x = c.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, alt);
  const cor = paleta();
  x.font = FONTE;
  x.textBaseline = "middle";

  const pts = g.pontos;
  if (!pts.length) {
    x.fillStyle = cor.muted;
    x.textAlign = "center";
    x.fillText(g.vazio(), w / 2, alt / 2);
    return;
  }

  const m = { e: w < 480 ? 36 : 46, d: w < 480 ? 36 : 46, t: 14, b: 28 };
  const L = w - m.e - m.d;
  const A = alt - m.t - m.b;
  const inicio = g.fim - g.janela;
  const [tMin, tMax] = escala(pts.map((p) => p.temperatura), estado.config.limite_temp);
  const [uMin, uMax] = escala(pts.map((p) => p.umidade), estado.config.limite_umid);
  const px = (p) => m.e + ((p.criado_em - inicio) / g.janela) * L;
  const yT = (v) => m.t + A - ((v - tMin) / (tMax - tMin)) * A;
  const yU = (v) => m.t + A - ((v - uMin) / (uMax - uMin)) * A;
  const casasT = tMax - tMin <= 8 ? 1 : 0;
  const casasU = uMax - uMin <= 8 ? 1 : 0;

  x.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(m.t + (A * i) / 4) + 0.5;
    x.strokeStyle = cor.linha;
    x.beginPath();
    x.moveTo(m.e, y);
    x.lineTo(m.e + L, y);
    x.stroke();
    x.fillStyle = cor.temp;
    x.textAlign = "right";
    x.fillText(num(tMax - ((tMax - tMin) * i) / 4, casasT), m.e - 8, y);
    x.fillStyle = cor.umid;
    x.textAlign = "left";
    x.fillText(num(uMax - ((uMax - uMin) * i) / 4, casasU), m.e + L + 8, y);
  }

  x.fillStyle = cor.muted;
  for (let i = 0; i <= 4; i += w < 520 ? 2 : 1) {
    x.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
    x.fillText(hora(inicio + (g.janela * i) / 4, g.janela <= 900), m.e + (L * i) / 4, alt - 10);
  }

  x.save();
  x.beginPath();
  x.rect(m.e, m.t - 2, L, A + 4);
  x.clip();

  const limite = estado.config.limite_temp;
  if (limite > tMin && limite < tMax) {
    const y = yT(limite);
    x.setLineDash([5, 4]);
    x.strokeStyle = alfa(cor.erro, "aa");
    x.beginPath();
    x.moveTo(m.e, y);
    x.lineTo(m.e + L, y);
    x.stroke();
    x.setLineDash([]);
    x.fillStyle = cor.erro;
    x.textAlign = "left";
    x.fillText(`limite ${lim(limite)} °C`, m.e + 6, y - 8);
  }

  const gradiente = x.createLinearGradient(0, m.t, 0, m.t + A);
  gradiente.addColorStop(0, alfa(cor.temp, "40"));
  gradiente.addColorStop(1, alfa(cor.temp, "00"));
  x.beginPath();
  pts.forEach((p, i) => (i ? x.lineTo(px(p), yT(p.temperatura)) : x.moveTo(px(p), yT(p.temperatura))));
  x.lineTo(px(pts[pts.length - 1]), m.t + A);
  x.lineTo(px(pts[0]), m.t + A);
  x.closePath();
  x.fillStyle = gradiente;
  x.fill();

  x.lineJoin = "round";
  [
    [cor.umid, 1.6, yU, "umidade"],
    [cor.temp, 2.2, yT, "temperatura"],
  ].forEach(([cl, largura, ys, campo]) => {
    x.beginPath();
    pts.forEach((p, i) => (i ? x.lineTo(px(p), ys(p[campo])) : x.moveTo(px(p), ys(p[campo]))));
    x.strokeStyle = cl;
    x.lineWidth = largura;
    x.stroke();
  });

  const ultimo = pts[pts.length - 1];
  [
    [cor.temp, yT(ultimo.temperatura)],
    [cor.umid, yU(ultimo.umidade)],
  ].forEach(([cl, y]) => {
    x.shadowColor = cl;
    x.shadowBlur = 10;
    x.fillStyle = cl;
    x.beginPath();
    x.arc(px(ultimo), y, 3.5, 0, Math.PI * 2);
    x.fill();
  });
  x.shadowBlur = 0;
  x.restore();

  if (g.hover != null && g.hover >= m.e && g.hover <= m.e + L) {
    const t = inicio + ((g.hover - m.e) / L) * g.janela;
    let p = pts[0];
    for (const q of pts) if (Math.abs(q.criado_em - t) < Math.abs(p.criado_em - t)) p = q;
    const xx = px(p);
    x.setLineDash([4, 4]);
    x.strokeStyle = cor.muted;
    x.beginPath();
    x.moveTo(xx, m.t);
    x.lineTo(xx, m.t + A);
    x.stroke();
    x.setLineDash([]);
    [
      [cor.temp, yT(p.temperatura)],
      [cor.umid, yU(p.umidade)],
    ].forEach(([cl, y]) => {
      x.fillStyle = cl;
      x.strokeStyle = cor.fundo;
      x.lineWidth = 2;
      x.beginPath();
      x.arc(xx, y, 4, 0, Math.PI * 2);
      x.fill();
      x.stroke();
    });
    const bw = 148;
    const bh = 64;
    const bx = xx + 14 + bw > w - 4 ? xx - bw - 14 : xx + 14;
    const by = m.t + 6;
    x.fillStyle = cor.fundo;
    x.strokeStyle = cor.linha;
    x.lineWidth = 1;
    x.beginPath();
    if (x.roundRect) x.roundRect(bx, by, bw, bh, 8);
    else x.rect(bx, by, bw, bh);
    x.fill();
    x.stroke();
    x.textAlign = "left";
    x.fillStyle = cor.muted;
    x.fillText(hora(p.criado_em), bx + 10, by + 15);
    x.fillStyle = cor.temp;
    x.fillText(`Temp.   ${num(p.temperatura)} °C`, bx + 10, by + 33);
    x.fillStyle = cor.umid;
    x.fillText(`Umid.   ${num(p.umidade)} %`, bx + 10, by + 51);
  }
}

function resumo(pts, prefixo) {
  const f = (campo) => {
    const v = pts.map((p) => p[campo]);
    if (!v.length) return [null, null, null];
    return [Math.min(...v), v.reduce((a, b) => a + b, 0) / v.length, Math.max(...v)];
  };
  const [tmin, tmed, tmax] = f("temperatura");
  const [umin, umed, umax] = f("umidade");
  const ps = (id, v, un) => {
    $(prefixo + id).textContent = v == null ? "—" : `${num(v)} ${un}`;
  };
  ps("tmin", tmin, "°C");
  ps("tmed", tmed, "°C");
  ps("tmax", tmax, "°C");
  ps("umin", umin, "%");
  ps("umed", umed, "%");
  ps("umax", umax, "%");
}

function fimDe(pts, d) {
  if (!pts.length) return Math.floor(Date.now() / 1000);
  const ultimo = pts[pts.length - 1].criado_em;
  return d && d.atraso != null ? ultimo + d.atraso : ultimo;
}

const observador = new ResizeObserver(() => redesenhar());
const grafico = criarGrafico($("grafico"), () => (estado.dispositivos.length ? "Sem leituras neste período" : "Cadastre um dispositivo para ver o gráfico"));
let graficoGaveta = null;

function redesenhar() {
  desenhar(grafico);
  if (graficoGaveta) desenhar(graficoGaveta);
}

function dispositivo(id) {
  return estado.dispositivos.find((d) => d.id === id);
}

function filtrados() {
  const busca = estado.busca.trim().toLowerCase();
  return estado.dispositivos.filter((d) => {
    const c = statusDe(d).chave;
    const passa =
      estado.filtro === "todos" ||
      (estado.filtro === "online" && (c === "ok" || c === "alerta")) ||
      (estado.filtro === "alerta" && c === "alerta") ||
      (estado.filtro === "offline" && c === "off") ||
      (estado.filtro === "aguardando" && c === "espera");
    return passa && (!busca || d.nome.toLowerCase().includes(busca) || d.id.toLowerCase().includes(busca));
  });
}

function comparar(a, b) {
  const { campo, dir } = estado.ordem;
  const nomes = a.nome.localeCompare(b.nome, "pt-BR", { numeric: true });
  if (campo === "nome") return nomes * dir;
  let x = a[campo];
  let y = b[campo];
  if (campo === "status") {
    x = RANK[statusDe(a).chave];
    y = RANK[statusDe(b).chave];
  }
  if (x == null && y == null) return nomes;
  if (x == null) return 1;
  if (y == null) return -1;
  return (x - y) * dir || nomes;
}

function criarLinha() {
  const r = {
    nome: h("strong"),
    id: h("code"),
    teste: h("span", { class: "chip" }, "Teste"),
    estado: h("td"),
    t: h("strong"),
    tl: h("em"),
    tb: h("i"),
    u: h("strong"),
    ul: h("em"),
    ub: h("i"),
    spark: h("td", { class: "c-tendencia" }),
    ultima: h("td", { class: "c-ultima" }),
  };
  const tr = h(
    "tr",
    {},
    h("td", { class: "c-nome" }, r.nome, h("small", {}, r.id, r.teste)),
    r.estado,
    h("td", { class: "c-medida" }, r.t, h("span", { class: "barra" }, r.tb), r.tl),
    h("td", { class: "c-medida" }, r.u, h("span", { class: "barra umid" }, r.ub), r.ul),
    r.spark,
    r.ultima,
    h(
      "td",
      { class: "c-acoes" },
      h("button", { type: "button", class: "botao-link", "data-acao": "ver" }, "Detalhes"),
      h("button", { type: "button", class: "botao-link perigo", "data-acao": "remover" }, "Remover")
    )
  );
  tr._r = r;
  return tr;
}

function atualizarLinha(tr, d) {
  const r = tr._r;
  const st = statusDe(d);
  const cfg = estado.config;
  r.nome.textContent = d.nome;
  r.id.textContent = d.id;
  r.teste.hidden = !d.simulado;
  if (r.estado.dataset.k !== st.chave) {
    r.estado.dataset.k = st.chave;
    r.estado.replaceChildren(selo(st));
  }
  const tem = d.temperatura != null;
  r.t.textContent = tem ? `${num(d.temperatura)} °C` : "—";
  r.tl.textContent = `limite ${lim(cfg.limite_temp)} °C`;
  r.tb.style.width = tem ? `${Math.min(100, Math.max(3, ((d.temperatura - 10) / 35) * 100))}%` : "0";
  r.tb.parentNode.className = "barra" + (tem && d.temperatura > cfg.limite_temp ? " alerta" : "");
  r.u.textContent = tem ? `${num(d.umidade)} %` : "—";
  r.ul.textContent = `mínimo ${lim(cfg.limite_umid)} %`;
  r.ub.style.width = tem ? `${Math.min(100, Math.max(3, d.umidade))}%` : "0";
  r.ub.parentNode.className = "barra umid" + (tem && d.umidade < cfg.limite_umid ? " alerta" : "");
  const chaveSpark = d.historico.join(",");
  if (r.spark.dataset.k !== chaveSpark) {
    r.spark.dataset.k = chaveSpark;
    r.spark.replaceChildren(sparkline(d.historico));
  }
  r.ultima.textContent = d.atraso == null ? "—" : ha(d.atraso);
}

function renderTabela() {
  const lista = filtrados().sort(comparar);
  sincronizar($("tabela-dispositivos"), lista, (d) => d.id, criarLinha, atualizarLinha);
  const vazio = $("tabela-vazia");
  vazio.hidden = lista.length > 0;
  if (lista.length) return;
  if (!estado.carregado) vazio.textContent = estado.erro || "Carregando dispositivos…";
  else if (!estado.dispositivos.length) vazio.textContent = "Nenhum dispositivo cadastrado. Clique em Adicionar para começar.";
  else vazio.textContent = "Nenhum dispositivo encontrado com esse filtro.";
}

function renderFiltros() {
  const contagem = { todos: estado.dispositivos.length, online: 0, alerta: 0, offline: 0, aguardando: 0 };
  estado.dispositivos.forEach((d) => {
    const c = statusDe(d).chave;
    if (c === "ok" || c === "alerta") contagem.online++;
    if (c === "alerta") contagem.alerta++;
    if (c === "off") contagem.offline++;
    if (c === "espera") contagem.aguardando++;
  });
  $$("#filtros button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.filtro === estado.filtro));
    b.querySelector("b").textContent = contagem[b.dataset.filtro];
  });
  $$("th[data-campo]").forEach((th) => {
    th.setAttribute("aria-sort", th.dataset.campo === estado.ordem.campo ? (estado.ordem.dir === 1 ? "ascending" : "descending") : "none");
  });
}

function mediaSerie(campo) {
  const series = estado.dispositivos.filter(online).map((d) => d[campo]).filter((s) => s.length);
  if (!series.length) return [];
  const n = Math.max(...series.map((s) => s.length));
  const saida = [];
  for (let i = n - 1; i >= 0; i--) {
    const vs = series.map((s) => s[s.length - 1 - i]).filter((v) => v !== undefined);
    saida.push(vs.reduce((a, b) => a + b, 0) / vs.length);
  }
  return saida;
}

function renderKpis() {
  const total = estado.dispositivos.length;
  const ligados = estado.dispositivos.filter(online);
  const med = (campo) => (ligados.length ? ligados.reduce((s, d) => s + d[campo], 0) / ligados.length : null);
  const nota = ligados.length ? `${ligados.length} dispositivo${ligados.length === 1 ? "" : "s"} online` : "Nenhum dispositivo online";
  const t = med("temperatura");
  const u = med("umidade");
  $("kpi-temp").textContent = t == null ? "—" : `${num(t)} °C`;
  $("kpi-temp-nota").textContent = nota;
  $("kpi-umid").textContent = u == null ? "—" : `${num(u)} %`;
  $("kpi-umid-nota").textContent = nota;
  const sT = mediaSerie("historico").join(",");
  const sU = mediaSerie("historico_umid").join(",");
  const eT = $("kpi-temp-spark");
  const eU = $("kpi-umid-spark");
  if (eT.dataset.k !== sT) {
    eT.dataset.k = sT;
    eT.replaceChildren(sparkline(mediaSerie("historico")));
  }
  if (eU.dataset.k !== sU) {
    eU.dataset.k = sU;
    eU.replaceChildren(sparkline(mediaSerie("historico_umid")));
  }
  $("kpi-online").textContent = total ? `${ligados.length}/${total}` : "—";
  const fora = total - ligados.length;
  $("kpi-online-nota").textContent = !total ? "Nenhum dispositivo cadastrado" : fora ? `${fora} sem comunicar` : "Todos comunicando agora";
  ajustarAnel($("kpi-anel"), total ? ligados.length / total : 0);
  const a = estado.alertas;
  $("kpi-alertas").textContent = num(a.total, 0);
  $("kpi-alertas").classList.toggle("com-alertas", a.ultimas_24h > 0);
  $("kpi-alertas-nota").textContent = a.ultimas_24h ? `${a.ultimas_24h} nas últimas 24 h` : "Nenhum nas últimas 24 h";
}

function criarRede() {
  const r = { nome: h("strong"), sub: h("small"), t: h("b"), u: h("b") };
  r.botao = h(
    "button",
    { class: "rede-item", type: "button" },
    h("span", { class: "ponto" }),
    h("span", { class: "rede-nome" }, r.nome, r.sub),
    h("span", { class: "rede-valores" }, r.t, r.u)
  );
  const li = h("li", {}, r.botao);
  li._r = r;
  return li;
}

function atualizarRede(li, d) {
  const r = li._r;
  const st = statusDe(d);
  r.botao.className = "rede-item" + (st.chave === "ok" ? "" : " " + st.chave);
  li.classList.toggle("selecionado", d.id === estado.selecionado);
  r.nome.textContent = d.nome;
  r.sub.textContent = `${st.rotulo} · ${ha(d.atraso)}`;
  r.t.textContent = d.temperatura == null ? "—" : `${num(d.temperatura)} °C`;
  r.u.textContent = d.umidade == null ? "—" : `${num(d.umidade)} %`;
}

function renderRede() {
  const n = estado.dispositivos.length;
  sincronizar($("rede"), estado.dispositivos, (d) => d.id, criarRede, atualizarRede);
  $("contagem").textContent = `${n} sensor${n === 1 ? "" : "es"}`;
  $("rede-vazia").hidden = n > 0;
}

function renderSelect() {
  const select = $("grafico-dispositivo");
  const chave = estado.dispositivos.map((d) => `${d.id}:${d.nome}`).join("|");
  if (select.dataset.k !== chave) {
    select.dataset.k = chave;
    select.replaceChildren(...estado.dispositivos.map((d) => new Option(d.nome, d.id)));
  }
  select.disabled = !estado.dispositivos.length;
  if (estado.selecionado) select.value = estado.selecionado;
}

function renderGrafico() {
  const d = dispositivo(estado.selecionado);
  grafico.pontos = estado.historico;
  grafico.janela = estado.janela;
  grafico.fim = fimDe(estado.historico, d);
  const rotulo = $("janelas").querySelector(`[data-janela="${estado.janela}"]`).textContent;
  $("grafico-sub").textContent = d ? `${d.nome} · últimos ${rotulo}` : "Temperatura e umidade ao longo do tempo";
  $$("#janelas button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.janela) === estado.janela)));
  resumo(estado.historico, "st-");
  desenhar(grafico);
}

function renderAlertas() {
  const a = estado.alertas;
  const nome = (id) => (dispositivo(id) || {}).nome;
  $("al-24h").textContent = num(a.ultimas_24h, 0);
  $("al-total").textContent = num(a.total, 0);
  $("al-limites").textContent = `> ${lim(estado.config.limite_temp)} °C · < ${lim(estado.config.limite_umid)} %`;
  const nav = $("nav-alertas");
  nav.hidden = !a.ultimas_24h;
  nav.textContent = a.ultimas_24h > 99 ? "99+" : a.ultimas_24h;

  const recentes = $("alertas-recentes");
  if (!a.itens.length) {
    recentes.replaceChildren(h("li", { class: "vazio" }, "Nenhum alerta registrado."));
  } else {
    if (recentes.firstElementChild && recentes.firstElementChild.classList.contains("vazio")) recentes.replaceChildren();
    sincronizar(
      recentes,
      a.itens.slice(0, 5),
      (i) => i.id,
      () => h("li", {}, h("span"), h("time")),
      (li, i) => {
        li.firstElementChild.textContent = i.mensagem;
        li.lastElementChild.textContent = dataHora(i.criado_em);
      }
    );
  }

  $("alertas-vazio").hidden = a.itens.length > 0;
  sincronizar(
    $("tabela-alertas"),
    a.itens,
    (i) => i.id,
    () => h("tr", {}, h("td", { class: "c-hora" }), h("td", {}, h("span", { class: "tipo" })), h("td")),
    (tr, i) => {
      tr.children[0].textContent = dataHora(i.criado_em);
      const tipo = tr.children[1].firstElementChild;
      tipo.className = "tipo" + (i.tipo === "umidade" ? " umidade" : "");
      tipo.textContent = i.tipo === "umidade" ? "Umidade" : "Temperatura";
      tr.children[2].textContent = i.mensagem + (i.dispositivo_id && !nome(i.dispositivo_id) ? " (removido)" : "");
    }
  );
}

function renderConfig() {
  if (!estado.configPreenchida) {
    $("cfg-temp").value = estado.config.limite_temp;
    $("cfg-umid").value = estado.config.limite_umid;
    $("cfg-offline").value = estado.config.offline_s;
    estado.configPreenchida = true;
  }
  $("exportar-vazio").hidden = estado.dispositivos.length > 0;
  sincronizar(
    $("lista-exportar"),
    estado.dispositivos,
    (d) => d.id,
    () => {
      const li = h("li", {}, h("span", {}, h("strong"), h("small")), h("a", { class: "botao-sec", download: "" }, "Baixar CSV"));
      return li;
    },
    (li, d) => {
      li.querySelector("strong").textContent = d.nome;
      li.querySelector("small").textContent = d.id;
      li.querySelector("a").href = `${SERVIDOR}/api/exportar/${encodeURIComponent(d.id)}`;
    }
  );
}

function montarGaveta() {
  const temp = criarAnel("anel");
  const umid = criarAnel("anel");
  const r = {
    nome: h("h2"),
    id: h("code"),
    teste: h("span", { class: "chip" }, "Teste"),
    estado: h("span"),
    ultima: h("span"),
    t: h("strong"),
    u: h("strong"),
    anelT: temp.valor,
    anelU: umid.valor,
    medT: h("figure", { class: "medidor" }, temp.svg),
    medU: h("figure", { class: "medidor umid" }, umid.svg),
    canvas: h("canvas", { role: "img", "aria-label": "Gráfico dos últimos 5 minutos" }),
    exportar: h("a", { class: "botao-sec", download: "" }, "Exportar CSV"),
    remover: h("button", { type: "button", class: "botao-perigo" }, "Remover"),
  };
  r.medT.append(r.t, h("small", {}, "Temperatura"));
  r.medU.append(r.u, h("small", {}, "Umidade"));
  const estat = (id, rotulo, classe) => h("li", { class: classe }, h("small", {}, rotulo), h("strong", { id: "g-st-" + id }, "—"));
  const fechar = h("button", { type: "button", class: "icone-botao", "data-fechar": "", "aria-label": "Fechar" }, "✕");
  $("gaveta-conteudo").replaceChildren(
    h("header", { class: "gaveta-topo" }, h("hgroup", {}, r.nome, h("p", {}, r.id, r.teste)), fechar),
    h("p", { class: "gaveta-status" }, r.estado, r.ultima),
    h("section", { class: "medidores" }, r.medT, r.medU),
    h("figure", { class: "grafico-caixa" }, r.canvas),
    h(
      "ul",
      { class: "estatisticas" },
      estat("tmin", "Temp. mínima", "e-temp"),
      estat("tmed", "Temp. média", "e-temp"),
      estat("tmax", "Temp. máxima", "e-temp"),
      estat("umin", "Umid. mínima", "e-umid"),
      estat("umed", "Umid. média", "e-umid"),
      estat("umax", "Umid. máxima", "e-umid")
    ),
    h("footer", { class: "gaveta-rodape" }, r.exportar, r.remover)
  );
  graficoGaveta = criarGrafico(r.canvas, () => "Sem leituras nos últimos 5 minutos");
  graficoGaveta.janela = 300;
  $("gaveta")._r = r;
  r.remover.addEventListener("click", () => {
    const d = dispositivo(estado.gaveta);
    if (d) remover(d);
  });
}

function renderGaveta() {
  if (!estado.gaveta) return;
  const d = dispositivo(estado.gaveta);
  if (!d) {
    $("gaveta").close();
    return;
  }
  const r = $("gaveta")._r;
  const st = statusDe(d);
  const cfg = estado.config;
  const tem = d.temperatura != null;
  r.nome.textContent = d.nome;
  r.id.textContent = d.id;
  r.teste.hidden = !d.simulado;
  if (r.estado.dataset.k !== st.chave) {
    r.estado.dataset.k = st.chave;
    r.estado.replaceChildren(selo(st));
  }
  r.ultima.textContent = `Última leitura: ${ha(d.atraso)}`;
  r.t.textContent = tem ? `${num(d.temperatura)} °C` : "—";
  r.u.textContent = tem ? `${num(d.umidade)} %` : "—";
  ajustarAnel(r.anelT, tem ? d.temperatura / 50 : 0);
  ajustarAnel(r.anelU, tem ? d.umidade / 100 : 0);
  r.medT.className = "medidor" + (tem && d.temperatura > cfg.limite_temp ? " alerta" : "");
  r.medU.className = "medidor umid" + (tem && d.umidade < cfg.limite_umid ? " alerta" : "");
  r.exportar.href = `${SERVIDOR}/api/exportar/${encodeURIComponent(d.id)}`;
  graficoGaveta.pontos = estado.historicoGaveta;
  graficoGaveta.fim = fimDe(estado.historicoGaveta, d);
  resumo(estado.historicoGaveta, "g-st-");
  desenhar(graficoGaveta);
}

function render() {
  renderKpis();
  renderRede();
  renderSelect();
  renderGrafico();
  renderFiltros();
  renderTabela();
  renderAlertas();
  renderConfig();
  renderGaveta();
  $("nav-dispositivos").textContent = estado.dispositivos.length;
}

let sequencia = 0;
let sequenciaGaveta = 0;

async function carregarHistorico() {
  const id = estado.selecionado;
  if (!id) {
    estado.historico = [];
    return;
  }
  const minha = ++sequencia;
  const dados = await api(`/leituras/${encodeURIComponent(id)}?janela=${estado.janela}`);
  if (minha === sequencia) estado.historico = dados;
}

async function carregarHistoricoGaveta() {
  const id = estado.gaveta;
  if (!id) return;
  const minha = ++sequenciaGaveta;
  const dados = await api(`/leituras/${encodeURIComponent(id)}?janela=300`);
  if (minha === sequenciaGaveta && id === estado.gaveta) estado.historicoGaveta = dados;
}

function definirConexao(ok, texto) {
  $("status-servidor").classList.toggle("sem-servidor", !ok);
  $("modo").textContent = ok ? "Servidor online" : "Servidor offline";
  $("atualizado").textContent = texto;
}

let ocupado = false;
let refazer = false;

async function atualizar() {
  if (ocupado) {
    refazer = true;
    return;
  }
  ocupado = true;
  try {
    const [dispositivos, alertas, config] = await Promise.all([
      api("/dispositivos"),
      api(`/alertas?limite=${estado.vista === "alertas" ? 100 : 6}`),
      api("/config"),
    ]);
    estado.dispositivos = dispositivos;
    estado.alertas = alertas;
    estado.config = config;
    estado.carregado = true;
    estado.erro = "";
    if (!dispositivo(estado.selecionado)) {
      estado.selecionado = dispositivos.length ? dispositivos[0].id : null;
      estado.historico = [];
    }
    const tarefas = [];
    if (estado.vista === "visao-geral") tarefas.push(carregarHistorico());
    if (estado.gaveta) tarefas.push(carregarHistoricoGaveta());
    await Promise.all(tarefas);
    definirConexao(true, `Atualizado às ${hora(Date.now() / 1000)}`);
    render();
  } catch (e) {
    estado.erro = e.message;
    definirConexao(false, "Sem conexão");
    renderTabela();
  } finally {
    ocupado = false;
    if (refazer) {
      refazer = false;
      atualizar();
    }
  }
}

function rotear() {
  let v = location.hash.slice(1);
  if (!VISTAS[v]) v = "visao-geral";
  estado.vista = v;
  $$(".vista").forEach((s) => {
    s.hidden = s.dataset.vista !== v;
  });
  $$("[data-link]").forEach((a) => {
    if (a.dataset.link === v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("titulo-pagina").textContent = VISTAS[v][0];
  $("subtitulo-pagina").textContent = VISTAS[v][1];
  document.title = `${VISTAS[v][0]} | MIOT`;
  document.body.classList.remove("menu-aberto");
  window.scrollTo(0, 0);
  if (estado.carregado) render();
  atualizar();
  requestAnimationFrame(redesenhar);
}

function selecionar(id) {
  estado.selecionado = id;
  estado.historico = [];
  renderSelect();
  renderRede();
  renderGrafico();
  atualizar();
}

function abrirGaveta(id) {
  estado.gaveta = id;
  estado.historicoGaveta = [];
  montarGaveta();
  renderGaveta();
  $("gaveta").showModal();
  atualizar();
}

async function remover(d) {
  const ok = await confirmar(`Remover "${d.nome}" e todo o histórico dele? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  try {
    await api(`/dispositivos/${encodeURIComponent(d.id)}`, { method: "DELETE" });
    aviso("Dispositivo removido");
    if (estado.gaveta === d.id) $("gaveta").close();
    if (estado.selecionado === d.id) estado.selecionado = null;
    atualizar();
  } catch (e) {
    aviso(e.message);
  }
}

function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  try {
    localStorage.setItem("miot-tema", tema);
  } catch {}
  document.querySelector('meta[name="theme-color"]').content = tema === "claro" ? "#eef2f8" : "#080e1a";
  redesenhar();
}

function iniciarTema() {
  let tema = "";
  try {
    tema = localStorage.getItem("miot-tema") || "";
  } catch {}
  if (!tema) tema = "escuro";
  aplicarTema(tema);
}

$("alternar-tema").addEventListener("click", () => aplicarTema(document.documentElement.dataset.tema === "claro" ? "escuro" : "claro"));
$("abrir-menu").addEventListener("click", () => document.body.classList.add("menu-aberto"));
$("fundo-menu").addEventListener("click", () => document.body.classList.remove("menu-aberto"));
window.addEventListener("hashchange", rotear);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) atualizar();
});

$("busca").addEventListener("input", (e) => {
  estado.busca = e.target.value;
  if (estado.vista !== "dispositivos") location.hash = "#dispositivos";
  else renderTabela();
});

$("filtros").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  estado.filtro = b.dataset.filtro;
  renderFiltros();
  renderTabela();
});

document.querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-campo]");
  if (!th) return;
  const campo = th.dataset.campo;
  estado.ordem = { campo, dir: estado.ordem.campo === campo ? -estado.ordem.dir : 1 };
  renderFiltros();
  renderTabela();
});

$("tabela-dispositivos").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const d = dispositivo(tr.dataset.chave);
  if (!d) return;
  if (e.target.closest('[data-acao="remover"]')) remover(d);
  else abrirGaveta(d.id);
});

$("rede").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) selecionar(li.dataset.chave);
});

$("grafico-dispositivo").addEventListener("change", (e) => selecionar(e.target.value));

$("janelas").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  estado.janela = Number(b.dataset.janela);
  estado.historico = [];
  renderGrafico();
  atualizar();
});

$$("[data-abrir]").forEach((b) =>
  b.addEventListener("click", () => {
    $(b.dataset.abrir).showModal();
    $("campo-nome").focus();
  })
);

$$("dialog").forEach((m) => {
  m.addEventListener("click", (e) => {
    if (e.target === m) m.close();
    if (e.target.closest("[data-fechar]")) m.close();
  });
});

$("gaveta").addEventListener("close", () => {
  estado.gaveta = null;
  estado.historicoGaveta = [];
  graficoGaveta = null;
});

$("modal-adicionar").addEventListener("close", () => {
  $("form-dispositivo").reset();
  $("form-erro").textContent = "";
});

$("form-dispositivo").addEventListener("submit", async (e) => {
  e.preventDefault();
  const corpo = { nome: $("campo-nome").value.trim(), simulado: $("campo-simulado").checked };
  const id = $("campo-id").value.trim();
  if (id) corpo.id = id;
  $("form-erro").textContent = "";
  try {
    const criado = await api("/dispositivos", { method: "POST", body: JSON.stringify(corpo) });
    $("modal-adicionar").close();
    estado.selecionado = criado.id;
    estado.historico = [];
    aviso(`"${criado.nome}" cadastrado`);
    atualizar();
  } catch (err) {
    $("form-erro").textContent = err.message;
  }
});

$("form-config").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("cfg-msg");
  msg.className = "mensagem";
  try {
    await api("/config", {
      method: "POST",
      body: JSON.stringify({
        limite_temp: parseFloat($("cfg-temp").value),
        limite_umid: parseFloat($("cfg-umid").value),
        offline_s: parseFloat($("cfg-offline").value),
      }),
    });
    msg.textContent = "Limites salvos.";
    msg.classList.add("ok");
    aviso("Configurações salvas");
    atualizar();
  } catch (err) {
    msg.textContent = err.message;
  }
});

iniciarTema();
rotear();
setInterval(() => {
  if (!document.hidden) atualizar();
}, 2000);