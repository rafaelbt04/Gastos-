#!/usr/bin/env python3
"""Cofrinho — extrai os anexos de e-mails do Gmail baixados no formato RAW.

Uso:
  python3 -I extrair_anexos.py PASTA_SAIDA ARQUIVO1 [ARQUIVO2 ...]

Cada ARQUIVO é a resposta do get_message (messageFormat RAW) salva em disco:
um JSON com os campos "id" e "raw" (MIME em base64url). Os anexos de cada
e-mail vão para PASTA_SAIDA/<id do e-mail>/.
"""
import base64
import email
import json
import os
import re
import sys
from email import policy


def ler_resposta(caminho):
    texto = open(caminho, encoding="utf-8", errors="replace").read().strip()
    try:
        d = json.loads(texto)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", texto, re.S)
        if not m:
            raise SystemExit(f"{caminho}: não é a resposta do Gmail em JSON")
        d = json.loads(m.group(0))
    if isinstance(d, list):
        d = d[0]
    if "raw" not in d:
        raise SystemExit(f"{caminho}: a resposta não tem o campo 'raw' (use messageFormat RAW)")
    return d.get("id") or os.path.splitext(os.path.basename(caminho))[0], d["raw"]


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    saida = sys.argv[1]
    total = 0
    for caminho in sys.argv[2:]:
        msg_id, raw = ler_resposta(caminho)
        msg_id = re.sub(r"[^A-Za-z0-9_-]", "", msg_id)
        dados = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        msg = email.message_from_bytes(dados, policy=policy.default)
        pasta = os.path.join(saida, msg_id)
        os.makedirs(pasta, exist_ok=True)
        with open(os.path.join(pasta, "_assunto.txt"), "w", encoding="utf-8") as f:
            f.write(str(msg.get("subject", "")) + "\n" + str(msg.get("date", "")) + "\n")
        n = 0
        for parte in msg.iter_attachments():
            nome = os.path.basename(parte.get_filename() or f"anexo{n}")
            nome = re.sub(r"[^A-Za-z0-9_.\-]", "_", nome)
            conteudo = parte.get_payload(decode=True) or b""
            with open(os.path.join(pasta, nome), "wb") as f:
                f.write(conteudo)
            print(f"{msg_id}\t{nome}\t{len(conteudo)} bytes")
            n += 1
        if n == 0:
            print(f"{msg_id}\t(sem anexos)")
        total += n
    print(f"TOTAL\t{total} anexo(s)")


if __name__ == "__main__":
    main()
