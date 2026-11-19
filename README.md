# Auditoría Web · Codelab

Herramienta gratuita de **Codelab** que analiza cualquier web al momento: **seguridad, SEO, accesibilidad y velocidad** (36 comprobaciones), con nota por áreas, datos clave, la lista de problemas explicada en lenguaje sencillo con cómo arreglarlos y lo que ya está bien. Sirve para captar clientes y vender auditoría experta, optimización y seguimiento.

- Página: `index.html` (castellano y catalán, tema claro y oscuro, informe descargable en PDF).
- `#ejemplo` al final de la dirección abre el informe de ejemplo (`data/ejemplo.json`, análisis real de consultasyvisitas.pauizel.com).
- `checks.js`: textos de cada comprobación. `config.js`: dirección del servidor y correo de contacto.

## Servidor (`worker/`)

Cloudflare Worker gratuito que visita la web, la analiza y devuelve el informe. No guarda nada.

- En producción: https://codelab-auditoria.codelab-pauizel.workers.dev
- Desplegar cambios: `cd worker && npx wrangler deploy`
- Opcional: añade la nota de velocidad de Google con una clave gratuita de PageSpeed Insights: `npx wrangler secret put PSI_KEY`
