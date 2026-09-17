# NanoTreinoCld

Asistente operativo de entrenamiento para usar desde el celular mientras entrenás:
cronómetro, regresivo, intervalos, contador de series y notas de sesión por dictado.
No es un tracker — solo captura. La interpretación y el registro estructurado se
hacen después, a mano, pasando el texto a tu proyecto Treino en ChatGPT.

## Publicar en GitHub Pages

1. Creá un repositorio nuevo en GitHub (puede ser público o privado si tenés GitHub Pro/Team).
2. Subí **todo el contenido de esta carpeta** (`index.html`, `styles.css`, `app.js`,
   `manifest.json`, `sw.js`, la carpeta `icons/`) a la raíz del repositorio — no dentro
   de una subcarpeta, salvo que ajustes las rutas.
3. En el repositorio: **Settings → Pages → Source** → elegí la rama `main` y la carpeta `/root`.
4. Guardá. GitHub te va a dar una URL del tipo `https://tuusuario.github.io/turepo/`.
5. Abrí esa URL desde Chrome en tu Samsung.

## Instalar como app en el teléfono

1. Abrí la URL en Chrome (Android).
2. Menú (⋮) → **Agregar a pantalla de inicio** (o Chrome puede sugerirlo solo).
3. A partir de ahí se abre en modo standalone, sin la barra de direcciones, como una
   app más.

## Actualizar la app más adelante

Si modificás `index.html`, `styles.css` o `app.js` y volvés a subir los cambios a
GitHub Pages, subí también la versión del cache en `sw.js`:

```js
const CACHE_NAME = 'nanotreino-v2'; // subir el número
```

Sin ese cambio, el service worker puede seguir sirviendo la versión vieja desde cache
por un tiempo.

## Cosas a tener en cuenta (limitaciones reales, no bugs)

- **Alarmas con la pantalla bloqueada o la app en segundo plano no son 100%
  confiables.** Es una limitación de Android/Chrome, no de esta app — el sistema
  operativo puede suspender el proceso o negar el "wake lock" (batería baja, ahorro
  de energía, gestión agresiva de Samsung Device Care). Para que el timer de
  intervalos sea confiable, dejá la pantalla encendida y NanoTreinoCld en primer
  plano. Si querés reforzarlo: en tu Samsung, Ajustes → Cuidado del dispositivo →
  Batería → agregar Chrome a la lista de apps que **no** se ponen en reposo.
- El número en pantalla es siempre la referencia real — el sonido/vibración son una
  ayuda, no una garantía.
- Los datos viven solo en el almacenamiento local de ese navegador en ese teléfono.
  Si borrás datos de navegación de Chrome, se pierde la sesión guardada.
- Si abrís dos pestañas de Treino al mismo tiempo, pueden pisarse los datos guardados
  entre sí. Usá una sola pestaña/instancia a la vez.

## Flujo de uso

1. Abrís NanoTreinoCld desde el ícono.
2. Elegís modo de timer (Cronómetro / Regresivo / Intervalos) y, si hace falta,
   tocás "Ajustar" para configurar duración o rondas.
3. Iniciás. Usás el contador de series con los botones grandes −/+.
4. Durante los descansos, tocás el campo de notas, activás el dictado del teclado
   Samsung y contás lo que hiciste. Se guarda solo.
5. Al terminar, tocás "Copiar para ChatGPT" — copia todo al portapapeles con
   fecha, duración, series y notas con horario.
6. Abrís tu proyecto Treino en ChatGPT, pegás, y confirmás el registro.
7. Recién ahí, mantenés presionado "Mantener para nueva sesión" (2 segundos) para
   limpiar y empezar de cero.

Si volvés a abrir la app con una sesión de más de 8 horas sin transferir, te va a
avisar antes de mezclarla con una sesión nueva.
