import json
import math
import os
import random
import re
import sqlite3
import threading
import time
import unicodedata
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PASTA = Path(__file__).parent
BANCO = PASTA / "miot.db"
PORTA = int(os.environ.get("PORTA", 8000))
RETENCAO_DIAS = 7
LIMITE_CORPO = 64 * 1024

CONFIG_CAMPOS = {
    "limite_temp": ("Temperatura máxima", -40, 100),
    "limite_umid": ("Umidade mínima", 0, 100),
    "offline_s": ("Tempo para offline", 2, 3600),
}

ARQUIVOS = {
    "/": "index.html",
    "/index.html": "index.html",
    "/style.css": "style.css",
    "/script.js": "script.js",
}
TIPOS = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}


def arquivo_sql():
    for caminho in PASTA.iterdir():
        if caminho.name.lower() == "bank.sql":
            return caminho
    raise FileNotFoundError("bank.sql não encontrado ao lado do app.py")


def executar(sql, params=()):
    con = sqlite3.connect(BANCO, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        with con:
            return con.execute(sql, params).fetchall()
    finally:
        con.close()


def criar_banco():
    con = sqlite3.connect(BANCO, timeout=10)
    con.execute("PRAGMA journal_mode = WAL")
    with con:
        con.executescript(arquivo_sql().read_text(encoding="utf-8"))
        colunas = [c[1] for c in con.execute("PRAGMA table_info(dispositivos)")]
        if "simulado" not in colunas:
            con.execute("ALTER TABLE dispositivos ADD COLUMN simulado INTEGER NOT NULL DEFAULT 0")
            con.execute("UPDATE dispositivos SET simulado = 1")
    con.close()


def configuracao():
    return {l["chave"]: l["valor"] for l in executar("SELECT chave, valor FROM configuracoes")}


def gerar_id(texto):
    texto = unicodedata.normalize("NFD", texto.lower())
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", texto).strip("-")


def numero_valido(valor, minimo, maximo):
    v = float(valor)
    if not math.isfinite(v) or not minimo <= v <= maximo:
        raise ValueError("fora da faixa")
    return v


def problema(temperatura, umidade, cfg):
    if temperatura > cfg["limite_temp"]:
        return f"temperatura alta ({temperatura:.1f} °C)"
    if umidade < cfg["limite_umid"]:
        return f"umidade baixa ({umidade:.1f} %)"
    return ""


def registrar_leitura(id, temperatura, umidade, quando=None):
    cfg = configuracao()
    anterior = executar(
        "SELECT temperatura, umidade FROM leituras WHERE dispositivo_id = ? "
        "ORDER BY criado_em DESC, id DESC LIMIT 1",
        (id,),
    )
    if quando is None:
        executar(
            "INSERT INTO leituras (dispositivo_id, temperatura, umidade) VALUES (?, ?, ?)",
            (id, temperatura, umidade),
        )
    else:
        executar(
            "INSERT INTO leituras (dispositivo_id, temperatura, umidade, criado_em) VALUES (?, ?, ?, ?)",
            (id, temperatura, umidade, quando),
        )
    atual = problema(temperatura, umidade, cfg)
    antes = problema(anterior[0]["temperatura"], anterior[0]["umidade"], cfg) if anterior else ""
    if atual and not antes:
        nome = executar("SELECT nome FROM dispositivos WHERE id = ?", (id,))[0]["nome"]
        mensagem = f"{nome}: {atual}"
        if quando is None:
            executar("INSERT INTO alertas (dispositivo_id, mensagem) VALUES (?, ?)", (id, mensagem))
        else:
            executar(
                "INSERT INTO alertas (dispositivo_id, mensagem, criado_em) VALUES (?, ?, ?)",
                (id, mensagem, quando),
            )


def listar_dispositivos():
    cfg = configuracao()
    linhas = executar(
        "SELECT d.id, d.nome, d.simulado, l.temperatura, l.umidade, "
        "CAST(strftime('%s', 'now') AS INTEGER) - l.criado_em AS atraso "
        "FROM dispositivos d "
        "LEFT JOIN leituras l ON l.id = ("
        "  SELECT id FROM leituras WHERE dispositivo_id = d.id "
        "  ORDER BY criado_em DESC, id DESC LIMIT 1"
        ") ORDER BY d.criado_em, d.id"
    )
    resultado = []
    for l in linhas:
        item = dict(l)
        item["simulado"] = bool(l["simulado"])
        item["atraso"] = max(0, l["atraso"]) if l["atraso"] is not None else None
        item["alerta"] = l["temperatura"] is not None and bool(
            problema(l["temperatura"], l["umidade"], cfg)
        )
        recentes = executar(
            "SELECT temperatura, umidade FROM leituras WHERE dispositivo_id = ? "
            "ORDER BY criado_em DESC, id DESC LIMIT 24",
            (l["id"],),
        )
        item["historico"] = [r["temperatura"] for r in reversed(recentes)]
        item["historico_umid"] = [r["umidade"] for r in reversed(recentes)]
        resultado.append(item)
    return resultado


def base(id):
    h = 7
    for c in id:
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    return 22 + (h % 76) / 10, 40 + h % 31


def gerar_leitura(id, quando=None):
    t0, u0 = base(id)
    ultima = executar(
        "SELECT temperatura, umidade FROM leituras WHERE dispositivo_id = ? "
        "ORDER BY criado_em DESC, id DESC LIMIT 1",
        (id,),
    )
    t = ultima[0]["temperatura"] if ultima else t0
    u = ultima[0]["umidade"] if ultima else u0
    t += random.uniform(-0.5, 0.5) + (t0 - t) * 0.05
    u += random.uniform(-1, 1) + (u0 - u) * 0.05
    u = min(100.0, max(0.0, u))
    registrar_leitura(id, round(t, 1), round(u, 1), quando)


def preencher_historico(id):
    agora = int(time.time())
    for i in range(40, 0, -1):
        gerar_leitura(id, agora - i * 2)


def criar_exemplos():
    for id, nome in [("sala", "Sensor Sala"), ("estufa", "Sensor Estufa"), ("lab", "Sensor Lab")]:
        executar("INSERT INTO dispositivos (id, nome, simulado) VALUES (?, ?, 1)", (id, nome))
        preencher_historico(id)


def limpar_antigas():
    executar(
        "DELETE FROM leituras WHERE criado_em < CAST(strftime('%s', 'now') AS INTEGER) - ?",
        (RETENCAO_DIAS * 86400,),
    )


def simulador():
    ciclos = 0
    while True:
        try:
            if ciclos % 1800 == 0:
                limpar_antigas()
            ids = [d["id"] for d in executar("SELECT id FROM dispositivos WHERE simulado = 1")]
        except Exception as erro:
            print("simulador:", erro)
            ids = []
        for id in ids:
            try:
                gerar_leitura(id)
            except Exception as erro:
                print("simulador:", id, erro)
        ciclos += 1
        time.sleep(2)


class Handler(BaseHTTPRequestHandler):
    def log_request(self, codigo="-", tamanho="-"):
        if str(codigo).isdigit() and int(codigo) >= 400:
            super().log_request(codigo, tamanho)

    def responder(self, codigo, corpo=None, tipo="application/json; charset=utf-8", cabecalhos=None):
        if isinstance(corpo, bytes):
            dados = corpo
        elif corpo is None:
            dados = b""
        else:
            dados = json.dumps(corpo).encode()
        try:
            self.send_response(codigo)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(len(dados)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            for chave, valor in (cabecalhos or {}).items():
                self.send_header(chave, valor)
            self.end_headers()
            self.wfile.write(dados)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def erro(self, codigo, mensagem):
        self.responder(codigo, {"erro": mensagem})

    def corpo_json(self):
        try:
            tamanho = int(self.headers.get("Content-Length", 0))
            if not 0 <= tamanho <= LIMITE_CORPO:
                return None
            dados = json.loads(self.rfile.read(tamanho) or b"{}")
        except ValueError:
            return None
        return dados if isinstance(dados, dict) else None

    def numero(self, consulta, nome, padrao, maximo):
        try:
            return max(1, min(int(consulta.get(nome, [padrao])[0]), maximo))
        except ValueError:
            return padrao

    def do_GET(self):
        url = urlparse(self.path)
        consulta = parse_qs(url.query)
        partes = url.path.strip("/").split("/")

        if url.path in ARQUIVOS:
            arquivo = PASTA / ARQUIVOS[url.path]
            try:
                self.responder(200, arquivo.read_bytes(), TIPOS[arquivo.suffix])
            except FileNotFoundError:
                self.erro(404, "Arquivo não encontrado.")
        elif url.path == "/favicon.ico":
            self.responder(204)
        elif url.path == "/api/dispositivos":
            self.responder(200, listar_dispositivos())
        elif url.path == "/api/config":
            self.responder(200, configuracao())
        elif len(partes) == 3 and partes[:2] == ["api", "leituras"]:
            if "janela" in consulta:
                linhas = executar(
                    "SELECT temperatura, umidade, criado_em FROM ("
                    "  SELECT id, temperatura, umidade, criado_em FROM leituras "
                    "  WHERE dispositivo_id = ? "
                    "  AND criado_em >= CAST(strftime('%s', 'now') AS INTEGER) - ? "
                    "  ORDER BY criado_em DESC, id DESC LIMIT 5000"
                    ") ORDER BY criado_em, id",
                    (partes[2], self.numero(consulta, "janela", 300, 86400)),
                )
                self.responder(200, [dict(l) for l in linhas])
            else:
                linhas = executar(
                    "SELECT temperatura, umidade, criado_em FROM leituras "
                    "WHERE dispositivo_id = ? ORDER BY criado_em DESC, id DESC LIMIT ?",
                    (partes[2], self.numero(consulta, "limite", 30, 2000)),
                )
                self.responder(200, [dict(l) for l in reversed(linhas)])
        elif len(partes) == 3 and partes[:2] == ["api", "exportar"]:
            if not executar("SELECT 1 FROM dispositivos WHERE id = ?", (partes[2],)):
                return self.erro(404, "Dispositivo não encontrado.")
            linhas = executar(
                "SELECT criado_em, temperatura, umidade FROM leituras "
                "WHERE dispositivo_id = ? ORDER BY criado_em, id",
                (partes[2],),
            )
            texto = "data_hora,temperatura_c,umidade_pct\n" + "".join(
                f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(l['criado_em']))},"
                f"{l['temperatura']},{l['umidade']}\n"
                for l in linhas
            )
            self.responder(
                200,
                texto.encode("utf-8"),
                "text/csv; charset=utf-8",
                {"Content-Disposition": f'attachment; filename="miot-{partes[2]}.csv"'},
            )
        elif url.path == "/api/alertas":
            total = executar("SELECT COUNT(*) AS n FROM alertas")[0]["n"]
            ultimas = executar(
                "SELECT COUNT(*) AS n FROM alertas "
                "WHERE criado_em >= CAST(strftime('%s', 'now') AS INTEGER) - 86400"
            )[0]["n"]
            linhas = executar(
                "SELECT id, dispositivo_id, mensagem, criado_em FROM alertas ORDER BY id DESC LIMIT ?",
                (self.numero(consulta, "limite", 10, 500),),
            )
            itens = []
            for l in linhas:
                item = dict(l)
                motivo = l["mensagem"].rsplit(": ", 1)[-1]
                item["tipo"] = "temperatura" if motivo.startswith("temperatura") else "umidade"
                itens.append(item)
            self.responder(200, {"total": total, "ultimas_24h": ultimas, "itens": itens})
        else:
            self.erro(404, "Rota não encontrada.")

    def do_POST(self):
        caminho = urlparse(self.path).path
        dados = self.corpo_json()
        if dados is None:
            return self.erro(400, "JSON inválido.")

        if caminho == "/api/dispositivos":
            nome = str(dados.get("nome", "")).strip()[:40]
            id = gerar_id(str(dados.get("id") or nome))[:30]
            simulado = 1 if dados.get("simulado") else 0
            if not nome or not id:
                return self.erro(400, "Informe um nome ou ID válido.")
            if executar("SELECT 1 FROM dispositivos WHERE id = ?", (id,)):
                return self.erro(409, f'Já existe um dispositivo com o ID "{id}".')
            executar(
                "INSERT INTO dispositivos (id, nome, simulado) VALUES (?, ?, ?)",
                (id, nome, simulado),
            )
            if simulado:
                preencher_historico(id)
            self.responder(201, {"id": id, "nome": nome, "simulado": bool(simulado)})
        elif caminho == "/api/leituras":
            try:
                id = str(dados["id"])
                temperatura = round(numero_valido(dados["temperatura"], -100, 200), 2)
                umidade = round(numero_valido(dados["umidade"], 0, 100), 2)
            except (KeyError, TypeError, ValueError):
                return self.erro(400, "Envie id, temperatura (-100 a 200) e umidade (0 a 100).")
            if not executar("SELECT 1 FROM dispositivos WHERE id = ?", (id,)):
                return self.erro(404, "Dispositivo não cadastrado.")
            registrar_leitura(id, temperatura, umidade)
            self.responder(201, {"ok": True})
        elif caminho == "/api/config":
            novos = {}
            for chave, (rotulo, minimo, maximo) in CONFIG_CAMPOS.items():
                if chave not in dados:
                    continue
                try:
                    valor = float(dados[chave])
                except (TypeError, ValueError):
                    return self.erro(400, f"{rotulo}: informe um número.")
                if not minimo <= valor <= maximo:
                    return self.erro(400, f"{rotulo}: use um valor entre {minimo} e {maximo}.")
                novos[chave] = valor
            for chave, valor in novos.items():
                executar("INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)", (chave, valor))
            self.responder(200, configuracao())
        else:
            self.erro(404, "Rota não encontrada.")

    def do_DELETE(self):
        partes = urlparse(self.path).path.strip("/").split("/")
        if len(partes) == 3 and partes[:2] == ["api", "dispositivos"]:
            if not executar("SELECT 1 FROM dispositivos WHERE id = ?", (partes[2],)):
                return self.erro(404, "Dispositivo não encontrado.")
            executar("DELETE FROM dispositivos WHERE id = ?", (partes[2],))
            self.responder(204)
        else:
            self.erro(404, "Rota não encontrada.")


if __name__ == "__main__":
    primeira_vez = not BANCO.exists()
    criar_banco()
    if primeira_vez:
        criar_exemplos()
    try:
        servidor = ThreadingHTTPServer(("0.0.0.0", PORTA), Handler)
    except OSError:
        raise SystemExit(f"A porta {PORTA} já está em uso. Feche o outro programa ou rode com outra porta (ex.: PORTA=8001).")
    threading.Thread(target=simulador, daemon=True).start()
    endereco = f"http://localhost:{PORTA}"
    print(f"MIOT rodando em {endereco}  (Ctrl+C para parar)")
    threading.Timer(1, lambda: webbrowser.open(endereco)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nMIOT encerrado.")