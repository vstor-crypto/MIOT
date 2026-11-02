"use strict";

(() => {
  const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
  const $$ = (seletor, raiz = document) => [...raiz.querySelectorAll(seletor)];

  let BASE = location.protocol === "file:" ? "http://localhost:8000" : "";
  let apiConfirmada = false;
  const INTERVALO = 2000;
  const CIRCUNFERENCIA = 2 * Math.PI * 50;
  const ROTULO = { ok: "Online", alerta: "Em atenção", off: "Offline", espera: "Aguardando" };
  const CLASSE_REDE = { ok: "", alerta: "alerta", off: "off", espera: "espera" };
  const RANK = { alerta: 0, off: 1, espera: 2, ok: 3 };
  const JANELAS = { 60: "1 min", 300: "5 min", 900: "15 min", 3600: "1 h" };
  const VISTAS = ["visao-geral", "dispositivos", "alertas", "integracao", "configuracoes"];
  const TITULOS = {
    "visao-geral": "Visão geral",
    dispositivos: "Dispositivos",
    alertas: "Alertas",
    integracao: "Integração",
    configuracoes: "Configurações",
  };

  const fmt1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtHoraCurta = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const fmtData = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const temp = (v) => (v == null ? "—" : `${fmt1.format(v)} °C`);
  const umid = (v) => (v == null ? "—" : `${fmt1.format(v)} %`);
  const hora = (ts) => fmtHora.format(new Date(ts * 1000));

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const normalizar = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const gerarId = (s) => normalizar(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const msgBR = (m) => String(m).replace(/\((-?\d+)\.(\d) /, "($1,$2 ");

  function relativo(s) {
    if (s == null) return "sem leituras";
    if (s < 3) return "agora";
    if (s < 60) return `há ${s} s`;
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    return `há ${Math.floor(s / 86400)} d`;
  }

  function ler(chave) {
    try { return localStorage.getItem(chave); } catch { return null; }
  }
  function guardar(chave, valor) {
    try { localStorage.setItem(chave, valor); } catch {}
  }

  function setHTML(el, html) {
    if (!el || el._html === html) return;
    el._html = html;
    const foco = el.contains(document.activeElement) ? document.activeElement.dataset.foco : null;
    el.innerHTML = html;
    if (foco) $(`[data-foco="${CSS.escape(foco)}"]`, el)?.focus({ preventScroll: true });
  }
  function setTexto(el, texto) {
    if (el && el.textContent !== texto) el.textContent = texto;
  }

  class ErroApi extends Error {
    constructor(mensagem, status) {
      super(mensagem);
      this.status = status;
    }
  }

  async function api(caminho, opcoes = {}) {
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), 6000);
    try {
      const res = await fetch(BASE + caminho, { ...opcoes, signal: controle.signal });
      let dados = null;
      if (res.status !== 204) {
        try { dados = await res.json(); } catch { dados = null; }
      }
      if (!res.ok && (res.status === 404 || res.status === 405) && caminho.startsWith("/api/") && !apiConfirmada && !opcoes.tentou) {
        if (BASE === "") BASE = `${location.protocol}//${location.hostname}:8000`;
        return api(caminho, { ...opcoes, tentou: true });
      }
      if (res.ok) apiConfirmada = true;
      if (!res.ok) throw new ErroApi(dados?.erro || `Erro ${res.status} no servidor.`, res.status);
      return dados;
    } catch (e) {
      if (e instanceof ErroApi) throw e;
      throw new ErroApi("Sem conexão com o servidor.", 0);
    } finally {
      clearTimeout(limite);
    }
  }

  const enviar = (metodo, caminho, corpo) =>
    api(caminho, {
      method: metodo,
      headers: corpo ? { "Content-Type": "application/json" } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });

  const buscarLeituras = (id, janela) => api(`/api/leituras/${encodeURIComponent(id)}?janela=${janela}`);

  const estado = {
    dispositivos: [],
    alertas: { total: 0, ultimas_24h: 0, itens: [] },
    config: { limite_temp: 30, limite_umid: 30, offline_s: 8 },
    carregado: false,
    conectado: true,
    ultimaOk: null,
    vista: "visao-geral",
    filtro: "todos",
    busca: "",
    ordem: { campo: "nome", dir: 1 },
    selecionado: ler("miot:selecionado"),
    janela: JANELAS[Number(ler("miot:janela"))] ? Number(ler("miot:janela")) : 300,
    leituras: [],
    carregandoGrafico: true,
    gaveta: null,
    leiturasGaveta: [],
    testeId: null,
    amostra: "curl",
    ultimoAlerta: null,
    alertaVisto: ler("miot:alertas-vistos") === null ? null : Number(ler("miot:alertas-vistos")),
  };

  const achar = (id) => estado.dispositivos.find((d) => d.id === id);

  function statusDe(d) {
    if (d.temperatura == null) return "espera";
    if (d.atraso > estado.config.offline_s) return "off";
    return d.alerta ? "alerta" : "ok";
  }

  function motivos(d) {
    const m = [];
    if (d.temperatura != null && d.temperatura > estado.config.limite_temp) m.push("Temperatura alta");
    if (d.umidade != null && d.umidade < estado.config.limite_umid) m.push("Umidade baixa");
    return m;
  }

  const online = (d) => d.estado === "ok" || d.estado === "alerta";
  const escalaTemp = () => Math.max(50, estado.config.limite_temp * 1.2);

  function estatistica(pontos, campo) {
    if (!pontos.length) return null;
    let mn = Infinity, mx = -Infinity, soma = 0;
    for (const p of pontos) {
      const v = p[campo];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      soma += v;
    }
    return { mn, mx, md: soma / pontos.length };
  }

  let corCache = null;
  function cores() {
    if (corCache) return corCache;
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    corCache = {
      temp: v("--temp"), umid: v("--umid"), texto: v("--texto"), muted: v("--muted"),
      linha: v("--linha-suave"), fundo: v("--elevada"), borda: v("--linha"),
      mono: v("--mono") || "monospace",
    };
    return corCache;
  }

  function eixo(valores, vaoMinimo, piso) {
    let lo = Math.min(...valores), hi = Math.max(...valores);
    if (hi - lo < vaoMinimo) {
      const meio = (lo + hi) / 2;
      lo = meio - vaoMinimo / 2;
      hi = meio + vaoMinimo / 2;
    }
    const folga = (hi - lo) * 0.1;
    lo -= folga;
    hi += folga;
    if (piso !== undefined) lo = Math.max(lo, piso);
    const mag = 10 ** Math.floor(Math.log10((hi - lo) / 4));
    for (const f of [1, 2, 2.5, 5, 10, 20, 50]) {
      const passo = f * mag;
      const min = Math.floor(lo / passo) * passo;
      if (min + 4 * passo >= hi) return { min, max: min + 4 * passo, passo };
    }
    return { min: lo, max: hi, passo: (hi - lo) / 4 };
  }

  const num = (v, casas) => v.toFixed(casas).replace(".", ",");

  class Grafico {
    constructor(canvas) {
      this.c = canvas;
      this.g = canvas.getContext("2d");
      this.pontos = [];
      this.janela = 300;
      this.cfg = estado.config;
      this.msg = "";
      this.hover = -1;
      this.geo = null;
      this.ro = new ResizeObserver(() => this.desenhar());
      this.ro.observe(canvas);
      canvas.addEventListener("pointermove", (e) => this.mover(e));
      canvas.addEventListener("pointerleave", () => { this.hover = -1; this.desenhar(); });
    }

    destruir() { this.ro.disconnect(); }

    definir(pontos, janela, msg) {
      this.pontos = pontos;
      this.janela = janela;
      this.msg = msg;
      if (this.hover >= pontos.length) this.hover = -1;
      this.desenhar();
    }

    mover(e) {
      if (!this.geo || !this.pontos.length) return;
      const { m, W, xa, span, pw } = this.geo;
      const x = e.clientX - this.c.getBoundingClientRect().left;
      if (x < m.l - 8 || x > W - m.r + 8) {
        if (this.hover !== -1) { this.hover = -1; this.desenhar(); }
        return;
      }
      const t = xa + ((x - m.l) / pw) * span;
      let melhor = 0, dist = Infinity;
      for (let i = 0; i < this.pontos.length; i++) {
        const d = Math.abs(this.pontos[i].criado_em - t);
        if (d < dist) { dist = d; melhor = i; }
      }
      if (melhor !== this.hover) { this.hover = melhor; this.desenhar(); }
    }

    desenhar() {
      const c = this.c;
      const r = c.getBoundingClientRect();
      const W = r.width, H = r.height;
      if (!W || !H) return;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const g = this.g, k = cores(), d = this.pontos;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      g.font = `11px ${k.mono}`;
      g.textBaseline = "middle";

      if (!d.length) {
        g.fillStyle = k.muted;
        g.textAlign = "center";
        g.fillText(this.msg || "Sem leituras neste período.", W / 2, H / 2);
        this.geo = null;
        return;
      }

      const lado = W < 480 ? 36 : 44;
      const m = { l: lado, r: lado, t: 18, b: 26 };
      const pw = W - m.l - m.r, ph = H - m.t - m.b;
      const x1 = d[d.length - 1].criado_em;
      const span = Math.min(Math.max(x1 - d[0].criado_em, 10), this.janela);
      const xa = x1 - span;
      const X = (t) => m.l + ((t - xa) / span) * pw;
      const et = eixo(d.map((p) => p.temperatura), 2);
      const eu = eixo(d.map((p) => p.umidade), 5, 0);
      const YT = (v) => m.t + ph - ((v - et.min) / (et.max - et.min)) * ph;
      const YU = (v) => m.t + ph - ((v - eu.min) / (eu.max - eu.min)) * ph;
      this.geo = { m, W, xa, span, pw };

      const decT = et.passo < 1 ? 1 : 0, decU = eu.passo < 1 ? 1 : 0;
      g.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = Math.round(m.t + ph - (ph * i) / 4) + 0.5;
        g.strokeStyle = k.linha;
        g.beginPath(); g.moveTo(m.l, y); g.lineTo(W - m.r, y); g.stroke();
        g.fillStyle = k.temp; g.textAlign = "right";
        g.fillText(num(et.min + et.passo * i, decT), m.l - 8, y);
        g.fillStyle = k.umid; g.textAlign = "left";
        g.fillText(num(eu.min + eu.passo * i, decU), W - m.r + 8, y);
      }
      g.fillStyle = k.temp; g.textAlign = "right"; g.fillText("°C", m.l - 8, 7);
      g.fillStyle = k.umid; g.textAlign = "left"; g.fillText("%", W - m.r + 8, 7);

      const ticks = W < 480 ? 3 : 5;
      const fmtT = span > 1200 ? fmtHoraCurta : fmtHora;
      g.fillStyle = k.muted;
      for (let i = 0; i < ticks; i++) {
        const t = xa + (span * i) / (ticks - 1);
        g.textAlign = i === 0 ? "left" : i === ticks - 1 ? "right" : "center";
        g.fillText(fmtT.format(new Date(t * 1000)), X(t), H - 9);
      }

      const limite = (v, Y, e, cor, rotulo) => {
        if (v < e.min || v > e.max) return;
        const y = Math.round(Y(v)) + 0.5;
        g.save();
        g.setLineDash([5, 4]); g.strokeStyle = cor; g.globalAlpha = 0.75;
        g.beginPath(); g.moveTo(m.l, y); g.lineTo(W - m.r, y); g.stroke();
        g.restore();
        g.fillStyle = cor; g.textAlign = "left";
        g.fillText(rotulo, m.l + 6, y - 8);
      };
      limite(this.cfg.limite_temp, YT, et, k.temp, "limite máx.");
      limite(this.cfg.limite_umid, YU, eu, k.umid, "limite mín.");

      const passos = d.slice(1).map((p, i) => p.criado_em - d[i].criado_em).sort((a, b) => a - b);
      const mediana = passos.length ? passos[passos.length >> 1] : 2;
      const buraco = Math.max(30, mediana * 5);
      const trechos = [[]];
      d.forEach((p, i) => {
        if (i && p.criado_em - d[i - 1].criado_em > buraco) trechos.push([]);
        trechos[trechos.length - 1].push(p);
      });

      const serie = (campo, Y, cor, area) => {
        g.save();
        g.beginPath(); g.rect(m.l, m.t - 2, pw, ph + 4); g.clip();
        g.strokeStyle = cor; g.fillStyle = cor; g.lineWidth = 2; g.lineJoin = "round";
        for (const t of trechos) {
          if (t.length === 1) {
            g.beginPath(); g.arc(X(t[0].criado_em), Y(t[0][campo]), 2.5, 0, Math.PI * 2); g.fill();
            continue;
          }
          g.beginPath();
          t.forEach((p, i) => (i ? g.lineTo(X(p.criado_em), Y(p[campo])) : g.moveTo(X(p.criado_em), Y(p[campo]))));
          g.stroke();
          if (area) {
            g.lineTo(X(t[t.length - 1].criado_em), m.t + ph);
            g.lineTo(X(t[0].criado_em), m.t + ph);
            g.closePath();
            g.globalAlpha = 0.1; g.fill(); g.globalAlpha = 1;
          }
        }
        g.restore();
      };
      serie("umidade", YU, k.umid, false);
      serie("temperatura", YT, k.temp, true);

      const alvo = this.hover >= 0 ? d[this.hover] : null;
      const px = X((alvo || d[d.length - 1]).criado_em);
      const ponto = (p) => {
        for (const [Y, campo, cor] of [[YU, "umidade", k.umid], [YT, "temperatura", k.temp]]) {
          g.beginPath(); g.arc(px, Y(p[campo]), 4, 0, Math.PI * 2);
          g.fillStyle = cor; g.fill();
          g.lineWidth = 2; g.strokeStyle = k.fundo; g.stroke();
        }
      };
      if (!alvo) { ponto(d[d.length - 1]); return; }

      g.save();
      g.setLineDash([3, 3]); g.strokeStyle = k.muted; g.lineWidth = 1;
      g.beginPath(); g.moveTo(px, m.t); g.lineTo(px, m.t + ph); g.stroke();
      g.restore();
      ponto(alvo);

      const linhas = [
        [k.muted, fmtData.format(new Date(alvo.criado_em * 1000)), null],
        [k.temp, "Temperatura", temp(alvo.temperatura)],
        [k.umid, "Umidade", umid(alvo.umidade)],
      ];
      g.font = `11px ${k.mono}`;
      const larg = Math.max(...linhas.map(([, a, b]) => g.measureText(a + (b ? "   " + b : "")).width)) + 32;
      const alt = linhas.length * 17 + 12;
      const bx = px + 14 + larg > W - 4 ? px - 14 - larg : px + 14;
      const by = m.t + 6;
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, larg, alt, 8); else g.rect(bx, by, larg, alt);
      g.fillStyle = k.fundo; g.fill();
      g.lineWidth = 1; g.strokeStyle = k.borda; g.stroke();
      g.textAlign = "left";
      linhas.forEach(([cor, rotulo, valor], i) => {
        const y = by + 14 + i * 17;
        if (valor) {
          g.fillStyle = cor; g.beginPath(); g.arc(bx + 12, y, 3.5, 0, Math.PI * 2); g.fill();
          g.fillStyle = k.texto; g.fillText(`${rotulo}   ${valor}`, bx + 22, y);
        } else {
          g.fillStyle = cor; g.fillText(rotulo, bx + 12, y);
        }
      });
    }
  }

  let graficoPrincipal = null;
  let graficoGaveta = null;

  function spark(valores, vaoMinimo = 0.5, w = 110, h = 30) {
    if (!valores || valores.length < 2) return "";
    let lo = Math.min(...valores), hi = Math.max(...valores);
    if (hi - lo < vaoMinimo) {
      const meio = (lo + hi) / 2;
      lo = meio - vaoMinimo / 2;
      hi = meio + vaoMinimo / 2;
    }
    const pts = valores.map((v, i) =>
      `${((i / (valores.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
      `<path class="spark-area" d="M0,${h} L${pts.join(" L")} L${w},${h}Z"/>` +
      `<polyline class="spark-linha" points="${pts.join(" ")}"/></svg>`;
  }

  function mediaHistorico(lista, campo) {
    const n = Math.max(0, ...lista.map((d) => d[campo].length));
    const saida = [];
    for (let i = 1; i <= n; i++) {
      const vs = lista.map((d) => d[campo][d[campo].length - i]).filter((v) => v != null);
      if (vs.length) saida.unshift(vs.reduce((a, b) => a + b, 0) / vs.length);
    }
    return saida;
  }

  function filtrados() {
    const q = normalizar(estado.busca.trim());
    return estado.dispositivos.filter((d) => !q || normalizar(`${d.nome} ${d.id}`).includes(q));
  }

  const passaFiltro = (d) =>
    estado.filtro === "todos" || (estado.filtro === "online" ? online(d) : d.estado === estado.filtro);

  function ordenar(lista) {
    const { campo, dir } = estado.ordem;
    const chave = (d) => (campo === "status" ? RANK[d.estado] : d[campo]);
    return [...lista].sort((a, b) => {
      const x = chave(a), y = chave(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === "string"
        ? x.localeCompare(y, "pt-BR", { sensitivity: "base", numeric: true })
        : x - y;
      return r * dir || a.nome.localeCompare(b.nome, "pt-BR");
    });
  }

  function renderStatus() {
    const caixa = $("#status-servidor");
    caixa.classList.toggle("sem-servidor", !estado.conectado);
    setTexto($("#modo"), !estado.carregado && estado.conectado ? "Conectando…" : estado.conectado ? "Servidor conectado" : "Sem conexão");
    const ultima = estado.ultimaOk ? hora(estado.ultimaOk / 1000) : "";
    setTexto(
      $("#atualizado"),
      estado.conectado ? (ultima ? `Atualizado ${ultima}` : "Carregando…") : `Sem conexão · último dado às ${ultima || "—"}`,
    );
  }

  function renderNav() {
    setTexto($("#nav-dispositivos"), String(estado.dispositivos.length));
    const novos = estado.alertaVisto == null ? 0 : estado.alertas.itens.filter((i) => i.id > estado.alertaVisto).length;
    const selo = $("#nav-alertas");
    selo.hidden = novos === 0;
    setTexto(selo, novos > 99 ? "99+" : String(novos));
  }

  function renderTitulo() {
    setTexto($("#titulo-pagina"), TITULOS[estado.vista]);
    const n = estado.dispositivos.length;
    const subs = {
      "visao-geral": "rede em tempo real",
      dispositivos: `${n} ${n === 1 ? "sensor cadastrado" : "sensores cadastrados"}`,
      alertas: "histórico de ocorrências",
      integracao: "conecte sensores reais pela API",
      configuracoes: "limites de alerta e exportação",
    };
    setTexto($("#subtitulo-pagina"), subs[estado.vista]);
  }

  function preencherSelect(sel, desejado) {
    const assinatura = estado.dispositivos.map((d) => `${d.id}\u0000${d.nome}`).join("\u0001");
    if (sel._assinatura !== assinatura) {
      sel._assinatura = assinatura;
      sel.innerHTML = estado.dispositivos.length
        ? estado.dispositivos.map((d) => `<option value="${esc(d.id)}">${esc(d.nome)}</option>`).join("")
        : '<option value="">Nenhum dispositivo</option>';
      sel.disabled = !estado.dispositivos.length;
    }
    if (desejado && sel.value !== desejado && achar(desejado)) sel.value = desejado;
  }

  function renderSeletores() {
    preencherSelect($("#grafico-dispositivo"), estado.selecionado);
    if (!achar(estado.testeId)) estado.testeId = estado.dispositivos[0]?.id ?? null;
    preencherSelect($("#teste-dispositivo"), estado.testeId);
  }

  function renderKpis() {
    const todos = estado.dispositivos, on = todos.filter(online);
    const media = (campo) => (on.length ? on.reduce((s, d) => s + d[campo], 0) / on.length : null);
    const nota = on.length ? `${on.length} de ${todos.length} online` : "Nenhum dispositivo online";

    setTexto($("#kpi-temp"), temp(media("temperatura")));
    setTexto($("#kpi-umid"), umid(media("umidade")));
    setTexto($("#kpi-temp-nota"), nota);
    setTexto($("#kpi-umid-nota"), nota);
    setHTML($("#kpi-temp-spark"), spark(mediaHistorico(on, "historico"), 1));
    setHTML($("#kpi-umid-spark"), spark(mediaHistorico(on, "historico_umid"), 3));

    setTexto($("#kpi-online"), todos.length ? `${on.length}/${todos.length}` : "0");
    setTexto($("#kpi-online-nota"), todos.length ? "Sensores comunicando agora" : "Nenhum sensor cadastrado");
    $("#kpi-anel").style.strokeDasharray = `${todos.length ? (on.length / todos.length) * CIRCUNFERENCIA : 0} 400`;
    $("#kpi-anel").style.strokeOpacity = on.length ? "1" : "0";

    const total = estado.alertas.total;
    const alertasEl = $("#kpi-alertas");
    setTexto(alertasEl, String(total));
    alertasEl.classList.toggle("com-alertas", estado.alertas.ultimas_24h > 0);
    setTexto($("#kpi-alertas-nota"), `${estado.alertas.ultimas_24h} nas últimas 24 h`);
  }

  function renderRede() {
    const lista = filtrados();
    setHTML($("#rede"), lista.map((d) => {
      const e = d.estado;
      return `<li class="${d.id === estado.selecionado ? "selecionado" : ""}">` +
        `<button type="button" class="rede-item ${CLASSE_REDE[e]}" data-id="${esc(d.id)}" data-foco="rede:${esc(d.id)}" aria-pressed="${d.id === estado.selecionado}">` +
        `<span class="ponto"></span>` +
        `<span class="rede-nome"><strong>${esc(d.nome)}</strong><small>${ROTULO[e]} · ${relativo(d.atraso)}</small></span>` +
        `<span class="rede-valores"><b>${temp(d.temperatura)}</b><b>${umid(d.umidade)}</b></span>` +
        `</button></li>`;
    }).join(""));
    const n = estado.dispositivos.length;
    setTexto($("#contagem"), `${n} ${n === 1 ? "sensor" : "sensores"}`);
    const vazio = $("#rede-vazia");
    vazio.hidden = lista.length > 0;
    setTexto(vazio, n ? "Nenhum dispositivo encontrado na busca." : "Nenhum dispositivo cadastrado ainda.");
  }

  function renderAlertasRecentes() {
    const itens = estado.alertas.itens.slice(0, 5);
    setHTML(
      $("#alertas-recentes"),
      itens.length
        ? itens.map((i) => `<li><span>${esc(msgBR(i.mensagem))}</span><time datetime="${new Date(i.criado_em * 1000).toISOString()}">${fmtData.format(new Date(i.criado_em * 1000))}</time></li>`).join("")
        : '<li class="vazio">Nenhum alerta registrado.</li>',
    );
  }

  function renderGrafico() {
    const d = achar(estado.selecionado);
    setTexto($("#grafico-sub"), d ? `${d.nome} · últimos ${JANELAS[estado.janela]}` : "Temperatura e umidade ao longo do tempo");
    const et = estatistica(estado.leituras, "temperatura"), eu = estatistica(estado.leituras, "umidade");
    setTexto($("#st-tmin"), et ? temp(et.mn) : "—");
    setTexto($("#st-tmed"), et ? temp(et.md) : "—");
    setTexto($("#st-tmax"), et ? temp(et.mx) : "—");
    setTexto($("#st-umin"), eu ? umid(eu.mn) : "—");
    setTexto($("#st-umed"), eu ? umid(eu.md) : "—");
    setTexto($("#st-umax"), eu ? umid(eu.mx) : "—");

    const ultimo = estado.leituras[estado.leituras.length - 1];
    $("#grafico").setAttribute(
      "aria-label",
      d && ultimo
        ? `Gráfico de ${d.nome}. Última leitura: ${temp(ultimo.temperatura)} e ${umid(ultimo.umidade)}.`
        : "Gráfico de temperatura e umidade do dispositivo selecionado",
    );
    const msg = !estado.carregado ? "Carregando…"
      : !estado.dispositivos.length ? "Cadastre um dispositivo para ver o histórico."
      : estado.carregandoGrafico ? "Carregando…"
      : "Sem leituras neste período.";
    graficoPrincipal?.definir(estado.leituras, estado.janela, msg);
  }

  function linhaDispositivo(d) {
    const e = d.estado;
    const id = esc(d.id);
    const tBarra = d.temperatura == null ? 0 : Math.min(100, Math.max(0, (d.temperatura / escalaTemp()) * 100));
    const uBarra = d.umidade == null ? 0 : Math.min(100, Math.max(0, d.umidade));
    const tAlta = d.temperatura != null && d.temperatura > estado.config.limite_temp;
    const uBaixa = d.umidade != null && d.umidade < estado.config.limite_umid;
    const medida = (v, unidade, texto, barra, classe) => v == null
      ? "<strong>—</strong>"
      : `<strong>${texto} <em>${unidade}</em></strong><span class="barra ${classe}"><i style="width:${barra.toFixed(0)}%"></i></span>`;
    return `<tr data-id="${id}" class="${e}">` +
      `<td class="c-nome"><strong>${esc(d.nome)}</strong><small><code>${id}</code>${d.simulado ? '<span class="chip">simulado</span>' : ""}</small></td>` +
      `<td><span class="selo ${e}" title="${esc(motivos(d).join(", "))}"><span class="ponto"></span>${ROTULO[e]}</span></td>` +
      `<td class="c-medida">${medida(d.temperatura, "°C", fmt1.format(d.temperatura ?? 0), tBarra, tAlta ? "alerta" : "")}</td>` +
      `<td class="c-medida">${medida(d.umidade, "%", fmt1.format(d.umidade ?? 0), uBarra, uBaixa ? "umid alerta" : "umid")}</td>` +
      `<td class="c-tendencia">${spark(d.historico, 1)}</td>` +
      `<td class="c-ultima">${relativo(d.atraso)}</td>` +
      `<td class="c-acoes">` +
      `<button type="button" class="botao-link" data-acao="detalhes" data-id="${id}" data-foco="det:${id}">Detalhes</button>` +
      `<a class="botao-link" href="${BASE}/api/exportar/${encodeURIComponent(d.id)}" download data-foco="csv:${id}">CSV</a>` +
      `<button type="button" class="botao-link perigo" data-acao="remover" data-id="${id}" data-foco="rem:${id}">Remover</button>` +
      `</td></tr>`;
  }

  function renderTabela() {
    const base = filtrados();
    const conta = { todos: base.length, online: 0, alerta: 0, off: 0, espera: 0 };
    for (const d of base) {
      if (online(d)) conta.online++;
      if (d.estado !== "ok") conta[d.estado]++;
    }
    $$("#filtros button").forEach((b) => {
      setTexto($("b", b), String(conta[b.dataset.filtro]));
      b.setAttribute("aria-pressed", String(b.dataset.filtro === estado.filtro));
    });
    const lista = ordenar(base.filter(passaFiltro));
    setHTML($("#tabela-dispositivos"), lista.map(linhaDispositivo).join(""));
    const vazio = $("#tabela-vazia");
    vazio.hidden = lista.length > 0;
    setTexto(
      vazio,
      !estado.carregado
        ? (estado.conectado ? "Carregando dispositivos…" : "Sem conexão com o servidor. Tentando novamente…")
        : !estado.dispositivos.length
          ? "Nenhum dispositivo cadastrado. Use “Adicionar” para criar o primeiro."
          : "Nenhum dispositivo encontrado com esses filtros.",
    );
  }

  function renderAlertas() {
    const itens = estado.alertas.itens;
    setTexto($("#al-24h"), String(estado.alertas.ultimas_24h));
    setTexto($("#al-total"), String(estado.alertas.total));
    setTexto($("#al-limites"), `> ${fmt1.format(estado.config.limite_temp)} °C · < ${fmt1.format(estado.config.limite_umid)} %`);
    setHTML(
      $("#tabela-alertas"),
      itens.map((i) =>
        `<tr><td class="c-hora">${fmtData.format(new Date(i.criado_em * 1000))}</td>` +
        `<td><span class="tipo ${i.tipo}">${i.tipo === "temperatura" ? "Temperatura" : "Umidade"}</span></td>` +
        `<td>${esc(msgBR(i.mensagem))}</td></tr>`).join(""),
    );
    $("#alertas-vazio").hidden = itens.length > 0;
    marcarAlertasVistos();
  }

  function marcarAlertasVistos() {
    const maior = Math.max(0, ...estado.alertas.itens.map((i) => i.id));
    if (estado.alertaVisto === maior) return;
    estado.alertaVisto = maior;
    guardar("miot:alertas-vistos", String(maior));
    renderNav();
  }

  function hostDaApi() {
    return BASE ? BASE.replace(/^https?:\/\//, "") : location.host;
  }

  function codigoAmostra() {
    const id = estado.testeId || estado.selecionado || "sala";
    const host = hostDaApi();
    const url = `http://${host}/api/leituras`;
    if (estado.amostra === "python") {
      return `import time\nimport requests\n\nURL = "${url}"\n\nwhile True:\n    leitura = {"id": "${id}", "temperatura": 25.4, "umidade": 55.2}\n    requests.post(URL, json=leitura, timeout=5)\n    time.sleep(5)\n`;
    }
    if (estado.amostra === "esp32") {
      const ip = host.replace(/^(localhost|127\.0\.0\.1)/, "IP_DO_COMPUTADOR");
      return `#include <WiFi.h>\n#include <HTTPClient.h>\n#include <DHT.h>\n\nconst char* REDE  = "NOME_DO_WIFI";\nconst char* SENHA = "SENHA_DO_WIFI";\nconst char* URL   = "http://${ip}/api/leituras";\n\nDHT dht(4, DHT22);  // sensor DHT22 no pino 4\n\nvoid setup() {\n  Serial.begin(115200);\n  dht.begin();\n  WiFi.begin(REDE, SENHA);\n  while (WiFi.status() != WL_CONNECTED) delay(500);\n}\n\nvoid loop() {\n  float t = dht.readTemperature();\n  float u = dht.readHumidity();\n  if (!isnan(t) && !isnan(u)) {\n    HTTPClient http;\n    http.begin(URL);\n    http.addHeader("Content-Type", "application/json");\n    String corpo = "{\\"id\\":\\"${id}\\",\\"temperatura\\":" + String(t, 1) + ",\\"umidade\\":" + String(u, 1) + "}";\n    http.POST(corpo);\n    http.end();\n  }\n  delay(5000);\n}\n`;
    }
    return `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"id": "${id}", "temperatura": 25.4, "umidade": 55.2}'\n`;
  }

  function renderIntegracao() {
    setTexto($("#amostra"), codigoAmostra());
    $$("[data-amostra]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.amostra === estado.amostra)));
  }

  function renderExportar() {
    setHTML(
      $("#lista-exportar"),
      estado.dispositivos.map((d) =>
        `<li><span><strong>${esc(d.nome)}</strong><small>${esc(d.id)}</small></span>` +
        `<a class="botao-sec" href="${BASE}/api/exportar/${encodeURIComponent(d.id)}" download data-foco="exp:${esc(d.id)}">Baixar CSV</a></li>`).join(""),
    );
    $("#exportar-vazio").hidden = estado.dispositivos.length > 0;
  }

  function abrirGaveta(id) {
    const d = achar(id);
    if (!d) return;
    const gaveta = $("#gaveta");
    estado.gaveta = id;
    estado.leiturasGaveta = [];
    const medidor = (classe, chave, rotulo) =>
      `<section class="medidor ${classe}" data-g="m-${chave}"><svg class="anel" viewBox="0 0 120 120" aria-hidden="true">` +
      `<circle class="anel-fundo" cx="60" cy="60" r="50"/><circle class="anel-valor" cx="60" cy="60" r="50" transform="rotate(-90 60 60)"/></svg>` +
      `<strong>—</strong><small>${rotulo}</small></section>`;
    const stat = (classe, rotulo, chave) => `<li class="${classe}"><small>${rotulo}</small><strong data-g="${chave}">—</strong></li>`;
    $("#gaveta-conteudo").innerHTML =
      `<header class="gaveta-topo"><hgroup><h2>${esc(d.nome)}</h2><p><code>${esc(d.id)}</code>${d.simulado ? '<span class="chip">simulado</span>' : ""}</p></hgroup>` +
      `<button type="button" class="icone-botao" data-fechar-gaveta aria-label="Fechar">✕</button></header>` +
      `<p class="gaveta-status"><span data-g="selo"></span><span data-g="ultima"></span></p>` +
      `<section class="medidores">${medidor("", "temp", "Temperatura")}${medidor("umid", "umid", "Umidade")}</section>` +
      `<figure class="grafico-caixa"><canvas role="img" aria-label="Gráfico do dispositivo"></canvas></figure>` +
      `<ul class="estatisticas">${stat("e-temp", "Temp. mínima", "tmin")}${stat("e-temp", "Temp. média", "tmed")}${stat("e-temp", "Temp. máxima", "tmax")}` +
      `${stat("e-umid", "Umid. mínima", "umin")}${stat("e-umid", "Umid. média", "umed")}${stat("e-umid", "Umid. máxima", "umax")}</ul>` +
      `<footer class="gaveta-rodape"><a class="botao-sec" href="${BASE}/api/exportar/${encodeURIComponent(d.id)}" download>Exportar CSV</a>` +
      `<button type="button" class="botao-perigo" data-acao="remover" data-id="${esc(d.id)}">Remover</button></footer>`;
    graficoGaveta?.destruir();
    graficoGaveta = new Grafico($("canvas", gaveta));
    if (!gaveta.open) gaveta.showModal();
    renderGaveta();
    atualizarGaveta().catch(() => {});
  }

  function renderGaveta() {
    if (!estado.gaveta) return;
    const gaveta = $("#gaveta");
    const d = achar(estado.gaveta);
    if (!d) {
      if (gaveta.open) gaveta.close();
      return;
    }
    const g = (nome) => $(`[data-g="${nome}"]`, gaveta);
    const e = d.estado;
    setHTML(g("selo"), `<span class="selo ${e}"><span class="ponto"></span>${ROTULO[e]}</span>`);
    const extra = e === "alerta" ? ` · ${motivos(d).join(", ")}` : "";
    setTexto(g("ultima"), d.temperatura == null ? "Sem leituras ainda" : `Última leitura ${relativo(d.atraso)}${extra}`);

    const tAlta = d.temperatura != null && d.temperatura > estado.config.limite_temp;
    const uBaixa = d.umidade != null && d.umidade < estado.config.limite_umid;
    const anel = (chave, valor, fracao, texto, alerta) => {
      const el = g(`m-${chave}`);
      el.classList.toggle("alerta", alerta);
      $(".anel-valor", el).style.strokeDasharray = `${Math.min(1, Math.max(0, valor == null ? 0 : fracao)) * CIRCUNFERENCIA} 400`;
      setTexto($("strong", el), texto);
    };
    anel("temp", d.temperatura, (d.temperatura ?? 0) / escalaTemp(), temp(d.temperatura), tAlta);
    anel("umid", d.umidade, (d.umidade ?? 0) / 100, umid(d.umidade), uBaixa);

    const et = estatistica(estado.leiturasGaveta, "temperatura"), eu = estatistica(estado.leiturasGaveta, "umidade");
    setTexto(g("tmin"), et ? temp(et.mn) : "—");
    setTexto(g("tmed"), et ? temp(et.md) : "—");
    setTexto(g("tmax"), et ? temp(et.mx) : "—");
    setTexto(g("umin"), eu ? umid(eu.mn) : "—");
    setTexto(g("umed"), eu ? umid(eu.md) : "—");
    setTexto(g("umax"), eu ? umid(eu.mx) : "—");
    graficoGaveta?.definir(estado.leiturasGaveta, estado.janela, "Sem leituras neste período.");
  }

  async function atualizarGaveta() {
    const id = estado.gaveta;
    if (!id) return;
    const pontos = await buscarLeituras(id, estado.janela);
    if (id !== estado.gaveta) return;
    estado.leiturasGaveta = pontos;
    renderGaveta();
  }

  function renderizar() {
    renderStatus();
    renderNav();
    renderSeletores();
    switch (estado.vista) {
      case "visao-geral": renderKpis(); renderRede(); renderAlertasRecentes(); renderGrafico(); break;
      case "dispositivos": renderTabela(); break;
      case "alertas": renderAlertas(); break;
      case "integracao": renderIntegracao(); break;
      case "configuracoes": renderExportar(); break;
    }
    renderTitulo();
    renderGaveta();
  }

  let timer = null, buscando = false, refazer = false;

  function agendar(ms = estado.conectado ? INTERVALO : 5000) {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(atualizar, ms);
  }

  async function atualizarGrafico() {
    const id = estado.selecionado, janela = estado.janela;
    if (!id) {
      estado.leituras = [];
      estado.carregandoGrafico = false;
      renderGrafico();
      return;
    }
    const pontos = await buscarLeituras(id, janela);
    if (id !== estado.selecionado || janela !== estado.janela) return;
    estado.leituras = pontos;
    estado.carregandoGrafico = false;
    renderGrafico();
  }

  function garantirSelecao() {
    if (achar(estado.selecionado)) return false;
    estado.selecionado = estado.dispositivos[0]?.id ?? null;
    estado.leituras = [];
    estado.carregandoGrafico = true;
    if (estado.selecionado) guardar("miot:selecionado", estado.selecionado);
    return true;
  }

  function avisarNovosAlertas(itens) {
    const maior = Math.max(0, ...itens.map((i) => i.id));
    if (estado.ultimoAlerta != null) {
      const novos = itens.filter((i) => i.id > estado.ultimoAlerta);
      if (novos.length) {
        aviso(`Novo alerta: ${msgBR(novos[0].mensagem)}${novos.length > 1 ? ` (+${novos.length - 1})` : ""}`);
      }
    }
    estado.ultimoAlerta = Math.max(estado.ultimoAlerta ?? 0, maior);
    if (estado.alertaVisto == null) {
      estado.alertaVisto = maior;
      guardar("miot:alertas-vistos", String(maior));
    }
  }

  async function atualizar() {
    clearTimeout(timer);
    if (buscando) { refazer = true; return; }
    buscando = true;
    let ok = false;
    try {
      const [dispositivos, alertas, config] = await Promise.all([
        api("/api/dispositivos"),
        api("/api/alertas?limite=50"),
        api("/api/config"),
      ]);
      Object.assign(estado.config, config);
      estado.dispositivos = dispositivos.map((d) => ({ ...d, estado: statusDe(d) }));
      estado.alertas = alertas;
      estado.ultimaOk = Date.now();
      if (!estado.conectado) aviso("Conexão restabelecida.", "ok");
      estado.conectado = true;
      avisarNovosAlertas(alertas.itens);
      garantirSelecao();
      estado.carregado = true;
      ok = true;
    } catch {
      if (estado.conectado && estado.carregado) aviso("Sem conexão com o servidor.", "erro");
      estado.conectado = false;
    }
    buscando = false;

    renderizar();
    if (!formConfigSujo()) preencherConfig();
    if (ok) {
      const tarefas = [];
      if (estado.vista === "visao-geral") tarefas.push(atualizarGrafico());
      if (estado.gaveta) tarefas.push(atualizarGaveta());
      await Promise.allSettled(tarefas);
    }
    const de_novo = refazer;
    refazer = false;
    agendar(de_novo ? 0 : undefined);
  }

  let tempoAviso;
  function aviso(texto, tipo = "") {
    const el = $("#aviso");
    el.textContent = texto;
    el.className = `aviso visivel${tipo ? ` ${tipo}` : ""}`;
    clearTimeout(tempoAviso);
    tempoAviso = setTimeout(() => el.classList.remove("visivel"), 4500);
  }

  function mensagem(el, texto, sucesso = false) {
    el.textContent = texto;
    el.classList.toggle("ok", sucesso);
  }

  function selecionar(id) {
    if (!achar(id)) return;
    estado.selecionado = id;
    guardar("miot:selecionado", id);
    estado.leituras = [];
    estado.carregandoGrafico = true;
    renderSeletores();
    renderRede();
    renderGrafico();
    atualizarGrafico().catch(() => {});
  }

  function marcarJanela() {
    $$("#janelas button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.janela) === estado.janela)));
  }

  function confirmar(texto, rotulo = "Remover") {
    const dlg = $("#modal-confirmar");
    setTexto($("#confirmar-texto"), texto);
    setTexto($("#confirmar-ok"), rotulo);
    dlg.returnValue = "";
    return new Promise((resolver) => {
      dlg.addEventListener("close", () => resolver(dlg.returnValue === "sim"), { once: true });
      dlg.showModal();
    });
  }

  async function removerDispositivo(id) {
    const d = achar(id);
    if (!d) return;
    const ok = await confirmar(`“${d.nome}” e todo o histórico de leituras serão apagados. Essa ação não pode ser desfeita.`);
    if (!ok) return;
    try {
      await enviar("DELETE", `/api/dispositivos/${encodeURIComponent(id)}`);
    } catch (e) {
      aviso(e.message, "erro");
      return;
    }
    const gaveta = $("#gaveta");
    if (estado.gaveta === id && gaveta.open) gaveta.close();
    estado.dispositivos = estado.dispositivos.filter((x) => x.id !== id);
    if (garantirSelecao()) atualizarGrafico().catch(() => {});
    renderizar();
    aviso(`“${d.nome}” removido.`, "ok");
    atualizar();
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {}
    const area = document.createElement("textarea");
    area.value = texto;
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }

  function formConfigSujo() {
    return $("#form-config")._sujo === true;
  }

  function preencherConfig() {
    const c = estado.config;
    $("#cfg-temp").value = c.limite_temp;
    $("#cfg-umid").value = c.limite_umid;
    $("#cfg-offline").value = c.offline_s;
  }

  function fecharMenu() { document.body.classList.remove("menu-aberto"); }

  function irPara() {
    let vista = location.hash.slice(1);
    if (!VISTAS.includes(vista)) vista = "visao-geral";
    estado.vista = vista;
    $$("[data-vista]").forEach((s) => { s.hidden = s.dataset.vista !== vista; });
    $$("[data-link]").forEach((a) => {
      if (a.dataset.link === vista) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.title = `${TITULOS[vista]} | MIOT`;
    fecharMenu();
    window.scrollTo({ top: 0 });
    if (vista === "configuracoes" && !formConfigSujo()) preencherConfig();
    renderizar();
    if (vista === "visao-geral") atualizarGrafico().catch(() => {});
  }

  function aplicarTema(tema) {
    document.documentElement.dataset.tema = tema;
    $('meta[name="theme-color"]').setAttribute("content", tema === "claro" ? "#eef2f8" : "#080e1a");
    corCache = null;
    graficoPrincipal?.desenhar();
    graficoGaveta?.desenhar();
  }

  function ligarEventos() {
    window.addEventListener("hashchange", irPara);

    $("#abrir-menu").addEventListener("click", () => document.body.classList.add("menu-aberto"));
    $("#fundo-menu").addEventListener("click", fecharMenu);

    $("#alternar-tema").addEventListener("click", () => {
      const novo = document.documentElement.dataset.tema === "claro" ? "escuro" : "claro";
      guardar("miot:tema", novo);
      aplicarTema(novo);
    });

    $("#busca").addEventListener("input", (e) => {
      estado.busca = e.target.value;
      if (estado.vista !== "visao-geral" && estado.vista !== "dispositivos" && estado.busca.trim()) {
        location.hash = "#dispositivos";
      } else {
        renderizar();
      }
    });
    document.addEventListener("keydown", (e) => {
      const digitando = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
      if (e.key === "/" && !digitando && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        $("#busca").focus();
      } else if (e.key === "Escape") {
        fecharMenu();
        if (document.activeElement === $("#busca") && $("#busca").value) {
          $("#busca").value = "";
          estado.busca = "";
          renderizar();
        }
      }
    });

    $("#grafico-dispositivo").addEventListener("change", (e) => selecionar(e.target.value));
    $("#janelas").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-janela]");
      if (!b) return;
      estado.janela = Number(b.dataset.janela);
      guardar("miot:janela", String(estado.janela));
      estado.leituras = [];
      estado.carregandoGrafico = true;
      marcarJanela();
      renderGrafico();
      atualizarGrafico().catch(() => {});
      if (estado.gaveta) atualizarGaveta().catch(() => {});
    });
    $("#rede").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-id]");
      if (b) selecionar(b.dataset.id);
    });

    $("#filtros").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-filtro]");
      if (!b) return;
      estado.filtro = b.dataset.filtro;
      renderTabela();
    });
    $("#tabela-dispositivos").addEventListener("click", (e) => {
      const botao = e.target.closest("[data-acao]");
      if (botao?.dataset.acao === "remover") return removerDispositivo(botao.dataset.id);
      if (botao?.dataset.acao === "detalhes") return abrirGaveta(botao.dataset.id);
      if (e.target.closest("a")) return;
      const linha = e.target.closest("tr[data-id]");
      if (linha) abrirGaveta(linha.dataset.id);
    });
    $("thead", $('[data-vista="dispositivos"]')).addEventListener("click", (e) => {
      const th = e.target.closest("th[data-campo]");
      if (!th) return;
      const campo = th.dataset.campo;
      estado.ordem = { campo, dir: estado.ordem.campo === campo ? -estado.ordem.dir : 1 };
      $$("th[data-campo]").forEach((x) =>
        x.setAttribute("aria-sort", x.dataset.campo === campo ? (estado.ordem.dir > 0 ? "ascending" : "descending") : "none"));
      renderTabela();
    });

    const gaveta = $("#gaveta");
    let pressionou = null;
    gaveta.addEventListener("pointerdown", (e) => { pressionou = e.target; });
    gaveta.addEventListener("click", (e) => {
      if (e.target === gaveta && pressionou === gaveta) { gaveta.close(); return; }
      if (e.target.closest("[data-fechar-gaveta]")) { gaveta.close(); return; }
      const rem = e.target.closest('[data-acao="remover"]');
      if (rem) removerDispositivo(rem.dataset.id);
    });
    gaveta.addEventListener("close", () => {
      estado.gaveta = null;
      graficoGaveta?.destruir();
      graficoGaveta = null;
    });

    const modal = $("#modal-adicionar");
    const campoNome = $("#campo-nome"), campoId = $("#campo-id");
    $$("[data-abrir]").forEach((b) => b.addEventListener("click", () => {
      mensagem($("#form-erro"), "");
      modal.showModal();
      campoNome.focus();
    }));
    $$("[data-fechar]", modal).forEach((b) => b.addEventListener("click", () => modal.close()));
    let pressionouModal = null;
    modal.addEventListener("pointerdown", (e) => { pressionouModal = e.target; });
    modal.addEventListener("click", (e) => { if (e.target === modal && pressionouModal === modal) modal.close(); });
    campoNome.addEventListener("input", () => {
      campoId.placeholder = gerarId(campoNome.value).slice(0, 30) || "Gerado automaticamente";
    });
    $("#form-dispositivo").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nome = campoNome.value.trim();
      if (!nome) return mensagem($("#form-erro"), "Informe o nome do dispositivo.");
      const botao = e.submitter || $('button[type="submit"]', e.target);
      botao.disabled = true;
      try {
        const novo = await enviar("POST", "/api/dispositivos", {
          nome,
          id: campoId.value.trim() || undefined,
          simulado: $("#campo-simulado").checked,
        });
        modal.close();
        e.target.reset();
        campoId.placeholder = "Gerado automaticamente";
        estado.selecionado = novo.id;
        guardar("miot:selecionado", novo.id);
        estado.leituras = [];
        estado.carregandoGrafico = true;
        aviso(`“${novo.nome}” cadastrado.`, "ok");
        atualizar();
      } catch (erro) {
        mensagem($("#form-erro"), erro.message);
      } finally {
        botao.disabled = false;
      }
    });

    $(".abas").addEventListener("click", (e) => {
      const b = e.target.closest("[data-amostra]");
      if (!b) return;
      estado.amostra = b.dataset.amostra;
      renderIntegracao();
    });
    $("#copiar").addEventListener("click", async (e) => {
      const botao = e.currentTarget;
      const ok = await copiar($("#amostra").textContent);
      botao.textContent = ok ? "Copiado ✓" : "Não foi possível copiar";
      setTimeout(() => { botao.textContent = "Copiar"; }, 1800);
    });
    $("#teste-dispositivo").addEventListener("change", (e) => {
      estado.testeId = e.target.value;
      renderIntegracao();
    });
    $(".predefinidos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-t]");
      if (!b) return;
      $("#teste-temp").value = b.dataset.t;
      $("#teste-umid").value = b.dataset.u;
    });
    $("#form-teste").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#teste-msg");
      const id = $("#teste-dispositivo").value;
      const d = achar(id);
      if (!d) return mensagem(msg, "Cadastre um dispositivo primeiro.");
      const t = Number($("#teste-temp").value), u = Number($("#teste-umid").value);
      if (!Number.isFinite(t) || !Number.isFinite(u)) return mensagem(msg, "Informe temperatura e umidade.");
      const botao = e.submitter || $('button[type="submit"]', e.target);
      botao.disabled = true;
      try {
        await enviar("POST", "/api/leituras", { id, temperatura: t, umidade: u });
        mensagem(
          msg,
          `Leitura enviada para ${d.nome}: ${temp(t)} · ${umid(u)}.${d.simulado ? " Como o sensor é simulado, a próxima leitura gerada substitui esta." : ""}`,
          true,
        );
        atualizar();
      } catch (erro) {
        mensagem(msg, erro.message);
      } finally {
        botao.disabled = false;
      }
    });

    const formConfig = $("#form-config");
    formConfig.addEventListener("input", () => { formConfig._sujo = true; mensagem($("#cfg-msg"), ""); });
    formConfig.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#cfg-msg");
      const botao = e.submitter || $('button[type="submit"]', e.target);
      botao.disabled = true;
      try {
        const nova = await enviar("POST", "/api/config", {
          limite_temp: Number($("#cfg-temp").value),
          limite_umid: Number($("#cfg-umid").value),
          offline_s: Number($("#cfg-offline").value),
        });
        Object.assign(estado.config, nova);
        formConfig._sujo = false;
        preencherConfig();
        mensagem(msg, "Limites salvos. Já valem para as próximas leituras.", true);
        atualizar();
      } catch (erro) {
        mensagem(msg, erro.message);
      } finally {
        botao.disabled = false;
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearTimeout(timer); else atualizar();
    });
    window.addEventListener("online", atualizar);
  }

  function iniciar() {
    graficoPrincipal = new Grafico($("#grafico"));
    aplicarTema(document.documentElement.dataset.tema === "claro" ? "claro" : "escuro");
    marcarJanela();
    ligarEventos();
    irPara();
    atualizar();
    document.fonts?.ready.then(() => {
      corCache = null;
      graficoPrincipal?.desenhar();
      graficoGaveta?.desenhar();
    });
  }

  iniciar();
})();