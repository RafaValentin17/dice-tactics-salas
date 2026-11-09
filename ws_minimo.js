// WebSocket mínimo sin dependencias (solo lo que necesita el servidor de salas):
// mensajes de texto, ping/pong y cierre. Así no hace falta instalar nada.
"use strict";
const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class Conexion extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1;
    this.bufer = Buffer.alloc(0);
    this.fragmentos = [];
    socket.on("data", (d) => this._datos(d));
    socket.on("close", () => this._cerrado());
    socket.on("error", () => this._cerrado());
  }

  send(texto) {
    if (this.readyState !== 1) return;
    const datos = Buffer.from(texto, "utf8");
    let cabecera;
    if (datos.length < 126) {
      cabecera = Buffer.from([0x81, datos.length]);
    } else if (datos.length < 65536) {
      cabecera = Buffer.alloc(4);
      cabecera[0] = 0x81; cabecera[1] = 126; cabecera.writeUInt16BE(datos.length, 2);
    } else {
      cabecera = Buffer.alloc(10);
      cabecera[0] = 0x81; cabecera[1] = 127; cabecera.writeBigUInt64BE(BigInt(datos.length), 2);
    }
    this.socket.write(Buffer.concat([cabecera, datos]));
  }

  close() {
    if (this.readyState !== 1) return;
    try { this.socket.write(Buffer.from([0x88, 0])); } catch {}
    this.socket.end();
    this._cerrado();
  }

  _cerrado() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  _datos(d) {
    this.bufer = Buffer.concat([this.bufer, d]);
    while (this.bufer.length >= 2) {
      const b0 = this.bufer[0], b1 = this.bufer[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, mascara = (b1 & 0x80) !== 0;
      let largo = b1 & 0x7f, pos = 2;
      if (largo === 126) { if (this.bufer.length < 4) return; largo = this.bufer.readUInt16BE(2); pos = 4; }
      else if (largo === 127) { if (this.bufer.length < 10) return; largo = Number(this.bufer.readBigUInt64BE(2)); pos = 10; }
      const total = pos + (mascara ? 4 : 0) + largo;
      if (this.bufer.length < total) return;
      let carga = this.bufer.subarray(pos + (mascara ? 4 : 0), total);
      if (mascara) {
        const m = this.bufer.subarray(pos, pos + 4);
        carga = Buffer.from(carga.map((x, i) => x ^ m[i % 4]));
      }
      this.bufer = this.bufer.subarray(total);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { // ping -> pong
        const c = Buffer.alloc(2 + carga.length); c[0] = 0x8a; c[1] = carga.length; carga.copy(c, 2);
        this.socket.write(c); continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.fragmentos.push(carga);
        if (fin) {
          const mensaje = Buffer.concat(this.fragmentos).toString("utf8");
          this.fragmentos = [];
          this.emit("message", mensaje);
        }
      }
    }
  }
}

// Acepta las conexiones WebSocket de un servidor http y llama a alConectar(conexion).
function aceptarWebSockets(servidorHttp, alConectar) {
  servidorHttp.on("upgrade", (req, socket) => {
    const clave = req.headers["sec-websocket-key"];
    if (!clave || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    const acepta = crypto.createHash("sha1").update(clave + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acepta}\r\n\r\n`
    );
    socket.setNoDelay(true);
    alConectar(new Conexion(socket));
  });
}

module.exports = { aceptarWebSockets };
