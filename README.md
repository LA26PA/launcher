# La 26 Launcher

Launcher propio para el server. Botón Jugar, entra directo al server (sin pasar por el menú de Minecraft). Soporta cuentas premium (Microsoft) y no premium (solo nick). Instala Fabric, actualiza los mods solo y viene optimizado para compus flojas.

## 1. Configurar

Editá `config.json`:

- `nombre`: el nombre que se ve en el launcher.
- `server.host` y `server.port`: la IP o dominio de tu server.
- `version`: la versión de Minecraft (tiene que ser la misma que la del server).
- `loader`: `{ "tipo": "fabric", "version": "latest" }`, o `{ "tipo": "vanilla" }` si el server no lleva mods.
- `mods`: descarga y actualización de mods (ver más abajo).
- `entrarDirecto`: `true` = al darle Jugar entra directo al server.
- `cerrarVentanaAlJugar`: `true` = cuando el juego ya está abriendo, se cierra la ventana del launcher para liberar memoria.
- `ramPorDefecto`: `"auto"` elige según la RAM de la compu (también se puede cambiar en el launcher). O poné `"4G"`, etc.
- `jvmArgs`: `null` usa unos ajustes de Java pensados para evitar tirones. Si querés los tuyos, poné una lista.
- `javaPath`: dejalo en `null` si Java está en el PATH. Si no, poné la ruta al `java.exe`.

## 2. Probarlo

Necesitás [Node.js](https://nodejs.org) y Java (para 1.21.x, Java 21).

```
npm install
npm start
```

## 3. Generar el .exe para tus amigos

```
npm run dist
```

Queda un `.exe` portable en la carpeta `dist/`. Se lo pasás a tus amigos y listo, no instalan nada más (salvo Java).

## Optimización

Viene con varias cosas para que ande mejor en compus de pocos recursos:

- **Mods de rendimiento** (`mods.modrinth` en `config.json`): el launcher los baja solo desde Modrinth, en la última versión compatible con tu versión de Minecraft, junto con las dependencias que necesiten. Por defecto: Fabric API, Sodium, Lithium, FerriteCore, ModernFix, Entity Culling e ImmediatelyFast. Podés agregar o sacar nombres de la lista (el nombre es el que aparece en el link de Modrinth, `modrinth.com/mod/<nombre>`).
- **RAM automática** según la compu.
- **Ajustes de Java** para reducir los tirones.
- **Opciones gráficas livianas** la primera vez que se abre (distancia de render 8, sin sombras de entidades, sin nubes, etc.). Si el jugador ya tiene un `options.txt`, no se toca.
- **El launcher se cierra** cuando el juego ya está abriendo, para no gastar memoria de más.

Si Modrinth no responde, el launcher sigue con lo que ya tenga instalado.

## Mods del server (descarga y actualización automática)

Los mods propios de tu server se reparten con un `manifest.json`. Cada vez que alguien le da Jugar, el launcher lo lee, descarga lo que falte o haya cambiado (verifica que no llegue dañado) y borra los mods que ya no estén en la lista. Así todos tienen exactamente los mismos mods que el server.

1. Armá una carpeta "pack" con esta forma: `mods/` (los `.jar` del server) y, si querés, `config/`, `resourcepacks/`, `shaderpacks/` y `options.txt`.
2. Subí esa carpeta tal cual a algún lugar con link directo (una web tuya, un repo de GitHub, etc.).
3. Generá el manifest:

```
node tools/generar-manifest.js ./mi-pack https://tu-web.com/la26
```

4. Subí el `manifest.json` y poné su link en `config.json`, en `mods.manifestUrl`.
5. Para actualizar más adelante: cambiás lo que quieras en el pack, volvés a correr el paso 3 y volvés a subir todo. Tus amigos se actualizan solos.

Notas:
- No pongas en tu pack mods que ya baja Modrinth (por ejemplo Sodium): quedarían dos copias y el juego no arranca.
- `mods.borrarExtras: true` elimina de la carpeta de mods cualquier `.jar` que no esté en las listas. Ponelo en `false` si querés que cada uno pueda agregar mods propios.
- Los mods del server tienen que ser los mismos que repartís acá.
- Soporta Fabric. Forge/NeoForge necesitan otro tipo de instalación y no están incluidos todavía.

## Menú de Minecraft personalizado

Con `entrarDirecto: true` el jugador nunca ve el menú de Minecraft al abrir el juego: va directo al server. El menú solo aparece si se desconecta o sale del server.

Para tener un menú propio (con tu fondo, tu logo y un botón "Jugar" que entre al server) se usa el mod **FancyMenu** (en Modrinth: `fancymenu`):

1. Agregá `"fancymenu"` a la lista `mods.modrinth` en `config.json` y abrí el juego una vez para que se instale.
2. Dentro del juego, diseñá el menú con el editor de FancyMenu (botón de personalizar en el menú principal).
3. Copiá la carpeta `config/fancymenu` (y las imágenes que hayas usado) a tu pack, volvé a correr `generar-manifest.js` y subí todo.
4. Desde ese momento, todos tus amigos reciben el mismo menú automáticamente.

## Herramientas del launcher

En la barra de la izquierda hay una llave inglesa con las herramientas de la versión elegida:

- **Carpetas**: abre mods, mundos, capturas y backups.
- **Backup de mundos**: guarda un `.zip` de la carpeta `saves` en `.la26/backups` (se conservan los últimos 5 por versión).
- **Ver log / Copiar reporte**: abre `launcher.log` o copia al portapapeles la versión, el sistema y el final de los logs, para pegárselo al admin.
- **Reparar**: borra los mods, la instalación de esa versión, las librerías y el Java descargado, y se vuelve a bajar todo al darle Jugar. No toca mundos, opciones ni skins.
- **Java**: muestra si ya hay Java o si el launcher lo va a descargar solo (Windows 64 bits).

## Actualización automática del launcher

`electron-updater` no sirve con el formato portable, así que el launcher trae su propio actualizador que usa **GitHub Releases**:

1. Creá un repo **público** en GitHub y poné su nombre en `config.json`: `"actualizaciones": { "repo": "usuario/repo" }`.
2. Para sacar una versión nueva: subí el número de `version` en `package.json` (por ejemplo `1.0.1`), corré `npm run dist`, y en GitHub creá una Release con el tag `v1.0.1` y adjuntá `dist/La26-Launcher.exe`.
3. Al abrir el launcher, si hay una versión nueva aparece una ventanita "Actualizando el launcher", se baja el `.exe` nuevo, se reemplaza solo y se reabre, sin tocar nada (como Lunar). Si no hay internet o falla algo, se abre la versión que ya tenían. Para desactivarlo poné `"automatica": false` (queda el aviso con botón dentro del launcher).

Los datos del jugador (nick, sesión, RAM) no se pierden al actualizar. Esto solo funciona desde el `.exe`, no con `npm start`.

## Si algo falla

El launcher guarda lo que escribe el juego en `launcher.log`, dentro de la carpeta `.la26` (en `%APPDATA%` en Windows). Si el juego se cierra solo, ahí está el motivo.

## Configurar el server para que entren no premium

En `server.properties`:

```
online-mode=false
```

Ojo con esto: con `online-mode=false` el server no verifica identidades y cualquiera puede entrar con el nick de otro (y ser OP si ese nick es OP). Para un server entre amigos conviene:

- Activar la `white-list`, y/o
- Instalar un plugin de login como AuthMe (para que cada uno ponga contraseña).

## Nota

Minecraft se descarga desde los servidores oficiales de Mojang. Los términos de Mojang piden tener el juego comprado, así que el modo no premium queda bajo responsabilidad de ustedes.
