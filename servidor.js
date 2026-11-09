// Servidor de salas de Dice Tactics.
// Guarda las salas en memoria: jugadores, configuración, semilla, la lista de
// órdenes de la partida (para quien se reconecta) y el chat.
// No decide nada del juego: solo numera y reparte las órdenes en el mismo
// orden a todos. No necesita instalar nada: se arranca con  node servidor.js
"use strict";

const http = require("http");
const { aceptarWebSockets } = require("./ws_minimo");

const PUERTO = process.env.PORT || 8080;
const MAX_JUGADORES = 4;
const CONFIG_INICIAL = { mapa: "clasico", objetos: "contenedores", rondas: 20 };
// Una sala sin nadie conectado se borra pasado este tiempo.
const BORRAR_SALA_VACIA_MS = 30 * 60 * 1000;

const salas = new Map();

function nuevoCodigo() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += letras[Math.floor(Math.random() * letras.length)];
  } while (salas.has(c));
  return c;
}

function limpiarNombre(n) {
  return String(n || "").trim().slice(0, 16) || "Jugador";
}

function enviar(ws, mensaje) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(mensaje));
}

function datosSala(sala) {
  return {
    codigo: sala.codigo,
    config: sala.config,
    empezada: sala.empezada,
    jugadores: sala.jugadores.map((j) => ({
      nombre: j.nombre, numero: j.numero, conectado: !!j.ws, anfitrion: j.numero === sala.anfitrion,
    })),
  };
}

function avisarSala(sala) {
  for (const j of sala.jugadores) enviar(j.ws, { tipo: "sala", sala: datosSala(sala), tu_numero: j.numero });
}

function aTodos(sala, mensaje) {
  for (const j of sala.jugadores) enviar(j.ws, mensaje);
}

function datosPartida(sala) {
  return {
    config: sala.config,
    semilla: sala.semilla,
    jugadores: sala.jugadores.map((j) => ({ nombre: j.nombre, numero: j.numero })),
  };
}

function chatSistema(sala, texto) {
  const m = ["★", texto];
  sala.chat.push(m);
  if (sala.chat.length > 60) sala.chat.shift();
  aTodos(sala, { tipo: "chat", nombre: m[0], texto: m[1] });
}

function revisarVacia(sala) {
  if (sala.jugadores.some((j) => j.ws)) {
    sala.vaciaDesde = 0;
  } else if (!sala.vaciaDesde) {
    sala.vaciaDesde = Date.now();
  }
}

setInterval(() => {
  const ahora = Date.now();
  for (const [codigo, sala] of salas) {
    if (sala.vaciaDesde && ahora - sala.vaciaDesde > BORRAR_SALA_VACIA_MS) salas.delete(codigo);
  }
}, 60 * 1000);

function alRecibir(ws, datos) {
  let m;
  try { m = JSON.parse(datos); } catch { return; }
  const sala = ws.sala ? salas.get(ws.sala) : null;
  const yo = sala ? sala.jugadores.find((j) => j.numero === ws.numero) : null;

  switch (m.tipo) {
    case "ping":
      enviar(ws, { tipo: "pong" });
      break;

    case "crear": {
      const codigo = nuevoCodigo();
      const nueva = {
        codigo, config: { ...CONFIG_INICIAL }, empezada: false, semilla: 0,
        jugadores: [], ordenes: [], chat: [], anfitrion: 1, vaciaDesde: 0,
      };
      salas.set(codigo, nueva);
      nueva.jugadores.push({ nombre: limpiarNombre(m.nombre), numero: 1, ws });
      ws.sala = codigo;
      ws.numero = 1;
      avisarSala(nueva);
      chatSistema(nueva, `${limpiarNombre(m.nombre)} ha creado la sala.`);
      break;
    }

    case "unirse": {
      const s = salas.get(String(m.codigo || "").trim().toUpperCase());
      if (!s) return enviar(ws, { tipo: "error", texto: "No existe ninguna sala con ese código." });
      const nombre = limpiarNombre(m.nombre);
      // ¿Vuelve alguien que ya estaba? (mismo nombre)
      let j = s.jugadores.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase());
      if (j && j.ws && j.ws !== ws && j.ws.readyState === 1) {
        return enviar(ws, { tipo: "error", texto: "Ya hay alguien conectado con ese nombre en la sala." });
      }
      if (!j) {
        if (s.empezada) return enviar(ws, { tipo: "error", texto: "La partida ya ha empezado: solo pueden volver los que estaban." });
        if (s.jugadores.length >= MAX_JUGADORES) return enviar(ws, { tipo: "error", texto: "La sala está llena (4 jugadores)." });
        let numero = 1;
        while (s.jugadores.some((x) => x.numero === numero)) numero++;
        j = { nombre, numero, ws: null };
        s.jugadores.push(j);
        s.jugadores.sort((a, b) => a.numero - b.numero);
        chatSistema(s, `${nombre} se ha unido.`);
      } else {
        chatSistema(s, `${j.nombre} ha vuelto.`);
      }
      j.ws = ws;
      ws.sala = s.codigo;
      ws.numero = j.numero;
      revisarVacia(s);
      avisarSala(s);
      if (s.empezada) {
        enviar(ws, { tipo: "reconexion", ...datosPartida(s), tu_numero: j.numero, ordenes: s.ordenes, chat: s.chat });
      } else {
        for (const c of s.chat) enviar(ws, { tipo: "chat", nombre: c[0], texto: c[1] });
      }
      break;
    }

    case "config":
      if (!sala || !yo || yo.numero !== sala.anfitrion || sala.empezada) return;
      sala.config = { ...sala.config, ...m.config };
      avisarSala(sala);
      break;

    case "empezar":
      if (!sala || !yo || yo.numero !== sala.anfitrion) return;
      if (sala.jugadores.length < 2) return enviar(ws, { tipo: "error", texto: "Hacen falta al menos 2 jugadores." });
      // Los números de jugador quedan seguidos (1, 2, 3...).
      sala.jugadores.forEach((x, i) => { x.numero = i + 1; if (x.ws) x.ws.numero = i + 1; });
      sala.anfitrion = Math.min(...sala.jugadores.map((x) => x.numero));
      sala.empezada = true;
      sala.semilla = Math.floor(Math.random() * 2147483647);
      sala.ordenes = [];
      avisarSala(sala);
      for (const x of sala.jugadores) enviar(x.ws, { tipo: "empezar", ...datosPartida(sala), tu_numero: x.numero });
      chatSistema(sala, "¡Empieza la partida!");
      break;

    case "orden":
      if (!sala || !yo || !sala.empezada || typeof m.orden !== "object") return;
      sala.ordenes.push(m.orden);
      aTodos(sala, { tipo: "orden", orden: m.orden, n: sala.ordenes.length });
      break;

    case "chat": {
      if (!sala || !yo) return;
      const texto = String(m.texto || "").trim().slice(0, 200);
      if (!texto) return;
      sala.chat.push([yo.nombre, texto]);
      if (sala.chat.length > 60) sala.chat.shift();
      aTodos(sala, { tipo: "chat", nombre: yo.nombre, texto });
      break;
    }

    case "salir":
      if (!sala || !yo) return;
      if (!sala.empezada) {
        sala.jugadores = sala.jugadores.filter((x) => x !== yo);
        if (sala.anfitrion === yo.numero && sala.jugadores.length) sala.anfitrion = sala.jugadores[0].numero;
      } else {
        yo.ws = null;
      }
      chatSistema(sala, `${yo.nombre} ha salido.`);
      ws.sala = null;
      revisarVacia(sala);
      avisarSala(sala);
      break;
  }
}

const servidorHttp = http.createServer((req, res) => {
  // Para comprobar que está vivo (y para que el hosting lo despierte).
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Dice Tactics: servidor de salas funcionando (${salas.size} salas).`);
});

aceptarWebSockets(servidorHttp, (ws) => {
  ws.on("message", (datos) => alRecibir(ws, datos));
  ws.on("close", () => {
    const sala = ws.sala ? salas.get(ws.sala) : null;
    if (!sala) return;
    const j = sala.jugadores.find((x) => x.ws === ws);
    if (!j) return;
    j.ws = null;
    chatSistema(sala, `${j.nombre} se ha desconectado.`);
    revisarVacia(sala);
    avisarSala(sala);
  });
});

servidorHttp.listen(PUERTO, () => console.log(`Servidor de salas en el puerto ${PUERTO}`));
