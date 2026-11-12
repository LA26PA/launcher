// Genera el manifest.json a partir de tu "pack" (la carpeta con todo lo que el launcher tiene que repartir).
//
// Uso: node tools/generar-manifest.js <carpeta-pack> <url-base> [salida]
//
// La carpeta pack puede tener esta forma:
//   mods/            -> los .jar del server (se actualizan y se borran los que sobren)
//   config/          -> configuraciones (por ejemplo la de FancyMenu, para el menú personalizado)
//   resourcepacks/   -> resource packs
//   shaderpacks/     -> shaders
//   options.txt      -> opciones por defecto (se copia solo si el jugador todavía no tiene una)
//
// Subí la carpeta pack TAL CUAL a <url-base> (queda <url-base>/mods/x.jar, <url-base>/config/..., etc.)
// Si la carpeta solo tiene .jar sueltos (sin subcarpeta "mods"), también funciona.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , carpeta, base, salida = 'manifest.json'] = process.argv;

if (!carpeta || !base) {
  console.log('Uso: node tools/generar-manifest.js <carpeta-pack> <url-base> [salida]');
  process.exit(1);
}

const RAICES = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt'];
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const urlBase = base.replace(/\/+$/, '');
const codificar = (ruta) => ruta.split('/').map(encodeURIComponent).join('/');

function listar(dir, rel = '') {
  let salidaArchivos = [];
  for (const nombre of fs.readdirSync(path.join(dir, rel)).sort()) {
    const relNuevo = rel ? rel + '/' + nombre : nombre;
    if (fs.statSync(path.join(dir, relNuevo)).isDirectory()) {
      salidaArchivos = salidaArchivos.concat(listar(dir, relNuevo));
    } else {
      salidaArchivos.push(relNuevo);
    }
  }
  return salidaArchivos;
}

const mods = [];
const archivos = [];

if (fs.existsSync(path.join(carpeta, 'mods')) && fs.statSync(path.join(carpeta, 'mods')).isDirectory()) {
  for (const ruta of listar(carpeta)) {
    const completo = path.join(carpeta, ...ruta.split('/'));
    const partes = ruta.split('/');
    if (!RAICES.includes(partes[0])) continue; // lo demás no se reparte

    if (partes[0] === 'mods') {
      if (partes.length === 2 && ruta.endsWith('.jar')) {
        mods.push({ archivo: partes[1], url: `${urlBase}/${codificar(ruta)}`, sha1: sha1(completo) });
      }
    } else {
      archivos.push({
        ruta,
        url: `${urlBase}/${codificar(ruta)}`,
        sha1: sha1(completo),
        soloSiNoExiste: ruta === 'options.txt',
      });
    }
  }
} else {
  // Modo simple: carpeta con .jar sueltos
  for (const f of fs.readdirSync(carpeta).filter((x) => x.endsWith('.jar')).sort()) {
    mods.push({ archivo: f, url: `${urlBase}/${encodeURIComponent(f)}`, sha1: sha1(path.join(carpeta, f)) });
  }
}

fs.writeFileSync(salida, JSON.stringify({ generado: new Date().toISOString(), mods, archivos }, null, 2));
console.log(`${mods.length} mods y ${archivos.length} archivos -> ${salida}`);
console.log(`Subí el contenido de la carpeta a ${urlBase} y el manifest.json donde lo apunte config.json (mods.manifestUrl).`);
